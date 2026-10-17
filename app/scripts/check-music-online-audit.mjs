// 第五期 Task 4 自检：出网审计（R75 的补偿装置）。全部离线——只喂假数据，不真的出网。
// 这一条守的是"联网默认打开"这句对用户的承诺：既然默认开，就必须把打了谁摊开给人看。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordEgress, auditSnapshot, resetAudit, AUDIT_LIMIT } from './online-audit.mjs';
import { guardedFetch, assertAllowedTarget, LYRICS_HOSTS, publicEgressReason, sanitizeEgressReasons, EGRESS_REJECT_MARKER } from './online-guard.mjs';
// R189：这两个用例原先 `listen` 之后直接 `fetch` —— 整跑里偶发 `fetch failed`（Windows 回环端口回收，
// 与 R181/R185 同族）。补一次探测，重试的是"连不上"、不是断言。
import { listenAndReady } from './check-ready.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const readScript = (name) => readFile(join(SCRIPTS, name), 'utf8');

test('审计是定长环形缓冲：超出上限丢最旧，totals 与 items 自洽（不许无界增长）', () => {
  resetAudit();
  for (let i = 0; i < AUDIT_LIMIT + 50; i += 1) {
    recordEgress({ host: `h${i % 3}`, kind: 'search', status: 200, bytes: 100, ms: 5, via: 'guard' });
  }
  const snap = auditSnapshot();
  assert.equal(snap.items.length <= AUDIT_LIMIT, true);
  assert.equal(snap.totals.requests, AUDIT_LIMIT, 'totals 只统计还留在缓冲里的那些，不能假装记得全');
  assert.equal(snap.totals.bytes, AUDIT_LIMIT * 100);
  const counted = snap.totals.byHost.h0 + snap.totals.byHost.h1 + snap.totals.byHost.h2;
  assert.equal(counted, AUDIT_LIMIT, 'byHost 的合计必须等于 requests');
  assert.equal(snap.totals.byKind.search, AUDIT_LIMIT);
  assert.deepEqual(Object.keys(snap.totals.byKind), ['search']);
  resetAudit();
  assert.deepEqual(auditSnapshot().items, [], '清空后是空的（面板与自检都要能重置）');
  assert.equal(auditSnapshot().totals.requests, 0);
});

test('审计不落盘、不含 URL 查询串与任何凭据形状（记的是主机与用途，不是请求细节）', async () => {
  const src = await readScript('online-audit.mjs');
  assert.doesNotMatch(src, /writeFile|appendFile|createWriteStream|mkdir/, '审计记录只许活在内存里');
  resetAudit();
  recordEgress({ host: 'u.y.qq.com', kind: 'lyrics', status: 200, bytes: 10, ms: 1, via: 'guard', url: 'https://u.y.qq.com/songlyrics?keyword=李荣浩&token=SECRETVALUE' });
  const text = JSON.stringify(auditSnapshot());
  assert.ok(!text.includes('SECRETVALUE'), '查询串里的东西一律不得进审计');
  assert.ok(!text.includes('李荣浩'), '查询串里的曲目名也不得进审计（它会进面板，面板可能被截图）');
  assert.ok(!text.includes('?'), '只存 host + kind，不存完整 URL');
  const item = auditSnapshot().items[0];
  assert.deepEqual(Object.keys(item).sort(), ['at', 'bytes', 'host', 'kind', 'ms', 'status', 'via'], '条目形状就是这七个字段，多一个都要先想过必要性');
  resetAudit();
});

test('拒绝也要记：被静态校验挡下的目标同样是一笔该让用户看到的事实', async () => {
  resetAudit();
  await assert.rejects(() => guardedFetch('http://u.y.qq.com/songlyrics', { hosts: LYRICS_HOSTS, kind: 'lyrics' }), /只允许 https/);
  await assert.rejects(() => guardedFetch('https://127.0.0.1:5177/api/health', { kind: 'lyrics' }), /IP 字面量|受限|拒绝/);
  const snap = auditSnapshot();
  assert.equal(snap.items.length, 2, `被挡下的两次都要各记一笔，实测 ${JSON.stringify(snap.items)}`);
  assert.deepEqual(snap.items.map((i) => i.host), ['127.0.0.1', 'u.y.qq.com'], '被自己拦下的那个主机名更要摊出来；items 是"最新的排前面"（面板直接渲染这个顺序）');
  assert.deepEqual(snap.items.map((i) => i.status), [0, 0], '没连出去的没有 HTTP 状态：0 = 未出网（面板据此渲染"已拦下"）');
  assert.deepEqual([...new Set(snap.items.map((i) => i.kind))], ['lyrics'], '用途照旧记，不然拦下的是什么用途都看不出');
  assert.deepEqual([...new Set(snap.items.map((i) => i.via))], ['guard']);
  resetAudit();
});

test('真出网的那一笔要带得上状态、字节与耗时（面板靠这三样判断"打了谁、打了多少"）', async () => {
  resetAudit();
  const real = globalThis.fetch;
  const body = new TextEncoder().encode('{"code":0}');
  globalThis.fetch = async () => ({
    ok: true, status: 200, headers: new Map([['content-length', String(body.length)]]),
    body: { [Symbol.asyncIterator]: async function* () { yield body } },
  });
  // 注入口只换掉"去哪查地址"，查到的结果照样逐个过 isBlockedAddress ⇒ 自检不碰真 DNS，也不减一道检查。
  const lookup = async () => [{ address: '123.123.123.123' }];
  try {
    await guardedFetch('https://u.y.qq.com/songlyrics?songmid=abc', { hosts: LYRICS_HOSTS, kind: 'lyrics', lookup });
  } finally {
    globalThis.fetch = real;
  }
  const item = auditSnapshot().items[0];
  assert.equal(item.host, 'u.y.qq.com');
  assert.equal(item.kind, 'lyrics', '用途由调用方给，不能所有出网都糊成一行');
  assert.equal(item.status, 200);
  assert.equal(item.bytes, body.length);
  assert.ok(typeof item.ms === 'number' && item.ms >= 0);
  assert.ok(!JSON.stringify(auditSnapshot()).includes('songmid=abc'), '查询串不得跟着成功那笔一起进表');
  resetAudit();
});

test('注入的地址也要过类别闸：假 lookup 给环回，审计里留下的是一笔被拦下的记录', async () => {
  resetAudit();
  const real = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return { ok: true, status: 200, headers: new Map(), body: null } };
  try {
    await assert.rejects(() => guardedFetch('https://u.y.qq.com/songlyrics', {
      hosts: LYRICS_HOSTS, kind: 'lyrics', lookup: async () => [{ address: '127.0.0.1' }],
    }), /受限地址/);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(fetched, 0, 'DNS 预解析挡下时不得真的发请求');
  const item = auditSnapshot().items[0];
  assert.equal(item.host, 'u.y.qq.com');
  assert.equal(item.status, 0, '被自己拦下的那笔没有 HTTP 状态');
  resetAudit();
});

test('桥的那一笔由客户端转进来：via=backend、host 是 provider 而不是假想主机', async () => {
  const server = await readScript('music-server.mjs');
  // Task D 把这段逻辑抽成了具名函数（这样才能被离线自检直接打到 via='guard' 那条分叉），
  // 所以"事件真的落进环形缓冲"这句话现在要按两跳来断：客户端的 onAudit 转给谁、那个人又调了谁。
  assert.match(server, /onAudit:\s*\(event\)\s*=>\s*recordBridgeAudit\(event\)/, '桥的审计事件必须交给 recordBridgeAudit');
  assert.match(server, /export function recordBridgeAudit\(event,\s*record\s*=\s*recordEgress\)/,
    '那个函数的默认落点必须是审计环形缓冲本身（record 只是自检注入口，默认值才是真路径）');
  assert.match(server, /record\(\{[\s\S]{0,160}via:\s*'guard'/, 'guard 那一路要原样入库');
  assert.match(server, /record\(\{[\s\S]{0,200}via:\s*'backend'/, 'backend 那一路要按 ok 折算状态');
  const bridge = await readScript('bridge/online-bridge.mjs');
  assert.match(bridge, /evt: 'audit'[\s\S]{0,200}via: 'backend'/, '桥内每次调用包函数都要留下一笔 via=backend 的补偿记录（R75 的诚实边界）');
  resetAudit();
  recordEgress({ host: 'qq', kind: '/bridge/lyrics', status: 200, bytes: 0, ms: 42, via: 'backend' });
  const snap = auditSnapshot();
  assert.equal(snap.totals.byKind['/bridge/lyrics'], 1);
  assert.equal(snap.items[0].host, 'qq', '这一行代表"第三方库内部的请求"，主机名只能用 provider 标识');
  resetAudit();
});

test('GET /api/online/audit 的开关次序与其他在线路由一致：关着 404 且不出网', async () => {
  const source = await readScript('music-server.mjs');
  const at = source.indexOf("'/api/online/audit'");
  assert.ok(at > 0, '审计路由必须真的挂在服务上');
  const before = source.slice(at, at + 400);
  assert.match(before, /online\?\.(lyrics|search|streaming|covers)|anyOnlineOn|some\(/, '路由读的是四张子开关，不是又造一个总闸');
});

test('真路由：曲库快照与审计表同时可读，且审计里就是刚才那几次真打的目标', async () => {
  const { createMusicServer } = await import('./music-server.mjs');
  resetAudit();
  recordEgress({ host: 'u.y.qq.com', kind: 'lyrics', status: 200, bytes: 4096, ms: 120, via: 'guard' });
  const store = {
    dataDir: 'D:/rhine-audit-test',
    config: { version: 1, roots: [], online: { lyrics: true, search: true, streaming: true, covers: true }, onlineEnabled: false, foobarBaseUrl: null },
    musicBrainzContact: '',
    snapshot: () => ({ version: 1, albums: [], genres: [], roots: [], scan: { running: false }, onlineEnabled: false, online: { lyrics: true }, onlineLyrics: { enabled: true } }),
    updateConfig: async (value) => ({ ...store.config, ...value }),
    trackForOnlineMatch: () => null,
    reloadRules: async () => {}, scan: async () => ({}), scanPromise: null,
  };
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false,
    bridgeClient: { status: () => ({ phase: 'off', port: 0, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), ensure: () => {}, call: async () => ({ ok: false, reason: 'x' }), shutdown: async () => ({ forced: false }) },
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
  });
  // R211（A 类第 5 处）：探测挪进 try（坏探测抛错时 finally 照样把这台关干净），并升级 listenAndReady。
  let origin;
  try {
    ({ origin } = await listenAndReady(server));
    const res = await fetch(`${origin}/api/online/audit`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items[0].host, 'u.y.qq.com');
    assert.equal(body.totals.byHost['u.y.qq.com'], 1);
    assert.equal((await (await fetch(`${origin}/api/library`)).json()).albums.length, 0, '审计不得影响本地曲库路由');
    assert.match(String((await fetch(`${origin}/api/online/audit`, { method: 'POST' })).status), /^405$/, '审计只接受 GET');
    // 全关 ⇒ 404，与其他在线路由同一规则
    store.config.online = { lyrics: false, search: false, streaming: false, covers: false };
    assert.equal((await fetch(`${origin}/api/online/audit`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    resetAudit();
  }
});

test('全关 ⇒ 记录随关闭一并清空（面板上写的那句"已随关闭清空"必须是真话）', async () => {
  const { createMusicServer } = await import('./music-server.mjs');
  const store = {
    dataDir: 'D:/rhine-audit-test',
    config: { version: 1, roots: [], online: { lyrics: true, search: true, streaming: true, covers: true }, onlineEnabled: false, foobarBaseUrl: null },
    musicBrainzContact: '',
    snapshot: () => ({ version: 1, albums: [], genres: [], roots: [], scan: { running: false }, onlineEnabled: false, online: { ...store.config.online }, onlineLyrics: { enabled: true } }),
    // 与真 store 同构：updateConfig 是**整个替换** config 对象，不是原地改
    updateConfig: async (value) => { store.config = { ...store.config, ...value, online: { ...store.config.online, ...(value.online ?? {}) } }; return { ...store.config, onlineLyrics: { enabled: store.config.online.lyrics === true } } },
    trackForOnlineMatch: () => null, reloadRules: async () => {}, scan: async () => ({}), scanPromise: null,
  };
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false,
    bridgeClient: { status: () => ({ phase: 'ready', port: 1, backends: [], unauthorized: 0, restarts: 0, lastError: null, hosts: [] }), ensure: () => {}, call: async () => ({ ok: false, reason: 'x' }), shutdown: async () => ({ forced: false }) },
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
  });
  // R211（A 类第 6 处）：同款 —— 探测挪进 try（`post` 是对 `origin` 的闭包，赋值晚一步不影响调用时读到真值）。
  let origin;
  const post = (body) => fetch(`${origin}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    ({ origin } = await listenAndReady(server));
    resetAudit();
    recordEgress({ host: 'u.y.qq.com', kind: 'lyrics', status: 200, bytes: 100, ms: 10, via: 'guard' });
    assert.equal(auditSnapshot().totals.requests, 1);
    // 只关歌词一项 ⇒ 别的用途还开着，记录必须留着（不然面板会莫名其妙空掉）
    let res = await post({ online: { lyrics: false } });
    assert.equal(res.status, 200);
    assert.equal(auditSnapshot().totals.requests, 1, '部分关闭不得清空审计');
    assert.equal((await (await fetch(`${origin}/api/online/audit`)).json()).totals.requests, 1);
    // 四张全关 ⇒ 清空 + 路由 404
    res = await post({ online: { search: false, streaming: false, covers: false } });
    assert.equal(res.status, 200);
    assert.equal(auditSnapshot().totals.requests, 0, '全关必须把记录一起清掉');
    assert.equal((await fetch(`${origin}/api/online/audit`)).status, 404);
    // 重新打开 ⇒ 表是空的（从零开始记），不是把旧行翻出来
    res = await post({ online: { lyrics: true, search: true, streaming: true, covers: true } });
    assert.equal(res.status, 200);
    const body = await (await fetch(`${origin}/api/online/audit`)).json();
    assert.deepEqual(body.items, [], '重新打开后从零开始记');
    assert.equal(body.totals.requests, 0);
    resetAudit();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('面板的诚实文案在位：包内部请求只能按 provider 汇总，不许写得像我们全知', async () => {
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /无法逐条列出主机/, '固有代价要写出来（选用非官方封装包的代价）');
  assert.match(app, /播放器主动发起/, '表里是什么必须先说清楚');
  // status 0 的两种含义必须分开渲染：guard 的 0 是"我们自己拦下"，backend 的 0 是"库确实打了、这次没成功"。
  // 把后者也写成"已拦下"等于掩盖了一次真实出网。
  assert.match(app, /row\.via === "backend" \? "调用未成功"/, '桥那一路的失败要按它自己的说法');
  assert.match(app, /"已拦下（未出网）"/, '被静态校验拦下的仍然要显式标出来');
  assert.match(app, /"\/bridge\/lyrics": /, '路由路径要有中文用途名，用户读不懂 /bridge/lyrics');
});

// ── P0（2026-10-10）· 出网层的内部码不许透到界面 ─────────────────────────────

test('P0：出网文案归一层——认得的机器句子翻成人话，认不出的原样给（只剥自家标识符）', () => {
  // 现场那一条（含被重复包了两层前缀的形状）：界面要拿到一句人话。
  assert.equal(publicEgressReason(`${EGRESS_REJECT_MARKER}: ${EGRESS_REJECT_MARKER}: 在线请求只允许 https，收到 http:`),
    '该地址的协议不受支持：本播放器只走 https');
  assert.equal(publicEgressReason(`${EGRESS_REJECT_MARKER}: 主机不在本次用途的在线白名单：m1.music.126.net`),
    '那个主机不在本机允许的出网清单里');
  assert.equal(publicEgressReason(`${EGRESS_REJECT_MARKER}: 目标解析到受限地址 127.0.0.1`),
    '那个主机解析到了一个本机不允许访问的地址');
  // 认不出的**不许**改写成一句通用话：把"平台确实没有这首歌"说成"通道坏了"是新的谎。
  assert.equal(publicEgressReason('这首没有可用的网易音源（VIP 曲会给 30 秒试听片段）'),
    '这首没有可用的网易音源（VIP 曲会给 30 秒试听片段）');
  // 但自家标识符一个都不许留下（哪怕句子没认出来）。
  assert.equal(publicEgressReason(`${EGRESS_REJECT_MARKER}: 某句我们还没登记的新文案`), '某句我们还没登记的新文案');
  assert.equal(publicEgressReason(''), '', '空值不造话');
  assert.equal(publicEgressReason(undefined), '', '没给就等于没有这一格');
  // 标识符本身在日志与自检里仍然有用 ⇒ 它只是不许进响应，不是要被删掉。
  assert.equal(EGRESS_REJECT_MARKER, 'ONLINE_TARGET_REJECTED');
});

test('P0：归一层只碰 reason / error 两格，其余逐字不动（审计那些行尤其不许改）', () => {
  const body = {
    trackId: 'on-netease-1', ok: false, scope: 'unavailable',
    reason: `${EGRESS_REJECT_MARKER}: 在线请求只允许 https，收到 http:`,
    nested: { perSource: [{ provider: 'netease', ok: false, reason: `${EGRESS_REJECT_MARKER}: 主机不在本次用途的在线白名单：x` }] },
    auditLike: { host: '127.0.0.1', kind: 'auth', status: 0, via: 'guard' },
  };
  const clean = sanitizeEgressReasons(body);
  assert.equal(clean.reason, '该地址的协议不受支持：本播放器只走 https');
  assert.equal(clean.nested.perSource[0].reason, '那个主机不在本机允许的出网清单里');
  assert.equal(JSON.stringify(clean.auditLike), JSON.stringify(body.auditLike), '不是 reason/error 的键一个字节都不许变');
  assert.equal(clean.trackId, body.trackId);
  assert.equal(clean.ok, false, '布尔值不被"顺手改写"');
  assert.equal(JSON.stringify(clean).includes(EGRESS_REJECT_MARKER), false, '归一之后整份响应里不该再有内部标识符');
  // 深度上限是"别把整棵树递归炸了"的保险，不是放行内部码的口子：超深时原样返回，由路由自己保证浅。
  assert.equal(sanitizeEgressReasons({ a: { b: { c: { d: { e: { reason: `${EGRESS_REJECT_MARKER}: x` } } } } } })
    .a.b.c.d.e.reason, `${EGRESS_REJECT_MARKER}: x`, '超过深度上限时原样返回（这一格如实登记在注释里）');
});

test('P0：被拦下那笔的抛错只带一层前缀（现场那条消息里出现两次，是 precheck 把自己重新包了一遍）', async () => {
  await assert.rejects(
    () => guardedFetch('http://u.y.qq.com/songlyrics', { hosts: LYRICS_HOSTS, kind: 'lyrics', lookup: async () => [{ address: '104.20.71.5' }] }),
    (error) => {
      const message = String(error?.message ?? '');
      assert.equal(message.split(EGRESS_REJECT_MARKER).length - 1, 1, `前缀只许出现一次：${message}`);
      assert.match(message, /只允许 https/, '协议这一格的原因仍然写在消息里（日志与自检要看得到）');
      return true;
    },
  );
});
