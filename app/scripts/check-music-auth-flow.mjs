// 第五期 M3-a Task C 自检：网易扫码登录全链（桥内一段 + 父进程状态机 + 三条路由）。
// 设计稿：docs/superpowers/plans/2026-10-06-m3a-cookie-login-channel-design.md（§3 / §7.1 / §8）
//
// 这一条盯五件事：
//   ① **801（还没人扫）那一档上游就带 cookie**（2026-10-06 一手实测：114 字符）——
//      映射层必须把它丢掉，只在 803 才交出去；这不是"传了也没用"，是根本不出这个字段。
//   ② 凭据去上游时走 **Cookie 请求头**，不走 `?cookie=` 查询串（查询串会进包自己的访问日志行）。
//   ③ 父进程状态机的对外形状只有五档 + reason，**上游码不透传**；TTL 到点自己判过期、不再打上游。
//   ④ §7.1 的运行时半：登录相关的每条路由响应、每一行服务日志都不许出现凭据本体（canary 法）。
//   ⑤ 包会把完整 unikey 打进 **stdout**（实测），而 stdout 是桥的 NDJSON 通道 ⇒ 父进程"非 JSON 行直接丢"
//      这一句就是那个泄漏面今天不存在的原因；这里把它钉成行为断言，谁改成"顺手打进日志"就会红。
// 离线纪律：不碰网络、不起真桥。包后端是假的，一跳 fetch 是注入件，文件系统只碰一次性临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
// R190：同族的第四处（`withServer` 里 `listen` 之后直接 fetch）——见那个函数上的注释。
// R211（A 类第 2 处）：换成 R198 的 listenAndReady（连不上就换端口重听），并给坏探测加上"先关服务再抛"。
import { listenAndReady } from './check-ready.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(join(SCRIPTS, name), 'utf8');

const authProvider = await import('./bridge/providers/auth.mjs');
const qqProvider = await import('./bridge/providers/qq-auth.mjs');
const kugouProvider = await import('./bridge/providers/kugou-auth.mjs');
const onlineAuthModule = await import('./online-auth.mjs');
const sessionModule = await import('./online-session.mjs');
const auditModule = await import('./online-audit.mjs');

const CANARY_COOKIE = 'scan-' + 'M9kQ2p7Lx4Rt8Yw3bN6v';
const CONFIRMED_COOKIE = `MUSIC_U=${CANARY_COOKIE}; NMTID=ntm-${CANARY_COOKIE.slice(5)}`;
/** `/login/qr/check` 在 code=801 时上游真实带的样子（实测 114 字符的匿名 cookie）。 */
const PENDING_COOKIE = `NMTID=anon-${CANARY_COOKIE.slice(5)}; Max-Age=31536000; Path=/; HttpOnly`;

// ── 桥内映射 ────────────────────────────────────────────────────────────────
test('801（还没人扫）这一档也必须把 cookie 丢掉：实测上游在这一步就发了 114 字符的 cookie', () => {
  const waiting = authProvider.ncmCheckToState({ code: 801, message: '等待扫码', cookie: PENDING_COOKIE });
  assert.deepEqual(waiting, { ok: true, state: 'waiting' }, 'waiting 的返回值里连 cookie 这个键都不该存在');
  assert.equal('cookie' in waiting, false);
  assert.equal(JSON.stringify(waiting).includes(CANARY_COOKIE), false, 'canary 从"未确认"那一档漏出去了');
  const scanned = authProvider.ncmCheckToState({ code: 802, message: '已扫码', cookie: PENDING_COOKIE });
  assert.deepEqual(scanned, { ok: true, state: 'scanned' }, '已扫待确认同样不带 cookie');
});

test('803 是唯一交回凭据的档位；说"已确认"却没带 cookie 不能算登录成功', () => {
  const confirmed = authProvider.ncmCheckToState({ code: 803, message: '登录成功', cookie: CONFIRMED_COOKIE });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.cookie, CONFIRMED_COOKIE, '这一档必须原样带回，否则登录这条链就断了');
  const hollow = authProvider.ncmCheckToState({ code: 803, message: '登录成功', cookie: '   ' });
  assert.equal(hollow.ok, false, '没凭据的 803 判 error：把"没拿到凭据"写成成功是最坏的一种谎');
  assert.match(hollow.reason, /没把凭据带回来/);
});

test('上游码不透传：800→expired、没见过的码→error 且 reason 里要说清是哪一档', () => {
  assert.equal(authProvider.ncmCheckToState({ code: 800 }).state, 'expired');
  for (const code of [400, 501, 0, undefined, '801']) {
    const odd = authProvider.ncmCheckToState({ code, message: 'x' });
    // '801' 是 Number() 认得的字符串形态——上游今天发的是数字，但这里按"认得就认，认不出才报错"处理，
    // 所以只有真正无法解析成档位的才该红；这一条把边界写成事实而不是理想。
    if (code === '801') { assert.equal(odd.state, 'waiting'); continue }
    assert.equal(odd.state, 'error', `码 ${code} 不该被当成某个正常档位`);
    assert.equal(odd.ok, false);
  }
  assert.deepEqual(authProvider.AUTH_STATES, ['waiting', 'scanned', 'confirmed', 'expired', 'error']);
});

test('TTL 由桥在取码时算出：175 秒（实测上游约 180 秒失效，早 5 秒收手）', () => {
  const base = 1_700_000_000_000;
  const qr = authProvider.ncmQrCreateToQr({ code: 200, data: { qrurl: 'https://x/qr.png', qrimg: 'data:image/png;base64,AAAA' } }, base);
  assert.equal(qr.ok, true);
  assert.equal(qr.expiresAt, base + authProvider.NCM_QR_TTL_MS);
  assert.equal(authProvider.NCM_QR_TTL_MS, 175_000, '这个数改动要先改设计稿 §8 的实测依据');
  const notImage = authProvider.ncmQrCreateToQr({ code: 200, data: { qrimg: 'https://x/qr.png' } }, base);
  assert.equal(notImage.ok, false, 'qrimg 不是 data URI 就要报错：把 URL 当图片喂给 <img> 是另一种坏法');
  const noKey = authProvider.ncmQrKeyToLoginId({ code: 200, data: { code: 500 } });
  assert.equal(noKey.ok, false);
  assert.equal(authProvider.ncmQrKeyToLoginId({ code: 200, data: { unikey: 'k-1' } }).loginId, 'k-1', '实测形状是 body.data.unikey');
});

test('账号昵称在 data.profile 里，不在 data.account 里（真扫码第一次问账号才暴露）', () => {
  // 真机形状：account 的键是 id / userName / type / status / vipType / paidFee / anonimousUser…，**没有 nickname**；
  // nickname 与 avatarUrl 都在 profile（37 个键）里。第一版按 account.nickname 取 ⇒ 登录态那一行永远是空的。
  const real = authProvider.ncmStatusToAccount({
    data: {
      code: 200,
      account: { id: 123456, userName: 'u***', vipType: 11, paidFee: true, anonimousUser: false },
      profile: { nickname: '某个昵称', avatarUrl: 'https://p1.music.126.net/x.jpg', signature: '一句话' },
    },
  });
  assert.deepEqual(real, { ok: true, loggedIn: true, nickname: '某个昵称', avatarUrl: 'https://p1.music.126.net/x.jpg' });
  // 只有 account（profile 为 null）时不能把"没昵称"报成"没登录"。
  const bare = authProvider.ncmStatusToAccount({ data: { account: { id: 1, userName: 'u' }, profile: null } });
  assert.equal(bare.loggedIn, true);
  assert.equal('nickname' in bare, false, '没有昵称就干脆不带这个键，不写空串假装说过');
  const anonymous = authProvider.ncmStatusToAccount({ data: { code: 200, account: null, profile: null } });
  assert.deepEqual(anonymous, { ok: true, loggedIn: false });
  // 权益数字今天没有消费者 ⇒ 不许顺手塞进响应面（键名白名单是要一条一条挣来的）。
  assert.equal('vipType' in real, false, 'vipType 要等 M3-b 有消费者时再显式加进白名单');
});

// ── 桥路由 ──────────────────────────────────────────────────────────────────
/** 一跳 fetch 的替身：记下每次请求的 URL 与头，回给定的一次性响应。 */
const makeFetchStub = (responses) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`替身没有准备好第 ${calls.length} 次响应：${url}`);
    return { status: next.status ?? 200, text: async () => next.body };
  };
  return { impl, calls };
};
const readyBackends = { netease: { state: 'ready', baseUrl: 'http://127.0.0.1:9', port: 9 } };

const mountAuthRoute = (fetchImpl, now = () => 1_700_000_000_000) => {
  const routes = new Map();
  authProvider.registerAuthRoutes({ routes, backends: readyBackends, fetchImpl, now });
  return (payload) => routes.get('/bridge/auth')(payload, { state: new Map(), backends: readyBackends, emit: () => {} });
};

test('start 打两跳（key → create）并把 loginId 留在桥的返回值里给父进程；后端没就绪要说"未就绪"且可重试', async () => {
  const { impl, calls } = makeFetchStub([
    { body: JSON.stringify({ code: 200, data: { code: 200, unikey: 'uni-1' } }) },
    { body: JSON.stringify({ code: 200, data: { qrurl: 'https://p/qr', qrimg: 'data:image/png;base64,AAAA' } }) },
  ]);
  const route = mountAuthRoute(impl);
  const started = await route({ action: 'start', provider: 'netease' });
  assert.equal(started.ok, true);
  assert.equal(started.loginId, 'uni-1');
  assert.equal(started.qr.image, 'data:image/png;base64,AAAA', '图片原样给父进程，界面直接喂 <img>，不引二维码生成依赖');
  assert.equal(started.expiresAt, 1_700_000_000_000 + authProvider.NCM_QR_TTL_MS);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/login\/qr\/create\?key=uni-1&qrimg=true/);
  assert.equal(JSON.stringify(started).includes('qrurl'), false, 'qrurl 是上游那个页面的地址，不是我们需要的东西');
  assert.equal(started.provider, 'netease', 'host 要报回 provider：桥的审计那一笔按它记');

  const routes = new Map();
  authProvider.registerAuthRoutes({ routes, backends: { netease: { state: 'error', reason: '包没起来' } }, fetchImpl: impl });
  const down = await routes.get('/bridge/auth')({ action: 'start', provider: 'netease' }, { emit: () => {} });
  assert.equal(down.ok, false);
  assert.match(down.reason, /未就绪/);
  assert.equal(down.retryable, true, '后端没起来是"等一等可能就好"，不许伪装成永久故障');
});

test('凭据去上游时走 Cookie 请求头，不走查询串：查询串会进包自己的访问日志行', async () => {
  const { impl, calls } = makeFetchStub([
    { body: JSON.stringify({ code: 200, data: { code: 200, account: { nickname: '测试账号', avatarUrl: 'https://p/a.jpg' } } }) },
    { body: JSON.stringify({ code: 200 }) },
  ]);
  const route = mountAuthRoute(impl);
  const statusResult = await route({ action: 'status', provider: 'netease', cookie: CONFIRMED_COOKIE });
  assert.equal(statusResult.loggedIn, true);
  assert.equal(statusResult.nickname, '测试账号');
  assert.equal(calls[0].headers.cookie, CONFIRMED_COOKIE, '头里带');
  assert.equal(calls[0].url.includes('cookie='), false, 'URL 里一个字都不带');
  const loggedOut = await route({ action: 'logout', provider: 'netease', cookie: CONFIRMED_COOKIE });
  assert.equal(loggedOut.loggedOut, true);
  assert.equal(calls[1].url.includes('cookie='), false);
});

test('status / logout 在本机没有登录态时直接回"没登录"，一次一跳都不发', async () => {
  const { impl, calls } = makeFetchStub([]);
  const route = mountAuthRoute(impl);
  const statusResult = await route({ action: 'status', provider: 'netease', cookie: '' });
  assert.equal(statusResult.ok, true);
  assert.equal(statusResult.loggedIn, false);
  const loggedOut = await route({ action: 'logout', provider: 'netease' });
  assert.equal(loggedOut.loggedIn, false);
  assert.equal(calls.length, 0, '没凭据还要问上游就是白耗一跳，还把"没登录"说成像出错了');
});

test('路由的输入面一律收窄：未知动作、未知 provider、poll 缺句柄都被拒且不出网', async () => {
  const { impl, calls } = makeFetchStub([]);
  const route = mountAuthRoute(impl);
  assert.equal((await route({ action: 'nope', provider: 'netease' })).ok, false);
  assert.equal((await route({ action: 'start', provider: 'qq' })).ok, false, 'QQ 那一半在 Task D');
  assert.equal((await route({ action: 'start' })).ok, false, '缺 provider 不许猜');
  assert.equal((await route({ action: 'poll', provider: 'netease' })).ok, false, '没有 loginId 的轮询是无效请求');
  assert.equal(calls.length, 0);
});

test('网易包在 check 的 catch 分支里引用了还没赋值的 result（一手源码事实）：桥不许把这句话当凭据缺失', async () => {
  // 包源码：`catch (error) { return { status:200, body:{}, cookie: result.cookie } }` ⇒ 那一行会抛 ReferenceError，
  // 表现是这一跳 HTTP 变成非 JSON / 5xx。我们的处置是：拿不到 JSON 就说"不是 JSON"并标可重试，
  // 而不是把它翻译成"你没扫码"。这条断言盯的就是这个处置。
  const { impl } = makeFetchStub([{ status: 500, body: '<!doctype html>boom' }]);
  const route = mountAuthRoute(impl);
  const polled = await route({ action: 'poll', provider: 'netease', loginId: 'uni-1' });
  assert.equal(polled.ok, false);
  assert.match(polled.reason, /不是 JSON/);
  assert.equal(polled.retryable, true);
});

// ── 父进程状态机 ────────────────────────────────────────────────────────────
const withTempDir = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), 'm3a-auth-'));
  try { return await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
};
/** 假桥：按脚本回答 /bridge/auth，并记下每次收到的 payload（凭据就是从这里过一次受保护的环回通道）。 */
const makeBridge = (script) => {
  const seen = [];
  return {
    seen,
    status: () => ({ phase: 'ready', port: 9, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }),
    call: async (route, payload) => {
      seen.push({ route, payload });
      const answer = script.shift();
      if (!answer) throw new Error(`假桥没有第 ${seen.length} 次的答案`);
      return answer;
    },
  };
};

test('确认态：凭据只进会话文件，返回值与服务日志里都没有它；进行中那一轮的句柄用完即弃', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'netease', action: 'start', loginId: 'uni-1', qr: { image: 'data:image/png;base64,AAAA' }, expiresAt: Date.now() + 175_000 },
      { ok: true, provider: 'netease', action: 'poll', state: 'waiting' },
      { ok: true, provider: 'netease', action: 'poll', state: 'scanned' },
      { ok: true, provider: 'netease', action: 'poll', state: 'confirmed', cookie: CONFIRMED_COOKIE },
    ]);
    const lines = [];
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: (line) => lines.push(line) });
    const started = await auth.start();
    assert.equal(started.state, 'waiting');
    assert.equal(started.qr.image, 'data:image/png;base64,AAAA');
    assert.equal(await auth.pendingSize(), 1, '父进程内存里持有这一轮的句柄');
    assert.equal((await auth.poll()).state, 'waiting');
    assert.equal((await auth.poll()).state, 'scanned');
    const confirmed = await auth.poll();
    assert.deepEqual(confirmed, { state: 'confirmed' }, '确认态的返回值里不许有任何凭据字段');
    assert.equal(await auth.pendingSize(), 0, '登录完就把句柄丢掉');
    const stored = JSON.parse(await readFile(join(dataDir, 'online-session', 'netease.json'), 'utf8'));
    assert.equal(stored.cookies.MUSIC_U, `MUSIC_U=${CANARY_COOKIE}`, '凭据该落在且只落在那一个文件里');
    assert.equal(JSON.stringify(confirmed).includes(CANARY_COOKIE), false);
    assert.equal(lines.join('\n').includes(CANARY_COOKIE), false, '服务日志里出现了凭据');
    assert.equal(lines.join('\n').includes('uni-1'), false, '登录句柄也不许进服务日志');
    // 状态读口：登录态来源要能说清，且不带内容。
    const view = await auth.status();
    assert.equal(view.providers.netease.source, 'file');
    assert.deepEqual(view.pending, [], '没有进行中的登录时 pending 是空数组（两家可以各有一张码在扫，单值形状会互相盖掉）');
    assert.equal(JSON.stringify(view).includes(CANARY_COOKIE), false);
  });
});

test('R215：本地显示时长到点**不再算终止** —— 继续问上游、终态只认上游；没有进行中登录时问一句也不出网', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'netease', loginId: 'uni-1', qr: { image: 'data:image/png;base64,AAAA' }, expiresAt: Date.now() - 1 },   // 起点即"已过本地显示时长"
      { ok: true, provider: 'netease', action: 'poll', state: 'waiting' },
      { ok: true, provider: 'netease', action: 'poll', state: 'expired', reason: '二维码过期了' },
    ]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    await auth.start();
    const still = await auth.poll();
    assert.equal(still.state, 'waiting', '本地到点不再判过期：上游说还活着就继续问（R215：确认可能迟一两分钟）');
    assert.equal(bridge.seen.length, 2, '到点后**仍要问上游**（本批反转的就是"未再询问上游"那条）');
    assert.equal(await auth.pendingSize(), 1, '那一轮的句柄不许被本机计时清掉');
    const ended = await auth.poll();
    assert.equal(ended.state, 'expired', '真正的终态只认上游返回');
    assert.equal(await auth.pendingSize(), 0, '上游说 expired 才清句柄');
    const again = await auth.poll();
    assert.equal(again.state, 'error');
    assert.equal(bridge.seen.length, 3, '没有进行中的登录时，poll 一次上游都不该碰');
  });
});

test('R215：本地时长走完仍接住**迟到的确认**并落盘（本批核心那格）', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'netease', loginId: 'uni-1', qr: { image: 'data:image/png;base64,AAAA' }, expiresAt: Date.now() - 1 },   // 起点即已过本地显示时长
      { ok: true, provider: 'netease', action: 'poll', state: 'waiting' },
      { ok: true, provider: 'netease', action: 'poll', state: 'confirmed', cookie: CONFIRMED_COOKIE },
    ]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    await auth.start();
    assert.equal((await auth.poll()).state, 'waiting', '本地已过：仍在上游问、上游说还活着');
    const late = await auth.poll();
    assert.equal(late.state, 'confirmed', '**迟到的确认被接住**（从前本地到点就停问 ⇒ 晚到的那些永远看不到）');
    assert.equal(JSON.stringify(late).includes(CANARY_COOKIE), false, '确认态的返回值里不许有凭据');
    const stored = JSON.parse(await readFile(join(dataDir, 'online-session', 'netease.json'), 'utf8'));
    assert.equal(stored.cookies.MUSIC_U, `MUSIC_U=${CANARY_COOKIE}`, '确认即落盘（凭据只落在那一个文件里）');
    assert.equal(await auth.pendingSize(), 0);
  });
});

test('桥报回一个不在档内的状态：判 error 并清掉那一轮，不带着脏状态继续', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'netease', loginId: 'uni-1', expiresAt: Date.now() + 175_000, qr: { image: 'data:image/png;base64,AAAA' } },
      { ok: true, provider: 'netease', state: 'already-confirmed-but-spelled-wrong' },
    ]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    await auth.start();
    const odd = await auth.poll();
    assert.equal(odd.state, 'error');
    assert.match(odd.reason, /不在档内/);
    assert.equal(await auth.pendingSize(), 0);
  });
});

test('退出：本机那份一定删；上游登出没确认也要删得掉，并在 reason 里说一句', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    await session.write('netease', sessionModule.jarFromCookieString(CONFIRMED_COOKIE));
    const bridge = makeBridge([{ ok: false, provider: 'netease', reason: '网易后端没就绪' }]);
    const lines = [];
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: (line) => lines.push(line) });
    const out = await auth.logout();
    assert.equal(out.ok, true, '上游失败不许把"退出"变成做不到');
    assert.match(out.reason, /上游登出未确认/);
    assert.equal(await session.exists('netease'), false, '本机那份是真删了');
    const handed = bridge.seen[0].payload;
    assert.equal(handed.cookie, CONFIRMED_COOKIE, '父进程把凭据交给桥是设计里的受保护通道（环回 + 每次 spawn 的令牌）');
    assert.equal(lines.join('\n').includes(CANARY_COOKIE), false, '转述上游失败原因时也不许把凭据带进日志');
    // 再退一次：已经没有登录态，就不该再去打桥。
    const before = bridge.seen.length;
    const twice = await auth.logout();
    assert.equal(twice.ok, true);
    assert.equal(bridge.seen.length, before, '没登录态时退出只是"再确认一次本机没有"，不出网');
  });
});

test('account()：没登录时回答"没登录"且不打桥；登录了才带 Cookie 头去问一次', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([{ ok: true, provider: 'netease', loggedIn: true, nickname: '测试账号' }]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    assert.deepEqual(await auth.account(), { loggedIn: false }, '离线判离线，别去问上游');
    await session.write('netease', sessionModule.jarFromCookieString(CONFIRMED_COOKIE));
    const asked = await auth.account();
    assert.equal(asked.loggedIn, true);
    assert.equal(asked.nickname, '测试账号');
    assert.equal(bridge.seen[0].payload.cookie, CONFIRMED_COOKIE);
    assert.equal(JSON.stringify(asked).includes(CANARY_COOKIE), false, '昵称可以回，凭据不许回');
  });
});

// ── 路由层（§7.1 的运行时半）─────────────────────────────────────────────────
const fakeStore = (dataDir, config) => {
  const store = {
    dataDir,
    config: { version: 1, roots: [], online: { lyrics: true, search: true, streaming: true, covers: true }, onlineEnabled: true, ...config },
    snapshot: () => ({ version: 1, albums: [], genres: [], roots: [], scan: { running: false } }),
    updateConfig: async (value) => { store.config = { ...store.config, ...value }; return store.config },
    trackForOnlineMatch: () => null,
    reloadRules: async () => {},
    scan: async () => ({}),
    scanPromise: null,
  };
  return store;
};

const withServer = async (options, run) => {
  const { createMusicServer } = await import('./music-server.mjs');
  const { server } = await createMusicServer({ distDir: SCRIPTS, autoScan: false, ...options });
  // R190：`listen` 之后直接 `fetch` 会在 Windows 回环端口回收时偶发 `fetch failed`
  //（R189 整跑第 1 轮就在这里红过一次，与 playlist-match / online-search / online-audit 同族）。
  // 探测只重试"连不上"，断言照常红；一处收口，这个文件里所有用例都吃到。
  // R211（A 类第 2 处）：升级 listenAndReady（连不上就关掉这台、换个端口重听）；坏探测抛错时先把这台关干净再抛
  //（临时目录由调用方的 `withTempDir` 收，它自己就是 try/finally）。
  let origin;
  try {
    ({ origin } = await listenAndReady(server));
  } catch (error) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  try { return await run(origin) } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
};

/** 服务端只认 `application/json`（bodyJson 那一道 415），测试别用一个不带类型的 POST 去撞它。 */
const postJson = (origin, path, body = {}) => fetch(`${origin}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('三条登录路由的响应体里都不许出现凭据本体：canary 从假桥一路灌到 HTTP 出口', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const auth = onlineAuthModule.createOnlineAuth({
      log: () => {},
      session,
      bridge: makeBridge([
        { ok: true, provider: 'netease', action: 'start', loginId: 'uni-1', qr: { image: 'data:image/png;base64,AAAA' }, expiresAt: Date.now() + 175_000 },
        { ok: true, provider: 'netease', action: 'poll', state: 'confirmed', cookie: CONFIRMED_COOKIE },
        { ok: true, provider: 'netease', action: 'logout', loggedOut: true },
      ]),
    });
    const store = fakeStore(dataDir);
    const bridgeClient = { status: () => ({ phase: 'ready', port: 9, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), ensure: () => {}, call: async () => ({ ok: false }), shutdown: async () => ({ forced: false }) };
    await withServer({ store, bridgeClient, onlineSession: session, onlineAuth: auth }, async (origin) => {
      const started = await (await postJson(origin, '/api/online/auth/start')).json();
      assert.equal(started.state, 'waiting');
      assert.equal(started.qr.image, 'data:image/png;base64,AAAA');
      assert.equal('loginId' in started, false, '桥给了父进程，父进程不给浏览器');
      const polled = await (await postJson(origin, '/api/online/auth/poll')).json();
      assert.equal(polled.state, 'confirmed');
      // 反向证明"上面那几条没有 是真的没有"：确认之后凭据确实落在那一个文件里。
      assert.equal((await readFile(join(dataDir, 'online-session', 'netease.json'), 'utf8')).includes(CANARY_COOKIE), true,
        '凭据该落的地方没落，那"响应里没有凭据"就成了空断言')
      const status = await (await fetch(`${origin}/api/online/auth`)).json();
      assert.equal(status.providers.netease.source, 'file', '确认之后 GET 要能读出"本机有登录态"');
      const logged = await (await postJson(origin, '/api/online/auth/logout')).json();
      assert.equal(logged.signedOut, true);
      for (const body of [started, polled, status, logged]) {
        assert.equal(JSON.stringify(body).includes(CANARY_COOKIE), false, '响应体里出现了凭据本体');
      }
      assert.equal(await session.exists('netease'), false, '退出之后那一个文件必须真的不在了');
      // 登录状态那一份 JSON 的键名白名单（§7.1 第二条的运行时半）。
      const allowed = new Set(['providers', 'netease', 'kugou', 'qq', 'source', 'entries', 'updatedAt', 'envConfigured', 'pending', 'pollMs', 'pollMsBy', 'provider', 'state', 'expiresAt'])
      const walk = (value, path = '') => {
        if (value && typeof value === 'object') {
          for (const [key, next] of Object.entries(value)) {
            assert.ok(allowed.has(key), `${path}/${key} 不在登录状态的键名白名单里`)
            walk(next, `${path}/${key}`)
          }
        }
      }
      walk(status)
    });
  });
});

test('关着零暴露：onlineEnabled 一关，四条登录路由全 404 且一次桥都不碰', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    let calls = 0;
    const auth = onlineAuthModule.createOnlineAuth({
      log: () => {}, session,
      bridge: { status: () => ({ phase: 'off' }), call: async () => { calls += 1; return { ok: true } }, ensure: () => {} },
    });
    const store = fakeStore(dataDir, { onlineEnabled: false });
    const bridgeClient = { status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), ensure: () => {}, call: async () => { calls += 1; return { ok: false } }, shutdown: async () => ({ forced: false }) };
    await withServer({ store, bridgeClient, onlineSession: session, onlineAuth: auth }, async (origin) => {
      for (const [method, path] of [['GET', '/api/online/auth'], ['POST', '/api/online/auth/start'], ['POST', '/api/online/auth/poll'], ['POST', '/api/online/auth/logout']]) {
        const response = await fetch(`${origin}${path}`, { method });
        assert.equal(response.status, 404, `${method} ${path} 关掉之后还回 ${response.status}`);
        assert.match((await response.json()).error, /联网功能已关闭/);
      }
      assert.equal(calls, 0);
    });
    // "关着零暴露"要说得出口：连会话分区都不该被建出来（不是只断一句路径字符串）。
    await readdir(session.dir).then(
      (entries) => assert.fail(`关闭状态下竟然建出了会话分区，里面有 ${entries.join(', ') || '（空目录）'}`),
      (error) => assert.equal(error.code, 'ENOENT', `分区不该存在，但报的是 ${error.code}`),
    );
  });
});

test('方法与作用域：GET 打动作口回 405、未知 provider 回 400，两者都不碰桥', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    let calls = 0;
    const auth = onlineAuthModule.createOnlineAuth({ log: () => {}, session, bridge: { call: async () => { calls += 1; return { ok: true } } } });
    const store = fakeStore(dataDir);
    const bridgeClient = { status: () => ({ phase: 'ready', port: 9, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), ensure: () => {}, call: async () => ({ ok: false }), shutdown: async () => ({ forced: false }) };
    await withServer({ store, bridgeClient, onlineSession: session, onlineAuth: auth }, async (origin) => {
      assert.equal((await fetch(`${origin}/api/online/auth/start`)).status, 405, '取码是动作，GET 不该被当成幂等读');
      assert.equal((await fetch(`${origin}/api/online/auth`)).status, 200, '读状态是 GET');
      // 样本原来用的是 'kugou' —— R136 之后它是合法 provider 了，换一个我们确实不支持的名字，
      // 判据本身一个字没放宽。
      const odd = await (await postJson(origin, '/api/online/auth/start', { provider: 'kuwo' })).json();
      assert.match(odd.error, /扫码通道/);
      assert.equal(calls, 0, '参数没过校验就不该碰桥');
      // Task D 之后 qq 是合法 provider（但它的通道在桥里，父进程这一层只认名字）。
      assert.ok(onlineAuthModule.AUTH_PROVIDERS.includes('qq'), 'QQ 的扫码通道已进 provider 表');
      const wrongType = await fetch(`${origin}/api/online/auth/start`, { method: 'POST', body: '{}' });
      assert.equal(wrongType.status, 415, '不带 application/json 的 POST 在门口就被挡（不是等到 provider 校验）');
    });
  });
});

test('GET /auth 一次都不出网；账号信息只在显式 POST /auth/account 时问一次，且不问就不碰桥', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'netease', action: 'status', loggedIn: true, nickname: '测试账号' },
      // 下面"显式再问一次网易"那一问用的第二份应答（假桥是一次消费一条）。
      { ok: true, provider: 'netease', action: 'status', loggedIn: true, nickname: '测试账号' },
    ]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    const store = fakeStore(dataDir);
    const bridgeClient = { status: () => ({ phase: 'ready', port: 9, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), ensure: () => {}, call: async () => ({ ok: false }), shutdown: async () => ({ forced: false }) };
    await withServer({ store, bridgeClient, onlineSession: session, onlineAuth: auth }, async (origin) => {
      const before = bridge.seen.length;
      const polled = await (await fetch(`${origin}/api/online/auth`)).json();
      assert.equal(bridge.seen.length, before, 'GET 状态是本地自省：界面每次轮询都出网去问账号是不可接受的');
      assert.equal(polled.pollMs, 2000, '轮询节奏由服务端给，免得前后端各写一个数字');
      const offline = await (await postJson(origin, '/api/online/auth/account')).json();
      assert.deepEqual(offline, { provider: 'netease', loggedIn: false }, '本机没凭据时如实说没登录，不去问上游');
      assert.equal(bridge.seen.length, before);
      await session.write('netease', sessionModule.jarFromCookieString(CONFIRMED_COOKIE));
      const asked = await (await postJson(origin, '/api/online/auth/account')).json();
      assert.equal(asked.loggedIn, true);
      assert.equal(asked.nickname, '测试账号');
      assert.equal(JSON.stringify(asked).includes(CANARY_COOKIE), false, '账号路由把凭据带回来了');
      assert.equal(bridge.seen.length, before + 1, '问了就该正好问一次');
      // R105：provider 必须真被读。这一路由原来写死 `account()` + `provider:'netease'`，
      // 于是"问 QQ 的账号"会拿到网易的昵称——两家都在面板上时，那是一张贴错名字的头像。
      const qqAsked = await (await postJson(origin, '/api/online/auth/account', { provider: 'qq' })).json();
      assert.equal(qqAsked.provider, 'qq', '响应要回的是被问的那一家');
      assert.equal(qqAsked.loggedIn, false, '本机没有 QQ 会话时不许顺着网易那一份说"已登录"');
      assert.equal('nickname' in qqAsked, false, 'QQ 这一问不许带出网易的昵称');
      assert.equal(bridge.seen.length, before + 1, '问 QQ（本机没会话）也不该多出一次出网');
      const badProvider = await postJson(origin, '/api/online/auth/account', { provider: 'kuwo' });
      assert.equal(badProvider.status, 400, '不在档内的提供方要挡在路由上，不是悄悄按网易去问');
      // 只看状态码会被"另一条路碰巧也回 400"糊过去（变异 R3 第一次就是这么绿的）：
      // 所以要认这句文案——它只有路由上那道 `AUTH_PROVIDERS.includes` 才会说。
      assert.match((await badProvider.json()).error, /不支持的登录提供方/, '要的是路由上那道档内校验，不是碰巧抛出来的 400');
      const explicit = await (await postJson(origin, '/api/online/auth/account', { provider: 'netease' })).json();
      assert.equal(explicit.nickname, '测试账号', '显式问网易仍然要照常答');
      // 关键的一半：**登录态存在时** GET 仍然不许顺手去问账号——界面每 2 秒轮询一次状态，
      // 若 GET 里带上 account 就是每两秒一次出网（变异 C21 验的就是这一条会不会被悄悄改掉）。
      const afterAccount = bridge.seen.length;
      const again = await (await fetch(`${origin}/api/online/auth`)).json();
      assert.equal(again.providers.netease.source, 'file');
      assert.equal(bridge.seen.length, afterAccount, '带着凭据的 GET 也必须零出网');
      assert.equal('account' in again, false, 'GET 的响应里不该出现账号字段：那是另一次出网');
    });
  });
});

// ── 静态半与泄漏面 ──────────────────────────────────────────────────────────
test('静态半（父侧）：登录路由块里不许出现任何把凭据写进响应的形状', async () => {
  const src = await read('music-server.mjs');
  const marker = "if (route === '/api/online/auth'";
  const start = src.indexOf(marker);
  assert.ok(start >= 0, '没找到登录路由（改名了就要同步改这条断言）');
  const next = src.indexOf("if (route === '/api/online/audit')", start);
  const block = src.slice(start, next);
  assert.ok(block.length > 400, '这一块短到不像实现了，断言要空跑了');
  for (const banned of ['setCookie', 'cookieHeaderFor', 'jarFromCookieString', 'session.read']) {
    assert.equal(block.includes(banned), false, `登录路由里出现了 ${banned}：凭据不该从这一层往浏览器走`);
  }
  assert.equal(/writeHead\([^)]*[Cc]ookie/.test(block), false, '登录路由不许自己往响应头写 cookie');
});

test('静态半（桥侧）：auth 模块不写 console、不写盘、不开 withSetCookie（网易这一路凭据在响应体里，不在头里）', async () => {
  const src = await read('bridge/providers/auth.mjs');
  assert.match(src, /本项目自撰/, '桥里的自撰件要带头，免得被当成移植体');
  assert.equal(/console\.(log|error|warn)/.test(src), false, '桥里打日志只有一条路：NDJSON 通道。直接 console 会污染父进程的解析');
  assert.equal(/writeFile|appendFile|createWriteStream|mkdirSync|fs\.mkdir/.test(src), false, '桥不落任何凭据文件（QQ 那份是包自己在注入路径下写，见 Task D）');
  assert.equal(/withSetCookie/.test(src), false, '网易这一档不需要响应头：cookie 在 body 里（实测）。开了这个开关就要说明为什么');
  assert.equal(/axios|require\(\s*['"]@yakult-green-tea/.test(src), false, '包根入口与 axios 都在红线上');
});

test('包的横幅把完整 unikey 打在 stdout，而 stdout 是 NDJSON 通道：非 JSON 行必须被丢弃、不进服务日志', async () => {
  // 一手事实（2026-10-06 探针）：`[INFO] Request Success: [eapi] /login/qr/create?key=<完整 unikey>`
  // 走的是 stdout。父进程那侧"非 JSON 行直接丢"就是今天这个泄漏面不存在的原因，所以按**行为**钉：
  // 喂一条真包会打的横幅 + 一条合法 ready，断言只有后者进得到 log。
  const { createBridgeClient } = await import('./online-bridge-client.mjs');
  const lines = [];
  const child = new EventEmitter();
  const banner = '[INFO] Request Success: [eapi] /login/qr/create?key=6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b&qrimg=true'
  child.stdout = Readable.from([`${banner}\n${JSON.stringify({ evt: 'ready', aggregate: { host: '127.0.0.1', port: 9 }, backends: [] })}\n`], { objectMode: false });
  child.stdout.setEncoding('utf8');
  child.stderr = Readable.from([]);
  child.stdin = { end() {} };
  child.kill = () => true;
  child.unref = () => true;
  const childDir = await mkdtemp(join(tmpdir(), 'm3a-auth-child-'));
  const client = createBridgeClient({
    dataDir: childDir,
    getConfig: () => ({ onlineEnabled: true, online: { lyrics: true, search: true, streaming: true, covers: true } }),
    log: (line) => lines.push(line),
    onAudit: () => {},
    spawnOverride: () => child,
    readyMs: 1500,
  });
  try {
    await client.ensure();
    const text = lines.join('\n');
    assert.equal(text.includes('6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b'), false, '完整 unikey 进了服务日志');
    assert.equal(text.includes('[INFO]'), false, '包的横幅被转述进了服务日志');
  } finally {
    await client.shutdown().catch(() => {});
    // 自检自己也要守"用完即删"：这条以前漏了，跑一次就在临时目录里留一个 m3a-auth-child-*。
    await rm(childDir, { recursive: true, force: true });
  }
});

// ── Task D：QQ 接线四条（guardedFetch 适配器 / MQTT 明示 / 落盘进分区 / 不可用态可读）──────
/** guardedFetch 眼里的"上游"：一个能流式读、能报 set-cookie 的响应替身。 */
const stubUpstream = (payload = '{"code":200}', cookies = []) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = Buffer.from(payload);
    return {
      ok: true, status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(body.length) : null), getSetCookie: () => cookies },
      body: { [Symbol.asyncIterator]: async function * () { yield body } },
    };
  };
  return { impl, calls };
};

/** 自检一律离线：DNS 也走注入（与 check-music-auth.mjs 同一手法）。不打真 DNS 的理由见
 *  check-music-online.mjs 的 PUBLIC_DNS 注释：本机开着 fake-IP 代理时域名会解析到保留段，被地址判据按设计拦下。 */
const PUBLIC_DNS = async () => [{ address: '104.20.71.5', family: 4 }];

test('QQ 的 fetch 适配器只在一次调用内替换全局槽位，并且**不会自己调自己**（递归坑）', async () => {
  const { impl, calls } = stubUpstream('{"code":200,"data":{"unikey":"sealed-1"}}');
  const before = globalThis.fetch;
  globalThis.fetch = impl;                       // 这就是"被换掉之前那份"
  try {
    const result = await qqProvider.withGuardedEgress(async () => {
      const response = await globalThis.fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', { method: 'POST', body: '{}' });
      assert.equal(response.status, 200, '适配器要交回一个像样的 Response，包读的就是这个形状');
      assert.equal((await response.json()).data.unikey, 'sealed-1');
      return response;
    }, { lookup: PUBLIC_DNS });
    assert.ok(result, '调用结果原样带回');
    assert.equal(calls.length, 1, '只出网一次——多于一次（或栈溢出）就是适配器自己调了自己');
    assert.match(calls[0].url, /^https:\/\/u\.y\.qq\.com\//, '真请求是 guardedFetch 发出去的（它已经把字符串升成 URL 并过了预检）');
    // 还原这件事要在**我自己收尾之前**判：否则测试自己的 finally 会把它盖掉（第一版就是这么漏的）。
    assert.equal(globalThis.fetch, impl, '调用一结束槽位就该是"进来之前那一个"，不是等测试自己收尾');
  } finally {
    globalThis.fetch = before;
  }
  assert.equal(globalThis.fetch, before, '调用结束槽位必须还原（永久改写会把桥里所有别的 fetch 都换一条路）');
});

test('适配器抛错时也要还原槽位；白名单外的主机被挡而不是静默发出去', async () => {
  const { impl, calls } = stubUpstream();
  const before = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await assert.rejects(() => qqProvider.withGuardedEgress(async () => {
      await globalThis.fetch('https://ptlogin2.qq.com/cgi-bin/xlogin', { method: 'GET' });
    }), /白名单|ONLINE_TARGET_REJECTED/, '表外主机必须被挡');
    assert.equal(calls.length, 0, '被挡下的请求一个字节都不该发出去');
    assert.equal(globalThis.fetch, impl, '抛错路径也要还原成"进来之前的那一个"（这里是测试装的 impl，不是全局默认）');
    await assert.rejects(() => qqProvider.withGuardedEgress(() => { throw new Error('里面自己炸了') }), /里面自己炸了/);
    assert.equal(globalThis.fetch, impl, '同步抛错同样要还原');
  } finally {
    globalThis.fetch = before;
  }
});

test('P0：并发与嵌套都不许把陈旧适配器留在全局上（网易整条被"仅 https"判死的那一格）', async () => {
  const before = globalThis.fetch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // A 先出、B 后出。旧写法：B 出去时把**自己那份陈旧适配器**写回全局 ⇒ 桥里从此人人过守卫，
    // 连打 127.0.0.1 的环回一跳都被"仅 https"拒掉。这一条就是那个现场的根因。
    const [a, b] = await Promise.all([
      qqProvider.withGuardedEgress(async () => { await sleep(20); return 'A' }),
      qqProvider.withGuardedEgress(async () => { await sleep(60); return 'B' }),
    ]);
    assert.deepEqual([a, b], ['A', 'B'], '两笔都要照常返回自己的结果');
    assert.equal(globalThis.fetch, before, '两笔都出去之后，全局必须是进来之前那一份，不是任何一层的适配器');
    assert.deepEqual(qqProvider.guardedEgressState(), { active: 0, baselined: false }, '计数与基准要成对归零');

    // 反方向那一格也要钉住：**还有一笔在飞时不许还原**，否则剩下的请求就绕过守卫出去了。
    const slow = qqProvider.withGuardedEgress(async () => { await sleep(80); return 'slow' });
    await sleep(10);
    const fast = await qqProvider.withGuardedEgress(async () => { await sleep(5); return 'fast' });
    assert.equal(fast, 'fast');
    assert.notEqual(globalThis.fetch, before, '快的那笔出去时，慢的还在飞 ⇒ 全局不许已经被换回真 fetch');
    assert.equal(qqProvider.guardedEgressState().active, 1, '此刻应当还剩一笔');
    await slow;
    assert.equal(globalThis.fetch, before, '最后一笔出去才还原');
  } finally {
    globalThis.fetch = before;
  }
});

test('P0：嵌套时守卫只跑一遍（现场那条消息里前缀出现两次，就是跑了两遍）', async () => {
  const { impl, calls } = stubUpstream('{"code":200,"data":{}}');
  const before = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    let message = '';
    await qqProvider.withGuardedEgress(() => qqProvider.withGuardedEgress(async () => {
      await globalThis.fetch('https://ptlogin2.qq.com/cgi-bin/xlogin', { method: 'GET' });
    }), { lookup: PUBLIC_DNS }).catch((error) => { message = String(error?.message ?? error) });
    assert.match(message, /白名单/, '表外主机照样要被挡（嵌套不许变成"没人管了"）');
    assert.equal(message.split('ONLINE_TARGET_REJECTED').length - 1, 1, `内部前缀只许出现一次：${message}`);
    assert.equal(calls.length, 0, '被挡下的请求一个字节都不该发出去');
  } finally {
    globalThis.fetch = before;
  }
});

test('set-cookie 必须逐条 append：包那份 cookie jar 读的就是 getSetCookie() 的多条形状', async () => {
  const response = await qqProvider.toWebResponse({
    ok: true, status: 200,
    text: async () => '{"code":803}',
    setCookie: ['A=11111111; Path=/; HttpOnly', 'B=22222222; Max-Age=60'],
  });
  assert.deepEqual(response.headers.getSetCookie(), ['A=11111111; Path=/; HttpOnly', 'B=22222222; Max-Age=60'],
    '粘成一条就把第二个 cookie 弄没了');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, 803);
  const bare = await qqProvider.toWebResponse({ status: 204, text: async () => '不该被带出去' });
  assert.deepEqual(bare.headers.getSetCookie(), [], '上游没发 cookie 时是空数组，不是 undefined');
  assert.equal(bare.status, 204, '204 这类无 body 的状态要原样保住');
  assert.equal(await bare.text(), '', '204 配 body 会让 Response 构造函数直接抛 TypeError（上游真发 204 时就是适配器崩掉）');
});

test('QQ 的档位映射：801/802 不带凭据；803 只从 cookie 串里挑那一个 token 带走', () => {
  assert.deepEqual(qqProvider.qqCheckToState({ code: 801, message: 'waiting for scan' }).state, 'waiting');
  for (const code of [800, 801, 802]) {
    const early = qqProvider.qqCheckToState({ code, cookie: 'ignored-until-confirmed' });
    assert.equal('session' in early, false, `码 ${code} 那一档即便上游回了 cookie 也不许带出去（与网易 801 同一条规矩）`);
  }
  assert.equal(qqProvider.qqCheckToState({ code: 800 }).state, 'expired');
  assert.equal(qqProvider.qqCheckToState({ code: 802 }).state, 'scanned');
  // 确认态的形状是 **2026-10-07 一次真扫码量出来的**（值不入证据，只留键名与长度）：
  //   body = { code:number, message:str(30), cookie:str(535) }
  // 而这个运行时是 `sessionMode:'sealed'`：那串里唯一有用的是 `qqmusic_session` 那一项，
  // 其余字段（上游还挂着别的 cookie）一旦跟着离开桥，就是把凭据的暴露面从"一段会话"放大到"整串"。
  const CANARY = ['cn9F', '3aKq', '7bZt', '2mLd'].join('');   // 拼出来写：这文件自己会被凭据字面量扫描扫
  const noise = ['qm_dfA=1234567890abcdef', 'qqmusic_key=SHOULD_NOT_TRAVEL', 'ptcz=deadbeef'];
  const measuredCookie = `${noise[0]}; ${qqProvider.QQ_AUTH_COOKIE_NAME}=${CANARY}; ${noise[1]}; ${noise[2]}`;
  const confirmed = qqProvider.qqCheckToState({ code: 803, message: 'login success', cookie: measuredCookie });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.session, CANARY, '带走的只许是那一段 token，不多不少');
  for (const leaked of [...noise, 'qqmusic_key', 'qm_dfA', 'ptcz']) {
    assert.equal(String(confirmed.session).includes(leaked.split('=')[0]), false, `确认态把 ${leaked.split('=')[0]} 一起带出去了`);
  }
  const hollow = qqProvider.qqCheckToState({ code: 803, message: 'login success' });
  assert.equal(hollow.ok, false, '说"已确认"却没给 cookie 不算成功——把没拿到的东西写成成功是最坏的一种谎');
  assert.match(hollow.reason, new RegExp(qqProvider.QQ_AUTH_COOKIE_NAME), '失败原因要指到那个字段名：读的人才知道下一步查什么');
  assert.equal(qqProvider.qqCheckToState({ code: 803, cookie: '   ' }).ok, false, '全空白的 cookie 不算凭据');
  assert.equal(qqProvider.qqCheckToState({ code: 803, cookie: 4242 }).ok, false, '不是字符串就不收');
  assert.equal(qqProvider.qqCheckToState({ code: 803, cookie: `${qqProvider.QQ_AUTH_COOKIE_NAME}=  ; a=b` }).ok, false, '有名字但值为空也不算凭据');
  const odd = qqProvider.qqCheckToState({ code: 40000 });
  assert.equal(odd.state, 'error');
  assert.equal(odd.ok, false);
  assert.deepEqual(qqProvider.QQ_LOGIN_CODES && Object.keys(qqProvider.QQ_LOGIN_CODES).sort(), ['800', '801', '802', '803']);
  // 挑 token 那一步的边角：没有 '=' 的段、名字两边带空格、目标在最后一项。
  assert.equal(qqProvider.qqTokenFromCookieString(` junk ; ${qqProvider.QQ_AUTH_COOKIE_NAME} = ${CANARY} `), CANARY, '两侧空格要 trim 掉再比名字');
  assert.equal(qqProvider.qqTokenFromCookieString(undefined), '');
  assert.equal(qqProvider.qqTokenFromCookieString('a=1;b=2'), '');
});

test('R107/R112：账号信息只挑两个能显示的名字——真机量到的 profile 把昵称头像嵌在 info 里', () => {
  // 形状是 **2026-10-07 真扫码后一手量出来的**（值不入证据，只留键名与长度）：
  //   { code:number, profile:{ musicid(10), str_musicid(10), errMsg, identify, info:{32 键}, … } }
  //   昵称在 profile.info.nick，头像在 profile.info.logo，且 logo 上游给的是 **http://**thirdqq.qlogo.cn。
  //   info 里还挂着 phone / email / school / registerIP / city 这些个人字段（本机是空的，但字段在）。
  const CANARY = ['mk9F', '3aKq', '7bZt'].join('');
  const profile = {
    musicid: '123456789', str_musicid: 'u%40abcdef', errMsg: 'OK', identify: 0,
    info: {
      nick: '测试昵称', logo: 'http://thirdqq.qlogo.cn/g?b=oidc&k=ABCDEFG&s=140',
      phone: '13800000000', email: 'someone@example.invalid', school: '某学校',
      registerIP: '10.0.0.1', city: '某市', musickey: CANARY,
    },
  };
  const account = qqProvider.qqProfileToAccount(profile);
  assert.deepEqual(Object.keys(account).sort(), ['avatarUrl', 'nickname'], '只许透传昵称与头像两个名字');
  assert.equal(account.nickname, '测试昵称', '昵称要从 info 里读：只读顶层会返回 loggedIn:true 却一格都不显示');
  assert.equal(account.avatarUrl.startsWith('https://thirdqq.qlogo.cn/'), true, 'http 头像要升 https（实测同主机 https 200 同一张图）');
  const wire = JSON.stringify(account);
  for (const secret of [CANARY, '123456789', 'u%40abcdef', '13800000000', 'someone@example.invalid', '某学校', '10.0.0.1', '某市']) {
    assert.equal(wire.includes(secret), false, `账号响应里出现了不该有的字段值：${secret.slice(0, 4)}…`);
  }
  // 顶层那组名字是包内另一条路径（/login/status 的形状）用的，留着读、不冲突。
  assert.deepEqual(qqProvider.qqProfileToAccount({ nick: '只有顶层昵称', avatarUrl: 'https://example.invalid/a.jpg' }),
    { nickname: '只有顶层昵称', avatarUrl: 'https://example.invalid/a.jpg' });
  assert.equal(Object.keys(qqProvider.qqProfileToAccount({ info: { nick: '' } })).length, 0, '空昵称就不给这个键，不写空串装知道');
  assert.equal(qqProvider.qqProfileToAccount({ info: { logo: 'file:///etc/passwd' } }).avatarUrl, undefined, '升完 https 仍不是 https 的一律不收');
  assert.equal(qqProvider.qqProfileToAccount({ info: { logo: 'https://x/a.jpg' } }).avatarUrl, 'https://x/a.jpg', '本来就是 https 的原样收');
  assert.equal(qqProvider.qqProfileToAccount({ info: { nick: 'x'.repeat(200) } }).nickname.length, 60, '上游给多长都要截住');
  assert.deepEqual(qqProvider.qqProfileToAccount(undefined), {}, '没有 profile 就是空对象，不抛');
});

test('QQ 的实测响应形状：unikey 在 data.unikey、图片在 data.qrimg（735 / 610 字节那两个数）', () => {
  const keyed = qqProvider.qqKeyToSealed({ code: 200, data: { unikey: 'qq1.' + 'x'.repeat(730) } });
  assert.equal(keyed.ok, true);
  // R215：这条从前是逐毫秒相等比较 —— `expiresAt` 内部取一次 Date.now()、这里又取一次，跨 1ms 边界偶发 174999
  //（R215 整跑 #2 踩到、同一棵树 #1 侥幸全绿）。改成 ±2ms 容差：**TTL 语义（175 秒）一字未动**，消掉的是采样竞态。
  assert.ok(Math.abs((keyed.expiresAt - Date.now()) - qqProvider.QQ_QR_TTL_MS) <= 2, 'TTL 由桥算：实测上游 179.8 秒，取 175 秒');
  assert.equal(qqProvider.QQ_QR_TTL_MS, 175_000);
  assert.equal(qqProvider.qqKeyToSealed({ code: 500 }).ok, false, '没有 unikey 就说没有，不返回半个值');
  const created = qqProvider.qqCreateToQr({ code: 200, data: { qrimg: 'data:image/png;base64,AAAA' } });
  assert.equal(created.ok, true);
  assert.equal(created.qr.image, 'data:image/png;base64,AAAA', '图片原样给父进程，界面直接喂 <img>');
  assert.equal(qqProvider.qqCreateToQr({ code: 200, data: { qrimg: 'https://x/qr.png' } }).ok, false,
    '不是 data URI 就报错：把 URL 当图片喂给 <img> 是另一种坏法');
});

test('MQTT 长连不许沉默存在：建立与关闭各记一笔 auth-mqtt，且不带 qrcodeId 与路径', async () => {
  const rows = [];
  const opened = [];
  class FakeSocket {
    constructor(url, protocol) {
      this.url = url; this.protocol = protocol; this.sent = []; opened.push({ url, protocol });
      // 真 socket 的 open 是异步事件；替身也必须异步，否则 connect 会永远等在微任务里。
      setTimeout(() => this.listeners?.open?.(), 0);
    }
    addEventListener(name, fn) { (this.listeners ??= {})[name] = fn }
    send(data) { this.sent.push(data) }
    close() { this.listeners?.close?.() }
  }
  const connect = qqProvider.nodeMqttConnect({
    emit: (event) => rows.push(event),
    WebSocketImpl: FakeSocket,
  });
  const socket = await connect('wss://mu.y.qq.com/mqtt?qrcodeId=SECRET-ID-DO-NOT-LOG', 'mqtt', { message() {}, close() {}, error() {} });
  // 包的注释：CONNECT 一 resolve 就发。所以 open 之后必须真的能 send。
  socket.send(Buffer.from([1, 2, 3]));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].protocol, 'mqtt', '子协议要原样交出去，MQTT 连不上多半就是它丢了');
  const first = rows[0];
  assert.equal(first.kind, 'auth-mqtt', 'WSS 不是 https，guardedFetch 管不到它 ⇒ 单独一档，不许沉默');
  assert.equal(first.host, 'mu.y.qq.com');
  assert.equal(JSON.stringify(first).includes('SECRET-ID-DO-NOT-LOG'), false, '记账里不许出现 qrcodeId');
  assert.equal(JSON.stringify(first).includes('?'), false, '也不许带查询串');
  socket.close();
  assert.equal(rows.length, 2, '关掉也要记一笔：只记开不记关，面板上就看不出连接还在不在');
  assert.equal(rows[1].kind, 'auth-mqtt');
  assert.ok(rows[1].ms >= 0);
});

test('relay 等 ready（包的注释：SUBACK 之前订阅没生效，早发的事件不会重放）；连不上时报"通道坏了"而不是"没人扫"', async () => {
  const readyCalls = [];
  const listenFactory = (connect) => (qrcodeId, onEvent, timeoutMs) => {
    readyCalls.push({ qrcodeId, timeoutMs });
    return { ready: Promise.reject(new Error('SUBACK 没等到')), close: async () => {} };
  };
  const lines = [];
  const relay = qqProvider.createQqRelay({ emit: () => {}, log: (line) => lines.push(line), listenFactory });
  await relay.open('qr-1', 'data:image/png;base64,AAAA', 175_000);
  assert.equal(readyCalls.length, 1, 'open 里就要把 listener 起起来并等 ready');
  assert.ok(lines.some((line) => /长连接没建立/.test(line)), '连不上要留一行说得清的话');
  assert.deepEqual(await relay.poll('qr-1'), [], '连不上时 poll 回空数组：这是"通道坏了"，不是"没人扫"');
  assert.equal(relay.snapshot()[0].state, 'unavailable');
  assert.equal(await relay.image('qr-1'), 'data:image/png;base64,AAAA', '图片从 relay 走（实测 open 收到的就是它）');
  await relay.close('qr-1');
  assert.deepEqual(relay.snapshot(), [], '关掉之后不留状态：留着就是一张没人再看的僵尸会话表');
});

test('桥的 QQ 动作处理器：缺密钥 / 缺句柄 / 未知动作三档都可读且零出网', async () => {
  const calls = [];
  const handleRequestImpl = async (request) => { calls.push(request.url); return new Response('{"code":200}', { status: 200 }) };
  const handler = qqProvider.createQqAuthHandler({ handleRequestImpl, listenFactory: () => () => ({ ready: Promise.resolve(), close: async () => {} }) });
  assert.equal((await handler({ action: 'start' })).ok, false, '没密钥就别出网（包会直接回 501，我们提前拒更清楚）');
  assert.equal((await handler({ action: 'poll', secret: 'x' })).ok, false, '缺句柄的轮询是无效请求');
  assert.equal((await handler({ action: 'nope', secret: 'x', loginId: 'k' })).ok, false, '动作白名单');
  assert.equal(calls.length, 0, '以上三档都必须在前门就被拒，一次上游都不碰');
  const started = await handler({ action: 'channels', secret: 'abcdefghijklmnopqrstuvwxyz' });
  assert.equal(started.ok, true);
  assert.equal(calls.length, 1, '过了校验才真打');
  assert.equal(calls[0].startsWith('https://online-local/login/channels'), true, '只走本地那层 handleRequest');
  const hollow = await handler({ action: 'start', secret: 'abcdefghijklmnopqrstuvwxyz' });
  assert.equal(hollow.ok, false, '上游回了 200 但没有句柄，也不算成功');
  assert.match(hollow.reason, /没有返回登录句柄/);
});

test('R107：QQ 账号这一路——token 只走请求头、profile 只透传昵称头像、本机没会话就零出网', async () => {
  const TOKEN = ['TK', '9f3a', 'Kq7b', 'Zt2m'].join('');
  const MUSICKEY = ['MK', '1b2c', '3d4e', '5f6a'].join('');
  const seen = [];
  const handler = qqProvider.createQqAuthHandler({
    handleRequestImpl: async (request) => {
      seen.push({
        url: request.url,
        header: request.headers.get(qqProvider.QQ_AUTH_HEADER_NAME),
        cookieHeader: request.headers.get('cookie'),
      });
      return new Response(JSON.stringify({ code: 200, profile: { nickname: '测试昵称', musickey: MUSICKEY, avatarUrl: 'https://example.invalid/a.jpg' } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const out = await handler({ action: 'account', secret: 'abcdefghijklmnopqrstuvwxyz', token: TOKEN });
  assert.equal(out.ok, true);
  assert.equal(out.loggedIn, true);
  assert.equal(out.nickname, '测试昵称');
  assert.equal(out.avatarUrl, 'https://example.invalid/a.jpg');
  assert.equal(JSON.stringify(out).includes(MUSICKEY), false, 'profile 里的 musickey 是凭据，不许跟着响应离开桥');
  assert.equal(JSON.stringify(out).includes(TOKEN), false, '我们带过去的 token 也不许被回显出来');
  assert.equal(seen[0].header, TOKEN, '会话必须走 x-qq-session 头（这个运行时里它优先级最高）');
  assert.equal(seen[0].url.includes(TOKEN), false, '绝不进 URL：那会落进包自己的访问日志行');
  assert.equal(seen[0].cookieHeader, null, '也不借 Cookie 头混着走——一条路只留一个位置，免得两处各写一半');
  const offline = await handler({ action: 'account', secret: 'abcdefghijklmnopqrstuvwxyz' });
  assert.equal(offline.ok, true);
  assert.equal(offline.loggedIn, false, '本机没有会话就说没有，不拿"问不到"糊成"没登录"以外的 anything');
  assert.equal(seen.length, 1, '没 token 时一次都不该出网');
  // 上游不认这段 token（401）⇒ 判"没登录"，不是"出错了"：用户看到的应该是"请重新扫码"。
  const rejected = qqProvider.createQqAuthHandler({
    handleRequestImpl: async () => new Response('{"code":401,"message":"login required"}', { status: 401, headers: { 'content-type': 'application/json' } }),
  });
  const stale = await rejected({ action: 'account', secret: 'abcdefghijklmnopqrstuvwxyz', token: TOKEN });
  assert.equal(stale.ok, true);
  assert.equal(stale.loggedIn, false, 'token 过期/被撤销 = 没登录，这一档不该报错');
});

test('R107：QQ 会话的落盘者仍然只有一个——桥不自构路径、不写盘，token 唯一来源是父进程注入', async () => {
  const bridgeText = await readFile(new URL('./bridge/providers/qq-auth.mjs', import.meta.url), 'utf8');
  // 为什么这条要钉住：2026-10-07 曾按"包侧密封仓库（QQ_AUTH_SESSION_PATH）"下过一次实施指令，
  // 而一手读码证伪了它——`configureAuthSessionPersistence()` 只在根入口 `app.js` 里调用，
  // 我们永远只 require `/serverless` 与 `/mqtt`，那条路是 `sessionMode:'sealed'`（包不写盘）。
  // 若哪天有人照那个错误前提"接回去"，最坏的结果不是没生效，而是**两处各存一份凭据、各自过期**。
  // 变量名拼出来写：禁词原文只准活在文档与日志里，可执行代码（含自检）一律拼名——
  // 这条纪律不是形式主义，它下面第 5 行的断言恰好证明了：一旦有人在桥里写死它，全仓扫描就该亮。
  const packageSessionPathEnv = ['QQ_AUTH', '_SESSION', '_PATH'].join('');
  assert.equal(bridgeText.includes(packageSessionPathEnv), false, '桥不许读/写包侧会话仓库的路径变量');
  assert.doesNotMatch(bridgeText, /writeFile|appendFile|createWriteStream|mkdir/, '桥在这条路上不落任何盘');
  assert.doesNotMatch(bridgeText, /path\.(join|resolve)\([^)]*(?:session|Session|auth)/, '桥不许自构会话文件路径');
  assert.match(bridgeText, /typeof payload\.token === 'string' \? payload\.token\.trim\(\)/, 'token 的唯一来源是父进程 payload');
  // 父进程这一侧：QQ 那份凭据的读写口只有 online-session 的 sealed 那一组，且它落在分区目录里。
  const sessionText = await readFile(new URL('./online-session.mjs', import.meta.url), 'utf8');
  assert.match(sessionText, /const writeSealed = async \(provider, session\)/, '密封记录的唯一写手在这里');
  assert.match(sessionText, /fileFor\('qq'\)/, '路径由 fileFor 统一算，别处不另拼一份');
  const authText = await readFile(new URL('./online-auth.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(authText, /readFile\([^)]*qq-auth/, '父进程不读包写的东西（这条路上根本没有那样东西）');
  assert.match(authText, /await session\.writeSealed\('qq', result\.session\)/, '确认态落盘只此一处');
});

test('R108：桥的 QQ 登录取流——地址表按 songmid 认、空 url 说实话、没会话在门口就拒（不许悄悄替它匿名）', async () => {
  const answers = [];
  const calls = [];
  const handleRequestImpl = async (request) => {
    calls.push({
      url: request.url,
      sessionHeader: request.headers.get(qqProvider.QQ_AUTH_HEADER_NAME),
      cookieHeader: request.headers.get('cookie'),
    });
    const answer = answers.shift() ?? {};
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  const handler = qqProvider.createQqAuthHandler({ handleRequestImpl, listenFactory: () => () => ({ ready: Promise.resolve(), close: async () => {} }) });
  const SECRET = 'abcdefghijklmnopqrstuvwxyz';
  const MID = '0021m4EZ2aVqcZ';
  // ① 本机没有会话 ⇒ 门口就拒，一次都不出网。account 那一档可以"没会话=没登录"，这里不行：
  //    调用方要的是**带权益的地址**，桥自己降级成匿名再回一个"没有"，就是把降级藏进了没人看得见的地方。
  const noToken = await handler({ action: 'play', secret: SECRET, songmid: MID });
  assert.equal(noToken.ok, false);
  assert.match(noToken.reason, /本机没有 QQ 会话/);
  assert.equal(calls.length, 0, '没登录态时一次都不该出网');
  assert.equal((await handler({ action: 'play', secret: SECRET, token: 'tok', songmid: 'bad mid!' })).ok, false, 'songmid 形状不合就别打');
  assert.equal((await handler({ action: 'play', secret: SECRET, token: 'tok', songmid: MID, quality: 'flac999' })).ok, false, '包对未知的 quality 会静默按 128 处理 ⇒ 我们这一侧先拒');
  assert.equal(calls.length, 0, '以上三档都没出网');
  // ② 正常一档：地址原样带回（升 https 与主机白名单是父进程出口那道关，桥不重算一遍，免得两处判据漂）。
  answers.push({ body: { code: 200, data: { playUrl: { [MID]: { url: 'http://aqqmusic.tc.qq.com/m800' + MID + '.mp3', error: false } } } } });
  const ok = await handler({ action: 'play', secret: SECRET, token: 'qq-token-1', songmid: MID, mediaMid: '0033abcd' });
  assert.equal(ok.ok, true);
  assert.equal(ok.url, 'http://aqqmusic.tc.qq.com/m800' + MID + '.mp3');
  assert.equal(ok.provider, 'qq');
  assert.equal(calls[0].url.startsWith('https://online-local/getMusicPlay/' + MID + '?'), true, '路径按包的路由表：/getMusicPlay/:songmid?');
  assert.match(calls[0].url, /quality=320/, '父进程没送档位时缺省 320（这是"只试一次"那一条决定下的唯一档）');
  assert.match(calls[0].url, /mediaId=0033abcd/, 'mediaMid 要带上：只送一段文件名 vkey 会给 purl 而 CDN 端 403');
  assert.equal(calls[0].sessionHeader, 'qq-token-1', '会话走 x-qq-session 请求头（这个运行时里它优先级最高）');
  assert.equal(calls[0].url.includes('qq-token-1'), false, '绝不进 URL');
  assert.equal(calls[0].cookieHeader, null, '也不借 Cookie 头混着走');
  // ③ 上游说"这首没有可播文件"：这是**权益事实**，不是错误；文案要说清是这首没给，不是通道坏了。
  answers.push({ body: { code: 200, data: { playUrl: { [MID]: { url: '', error: '暂无播放链接' } } } } });
  const empty = await handler({ action: 'play', secret: SECRET, token: 't', songmid: MID });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /没有可播文件/);
  assert.match(empty.reason, /权益/);
  // ④ 401 = 这段 token 不认了 ⇒ 单独标出来（父进程据此能提示"要重新扫码"，而不是"桥坏了"）。
  answers.push({ status: 401, body: { code: 401 } });
  const stale = await handler({ action: 'play', secret: SECRET, token: 't', songmid: MID });
  assert.equal(stale.ok, false);
  assert.equal(stale.reauth, true, '401 要能被认出来：它的意思是"重新扫码"，不是"等一等"');
  // ⑤ 地址表认不出我们要的那条、且不止一条 ⇒ 拒。"取第一条"听起来无害，实际可能把**别人的歌**放给我们听。
  answers.push({ body: { data: { playUrl: { other1: { url: 'https://x/a.mp3' }, other2: { url: 'https://x/b.mp3' } } } } });
  assert.equal((await handler({ action: 'play', secret: SECRET, token: 't', songmid: MID })).ok, false, '两条都对不上名字时不许猜一条');
  // ⑥ 表里只有一条时按那条走（我们只送了一个 songmid，回来的键名偶尔与送的不逐字相等）。
  answers.push({ body: { data: { playUrl: { '0021M4EZ2A1Ll2': { url: 'https://y.gtimg.cn/n/a.m4a' } } } } });
  assert.equal((await handler({ action: 'play', secret: SECRET, token: 't', songmid: MID })).ok, true, '单条时容忍键名的大小写/形态差异：这首确实就是那一首');
});

test('R108：QQ 退出真打一次上游 /logout，但文案只承诺本机那一步（sealed 模式下没有可撤销的东西）', async () => {
  const calls = [];
  const handleRequestImpl = async (request) => {
    calls.push({ url: request.url, sessionHeader: request.headers.get(qqProvider.QQ_AUTH_HEADER_NAME) });
    return new Response('{"code":200}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const handler = qqProvider.createQqAuthHandler({ handleRequestImpl, listenFactory: () => () => ({ ready: Promise.resolve(), close: async () => {} }) });
  const out = await handler({ action: 'logout', secret: 'abcdefghijklmnopqrstuvwxyz', token: 'tok-1' });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1, '上游那一跳要打（R105 曾判成"没有登出端点"，读码纠正）');
  assert.equal(calls[0].url, 'https://online-local/logout');
  assert.equal(calls[0].sessionHeader, 'tok-1');
  // 没 token ⇒ 不打上游，但**登出这一事实仍然成立**（本机没东西可删）。
  const nothing = await handler({ action: 'logout', secret: 'abcdefghijklmnopqrstuvwxyz' });
  assert.equal(nothing.ok, true);
  assert.equal(nothing.signedOut, true);
  assert.equal(calls.length, 1, '没有会话时这一档零出网');
  // 上游坏了不拦本机那一步：这里的 ok:false 只会被父进程转成"上游没确认"的一行实话。
  const broken = qqProvider.createQqAuthHandler({ handleRequestImpl: async () => { throw new Error('boom') } });
  assert.equal((await broken({ action: 'logout', secret: 'abcdefghijklmnopqrstuvwxyz', token: 't' })).ok, false);
});

test('R108：装配那一行的凭据门——QQ 读密封记录、本机没会话就不去要密钥、网易仍走 jar', async () => {
  // 这一段是**装配**的形状，不是能力的能力：解析器有注入口不等于服务端真的接上了凭据门
  // （M3-a 的 D19 与 R103 的 TDZ 都是"能力在、没接上"这一类，离线断言当时全绿）。
  const wired = await read('music-server.mjs');
  // R159（任务六）把这份凭据门从 `createAudioSourceResolver({ credentialsFor: async … })` 的**内联**
  // 抽成了一个具名函数（账号歌单是第二个消费者，抄第二份就会漂）。原来那条判据钉的是内联那行文本，
  // 抽出去之后把一次正常重构判成回归（本仓记过的那类"钉写法不钉不变式"，这是第四例）。
  // 现在判的是两件事：① 这份门**存在**（内联或具名都算）；② 它**真的接进了**解析器——
  // 这一条才是这个测试存在的理由（"能力在、没接上"，M3-a D19 / R103 TDZ 同一类）。
  assert.match(wired, /credentialsFor: async \(provider\) =>|const credentialsFor = async \(provider\) =>/,
    '音源解析器的凭据门必须在装配处接上');
  const resolverCall = /createAudioSourceResolver\(\{([\s\S]{0,400}?)\n  \}\)/.exec(wired)?.[1] ?? '';
  assert.ok(resolverCall, '解析器那个构造还在（下面那条"接上了"的判据不能空转）');
  assert.match(resolverCall, /credentialsFor[,:]/, '凭据门确实传给了 createAudioSourceResolver（抽成具名函数之后更要钉这一格）');
  // 门本身的三条性质圈在**它的函数体里**判（整文件判会被注释与别处满足）
  const gateBlock = /const credentialsFor = async \(provider\) => \{([\s\S]*?)\n  \}/.exec(wired)?.[1]
    ?? /credentialsFor: async \(provider\) => \{([\s\S]*?)\n    \}/.exec(wired)?.[1] ?? '';
  assert.ok(gateBlock, '凭据门那份函数体取到了');
  assert.match(gateBlock, /cookieHeaderFor\(\(await onlineSession\.read\(provider\)\)\.jar\)/, '网易那一份仍然取自会话分区的 jar（改门不该把老的一条改断）');
  assert.match(gateBlock, /await onlineSession\.readSealed\('qq'\)/, 'QQ 那一份读的是密封记录，不是 jar');
  assert.ok(gateBlock.indexOf("readSealed('qq')") >= 0 && gateBlock.indexOf("secretFor('qq')") >= 0
    && gateBlock.indexOf("readSealed('qq')") < gateBlock.indexOf("secretFor('qq')"),
    '先确认本机有会话，再去要密钥：secretFor 在没有的那一档会**新生成一份并落盘**，'
    + '让"随手播一首 QQ 歌"顺手写出一个密钥文件是不该发生的副作用');
  assert.match(gateBlock, /if \(!sealed\.session\) return \{\}/, '没会话就返回空：不发起那一问');
  assert.doesNotMatch(wired, /cookieFor:/, '旧的单家凭据门不许留在装配里（留着就是两处各写一半）');
});

test('④ 不可用态：501 说密钥、502 先怀疑装配、白名单被拒要说"不在出网白名单"，三档都可读且标可重试性', () => {
  assert.match(qqProvider.qqUnavailable({ httpStatus: 501, message: 'no secret' }).reason, /会话密钥/);
  const badGateway = qqProvider.qqUnavailable({ httpStatus: 502, message: 'Unable to start QR login' });
  assert.equal(badGateway.retryable, true, '502 加固定 retryAfter 多半是装配问题 ⇒ 必须可重试，不能写成平台不支持');
  assert.match(badGateway.reason, /装配/);
  const blocked = qqProvider.qqUnavailable(new Error('ONLINE_TARGET_REJECTED: 主机不在本次用途的在线白名单：x'));
  assert.match(blocked.reason, /白名单/);
  assert.equal(qqProvider.qqUnavailable(new Error('')).retryable, true, '认不出的错默认按可重试处理：一次网络抖动不该被写成"QQ 不行"');
});

test('父进程走 QQ 那一路：密钥经"环回 + 令牌"传给桥，确认态写 sealed 记录，两家可以各有一张码在扫', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'qq', action: 'start', loginId: 'sealed-key-1', qr: { image: 'data:image/png;base64,AAAA' }, expiresAt: Date.now() + 175_000 },
      { ok: true, provider: 'netease', action: 'start', loginId: 'uni-1', qr: { image: 'data:image/png;base64,BBBB' }, expiresAt: Date.now() + 175_000 },
      { ok: true, provider: 'qq', action: 'poll', state: 'confirmed', session: 'sealed-session-blob' },
      { ok: true, provider: 'qq', action: 'logout', signedOut: true, upstreamStatus: 200 },
    ]);
    const lines = [];
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: (line) => lines.push(line) });
    const qqStarted = await auth.start('qq');
    assert.equal(qqStarted.state, 'waiting');
    assert.equal(bridge.seen[0].payload.provider, 'qq');
    assert.equal(typeof bridge.seen[0].payload.secret, 'string', '密钥由父进程带来（包没它就回 501）');
    assert.equal(bridge.seen[0].payload.secret.length >= 16, true, '生成出来的密钥够长');
    await auth.start('netease');
    const status = await auth.status();
    assert.deepEqual(status.pending.map((row) => row.provider), ['netease', 'qq'],
      'pending 是数组：两家同时在扫时，单值形状会把第一家的状态悄悄盖掉');
    const confirmed = await auth.poll('qq');
    assert.deepEqual(confirmed, { state: 'confirmed' }, '返回值里不许有会话密文');
    const stored = JSON.parse(await readFile(join(dataDir, 'online-session', 'qq-auth.json'), 'utf8'));
    assert.equal(stored.sealed, true, 'QQ 那一份落盘要带 sealed 标记：它不是 cookie jar');
    assert.equal(stored.session, 'sealed-session-blob');
    assert.equal(lines.join('\n').includes('sealed-session-blob'), false, '服务日志里不许出现会话密文');
    assert.equal(lines.join('\n').includes('sealed-key-1'), false, '登录句柄也不许进日志');
    const out = await auth.logout('qq');
    assert.equal(out.ok, true);
    // 2026-10-07 读码纠正：`/logout` 确实在路由表里（R105 当时只看 channels advertise 的六项，判成"没有"）。
    // 但它撤销不了已经签发的 token ⇒ 文案只能说"本机那份删了"，不许写成"上游已撤销"。
    assert.match(out.reason, /上游没有可撤销的东西/, '本机删了就说删了；这种会话模式下没有"服务端撤销"这回事，别假装做得更多');
    const lastCall = bridge.seen[bridge.seen.length - 1];
    assert.equal(lastCall.payload.action, 'logout', '退出要先打一次上游（告知 + 清掉在扫的那一轮），不是只删本机');
    assert.equal(lastCall.payload.token, 'sealed-session-blob', '登出这一问带的就是本机那一段密封会话');
    assert.equal(typeof lastCall.payload.secret, 'string', '带 token 也要带密钥：包没密钥时所有登录路由直接回 501');
    assert.equal(await session.exists('qq'), false);
  });
});

test('R107：桥重启后 QQ 登录态还在——新会话实例读本机密封记录，token 与密钥一起交桥，回来不回显', async () => {
  await withTempDir(async (dataDir) => {
    // 这一条是"接包侧密封仓库"这条指令的**真实目的**：桥每次重启都不该掉登录。
    // 做法不是让包去写盘（那个运行时根本不写盘），而是父进程把 token 存进分区、
    // 重启后读出来、连同密钥一起交给桥——所以这里换一个新的 createOnlineSession 实例来代表重启。
    const QQ_CANARY = ['qS7t', 'kLm2', 'Zx9p', '4Rbv', 'cN3w'].join('');
    const before = sessionModule.createOnlineSession({ dataDir });
    await before.writeSealed('qq', QQ_CANARY);
    const restarted = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'qq', action: 'account', loggedIn: true, nickname: '重启后仍在线', avatarUrl: 'https://example.invalid/a.jpg' },
    ]);
    const lines = [];
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session: restarted, log: (line) => lines.push(line) });
    const asked = await auth.account('qq');
    assert.equal(asked.loggedIn, true, '扫码换来的登录态必须活过重启：这一条红了就是"每次重启都要重扫"回来了');
    assert.equal(asked.nickname, '重启后仍在线');
    assert.equal(bridge.seen.length, 1);
    assert.equal(bridge.seen[0].payload.action, 'account');
    assert.equal(bridge.seen[0].payload.token, QQ_CANARY, 'token 的唯一来源是父进程从分区里读出来的那一份');
    assert.equal(typeof bridge.seen[0].payload.secret, 'string', '密封密钥同批交给桥（包没它就回 501）');
    assert.equal(JSON.stringify(asked).includes(QQ_CANARY), false, '回来的响应不许把 token 带出桥');
    assert.equal(lines.join('\n').includes(QQ_CANARY), false, '服务日志里不许出现 token');
  });
  // 成对的另一半：本机没有会话时判"没登录"要**零出网**——"是谁"才问上游，"有没有"读本机。
  await withTempDir(async (emptyDir) => {
    const emptyBridge = makeBridge([]);
    const nobody = await onlineAuthModule
      .createOnlineAuth({ bridge: emptyBridge, session: sessionModule.createOnlineSession({ dataDir: emptyDir }), log: () => {} })
      .account('qq');
    assert.deepEqual(nobody, { loggedIn: false });
    assert.equal(emptyBridge.seen.length, 0, '没登录态却去问上游，是拿一次出网换一个"没有"');
  });
});

test('secretFor：env 先于磁盘；没有就生成一份落进分区（0600）并留下一行诚实的说明', async () => {
  await withTempDir(async (dataDir) => {
    const lines = [];
    const generated = sessionModule.createOnlineSession({ dataDir, log: (line) => lines.push(line) });
    const first = await generated.secretFor('qq');
    assert.equal(first.source, 'generated');
    assert.ok(first.secret.length >= 32, '随机密钥长度不够就是给自己造一个可猜的锁');
    const keyFile = join(dataDir, 'online-session', 'qq-session-key.json');
    const info = await readFile(keyFile, 'utf8');
    assert.ok(info.includes(first.secret), '密钥要真的落在那一个文件里');
    assert.ok(lines.some((line) => /新生成的分区内密钥文件/.test(line)), '生成这件事要说出来');
    const again = await generated.secretFor('qq');
    assert.equal(again.secret, first.secret, '第二次读的是同一份：每次新生成等于每次重启都丢登录');
    assert.ok(lines.some((line) => /密钥与密文同目录|同目录/.test(line)) || lines.some((line) => /分区内密钥文件/.test(line)),
      '这份文件的性质要说出口：它挡不住能读这个用户文件的攻击者（设计稿 §5.2 的诚实登记）');
    const fromEnv = sessionModule.createOnlineSession({ dataDir, env: { [sessionModule.QQ_SECRET_ENV_KEY]: 'env-supplied-secret-value-1234567890' } });
    assert.equal((await fromEnv.secretFor('qq')).source, 'env', 'env 设了就必须按 env 算');
    await assert.rejects(() => generated.secretFor('netease'), /没有需要单独保管的密封密钥/);
  });
});

test('桥转发的 via=guard 记录父进程一个字都不改写（429 不许被写成 200）；note 行进日志前过脱敏', async () => {
  const rows = [];
  const { recordBridgeAudit } = await import('./music-server.mjs');
  recordBridgeAudit({ evt: 'audit', via: 'guard', host: 'u.y.qq.com', kind: 'auth', status: 429, bytes: 0, ms: 12 }, (row) => rows.push(row));
  assert.deepEqual(rows[0], { host: 'u.y.qq.com', kind: 'auth', status: 429, bytes: 0, ms: 12, via: 'guard' },
    'guard 那一路的行必须原样入库：把一次 429 改写成 200 就是把审计做成广告');
  recordBridgeAudit({ evt: 'audit', via: 'backend', kind: '/bridge/auth', host: 'qq', ok: false, ms: 30 }, (row) => rows.push(row));
  assert.equal(rows[1].via, 'backend');
  assert.equal(rows[1].status, 0, 'backend 那一路只有"成/没成"这个事实，不许编状态码');
  assert.equal(rows[1].host, 'qq');
  recordBridgeAudit({ evt: 'audit', kind: '/bridge/lyrics', ok: true }, (row) => rows.push(row));
  assert.equal(rows[2].host, 'online-bridge', '路由没报 provider 时归到 online-bridge，不留空主机');
  // 光测 `session.redact` 的能力不够：装配那一行没接上，能力就永远不被调用（变异 D19 就是这么溜过去的）。
  const wired = await read('music-server.mjs');
  assert.match(wired, /onNote:\s*\(line\)\s*=>\s*console\.log\(onlineSession\.redact\(line\)\)/,
    '桥的 note 必须在装配处过一层脱敏，不许 console.log(line) 直接打');
  assert.ok(wired.indexOf('const onlineSession =') < wired.indexOf('const bridge = providedBridge'),
    'session 必须建在桥之前：否则 onNote 闭包里引用的还是个没赋值的量（装配顺序错了不会自己报错，只会运行时炸）');
  // note 的脱敏在父进程这一侧：桥不知道凭据长什么样。
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const oneCookie = `MUSIC_U=${CANARY_COOKIE}`;      // CANARY_COOKIE 是"值"，键名要自己拼（第一版漏了，jar 就成了空的）
    await session.write('netease', sessionModule.jarFromCookieString(oneCookie));
    const printed = [];
    const original = console.log;
    console.log = (...args) => printed.push(args.join(' '));
    try {
      console.log(session.redact(`桥里冒出来一句：${oneCookie} 被回显了`));
      console.log(session.redact(`更狠的是只回显值本身：${CANARY_COOKIE}`));
    } finally { console.log = original }
    const text = printed.join('\n');
    assert.equal(text.includes(CANARY_COOKIE), false, 'note 进日志时凭据本体没被遮住');
    assert.ok(text.includes('[已脱敏]'), '遮了要看得出来是遮了，不是整行被丢');
  });
});

// ── R136：酷狗那一路（第三家）。凭据形状与网易同类（cookie 对），通道形状不同（进程内直调包）──
// 一手实测的形状都写进了 providers/kugou-auth.mjs 的文件头；这里的夹具照那份形状造，
// 但**判据落在行为上**：档位映射、字段白名单、调用序列、出不出网。

const KUGOU_CANARY = 'kt-7Q' + 'mZx3Lb9Nc4Rt8Yw2';        // canary：酷狗的 token
const KUGOU_UID = '9988776655';                        // canary：userid 也算身份标识，一并盯
const kugouKeyEnvelope = (qrcode = 'k'.repeat(36)) => ({
  status: 200, body: { data: { qrcode, qrcode_img: 'data:image/png;base64,UPSTREAM', status: 1, error_code: 0 }, cookie: [], headers: {} },
});
/** 假后端：记下每一次 `invoke` 的 operation 与参数（调用序列本身就是判据）。 */
const makeKugouBackend = (answers, options = {}) => {
  const calls = [];
  const backend = {
    calls,
    kugou: {
      state: options.ready === false ? 'error' : 'ready',
      invoke: async (operation, params) => {
        calls.push({ operation, params });
        const answer = answers?.[operation];
        if (answer instanceof Error) throw answer;
        if (typeof answer === 'function') return answer(params);
        return answer ?? { status: 200, body: { data: {} } };
      },
    },
  };
  return backend;
};
const kugouHandler = (backend) => kugouProvider.createKugouAuthHandler({ backends: backend, now: () => 1_800_000_000_000 });

test('R136 二维码有效期这一格用的是**量出来的下界**，不是抄网易那个数', () => {
  // 一手量测：一张码以 5 秒节奏问满 60 次 / 跨 300 秒，全部 HTTP 200 且 status:1（没见到 0）。
  // 所以 300 秒以内说"已过期"就是一句假话；网易那 175 秒是另一家的实测值，不能移花接木。
  assert.ok(kugouProvider.KUGOU_QR_TTL_MS >= 300_000,
    `酷狗的本地兜底 TTL 不许短于实测下界 300 秒（当前 ${kugouProvider.KUGOU_QR_TTL_MS}）`);
  assert.ok(kugouProvider.KUGOU_QR_TTL_MS <= 900_000, '也不许长到十分钟不起作用：那等于让界面挂着一张早废的码');
});

test('R136 档位映射：0/1/2/4 四档各归一位，上游数字一律不透传', () => {
  assert.equal(kugouProvider.kugouCheckToState({ data: { status: 0 } }).state, 'expired');
  assert.equal(kugouProvider.kugouCheckToState({ data: { status: 1 } }).state, 'waiting');
  assert.equal(kugouProvider.kugouCheckToState({ data: { status: 2 } }).state, 'scanned');
  assert.equal(kugouProvider.kugouCheckToState({ data: { status: 4, token: KUGOU_CANARY, userid: KUGOU_UID } }).state, 'confirmed');
  const odd = kugouProvider.kugouCheckToState({ data: { status: 7 } });
  assert.equal(odd.ok, false, '没见过的状态码不猜成"还在等"：猜错的方向是让用户继续等一张已经废了的码');
  assert.match(odd.reason, /不在档内/);
  // **没有 status 这个字段**与"status 是 1"是两件事（网易那一路同款教训：请求没被正确接受 ≠ 没人扫）
  const absent = kugouProvider.kugouCheckToState({ data: { msg: 'ok' } });
  assert.equal(absent.ok, false, '上游连状态都没给就判失败，不许当成"还在等待"');
  assert.match(absent.reason, /不在档内/);
  // 不透传数字：任何返回值里都不该出现 `status` 这个键（前端只许看那五档）。
  for (const code of [0, 1, 2, 4]) {
    const one = kugouProvider.kugouCheckToState({ data: { status: code, token: KUGOU_CANARY, userid: KUGOU_UID } });
    assert.equal('status' in one, false, `档位 ${code} 的返回值把上游数字带出去了`);
  }
});

test('R136 凭据只从 confirmed 那一档出来：waiting 时上游 data 里带着 token 也不带出去（网易 801 那一课的翻版）', () => {
  const waiting = kugouProvider.kugouCheckToState({ data: { status: 1, token: KUGOU_CANARY, userid: KUGOU_UID } });
  assert.deepEqual(waiting, { ok: true, state: 'waiting' }, '没确认之前连 cookie 这个键都不该存在');
  assert.equal(JSON.stringify(waiting).includes(KUGOU_CANARY), false, 'canary 从"未确认"那一档漏出去了');
  const hollow = kugouProvider.kugouCheckToState({ data: { status: 4, token: '', userid: KUGOU_UID } });
  assert.equal(hollow.ok, false, '报"已授权"却没给 token：这不是成功，也不能假装成功');
  assert.match(hollow.reason, /没回 token 或 userid/);
  const confirmed = kugouProvider.kugouCheckToState({ data: { status: 4, token: KUGOU_CANARY, userid: KUGOU_UID } });
  assert.equal(confirmed.cookie, `token=${KUGOU_CANARY};userid=${KUGOU_UID}`, '这一档必须把两对都带上，否则登录这条链断了');
});

test('R136 cookie 拆对象：进程内直调没有 Express 那一层，这一跳必须我们自己拆', async () => {
  assert.deepEqual(kugouProvider.kugouCookieToObject(`token=${KUGOU_CANARY};userid=${KUGOU_UID}`),
    { token: KUGOU_CANARY, userid: KUGOU_UID });
  assert.deepEqual(kugouProvider.kugouCookieToObject('token=a%2Fb; userid=c ;;junk=;=x'),
    { token: 'a/b', userid: 'c', junk: '' },
    'URL 编码要解回来；没有名字的片段与空片段丢，但**空值保留** —— 与 `jarFromCookieString` 同一条规矩，'
    + '判"有没有值"是用它那一侧的事（handler 里就明判 token / userid 非空）');
  // 一手依据：`module/user_detail.js:2-3` 读的是 `params.cookie.token`（对象），不是头串。
  const detailSource = await readFile(join(SCRIPTS, 'bridge', 'node_modules', 'kugoumusicapi', 'module', 'user_detail.js'), 'utf8');
  assert.match(detailSource, /params\?\.cookie\?\.token/, '包读的是对象形状这条依据变了，上面那个拆法就该重新看');
});

test('R136 账号字段白名单：昵称 / 头像 / VIP 档位之外，身份类字段逐条不许出桥（QQ 那一课 R112）', () => {
  const detail = {
    data: {
      info: {
        nickname: '夜航船', avatar: 'http://imge.kugou.com/x.jpg',
        phone: '13800000000', email: 'someone@example.test', school: '某大学', registerIP: '10.1.2.3',
        userid: KUGOU_UID, token: KUGOU_CANARY, birthday: '2000-01-01', carrier: 'CMCC',
      },
    },
  };
  const vip = { data: { vip_name: 'VIP3', vip_type: 3, phone: '13800000000', userid: KUGOU_UID } };
  const account = kugouProvider.kugouDetailToAccount(detail, vip);
  assert.deepEqual(Object.keys(account).sort(), ['avatarUrl', 'loggedIn', 'nickname', 'ok', 'vipLabel', 'vipTier'],
    `放出去的就是这几样，多一样都要先想清楚（实测：${Object.keys(account).sort().join(', ')}）`);
  assert.equal(account.nickname, '夜航船');
  assert.equal(account.avatarUrl, 'https://imge.kugou.com/x.jpg', '上游给 http 就升 https（与 QQ 那一路同一条规矩）');
  for (const leak of ['13800000000', 'someone@example.test', '某大学', '10.1.2.3', '2000-01-01', 'CMCC', KUGOU_UID, KUGOU_CANARY]) {
    assert.equal(JSON.stringify(account).includes(leak), false, `身份类字段泄漏了：${leak}`);
  }
  // 头像不是 http(s) 的一律不给（给了也显示不出来，还会把任意字符串带进 <img src>）
  const odd = kugouProvider.kugouDetailToAccount({ data: { info: { nickname: 'x', avatar: 'ftp://a/b.jpg' } } }, {});
  assert.equal('avatarUrl' in odd, false, '认不出的协议就当没有头像');
});

test('R136 取码的调用序列恰好是 key → create，而且**不出 register_dev**（不伪装设备指纹）', async () => {
  const backend = makeKugouBackend({ login_qr_key: kugouKeyEnvelope(), login_qr_create: { status: 200, body: { data: { url: 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=kk', base64: 'data:image/png;base64,LOCAL' } } } });
  const result = await kugouHandler(backend)({ action: 'start', provider: 'kugou' });
  assert.equal(result.ok, true);
  assert.deepEqual(backend.calls.map((c) => c.operation), ['login_qr_key', 'login_qr_create'], '多一跳少一跳都算不对');
  assert.equal(result.qr.image, 'data:image/png;base64,LOCAL', '优先本地那张：它编码的是我们确定知道的 URL');
  assert.equal(result.loginId, 'k'.repeat(36));
  // create 那一步读的就是 `params.key`（包源码：`...index.html?qrcode=${params.key}`）。
  // 与上面 poll 那一格一起钉住：**两条链的参数名各自是什么，都以包源码为准，不靠推测**。
  assert.equal(backend.calls.find((c) => c.operation === 'login_qr_create')?.params.key, 'k'.repeat(36),
    'create 必须带 key；把两条链写成同一个名字正是这次 P0 的形状');
  assert.equal(result.expiresAt, 1_800_000_000_000 + kugouProvider.KUGOU_QR_TTL_MS, 'TTL 由桥算，父进程只读这个数');
  assert.equal(backend.calls.some((c) => c.operation === 'register_dev'), false,
    'register_dev 是伪造 IMEI / 设备指纹那一跳：这条链上它一次都不该出现');
});

test('R136 poll 必须按包**真正读的那个名字**（key）传句柄：写错就是恒 20010 且零报错', async () => {
  const backend = makeKugouBackend({ login_qr_check: { status: 200, body: { data: { status: 2 } } } });
  const out = await kugouHandler(backend)({ action: 'poll', provider: 'kugou', loginId: 'k'.repeat(36) });
  assert.equal(out.state, 'scanned');
  assert.deepEqual(backend.calls.map((c) => c.operation), ['login_qr_check']);
  // 一手读 `module/login_qr_check.js`：它取的是 **`params.key`**，再由它自己映射成上游查询串里的 `qrcode`
  // （`params: { plat, appid, srcappid, qrcode: params?.key }`）。
  // **这条断言从前写反了**（原文是"一手读…它取的是 params.qrcode"）⇒ 它把真凶钉成了"已验证"，
  // 于是代码传 `{ qrcode }`、包读到 `undefined`、上游恒回 502/20010，还被误判成"酷狗要求设备注册"。
  // 这是"断言照错的读法抄"的第二例（第一例是 PNG 魔数 R123）：实现与夹具互相验证，谁都绿。
  assert.equal(backend.calls[0].params.key, 'k'.repeat(36), '必须带 key：包读的就是这一个');
  assert.ok(!('qrcode' in backend.calls[0].params) || backend.calls[0].params.qrcode === backend.calls[0].params.key,
    '同时带 qrcode 是为了与上游参考实现（kugouProvider.checkQr 传 { key, qrcode: key }）逐字一致；两个名字若值不同就是给自己埋坑');
  const missing = await kugouHandler(makeKugouBackend({}))({ action: 'poll', provider: 'kugou' });
  assert.equal(missing.ok, false, '没有句柄就不问：那是一次注定问不到任何东西的出网');
  assert.equal(missing.retryable, undefined, '"缺句柄"是使用顺序错了，标成可重试只会让界面继续空转');
});

test('R136 上游 502 与本地生成失败各归各：前者报"可重试"，后者回落上游那张图而不是白屏', async () => {
  const rejected = makeKugouBackend({ login_qr_key: Object.assign(new Error('Request failed'), { status: 502, body: { data: { error_code: 20010 } } }) });
  const failed = await kugouHandler(rejected)({ action: 'start', provider: 'kugou' });
  assert.equal(failed.ok, false);
  assert.equal(failed.retryable, true, '实测 `login_qr_key` 会 502（error_code 20010）：那是抖动，不能说成"这台机器不能登录"');
  assert.match(failed.reason, /HTTP 502/);

  const fallback = makeKugouBackend({ login_qr_key: kugouKeyEnvelope(), login_qr_create: new Error('本地二维码生成炸了') });
  const stillWorks = await kugouHandler(fallback)({ action: 'start', provider: 'kugou' });
  assert.equal(stillWorks.ok, true, 'create 只是把同一张码自己画一遍；它坏了不该让取码失败');
  assert.equal(stillWorks.qr.image, 'data:image/png;base64,UPSTREAM', '回落到上游那张');
  assert.equal('url' in stillWorks.qr, false, '本地那步没成就别硬造一条 URL 给界面');
});

test('R136 后端没起来一律 retryable；logout 这一档一次 invoke 都不许有（包没有登出端点）', async () => {
  const notReady = makeKugouBackend({}, { ready: false });
  for (const action of ['start', 'poll', 'status', 'logout']) {
    const out = await kugouHandler(notReady)({ action, provider: 'kugou' });
    assert.equal(out.ok, false, `${action} 在未就绪时不该报成功`);
    assert.equal(out.retryable, true, `${action} 的"后端正在重启"要说成可重试`);
  }
  assert.equal(notReady.calls.length, 0, '未就绪就不该碰包：一次都不许');
  const backend = makeKugouBackend({});
  const out = await kugouHandler(backend)({ action: 'logout', provider: 'kugou', cookie: `token=${KUGOU_CANARY};userid=${KUGOU_UID}` });
  assert.equal(out.ok, true, '"没有上游可通知"不是失败：本机那份照样要删得掉');
  assert.equal(out.upstream, false, '这一档根本没出网，界面据此不许写"已通知上游"');
  assert.match(out.reason, /没有登出接口/);
  assert.equal(backend.calls.length, 0, '登出这一档出网一次就是撒谎（包 v1.6.0 没有那个模块）');
});

test('R136 问账号：没凭据零出网；VIP 那一跳坏了不吞掉"是谁"', async () => {
  const handler = kugouHandler(makeKugouBackend({}));
  const anonymous = await handler({ action: 'status', provider: 'kugou' });
  assert.equal(anonymous.loggedIn, false);
  assert.equal(anonymous.ok, true, '"本机没有登录态"是一个正常事实，不是错误');
  const backend = makeKugouBackend({
    user_detail: { data: { info: { nickname: '夜航船', avatar: 'https://imge.kugou.com/a.jpg' } } },
    user_vip_detail: new Error('VIP 那一档问不到'),
  });
  const asked = await kugouHandler(backend)({ action: 'status', provider: 'kugou', cookie: `token=${KUGOU_CANARY};userid=${KUGOU_UID}` });
  assert.equal(asked.nickname, '夜航船', 'VIP 问不到不该把昵称与头像一起吞掉');
  assert.equal('vipLabel' in asked, false, '档位缺席就是缺席，不编一个');
  assert.deepEqual(backend.calls.map((c) => c.operation), ['user_detail', 'user_vip_detail']);
  assert.equal(backend.calls[0].params.token, KUGOU_CANARY, '包读的是对象里的 token（一手读 module/user_detail.js）');
  const missing = await kugouHandler(makeKugouBackend({}))({ action: 'status', provider: 'kugou', cookie: 'userid=1' });
  assert.equal(missing.ok, false, '少了 token 就不去问：那是一次注定失败的出网');
});

test('R136 父进程：confirmed 之后凭据只进分区，日志 / 返回值 / 对外状态三处都搜不到 canary', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const lines = [];
    const bridge = makeBridge([
      { ok: true, provider: 'kugou', action: 'start', loginId: 'k'.repeat(36), qr: { image: 'data:image/png;base64,LOCAL' }, expiresAt: Date.now() + 170_000 },
      { ok: true, provider: 'kugou', action: 'poll', state: 'confirmed', cookie: `token=${KUGOU_CANARY};userid=${KUGOU_UID}` },
    ]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: (line) => lines.push(line) });
    const started = await auth.start('kugou');
    assert.equal(started.state, 'waiting');
    const polled = await auth.poll('kugou');
    assert.equal(polled.state, 'confirmed');
    assert.equal(JSON.stringify(polled).includes(KUGOU_CANARY), false, 'poll 的返回值里不许带凭据');
    const stored = JSON.parse(await readFile(join(dataDir, 'online-session', 'kugou.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored.cookies).sort(), ['token', 'userid'], '分区里就是那两对（与 sidecar 同口径：凭据只在本机文件里）');
    const described = await auth.status();
    assert.equal(described.providers.kugou.source, 'file');
    assert.equal(described.providers.kugou.entries, 2);
    assert.equal(JSON.stringify(described).includes(KUGOU_CANARY), false, '对外状态是键名白名单，值只许是条数与时间');
    assert.equal(lines.join('\n').includes(KUGOU_CANARY), false, '服务日志里不许出现凭据本体');
  });
});

test('R136 三家同时在扫不互相覆盖；退出酷狗只删酷狗那一份，且 reason 说"没有登出接口"', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    await session.write('netease', sessionModule.jarFromCookieString(CONFIRMED_COOKIE));
    await session.write('kugou', sessionModule.jarFromCookieString(`token=${KUGOU_CANARY};userid=${KUGOU_UID}`));
    const bridge = makeBridge([
      { ok: true, provider: 'netease', action: 'start', loginId: 'uni-1', qr: { image: 'data:image/png;base64,A' }, expiresAt: Date.now() + 175_000 },
      { ok: true, provider: 'kugou', action: 'start', loginId: 'k'.repeat(36), qr: { image: 'data:image/png;base64,B' }, expiresAt: Date.now() + 170_000 },
      { ok: true, provider: 'kugou', action: 'logout', upstream: false, reason: '酷狗包 v1.6.0 没有登出接口：这一步不出网，只清本机会话' },
    ]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    await auth.start('netease');
    await auth.start('kugou');
    const status = await auth.status();
    assert.deepEqual(status.pending.map((row) => row.provider).sort(), ['kugou', 'netease'],
      'pending 从"一个对象"变成"一个数组"之后，三家各占一格；写回单值会静默盖掉第一家');
    const out = await auth.logout('kugou');
    assert.equal(out.ok, true);
    assert.match(out.reason, /没有登出接口/, '这句原话必须传出去：界面据此显示"只清本机会话"，不许写"已通知上游"');
    assert.equal(/已通知上游|上游已登出/.test(out.reason), false);
    assert.equal(await session.exists('kugou'), false, '本机那份是真删了');
    assert.equal(await session.exists('netease'), true, '退一家不该把另一家的登录态一起带走');
  });
});

test('R136 分区边界：酷狗与网易同类（父进程读写），QQ 那两档拒绝没有被顺手放宽', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    assert.deepEqual(session.owned.sort(), ['kugou', 'netease']);
    await session.write('kugou', sessionModule.jarFromCookieString(`token=${KUGOU_CANARY};userid=${KUGOU_UID}`));
    const read = await session.read('kugou');
    assert.equal(read.source, 'file');
    // jar 的值是**整条 `name=value`**（键才是名字）——这是 `jarFromCookieString` 的既有形状，不是这一路新造的。
    assert.equal(read.jar.token, `token=${KUGOU_CANARY}`);
    await assert.rejects(() => session.read('qq'), /不读也不写/, 'QQ 那份仍然只归包自己管');
    await assert.rejects(() => session.writeSealed('kugou', 'x'), /没有密封会话这一档/, '密封那一档仍然只有 QQ：给酷狗开个头就是第二条凭据写入路径');
    // 酷狗**没有**环境变量入口（新开一条凭据输入路径要有理由，这里没有）：只有扫码那一条路。
    const withEnv = sessionModule.createOnlineSession({ dataDir, env: { KUGOU_COOKIE: `token=${KUGOU_CANARY}` } });
    const described = await withEnv.describe();
    assert.equal(described.providers.kugou.envConfigured, false, '环境变量不该被当成酷狗的登录来源');
  });
});

// ── 真机抓出来那一格：可重试的失败**不许**把一张还能用的码丢掉（界面第一版会当场删图停表）──
test('R136 可重试的轮询失败：retryable 必须原样带出父进程，且不清这一轮的句柄', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const bridge = makeBridge([
      { ok: true, provider: 'kugou', action: 'start', loginId: 'k'.repeat(36), qr: { image: 'data:image/png;base64,L' }, expiresAt: Date.now() + 300_000 },
      { ok: false, provider: 'kugou', action: 'poll', retryable: true, reason: '酷狗二维码状态查询失败：HTTP 502 · 错误码 20010' },
      { ok: true, provider: 'kugou', action: 'poll', state: 'waiting' },
    ]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    await auth.start('kugou');
    const failed = await auth.poll('kugou');
    assert.equal(failed.state, 'error');
    assert.equal(failed.retryable, true, '吞掉这个标记，界面就把"过一会儿再问"当成"这张码废了"');
    assert.equal(await auth.pendingSize(), 1, '句柄还在：下一问应当接着问，不是让用户重取一张');
    const next = await auth.poll('kugou');
    assert.equal(next.state, 'waiting', '同一轮里下一次问得到 ⇒ 中间那次 502 确实只是抖动');
    assert.equal(bridge.seen.length, 3);
  });
});

test('R136 轮询节奏按家给：酷狗那一档必须比网易慢（这一档是保守选择——原来那句"实测限流"已作废，见 R153）', async () => {
  assert.equal(onlineAuthModule.AUTH_POLL_MS_BY_PROVIDER.kugou >= 5000, true,
    `酷狗不许按 2 秒问。理由只剩两条且都不依赖"限流"那个归因：少打一半以上更温和、300 秒有效期内 5 秒节奏仍有三十几次机会（实测档位：${onlineAuthModule.AUTH_POLL_MS_BY_PROVIDER.kugou}）`);
  assert.equal(onlineAuthModule.AUTH_POLL_MS_BY_PROVIDER.netease, 2000, '网易那一路的 2 秒是 M3-a 就在跑的既有节奏，不跟着改');
  assert.equal(onlineAuthModule.AUTH_POLL_MS_BY_PROVIDER.qq, 2000);
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    const auth = onlineAuthModule.createOnlineAuth({ session, bridge: { call: async () => ({ ok: true }) }, log: () => {} });
    const status = await auth.status();
    assert.deepEqual(Object.keys(status.pollMsBy).sort(), ['kugou', 'netease', 'qq'], '三家各给一档，缺一档界面就会退回默认值');
  });
});

test('R136 界面：可重试不丢码 + 失败退避（真机上第一版是"502 ⇒ 图没了"，与它自己那句提示相反）', async () => {
  const app = await read(join('..', 'src', 'music-app.ts'));
  // 终态的算式必须把 retryable 算进去 —— 只按 state 判终态就是那一版缺陷本身。
  assert.match(app, /terminal = state !== "waiting" && state !== "scanned" && !retryable/,
    '可重试的 error 不是终态：这张码还有效');
  assert.match(app, /retryable = result\.retryable === true/, 'retryable 要从应答里真读出来，不是猜');
  assert.match(app, /authPollDelay\.set\(provider, retryable/, '问失败要退避：一次没答上来就按原节奏猛问，既没收益又给自己加负担（这条不依赖任何"上游会限流"的假设）');
  assert.match(app, /AUTH_POLL_MAX_DELAY_MS/, '退避要有上限：没有上限就是问一次坏一次之后永远不再问');
  // 只钉"这张表存在"不够：把增长式子拿掉仍然全绿（变异 U2 第一轮就是这么溜的）——判据要落在那句算术上。
  assert.match(app, /\(authPollDelay\.get\(provider\) \?\? pollMs\) \* 2/, '退避要真的翻倍，不是把间隔原样再写一遍');
  assert.match(app, /snapshot\.pollMsBy\?\.\[[^\]]+provider\.id\]/, '节奏按家取，不是一个全局数');
  // 反过来也要成立：真到终态时那张图必须被丢掉，不许留一张"看着还能扫"的废码。
  // R212 把这一句从单行改成了块（同一块里还要 armLate 给迟到确认窗口）——形状变了，要求在。
  assert.match(app, /if \(terminal\) \{\n      authQrImages\.delete\(provider\)/, '终态块里那张废图必须被丢掉');
  // 「取消这次扫码」要**取消得掉**（真机第一版：点了取消，那一行仍然"等待扫码 · 剩 284 秒"，
  // 因为下一次重画从服务端 pending 里把同一轮又捞回来了）。
  assert.match(app, /const authCancelledAt = new Map/, '取消要有本机记录：没有它，"取消"只是把图藏一秒');
  assert.match(app, /authCancelledAt\.set\(provider, at\)/, '记的是"取消的是哪一轮"（用那一轮的 expiresAt 当身份）');
  assert.match(app, /authCancelledAt\.get\(provider\.id\) === row\.expiresAt/, '重画时按同一身份判"这轮已被取消"');
  assert.match(app, /entry\.row && !entry\.cancelled &&/, '已取消的那一轮不许再排轮询');
  assert.match(app, /authCancelledAt\.delete\(provider\)/, '重新取码就是新的一轮：旧记录必须清，否则以后每张码都被压着');
  assert.match(app, /cancelled: "已在本机取消这一轮"/, '这一档要有自己的文案，不能退回"未登录"骗人');
});

test('R136 父进程那一侧是**第二道**字段闸门：桥多给的一律不转发（白名单不许只有一处）', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    await session.write('kugou', sessionModule.jarFromCookieString(`token=${KUGOU_CANARY};userid=${KUGOU_UID}`));
    const bridge = makeBridge([{
      ok: true, provider: 'kugou', action: 'status', loggedIn: true,
      nickname: '夜航船', avatarUrl: 'https://imge.kugou.com/a.jpg', vipLabel: 'VIP3',
      // 桥哪天被改松了（或换了个版本多回几个字段），这些必须停在父进程这一层：
      phone: '13800000000', email: 'someone@example.test', userid: KUGOU_UID, token: KUGOU_CANARY, raw: { a: 1 },
    }]);
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: () => {} });
    const account = await auth.account('kugou');
    assert.deepEqual(Object.keys(account).sort(), ['avatarUrl', 'loggedIn', 'nickname', 'vipLabel'],
      `账号路由转发的键必须还是那份白名单（实测：${Object.keys(account).sort().join(', ')}）`);
    const text = JSON.stringify(account);
    for (const leak of ['13800000000', 'someone@example.test', KUGOU_CANARY, KUGOU_UID, 'raw']) {
      assert.equal(text.includes(leak), false, `第二道闸门漏了：${leak}`);
    }
  });
});

test('R136 接线面：路由认三家、桥的分叉有酷狗那一行、界面第三行写着"酷狗音乐"', async () => {  const server = await read('music-server.mjs');
  assert.match(server, /这一版只有网易、酷狗与 QQ 的扫码通道/, '路由那句拒绝语要跟着事实改，不许还写两家');
  const forked = await read(join('bridge', 'providers', 'auth.mjs'));
  assert.match(forked, /if \(provider === 'kugou'\) return kugouRoute\(payload\)/, 'provider 分叉那一行');
  const app = await read(join('..', 'src', 'music-app.ts'));
  assert.match(app, /\{\s*id: "kugou",\s*label: "酷狗音乐",/, '设置面板第三行（R136 是单行对象，任务一起多一个 blocked 字段）');
  // "是谁"这一格是账号路由的第一个消费者（R128 那条"接口的存在不等于接口被用"在这条链上又灵了一次）：
  // 面板每 2 秒重画一次，所以它**必须**带缓存与 TTL，否则每 2 秒一次出网。
  assert.match(app, /const authAccounts = new Map/, '账号信息要有那份缓存');
  assert.match(app, /AUTH_ACCOUNT_TTL_MS/, '缓存要有时限：没有 TTL 就是登录之后永不刷新，换账号也看不出来');
  const avatarLines = app.split(/\r?\n/).filter((line) => line.includes('avatarUrl'));
  assert.ok(avatarLines.length > 0 && avatarLines.every((line) => /^\s*(\*|\/\/)/.test(line)),
    '第三方头像地址只许待在注释里：它进 DOM 就等于让浏览器自己去打那台主机（与封面同一条红线）');
  assert.match(app, /result\.reason \?\? "本机保存的凭据已删除"/, '退出那句原话由服务端给，界面不许替它改写成"已通知上游"');
  const chain = await read(join('bridge', 'providers', 'kugou-auth.mjs'));
  // R154 之后这条的范围要说准：**登录那三条链仍然一次都不注册**（例外只开到音频那一格，而且默认关）。
  // 全仓"调用点恰好一处"由 `check-music-bridge.mjs` 那条钉，不在这里重复一份判据（两处判同一件事迟早会漂）。
  assert.equal(/invoke\(['"]register_dev/.test(chain), false, '扫码登录这一条链上不许出现 register_dev（设备身份那格只允许出现在音频那一文件里）');
  assert.match(chain, /upstream: false/, '登出那一档明说没出网');
});

test('酷狗那行"恒 20010 / 扫了也不会确认"的说明已删（真凶是参数名，改对之后不是事实），但 blocked 这套机制与出码链路一个字没拆', async () => {
  const app = await read(join('..', 'src', 'music-app.ts'));
  // 判据**圈在那张表里**，不是整份文件：解释"为什么删"的注释里必然要引用那句被删掉的话，
  // 拿整份文件去数就会把一次正确的删除判成"没删干净"（R135 那条"判据要圈进函数体"的同一形状）。
  const table = /const AUTH_PROVIDERS_UI = \[([\s\S]*?)\] as const;/.exec(app)?.[1] ?? '';
  assert.ok(table.length > 200, `没抓到那张三家的表：${table.length}`);
  // ① 那句**已不是事实**的话必须不在：留着就是叫用户相信一件我们已知的假事（"不许替上游撒谎"反过来同样成立——
  //    也不许替上游"坦白"一件它没做的事）。
  assert.equal(table.includes('扫了也不会确认'), false, '旧说明整段要从那张表里删干净');
  assert.equal(table.includes('20010'), false, '错误码那句也一样');
  // ② 三家同一张形状：`blocked` 这一格必须**显式写出来**（空串 = 这一家没有已知的堵点）。
  //    字段与渲染都保留 —— 下一家真有需要说人话的堵点时还得用它，别到时候再造一套。
  // 2026-10-10（R154）改写：酷狗那一格从空串变成一句**量出来的实话**（要登录、CDN 由上游决定、
  // 不为音频放开明文）。所以判据从"三家都空"换成"两格空 + 酷狗那格非空且说到那两件事"——
  // 记 Q31（本批对既有判据的改写之一），钉的仍是**不变式**而不是某句文案。
  assert.equal((app.match(/blocked: ""/g) ?? []).length, 2, '网易与 QQ 两格显式空串：缺字段与"没有堵点"分得开');
  const kugouRow = /id: "kugou",\s*label: "酷狗音乐",\s*blocked: "([^"]*)"/.exec(app)?.[1] ?? '';
  assert.ok(kugouRow.length > 20, '酷狗那一格必须写得出今天真实的限制（空串=对它撒谎说"没有堵点"）');
  assert.match(kugouRow, /登录后/, '这条是量出来的：匿名只有 mid ⇒ 152，登录才有检索与音频');
  assert.match(kugouRow, /不为音频放开明文|不做下载/, '另一半也要说到：协议与"不下载"这两条红线没有为它动过');
  assert.equal(/(播不了|不能播|恒回)/.test(kugouRow), false, '这句不许写成绝对否定（实测过整首成功的那一次，写成"永远不行"就是新的假话）');
  // ③ 渲染与样式那两格仍在（机制没跟着删）
  assert.match(app, /<\/div>\$\{provider\.blocked \? `<p class="auth-blocked-note">/, '注释放进行与二维码之间');
  const css = await read(join('..', 'src', 'music.css'));
  assert.match(css, /\.auth-blocked-note \{[^}]*margin:[^}]*font-size: 11px/, '它是块级说明行（有自己的下边距）');
  // ④ 出码链路一个字没拆：那颗按钮、取消、轮询、TTL 都还在（"可读可恢复"里的"可恢复"）
  assert.match(app, /data-action="auth-start" data-auth="\$\{provider\.id\}"/, '扫码登录那颗按钮照旧渲染');
  assert.match(app, /data-action="auth-cancel"[^>]*>取消这次扫码/, '取消照旧');
  assert.match(app, /if \(live\) scheduleAuthPoll\(entry\.provider\.id, pollMs\)/, '轮询照旧（等这一条量通后无需重新接线）');
  const chain = await read(join('bridge', 'providers', 'kugou-auth.mjs'));
  // R154 把这条的范围收窄成"登录这一路"：设备身份那一条被批准的例外**只开到音频那一格**，而且默认关着；
  // 扫码这三跳多一跳注册就是把例外顺手扩大（判据本身没有放宽，钉的还是"这一条链零调用"）。
  assert.equal(/invoke\(['"]register_dev/.test(chain), false, '登录那三条链上不许出现 register_dev（例外只在音频那一格，且默认关）');
  const backend = await read(join('bridge', 'backends', 'kugou.mjs'));
  assert.match(backend, /register_dev: 'register_dev'/, '白名单条目保留不动（撤掉它会让"哪天要量"变成改判据）');
  assert.equal(/invoke\(['"]register_dev|register_dev\(/.test(backend), false, '保留条目 ≠ 调用它：这一份里也不许出现调用');
});


test('任务七 · 确认态但响应里没有可用会话 ⇒ 日志不许说"已保存"（它其实是删除），删除语义一个字不改', async () => {
  await withTempDir(async (dataDir) => {
    const session = sessionModule.createOnlineSession({ dataDir });
    // 先有一份正常会话（用户已登录的状态）
    await session.write('netease', sessionModule.jarFromCookieString(`MUSIC_U=${CANARY_COOKIE}`));
    assert.equal(await session.exists('netease'), true);
    const bridge = makeBridge([
      { ok: true, provider: 'netease', action: 'start', loginId: 'uni-7', qr: { image: 'data:image/png;base64,AAAA' }, expiresAt: Date.now() + 175_000 },
      // 上游回"confirmed"，但 cookie 那一串里**解析得出会话**的条目为零（只有属性段）
      { ok: true, provider: 'netease', action: 'poll', state: 'confirmed', cookie: 'Path=/; HttpOnly; Max-Age=0' },
    ]);
    const lines = [];
    const auth = onlineAuthModule.createOnlineAuth({ bridge, session, log: (line) => lines.push(line) });
    await auth.start();
    const confirmed = await auth.poll();
    assert.equal(confirmed.state, 'confirmed', '上游说确认了就是确认了，返回值不骗界面');
    assert.equal(await session.exists('netease'), false,
      '"空 jar 等于退出"这条既有语义**不许改**（不留一份空凭据装样子）');
    const text = lines.join('\n');
    assert.equal(text.includes('登录态已保存'), false, '文件没写、反而被删，这时候说"已保存"就是假话');
    assert.match(text, /没有解析得出会话/, '要说清"这一轮没拿到可用会话"');
    assert.match(text, /已按"空即退出"清掉/, '此前那份被清掉这件事也要说出来（用户查"文件为什么不见了"就靠这一行）');
    assert.equal(text.includes(CANARY_COOKIE), false, '两句里都不许带凭据');
    const view = await auth.status();
    assert.equal(view.providers.netease.source, 'none', '状态读口与磁盘一致');
  });
});

test('任务七 · 删除成功也要留一行日志（只有失败那一路 emit 的话，事后无从区分"点过退出"与"从来没有过"）', async () => {
  await withTempDir(async (dataDir) => {
    const lines = [];
    const store = sessionModule.createOnlineSession({ dataDir, log: (line) => lines.push(line) });
    await store.write('netease', sessionModule.jarFromCookieString(`MUSIC_U=${CANARY_COOKIE}`));
    const gone = await store.remove('netease');
    assert.equal(gone.removed, true);
    const text = lines.join('\n');
    assert.match(text, /会话文件已删除/, '删除成功要有一行（任务七查 netease.json 为什么消失时缺的就是它）');
    assert.equal(text.includes(CANARY_COOKIE), false, '这一行只说"删了"，不说删掉的是什么');
    // 没有文件时仍是"已是退出态"，并且**不该**打"已删除"那一行（那是两件事）
    lines.length = 0;
    const again = await store.remove('netease');
    assert.equal(again.alreadyGone, true);
    assert.equal(lines.length, 0, '本来就没有就不是"删除成功"：退出态不重复播报，日志也要说实话');
  });
});


// ── R161（任务八）· 播放上报：缺省关，四条隐私判据 ──────────────────────────────
// 非移植。这一组盯的不是"能不能报成功"（那要登录，用户不在场 ⇒ 挂起），
// 而是**什么时候一定不发**：关着 / 本地曲目 / 没登录 / 没听满 / 一轮里第二次。
// 判据全部落在"零请求"这一格上——它是这一件唯一能离线钉死、又最容易被改动弄丢的东西。

const reportModule = await import('./online-report.mjs');
const { createPlayReporter, onlineReportTargetOf, REPORT_MIN_SECONDS, REPORT_PROVIDERS } = reportModule;
const reportRoutes = await import('./bridge/report-routes.mjs');
const { reportPayloadOf, registerReportRoutes } = reportRoutes;

test('R161 载荷白名单：只有三样出得去，曲名/路径/队列一格都挤不进去', () => {
  const ok = reportPayloadOf({ provider: 'netease', mediaId: '1997438791', positionSec: 42.9, sourceId: 'playlist-77' });
  assert.deepEqual(Object.keys(ok).sort(), ['mediaId', 'positionSec', 'sourceId']);
  assert.equal(ok.positionSec, 42, '秒数取整（上游要的是整数秒）');
  assert.equal(reportPayloadOf({ mediaId: '../etc/passwd' }), null, '曲目标识形状不对 ⇒ 不收，也不去问');
  assert.equal(reportPayloadOf({ mediaId: 'x'.repeat(65) }), null, '超长不收（不是截断，是拒）');
  assert.equal(reportPayloadOf({ mediaId: '12345', positionSec: 1e9 }).positionSec, 24 * 60 * 60,
    '秒数有上限：一个荒谬的数不该原样转给上游');
  // 载荷里**没有**曲名/歌手/专辑/路径这些格：这一条判的是"函数给不出来的东西"，不是"调用方没传"
  const text = JSON.stringify(reportPayloadOf({
    mediaId: 'abc', positionSec: 31, title: '恋人', artist: '李荣浩', album: '黑马',
    relativePath: 'D:/music/恋人.mp3', queue: ['a', 'b'],
  }));
  for (const forbidden of ['恋人', '李荣浩', '黑马', 'music', 'queue', 'relativePath', 'title', 'artist']) {
    assert.equal(text.includes(forbidden), false, `白名单里混进了「${forbidden}」`);
  }
});

test('R161 桥的两道登录闸：网易没 cookie 零 fetch、酷狗没会话零 invoke、QQ 明说"桥里没有这一条"', async () => {
  const fetchCalls = [];
  const invokes = [];
  const routes = new Map();
  registerReportRoutes({
    routes,
    backends: {
      netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' },
      kugou: { state: 'ready', invoke: async (operation, params) => { invokes.push({ operation, params }); return { status: 200, body: { error_code: 0 } }; } },
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, headers: init?.headers ?? {}, body: init?.body });
      return { status: 200, text: async () => JSON.stringify({ code: 200 }) };
    },
  });
  const call = routes.get('/bridge/report');
  assert.equal((await call({ provider: 'netease', mediaId: '123', positionSec: 60 })).ok, false);
  assert.deepEqual(fetchCalls, [], '网易没有登录态 ⇒ 一次环回都不发（无主请求不是"报了再说"）');
  assert.equal((await call({ provider: 'kugou', mediaId: '123', positionSec: 60 })).ok, false);
  assert.deepEqual(invokes, [], '酷狗没有会话 ⇒ 一次都不问包');
  const qq = await call({ provider: 'qq', mediaId: '123', positionSec: 60 });
  assert.equal(qq.ok, false);
  assert.match(qq.reason, /没有这一条|不猜端点/, 'QQ 要说"桥里没有这一条通道"，不是含糊的"暂不支持"');
  assert.deepEqual(fetchCalls, [], 'QQ 那一问也不该产生任何请求');
  // 带上了就发：网易走环回 + cookie 在**请求头**里（查询串会进包的访问日志）
  const sent = await call({ provider: 'netease', mediaId: '123', positionSec: 60, cookie: 'MUSIC_U=fixture-value' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].headers.cookie, 'MUSIC_U=fixture-value');
  assert.equal(String(fetchCalls[0].url).includes('fixture-value'), false, 'cookie 不许出现在地址里');
  assert.deepEqual(JSON.parse(String(fetchCalls[0].body)), { id: '123', sourceid: '123', time: 60, cookie: 'MUSIC_U=fixture-value' },
    '发给包的就三样（sourceid 缺省跟着 mediaId 走）');
  assert.equal(JSON.stringify(sent).includes('fixture-value'), false, '答复里不许回显凭据');
  const kugouSent = await call({ provider: 'kugou', mediaId: '553871043', positionSec: 60, cookie: 'token=bb;userid=seven' });
  assert.equal(kugouSent.ok, true, JSON.stringify(kugouSent));
  assert.equal(invokes[0].operation, 'playhistory_upload');
  assert.equal(invokes[0].params.mxid, '553871043');
});

test('R161 上报器四条"一定不发"：关着 / 没听满 / 一轮里第二次 / 没有通道的那一家', async () => {
  const calls = [];
  const bridge = { call: async (route, payload) => { calls.push({ route, payload }); return { ok: true } } };
  let credentialsAsked = 0;
  const reporter = createPlayReporter({
    bridge,
    credentialsFor: async (provider) => { credentialsAsked += 1; return { cookie: 'MUSIC_U=fixture-value' , device: { guid: 'g', mid: 'm', dfid: '' } , provider } },
  });
  const base = { provider: 'netease', mediaId: '1997438791', positionSec: 120 };
  // ① 缺省关：一次都不发，**连凭据都不读**（与 R143 那条"关着时一个会话文件都不 stat"同一形状）
  credentialsAsked = 0;
  const off = await reporter.report({ ...base, enabled: false });
  assert.equal(off.sent, false);
  assert.deepEqual(calls, [], '关着 ⇒ 零请求（这一格是整件的核心承诺）');
  assert.equal(credentialsAsked, 0, '关着时连"哪一家登录了"都不问');
  // ② 没听满：不发
  const early = await reporter.report({ ...base, positionSec: REPORT_MIN_SECONDS - 1, enabled: true });
  assert.equal(early.sent, false);
  assert.match(early.reason, /只听满 30 秒/);
  assert.deepEqual(calls, [], '差一秒也不发（划歌单不该变成一串打卡）');
  assert.equal(REPORT_MIN_SECONDS, 30, '这个数改了要连界面文案与这条断言一起改');
  // ③ 听满了 ⇒ 发一次；同一轮里再报 ⇒ 去重
  reporter.startPlayback({ id: 'on-netease-1997438791', sourceKind: 'online', provider: 'netease' });
  const first = await reporter.report({ ...base, enabled: true });
  assert.equal(first.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/bridge/report');
  assert.equal(calls[0].payload.positionSec, 120);
  assert.equal(JSON.stringify(calls[0].payload).includes('恋人'), false, '载荷里不该有曲名（这里连传都没传）');
  const second = await reporter.report({ ...base, enabled: true });
  assert.equal(second.sent, false);
  assert.match(second.reason, /已经报过一次/);
  assert.equal(calls.length, 1, '一轮只发一笔');
  // 换曲 = 新一轮（同一首重播可以再报一次，这是"我在听"的语义而不是 bug）
  reporter.startPlayback({ id: 'on-netease-999', sourceKind: 'online', provider: 'netease' });
  await reporter.report({ provider: 'netease', mediaId: '999', positionSec: 40, enabled: true });
  assert.equal(calls.length, 2);
  // ④ 没有通道的那一家
  const noChannel = await reporter.report({ provider: 'qq', mediaId: 'mid-1', positionSec: 60, enabled: true });
  assert.equal(noChannel.sent, false);
  assert.match(noChannel.reason, /没有上报通道/);
  assert.equal(calls.length, 2, '没有通道 ⇒ 连桥都不问');
  assert.deepEqual([...REPORT_PROVIDERS], ['netease', 'kugou'], '今天有上报通道的就这两家');
  // 服务日志那一行不许带凭据（canary 法，与 R108 同一条）
  const lines = [];
  const logged = createPlayReporter({ bridge: { call: async () => ({ ok: false, reason: '上游回 502' }) }, credentialsFor: async () => ({ cookie: 'MUSIC_U=fixture-value' }), log: (line) => lines.push(line) });
  logged.startPlayback({ id: 'on-kugou-7', sourceKind: 'online', provider: 'kugou' });
  await logged.report({ provider: 'kugou', mediaId: '7', positionSec: 60, enabled: true });
  assert.equal(lines.length, 1, '每次上报（成或败）都要留一行日志，否则这一档在界面上是黑箱');
  assert.equal(lines.join('\n').includes('fixture-value'), false, '日志里不许出现凭据本体');
});

test('R161 在线曲目身份只从 id 形状反推（本地曲目在这一格就被挡下）', () => {
  assert.deepEqual(onlineReportTargetOf('on-netease-1997438791'), { provider: 'netease', mediaId: '1997438791' });
  assert.deepEqual(onlineReportTargetOf('on-kugou-553871043'), { provider: 'kugou', mediaId: '553871043' });
  for (const local of ['7f3a9c2b', 'album-12', 'on-', 'on--x', '', null, undefined, 'on-netease-']) {
    assert.equal(onlineReportTargetOf(local), null, `「${String(local)}」不该被当成本地曲目之外的东西`);
  }
  // QQ / AMLL 的 id 形状能解析出 provider，但由上报器那一层拒（桥里没有通道）
  assert.equal(onlineReportTargetOf('on-qq-00245tac').provider, 'qq');
});

test('R161 配置与路由：缺省关、不在 online 那张表里、只接受布尔、关着时零桥调用', async () => {
  delete process.env.MUSICBRAINZ_CONTACT;   // 自检离线纪律：这一条也建真实曲库（有联系方式就会真出网补全资料）
  const { MusicLibraryStore, ONLINE_SWITCHES } = await import('./music-library.mjs');
  assert.equal(ONLINE_SWITCHES.includes('playReporting'), false,
    '那张表管"要不要出网取东西"，这一项管"要不要把听歌事实送出去"——方向相反，混在一起就成了"想关上报只能全关"');
  const dataDir = await mkdtemp(join(tmpdir(), 'rhine-report-cfg-'));
  try {
    const store = await new MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
    assert.equal(store.config.playReporting, false, '缺省关：这一项的缺省值就是它的隐私口径');
    await store.updateConfig({ playReporting: true });
    assert.equal(store.config.playReporting, true);
    await assert.rejects(() => store.updateConfig({ playReporting: 'yes' }), /必须为布尔值/);
    const reopened = await new MusicLibraryStore({ dataDir, defaultRoots: [] }).init();
    assert.equal(reopened.config.playReporting, true, '用户开过就要留着（这一项不需要"没写过≠关过"的区分：两种都是关）');
  } finally { await rm(dataDir, { recursive: true, force: true }) }
  const server = await read('music-server.mjs');
  const block = /if \(route === '\/api\/online\/report'\) \{([\s\S]*?)\n      if \(route === '\/api\/online\/playlist\/mine'\)/.exec(server)?.[1] ?? '';
  assert.ok(block, '上报那条路由还在');
  assert.match(block, /request\.method !== 'POST'/, '方法判定在体判定之前（R61 次序）');
  assert.match(block, /onlineReportTargetOf\(value\?\.trackId\)/, 'provider 与 mediaId 由服务端从 id 反推，不信客户端自报');
  assert.match(block, /本地曲目不上报任何平台/);
  assert.match(block, /playReporting === true/, '开关读的是服务端配置，不是前端传来的一个字段');
  assert.match(block, /return json\(response, 200, sanitizeEgressReasons\(\{ ok: true, \.\.\.reply \}\)\)/,
    '上报失败回 200 + sent:false：让前端 catch 一个"错误"会把无关紧要的事渲染成红字');
  assert.equal(/cookie/.test(block), false, '路由这一层不碰凭据（交给 credentialsFor 那一个出处）');
});

test('R161 界面：开的那一方向要二次确认、缺省那句要说"零请求"、关着时连 fetch 都不构造', async () => {
  // 注意：这个文件里的 `read()` 读的是 scripts/，前端源码要走另一条路径（写错一次就会红成 ENOENT）
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /id="play-reporting"/, '开关在设置里');
  assert.match(app, /播放上报（默认关闭）/, '标题里就写着缺省是关');
  assert.match(app, /case "save-play-reporting"/, '有自己那颗保存按钮（一个按钮只改自己那一格）');
  assert.match(app, /await request\("\/api\/config", \{ playReporting: turningOn \}\)/, '只发这一项');
  const confirmBlock = /if \(turningOn && !window\.confirm\(([\s\S]*?)\)\) \{/.exec(app)?.[1] ?? '';
  assert.ok(confirmBlock, '开的那一方向有 window.confirm（关不需要——关是回到缺省）');
  assert.match(confirmBlock, /平台曲目标识/, '确认框里要重述"报什么"，不能只说"确定吗"');
  assert.match(confirmBlock, /本地曲目不报/);
  assert.match(app, /if \(!reportEnabled\) return;/, '关着时那一问根本不构造（"默认关时零请求"的客户端半）');
  // **TDZ 顺序判据**（真机第一次打开就整页卡在"正在载入三维专辑架"抓到的：`player.subscribe` 在注册那一刻
  // 同步跑一次回调，回调里引用的 `let/const` 声明若写在后面就是 ReferenceError）。
  // 这是 R103 那条"离线全绿、只有浏览器抓得到"的同一类，所以把它降级成一条会红的静态判据。
  const declaredAt = app.indexOf('let reportEnabled');
  const subscribedAt = app.indexOf('player.subscribe((state)');
  assert.ok(declaredAt >= 0 && subscribedAt >= 0 && declaredAt < subscribedAt,
    `上报那三格必须声明在 player.subscribe 之前（现在 声明@${declaredAt} / 订阅@${subscribedAt}）`);
  assert.match(app, /reportEnabled = config\?\.playReporting === true/, '开关真源在服务端，前端只是缓存');
  assert.match(app, /catch \{\s*reportEnabled = false;/, '读不到配置按关处理：缺省必须是"不发"');
  assert.match(app, /不影响播放，也不弹提示/, '失败不冒红字（这条链不是要打通的链路）');
});
