// 第五期 Task 2/3 自检：在线后端子进程（online-bridge）的生命周期与安全面。
// 这一条钉的是"最容易在真实机器上翻车"的那部分：端口从哪来、令牌怎么校验、
// 父进程消失后子进程会不会变孤儿、桥崩了本地核心还在不在。
// 离线口径：不 require 任何第三方后端包（那是 Task 5 起的事），hosts 传空 ⇒ 零出网。
// 唯一例外 = R224（iii）：它确实 require 真包（为的是量"包实际组装出去的那一份参数"），
// 但在它进 require cache 之后把**唯一发送口** `util/request.js` 的 `createRequest` 换成桩 ⇒ 一笔都出不去，
// 并在 finally 里换回来。这一格是有意破例、不是漂移，改它要连带改这两行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenAndReady, waitListening } from './check-ready.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const readScript = (name) => readFile(join(SCRIPTS, name), 'utf8');

const { startBridge } = await import('./bridge/online-bridge.mjs');
const { createBridgeClient } = await import('./online-bridge-client.mjs');

// 32 位、刻意不含数字：凭据扫描判据要求"同时含字母与数字"，测试常量不该被当成可用凭据（它确实不是）。
const TOKEN = 'bridge-self-check-token-abcdefgh';
const BRIDGE_ENTRY = fileURLToPath(new URL('./bridge/online-bridge.mjs', import.meta.url));
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
const waitExit = (child, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  child.once('exit', (code) => { clearTimeout(timer); resolve(code) });
});

/**
 * 起一个桥并**确认它可连**。这台机器上"刚 listen 完的第一笔 connect 偶发被拒"
 * 是环境类抖动（Windows 回环端口回收），不是逻辑问题；探测只重连，不重任何断言。
 * 见 check-ready.mjs 头注与执行日志 M2 的"链式跑测偶发"一节。
 */
const startReadyBridge = async (options) => {
  const bridge = await startBridge(options);
  // 探测带**合法令牌**：不带的话桥会把这一笔记成 unauthorized，把"401 计数"那两条用例污染掉。
  await waitListening(`http://127.0.0.1:${bridge.port}`, { path: '/bridge/status', headers: { 'x-online-token': options.token } });
  return bridge;
};

test('就绪协议：ready 报的是真在听的端口，且只 bind 127.0.0.1', async () => {
  const events = [];
  const bridge = await startReadyBridge({ token: TOKEN, hosts: [], emit: (e) => events.push(e) });
  try {
    const ready = events.find((e) => e.evt === 'ready');
    assert.ok(ready, '没收到 ready 事件');
    assert.equal(ready.aggregate.host, '127.0.0.1', '不许 bind 通配地址或 localhost 别名');
    assert.ok(Number.isInteger(ready.aggregate.port) && ready.aggregate.port > 0 && ready.aggregate.port < 65536);
    assert.equal(ready.aggregate.port, bridge.port, '上报的端口必须就是实际在听的那个');
    const src = await read('scripts/bridge/online-bridge.mjs');
    assert.match(src, /\.address\(\)/, '端口必须从已 listen 的 server 上读');
    assert.doesNotMatch(src, /createServer\(\)\.listen\(0[^)]*\)[^;]{0,120}\.close\(\)/, '不许用"拿号再 close"的探测法（上游 main.cjs:4153 的 TOCTOU）');
    // 两条第一版就把测试进程挂死的教训，钉成断言免得被"顺手改回去"
    assert.match(src, /if \(watchParent\)/, '看门狗只在独立运行时挂：进程内 resume() 会把测试自己的 stdin 变成活动句柄');
    assert.match(src, /closeAllConnections/, '关桥必须先掐 keep-alive 连接，否则 server.close() 永远等不完');
  } finally { await bridge.close(); }
});

test('令牌：缺令牌与错令牌都 401 并被计数；控制消息同样校验', async () => {
  const bridge = await startReadyBridge({ token: TOKEN, hosts: [], emit: () => {} });
  try {
    for (const headers of [{}, { 'x-online-token': 'f'.repeat(48) }]) {
      const res = await fetch(`http://127.0.0.1:${bridge.port}/bridge/status`, { headers });
      assert.equal(res.status, 401);
    }
    assert.equal(bridge.unauthorized(), 2, '两次非法访问都要计数');
    const ok = await fetch(`http://127.0.0.1:${bridge.port}/bridge/status`, { headers: { 'x-online-token': TOKEN } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.backends, [], '没配后端时状态要能读，且是空表');
  } finally { await bridge.close(); }
});

test('路由表：未知路由 404、GET 到 POST-only 路由 405、handler 抛错回 200 + 可读 reason', async () => {
  const { ROUTES } = await import('./bridge/online-bridge.mjs');
  ROUTES.set('/bridge/boom', async () => { throw new Error('后端炸了') });
  const events = [];
  const bridge = await startReadyBridge({ token: TOKEN, hosts: [], emit: (e) => events.push(e), routes: ROUTES });
  const head = { 'x-online-token': TOKEN, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/bridge/nope`, { method: 'POST', headers: head, body: '{}' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/bridge/boom`, { headers: head })).status, 405, '业务路由只接受 POST');
    const res = await fetch(`http://127.0.0.1:${bridge.port}/bridge/boom`, { method: 'POST', headers: head, body: '{}' });
    assert.equal(res.status, 200, '桥内失败不许变成 5xx：失败是信息');
    assert.deepEqual(await res.json(), { ok: false, reason: '后端炸了' });
    // R75 的审计补偿：每次业务调用都要留下一笔，成败都要记（Task 4 把它接到面板）
    const audits = events.filter((e) => e.evt === 'audit');
    assert.equal(audits.length, 1, `只给业务调用记账，实测 ${JSON.stringify(audits)}`);
    assert.equal(audits[0].kind, '/bridge/boom');
    assert.equal(audits[0].ok, false, '失败也要如实记账');
    assert.equal(typeof audits[0].ms, 'number');
  } finally {
    ROUTES.delete('/bridge/boom');
    await bridge.close();
  }
});

test('启动守卫：令牌缺失或太短直接拒绝启动（宁可起不来也不裸奔）', async () => {
  for (const token of [undefined, '', 'short']) {
    await assert.rejects(() => startBridge({ token, hosts: [], emit: () => {} }), /ONLINE_BRIDGE_TOKEN/, `token=${JSON.stringify(token)} 必须被拒`);
  }
});

test('看门狗：父进程管道关闭后子进程自行退出（Windows 无 SIGTERM 传播，这条最可靠）', async () => {
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: { ...process.env, ONLINE_BRIDGE_TOKEN: TOKEN, ONLINE_BRIDGE_HOSTS: '' },
    stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
  });
  let buf = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`6 秒内没等到 ready；stdout=${buf}`)), 6000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('"ready"')) { clearTimeout(timer); resolve() } });
  });
  await ready;
  child.stdin.end();                       // 模拟父进程消失 ⇒ OS 关管道
  const code = await waitExit(child, 5000);
  assert.notEqual(code, null, '管道关闭后必须自行退出，不能变孤儿');
});

test('服务端把桥交给匹配器（Task 5 的接线：匹配器早于桥构造就会永远"桥不可用"）', async () => {
  const src = await read('scripts/music-server.mjs');
  assert.match(src, /createOnlineLyricMatcher\(\{ bridge \}\)/, '真匹配器必须拿到桥');
  const matcherAt = src.indexOf('createOnlineLyricMatcher({ bridge })');
  const bridgeAt = src.indexOf('createBridgeClient({');
  assert.ok(matcherAt > bridgeAt, '顺序：先建桥，再建拿得到桥的匹配器');
  assert.match(src, /onlineLyricsMatcher: providedMatcher/, '自检仍可整体注入假匹配器');
});

test('后端引导：网易 tmp 占位文件、桥只起两个包后端、三条硬前置都在位（Task 0 + Task 2 + R83 撤回）', async () => {
  const boot = await read('scripts/bridge/backends/bootstrap.mjs');
  assert.match(boot, /anonymous_token/, '网易包 require 时同步读这枚文件，缺了直接 ENOENT 崩进程');
  assert.match(boot, /xeapi_public_key/, '第二枚占位文件（包内是容错读，但我们一并预建）');
  assert.match(boot, /ENABLE_GENERAL_UNBLOCK/, '上游 main.cjs:3810 同值，必须显式设');
  // QQ 后端文件**不该存在**（2026-10-05 证伪后的改判，两条都记在 R83）：
  // ① Task 2 记的"包根 serverless dispatcher"在 3.1.2 不存在（实测 root keys = server,
  //    configureAuthSessionRepository,default，`mod.callback === undefined`，`default` 是 Koa Application）；
  // ② 那三条"参数里能塞任意 URL"的包内路由（/getMusicUrl、/getPic、/getFollowSingerList）也没注册，
  //    且 controllers/ 里 grep 不到读 query.url 的代码 ⇒ 当初据它们立起来的禁用表没有对象。
  // 结论：桥不许留一个"看起来 ready、第一笔调用就返垃圾"的后端；也不许为没人调用的包开回环端口。
  const entry = await read('scripts/bridge/online-bridge.mjs');
  assert.doesNotMatch(entry, /backends\/qq\.mjs|startQqBackend/, '桥的引导表里不得再有 QQ 包后端');
  assert.equal(existsSync(join(SCRIPTS, 'bridge/backends/qq.mjs')), false,
    'QQ 包后端文件必须已删除（留着就是死代码 + 一个没人调的监听面）');
  assert.match(entry, /R83/, '撤回原因要写在桥的入口文件头，不能只活在日志里');
  // 客户端那份 hosts 表是唯一的 spawn 参数来源，两处必须一致。
  const client = await read('scripts/online-bridge-client.mjs');
  assert.match(client, /hosts = \(\) => anyOn\(\) \? \['netease', 'kugou'\] : \[\]/,
    '后端表收窄成两个；QQ 走自写 fcg + guardedFetch（出网才进得了审计表）');
  // 以下两条由"真实 boot 取证"换来，删掉任一条桥都会当场翻车（不是理论风险）：
  const netease = await read('scripts/bridge/backends/netease.mjs');
  assert.match(netease, /server\.address\(\)/, '端口只能从已 listen 的 server 上读');
  assert.match(netease, /PORT['"]?\s*=\s*['"]0['"]/, 'options.port:0 会被 falsy 吞成 3000 ⇒ 必须走 env.PORT');
  assert.match(netease, /once\('listening'/, "server.js:443 的 app.listen() 没被 await ⇒ 不等 listening 就读 address() 拿到 null");
  assert.match(netease, /checkVersion:\s*false/, 'options.checkVersion 为真时包会去查 npm 版本 ⇒ 那是一笔不被审计的出网');
  const kugou = await read('scripts/bridge/backends/kugou.mjs');
  assert.match(kugou, /本项目自撰/);
});

test('第三方包不得咽掉异常：withKugouRequire 摘掉它 require 时注册的进程级处理器，桥自己发 fatal 再非零退出', async () => {
  const { withKugouRequire } = await import('./bridge/backends/bootstrap.mjs');
  const before = process.listeners('uncaughtException').length;
  const swallowed = [];
  const loaded = withKugouRequire(() => {
    process.on('uncaughtException', (error) => swallowed.push(error));   // 模拟酷狗包注册的那一枚
    process.on('unhandledRejection', () => {});
    return 'ok';
  });
  assert.equal(loaded, 'ok', '包加载结果要原样返回');
  assert.equal(process.listeners('uncaughtException').length, before, '它新加的 uncaughtException 处理器必须被摘掉');
  assert.equal(process.listeners('unhandledRejection').length, before, 'unhandledRejection 同理');
  assert.equal(swallowed.length, 0);
  const kugou = await read('scripts/bridge/backends/kugou.mjs');
  assert.match(kugou, /withKugouRequire\(\(\) => require\(/, '酷狗侧确实走的是这层包装');
  const src = await read('scripts/bridge/online-bridge.mjs');
  assert.match(src, /process\.on\('uncaughtException'/, '桥要有一份自己看得见异常的处理器');
  assert.match(src, /evt: 'fatal', reason: `\$\{label\}：\$\{error\?\.message/, 'fatal 要带上异常类别与消息（"安静地坏掉"是最坏结局）');
  // 只在独立运行时装：进程内被自检调用时不许劫持测试进程的异常（那会把测试失败原因改成桥的退出）。
  const guard = src.match(/if \(watchParent\) \{[\s\S]{0,1400}/);
  assert.ok(guard && /process\.on\('uncaughtException'/.test(guard[0]), '异常处理器必须排在 watchParent 之内');
  assert.ok(guard && /process\.stdin\.resume\(\)/.test(guard[0]), '看门狗也在这同一个门里：两条都只对独立运行生效');
});

test('独立入口对 Windows 路径写法不敏感：正斜杠 argv 也要真的 emit ready', async () => {
  // 翻过一次：`fileURLToPath(import.meta.url) === process.argv[1]` 在 argv 用正斜杠时不相等
  // ⇒ main() 没跑 ⇒ 桥活着但一声不吭，父进程只能等到 30 秒超时。探针脚本当时就是这么踩的。
  const forwardSlash = BRIDGE_ENTRY.replaceAll('\\', '/');
  assert.notEqual(forwardSlash, BRIDGE_ENTRY, '这条用例的前提是两种写法确实不同形（Windows）');
  const child = spawn(process.execPath, [forwardSlash], {
    env: { ...process.env, ONLINE_BRIDGE_TOKEN: TOKEN, ONLINE_BRIDGE_HOSTS: '' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let buf = '';
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; if (d.includes('"ready"')) { clearTimeout(timer); resolve('ready') } });
    child.once('exit', (code) => { clearTimeout(timer); resolve(`exit:${code}`) });
  });
  child.stdin.end();
  const code = await waitExit(child, 6000);
  assert.equal(outcome, 'ready', `正斜杠路径起桥必须真的进入监听并 emit ready，实测 ${outcome}；stdout=${JSON.stringify(buf)}`);
  assert.notEqual(code, null, 'ready 之后关掉管道仍要能自行退出');
});

test('服务端必须把开关表以 getter 交给客户端（真实机器抓到：抓引用会从此只读旧开关）', async () => {
  const src = await read('scripts/music-server.mjs');
  assert.match(src, /getConfig: \(\) => store\.config/, '传 getter：store.updateConfig() 换的是整个 config 对象');
  assert.doesNotMatch(src, /createBridgeClient\(\{[^}]*\bconfig: store\.config/s, '不许再把 config 对象本身交给客户端');
  const client = await read('scripts/online-bridge-client.mjs');
  assert.match(client, /if \(typeof getConfig !== 'function'\) throw/, '传错形状要在构造时就炸，而不是静默读旧开关');
  assert.throws(() => createBridgeClient({}), /getConfig/, '缺 getter 直接拒绝构造');
});

test('状态表现读：聚合口先 ready、包后起来时，/bridge/status 不得一直报 starting', async () => {
  const backends = {};
  const bridge = await startBridge({
    token: TOKEN, hosts: ['netease', 'kugou'], emit: () => {}, backends,
  });
  const head = { 'x-online-token': TOKEN };
  // 桥的聚合口刚 listen 完，第一笔 connect 在这台机器上偶发被拒（Windows 回环端口回收）。
  // 探测带合法令牌、只重连不重断言 —— 见 check-ready.mjs 头注。
  await waitListening(`http://127.0.0.1:${bridge.port}`, { path: '/bridge/status', headers: head });
  const read = async () => (await (await fetch(`http://127.0.0.1:${bridge.port}/bridge/status`, { headers: head })).json()).backends;
  try {
    assert.deepEqual(await read(), [{ id: 'netease', state: 'starting' }, { id: 'kugou', state: 'starting' }]);
    backends.netease = { state: 'ready', port: 4321 };
    backends.kugou = { state: 'error', reason: '包起不来' };
    assert.deepEqual(await read(), [
      { id: 'netease', state: 'ready', port: 4321 },
      { id: 'kugou', state: 'error', reason: '包起不来' },
    ], '独立入口是"先 ready 后 boot"，所以状态必须现读 backends 句柄');
  } finally { await bridge.close(); }
});

test('入口判定对 Windows 路径形态不敏感：正斜杠 argv 也必须真的跑 main()（翻过一次：桥活着但一声不吭）', async () => {
  const forward = BRIDGE_ENTRY.split(sep).join('/');
  assert.notEqual(forward, BRIDGE_ENTRY, '这条用例的前提就是拿一个与 fileURLToPath 不同形的路径写法');
  const child = spawn(process.execPath, [forward], {
    env: { ...process.env, ONLINE_BRIDGE_TOKEN: TOKEN, ONLINE_BRIDGE_HOSTS: '' },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let buf = '';
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 6000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { buf += d; if (buf.includes('"ready"')) { clearTimeout(timer); resolve('ready') } });
    child.once('exit', (code) => { clearTimeout(timer); resolve(`exited:${code}`) });
  });
  child.stdin.end();
  const code = await waitExit(child, 5000);
  assert.equal(ready, 'ready', `用正斜杠路径起桥应当真的进入监听并 emit ready，实测 ${ready}；stdout=${buf}`);
  assert.notEqual(code, null, 'ready 之后关掉管道仍要能自行退出');
});

test('退出路径：单个后端的 close 挂住也不许把桥拖成孤儿进程（真实取证：关不掉就是留不下）', async () => {
  const src = await read('scripts/bridge/online-bridge.mjs');
  assert.match(src, /const capped = Promise\.race\(\[[\s\S]{0,160}handle\?\.close\?\.\(\)[\s\S]{0,160}\]\)/,
    '每个后端的 close 都要有超时上限');
  assert.match(src, /setTimeout\(resolve, 2000\)\.unref\(\)/, '上限定时器不得自己成为留住事件循环的句柄');
  // 现场验证：一个 close 永远不返回的假后端，桥必须照样退得掉。
  const hanging = { state: 'ready', port: null, close: () => new Promise(() => {}) };
  const bridge = await startReadyBridge({ token: TOKEN, hosts: [], emit: () => {}, backends: { hang: hanging } });
  const started = Date.now();
  await bridge.close();
  assert.ok(Date.now() - started < 5000, `关桥被一个挂死的后端拖住了 ${Date.now() - started}ms`);
});

test('酷狗 operation 白名单：表外名字、原型链键、包内缺模块都在调用前拒（纯函数，离线可断）', async () => {
  const { KUGOU_OPERATIONS, resolveOperation, kugouModule } = await import('./bridge/backends/kugou.mjs');
  const stub = { lyric: async () => ({}), search: { default: async () => ({}) } };
  assert.equal(resolveOperation('lyric', stub), 'lyric', '白名单内且包里有 ⇒ 放行');
  // 包是 ESM 产物挂在 CJS 上：`api.search` 是 `{ default: fn }` 而不是函数（Task 2 实测）。
  // 少了这一跳，上游那句"module is not a function"就会在我们的调用点上重现。
  assert.equal(resolveOperation('search', stub), 'search', '命名空间形态的导出（.default）也必须认');
  assert.equal(typeof kugouModule(stub, 'search'), 'function');
  assert.equal(kugouModule(stub, 'user_cloud'), null, '包里没有的模块要老实返回 null');
  assert.equal(kugouModule({ audio: {} }, 'audio'), null, '{ default: 非函数 } 不算导出');
  for (const name of ['playlist_all', 'logout', 'constructor', '__proto__', 'lyric ']) {
    assert.throws(() => resolveOperation(name, { ...stub, [name]: async () => ({}) }),
      /不在酷狗 operation 白名单里/, `${JSON.stringify(name)} 必须被白名单挡下`);
  }
  // 第二道把关：白名单里的名字，包里却没有 ⇒ 报错要提前到调用前，不能把 TypeError 抛给 route。
  assert.throws(() => resolveOperation('user_playlist', stub), /酷狗包缺少模块：user_playlist/);
  assert.ok(!('logout' in KUGOU_OPERATIONS), '退出登录不走包（v1.6.0 无此模块，Task 0 U4 实测）');
  assert.ok(Object.isFrozen(KUGOU_OPERATIONS), '白名单必须冻结：运行期不许被请求参数改写');
  for (const [operation, name] of Object.entries(KUGOU_OPERATIONS)) {
    assert.equal(operation, name, `${operation} 的映射不该指向别的模块名（恒等表才是可审的表）`);
  }
  const src = await read('scripts/bridge/backends/kugou.mjs');
  assert.match(src, /kugouModule\(modules, resolveOperation\(operation, modules\)\)/, '调用点只准经过这两层，白名单才只有一个把关处');
  assert.doesNotMatch(src, /modules\[\s*(?:operation|name|op|req|body)\b/, '不许拿请求里的名字直接查表');
});

test('桥与后端一律离线可测：本自检不得 import 任何第三方后端包', async () => {
  const src = await read('scripts/check-music-bridge.mjs');
  // 只查"真的被引进来"的形态（from/require），否则本文件里作为字面量列出的包名会自己把自己判红。
  assert.doesNotMatch(src, /from ['"]@?(neteasecloudmusicapienhanced|yakult-green-tea|kugoumusicapi)/);
  assert.doesNotMatch(src, /require\(['"](neteasecloudmusicapienhanced|@neteasecloudmusicapienhanced|@yakult-green-tea|kugoumusicapi)/);
  const bridge = await read('scripts/bridge/online-bridge.mjs');
  assert.doesNotMatch(bridge, /^import .*from ['"](@neteasecloudmusicapienhanced|@yakult-green-tea|kugoumusicapi)/m,
    '桥的模块顶层不许静态引后端包：那样 hosts 传空也会把它们装进来');
});

// ── Task 3：桥客户端（music-server 侧的生命周期唯一持有者）───────────────────
// 这三条钉的是第五期最贵的三种事故：关着却起了进程、桥崩了带走本地播放、反复崩溃刷出一串进程。

/** 假子进程：只实现客户端真正用到的那几件事（stdout 事件、exit、kill、IPC channel）。 */
function fakeChild({ emitReady = true, exitAfter = null, onKill } = {}) {
  const listeners = new Map();
  const stdout = { setEncoding() {}, on: (name, fn) => { stdout._data = fn }, emit(text) { stdout._data?.(text) } };
  const stderr = { setEncoding() {}, on: () => {} };
  const child = {
    stdout, stderr, stdin: { end() {} }, channel: { posted: [], postMessage(m) { this.posted.push(m) } }, pid: 4242, killCalls: 0,
    listeners,
    on() {}, once(name, fn) { listeners.set(name, fn) },
    kill() { child.killCalls += 1; onKill?.(); if (exitAfter !== 'never') listeners.get('exit')?.(exitAfter ?? 0, exitAfter === 'never' ? undefined : 'SIGTERM') },
  };
  if (emitReady) setImmediate(() => stdout.emit(`${JSON.stringify({ evt: 'ready', aggregate: { host: '127.0.0.1', port: 4599 }, backends: [{ id: 'netease', state: 'ready' }] })}\n`));
  if (typeof exitAfter === 'number') setTimeout(() => listeners.get('exit')?.(1), exitAfter);
  return child;
}

test('开关全关 ⇒ 根本不 spawn：零子进程、零端口、phase=off，call 直接回 bridge-off', async () => {
  let spawns = 0;
  const client = createBridgeClient({
    getConfig: () => ({ online: { lyrics: false, search: false, streaming: false, covers: false } }),
    spawnOverride: () => { spawns += 1; return fakeChild() },
    backoffMs: [1], readyMs: 200,
  });
  assert.equal(client.status().phase, 'off');
  await client.ensure();
  assert.equal(client.childCount(), 0, '关闭时一个子进程都不许存在');
  assert.equal(spawns, 0, '连 spawn 调用都不能发生（不是"起了再杀"）');
  assert.deepEqual(await client.call('/bridge/status', {}), { ok: false, reason: 'bridge-off' });
  assert.deepEqual(client.status().hosts, [], '全关时后端清单是空的');
});

test('部分开着 ⇒ 只 spawn 一个桥；ready 之后 phase=ready、端口与后端状态可读', async () => {  const children = [];
  const client = createBridgeClient({
    getConfig: () => ({ online: { lyrics: true } }),                        // 只开歌词一项，其余三项没写过 ⇒ 按默认开启算
    spawnOverride: () => { const c = fakeChild(); children.push(c); return c },
    backoffMs: [1], readyMs: 500,
  });
  await client.ensure();
  await client.ensure();
  await client.ensure();                                        // 幂等：三次 ensure 只该有一个子进程
  assert.equal(children.length, 1, `ensure() 不幂等，起了 ${children.length} 个桥`);
  assert.equal(client.childCount(), 1);
  assert.equal(client.status().phase, 'ready');
  assert.equal(client.status().port, 4599, '端口来自 ready 事件里那个真在听的值');
  assert.deepEqual(client.status().backends, [{ id: 'netease', state: 'ready' }]);
});

test('退避有上限：连续失败 3 次后停在 unavailable，并且不留半死进程', async () => {
  let spawns = 0;
  const client = createBridgeClient({
    getConfig: () => ({ online: { lyrics: true } }),
    // 一起来就退出的桥：ready 永远等不到 ⇒ 触发退避重启
    spawnOverride: () => { spawns += 1; return fakeChild({ emitReady: false, exitAfter: 0 }) },
    backoffMs: [1, 1, 1], readyMs: 60,
  });
  await client.ensure();                                        // ensure() 只踢起监管协程
  const deadline = Date.now() + 4000;
  while (client.status().phase !== 'unavailable' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(client.restarts(), 3, '退避 1/2/3 三次机会，用完就停');
  assert.equal(client.status().phase, 'unavailable');
  assert.equal(client.childCount(), 0, '超限后不许留半死进程');
  assert.ok(spawns >= 4, `初次 + 3 次重启，实测 spawn=${spawns}`);
  // 关键的负面性质：到了 unavailable 之后，再 ensure 也不许偷偷重新拉起（否则就是无限刷进程）。
  const before = spawns;
  client.ensure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(spawns, before, 'unavailable 之后不得再自动拉起');
  const callResult = await client.call('/bridge/anything', {});
  assert.equal(callResult.ok, false, '桥不可用时 call 必须回可读原因，不许抛');
  assert.match(String(callResult.reason), /退出|不可用|没就绪|unavailable/);
});

test('崩溃隔离：call() 永不抛异常——子进程连 stdout 都没有时也只回 reason', async () => {
  const client = createBridgeClient({
    getConfig: () => ({ online: { lyrics: true } }),
    spawnOverride: () => ({ stdout: null, stderr: null, stdin: null, channel: null, on: () => {}, once: () => {}, kill: () => {} }),
    backoffMs: [1], readyMs: 40,
  });
  await client.ensure();
  const outcome = await client.call('/bridge/status', {});
  assert.equal(typeof outcome, 'object');
  assert.equal(outcome.ok, false, '坏掉的子进程必须落成一次失败结果，不是异常');
  assert.ok(typeof outcome.reason === 'string' && outcome.reason.length > 0);
});

test('优雅关停：先走 IPC shutdown 与 stdin 关管道，1.5 秒内没退才 kill，之后 phase=off', async () => {
  let killed = 0;
  const child = fakeChild({ exitAfter: 'never', onKill: () => { killed += 1 } });
  const client = createBridgeClient({
    getConfig: () => ({ online: { lyrics: true } }),
    spawnOverride: () => child,
    backoffMs: [1], readyMs: 500,
  });
  await client.ensure();
  assert.equal(client.status().phase, 'ready');
  const result = await client.shutdown();
  assert.deepEqual(child.channel.posted.map((m) => m.cmd), ['shutdown'], '关停要先经 IPC 命令，命令里带令牌');
  assert.equal(child.channel.posted[0].cmd, 'shutdown');
  assert.ok(child.channel.posted.every((m) => typeof m.token === 'string' && m.token.length >= 32), 'IPC 消息必须带令牌');
  assert.equal(result.forced, true, '假子进程不肯自己退 ⇒ 必须升级为 kill');
  assert.equal(killed, 1);
  assert.equal(client.status().phase, 'off', '关停后不得再被监管协程拉起来');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(client.childCount(), 0, '关停后监管协程必须已经退出');
});

test('cwd 固定成数据目录：包依赖里有人从 cwd 读 .env，不能让它成为改变后端行为的通道', async () => {
  const seen = [];
  const client = createBridgeClient({
    getConfig: () => ({ online: { lyrics: true } }), dataDir: 'D:/rhine-music-data-test',
    spawnOverride: () => { seen.push(1); return fakeChild() },
    bridgeEntry: '/fake/entry.mjs', backoffMs: [1], readyMs: 300,
  });
  // 用真的 spawn 形状验 cwd：这里换成一个记录参数的假 spawn（客户端走 spawnOverride 时不带 cwd，
  // 所以这条断言读的是源码——它验的是"生产路径那一行"，不是假对象）。
  const src = await read('scripts/online-bridge-client.mjs');
  assert.match(src, /cwd: dataDir \?\? process\.cwd\(\)/, 'spawn 的 cwd 必须锚在数据目录');
  await client.ensure();
  assert.equal(seen.length, 1);
});

test('QQ 通道只走自写 fcg + guardedFetch：包不得被桥 require（R83 撤回后的新形状）', async () => {
  // 为什么这条值得钉死：包内部是 axios，绕开我们的安全层 ⇒ 出网审计表上看不见它打了谁。
  // 桥只起两个包后端，QQ 那一家由本项目自己发 fcg 请求（第四期起就是这样，实测可用）。
  const qq = await read('scripts/online-lyrics.mjs');
  assert.match(qq, /import \{ guardedFetch/, 'QQ 的每一笔出网都要过安全层');
  assert.match(qq, /QQ_FCG = 'https:\/\/u\.y\.qq\.com\/cgi-bin\/musicu\.fcg'/, ' fcg 端点是常量，不是拼出来的');
  assert.match(qq, /kind: 'lyrics'/, '审计表的用途列要带上，面板才分得清是歌词还是别的');
  // 桥目录下不许出现 QQ 包的任何 import/require —— 这是"少一个监听面 + 少一笔不被审计的出网"的实现点。
  for (const name of ['online-bridge.mjs', 'lyric-routes.mjs', 'loopback.mjs', 'backends/bootstrap.mjs',
    'backends/netease.mjs', 'backends/kugou.mjs']) {
    const text = await read(`scripts/bridge/${name}`);
    assert.doesNotMatch(text, /qq-music-api/, `${name} 不该 require QQ 包`);
  }
  // 包仍在独立依赖树里（M3 的扫码登录要用它），但 app 的依赖集合一个字节都不能变——那条由
  // check-music-online-discipline 的 R73 钉着，这里只补一句：bridge 的依赖表不能因为"暂时不用"被删项。
  const bridgePkg = JSON.parse(await read('scripts/bridge/package.json'));
  assert.ok('@yakult-green-tea/qq-music-api' in bridgePkg.dependencies,
    'QQ 包留在桥的依赖树里备用（M3 登录），只是本期不起它');
});

// ── Task 5：桥侧歌词通道（网易 / 酷狗）。全部离线：假后端句柄，不加载任何第三方包 ──
const { isQrcPayload, countTimedLines } = await import('./online-normalize.mjs');
const { registerLyricRoutes } = await import('./bridge/lyric-routes.mjs');
const lyrics = await import('./bridge/providers/lyrics.mjs');

test('网易 NDJSON 段 → 行级 LRC：富字段丢掉、坏行跳过、普通 LRC 行原样保留', () => {
  // 形状取自 Task 5 真实探针：/lyric/new 的 lyric 是"每行一个 JSON 对象"
  const raw = [
    '{"t":0,"c":[{"tx":"作词: "},{"tx":"刘嘉星"}]}',
    '{"t":1000,"c":[{"tx":"作曲: "},{"tx":"刘嘉星","li":"http://p1.music.126.net/x.jpg"}]}',
    '{"t":61000,"c":[{"tx":"第二行"}]}',
    '{ 坏掉的半行',
    '{"t":9000,"c":[{"tx":"   "}]}',
  ].join('\n');
  const lrc = lyrics.ncmSegmentsToLrc(raw);
  assert.deepEqual(lrc.split('\n'), ['[00:00.00]作词: 刘嘉星', '[00:01.00]作曲: 刘嘉星', '[01:01.00]第二行'],
    '时间戳统一到 [mm:ss.xx]；富字段（li/or）与空白行必须被丢掉，坏行不许把整首歌带坏');
  assert.equal(countTimedLines(lrc), 3);
  assert.equal(lyrics.ncmSegmentsToLrc(''), '');
  // /lyric（老端点）给的就是普通 LRC：不能被再包一层
  assert.equal(lyrics.ncmSegmentsToLrc('[00:01.00]ALPHA\n[00:05.00]BETA'), '[00:01.00]ALPHA\n[00:05.00]BETA');
});

test('网易两个歌词端点的字段名不同，在这里一次收敛（new 给段、老端点给 lrc + tlyric）', () => {
  const fromNew = lyrics.ncmLyricToText({ lyric: '{"t":900,"c":[{"tx":"第一行"}]}\n{"t":2000,"c":[{"tx":"第二行"}]}' });
  assert.equal(fromNew.text, '[00:00.90]第一行\n[00:02.00]第二行');
  assert.equal(fromNew.translation, undefined);
  const fromOld = lyrics.ncmLyricToText({ lrc: { lyric: '[00:00.90]第一行' }, tlyric: { lyric: '[00:00.90]译文行' } });
  assert.deepEqual(fromOld, { text: '[00:00.90]第一行', translation: '[00:00.90]译文行' });
  assert.equal(lyrics.ncmLyricToText({}).text, '', '两个字段都没有就是没有，不许造出空串命中');
  assert.equal(lyrics.ncmLyricToText({ lrc: { lyric: 'x' }, tlyric: { lyric: '   ' } }).translation, undefined, '空白译文要归成 undefined');
});

test('KRC → 内部逐字写法：词级标记换成 QRC 那一跳，岛内不必新增格式', () => {
  // 实测酷狗 decodeContent：[900,3020]<0,430,0>张<430,440,0>磁带<870,1790,0>…
  const krc = '[offset:0]\r\n[900,3020]<0,430,0>张<430,440,0>磁带<870,1790,0>一再\n[4000,1000]<0,500,0>你好';
  const out = lyrics.krcToWordMarks(krc);
  assert.equal(out.split('\n').length, 2, '[offset:0] 这类无计时行必须丢掉');
  assert.ok(/^\[\d+,\d+\]/m.test(out));
  assert.ok(!/<\d+,\d+,\d+>/.test(out), 'KRC 的三元标记不该留下');
  assert.equal(isQrcPayload(out), true, '转完必须被既有的"逐字"判据认出来，否则徽标与解析都会退成行级');
  const converted = lyrics.kugouLyricToText({ decodeContent: krc });
  assert.equal(converted.format, 'krc');
  assert.equal(lyrics.kugouLyricToText({ decodeContent: '[00:01.00]A\n[00:02.00]B\n[00:03.00]C' }).format, 'lrc', '行级正文别硬说成逐字');
  assert.equal(lyrics.kugouLyricToText({}).text, '');
});

test('候选形状统一：网易要 id、酷狗要 id + accesskey（缺 accesskey 实测包直接抛）', () => {
  const ncm = lyrics.ncmSearchToCandidates({ result: { songs: [{ id: 2600493765, name: '恋人', artists: [{ name: '李荣浩' }], album: { name: '黑马' }, duration: 251000 }, { id: 0, name: '缺 id' }] } });
  assert.deepEqual(ncm[0], { sourceId: '2600493765', name: '恋人', artists: [{ name: '李荣浩' }], album: { name: '黑马' }, durationMs: 251000 });
  assert.equal(ncm.length, 1, 'id 为 0/空的候选不进表（它取不到词，只会浪费一次探测）');
  // 字段名用 Task 5 真实探针抄下来的那一份：song / singer（不是上游文档里的 song_name / singer_name）
  const kg = lyrics.kugouSearchToCandidates({ candidates: [{ id: '494789046', accesskey: '620D4BEB', song: '恋人', singer: '李荣浩', duration: 35000, krctype: 2 }, { id: '1', accesskey: 'AK', song_name: '老写法仍然认', singer_name: '某人' }, { id: '2', song: '没有 accesskey' }] });
  assert.deepEqual(kg.map((c) => c.name), ['恋人', '老写法仍然认']);
  assert.equal(kg[0].artists[0].name, '李荣浩');
  assert.equal(kg[0].durationMs, 0, '时长单位没被证实 ⇒ 不映射，让时长项自动不参与打分（拿没证实的数字打分会误杀）');
});

test('歌词路由：源名与动作都是白名单，后端没就绪就是可读的 ok:false（不抛、不 5xx）', async () => {
  const routes = new Map();
  const backends = { netease: { state: 'error', reason: '包没起来' } };
  registerLyricRoutes({ routes, backends });
  const handler = routes.get('/bridge/lyrics');
  assert.ok(handler, '/bridge/lyrics 必须挂上');
  assert.equal((await handler({ source: 'tencent', action: 'search' })).ok, false, '不认识的源要拒');
  assert.match((await handler({ source: 'tencent' })).reason, /不支持的歌词源/);
  assert.match((await handler({ source: 'netease', action: 'search', keywords: 'x' })).reason, /未就绪.*包没起来/, '后端状态要原话报出来');
  assert.match((await handler({ source: 'kugou', action: 'explode' })).reason, /未就绪|未知的歌词动作/);
  assert.match((await handler({ source: 'netease', action: 'lyric', mediaId: '../../etc' })).reason, /未就绪/);
});

test('歌词路由：检索与取词两跳都通，且每一笔都带 provider（审计行要用）', async () => {
  const routes = new Map();
  const seen = [];
  const backends = {
    netease: { state: 'ready', baseUrl: 'http://127.0.0.1:1' },
    kugou: {
      state: 'ready',
      invoke: async (operation, params) => {
        seen.push([operation, params]);
        if (operation === 'search_lyric') return { status: 200, body: { status: 200, candidates: [{ id: '77', accesskey: 'AK', song_name: '恋人', singer_name: '李荣浩' }] } };
        return { status: 200, body: { status: 200, decodeContent: '[900,3020]<0,430,0>张<430,440,0>磁带<870,1790,0>一再\n[4000,1000]<0,500,0>你好\n[9000,1000]<0,500,0>世界' } };
      },
    },
  };
  registerLyricRoutes({ routes, backends });
  const handler = routes.get('/bridge/lyrics');
  const search = await handler({ source: 'kugou', action: 'search', keywords: '恋人 李荣浩' });
  assert.equal(search.ok, true);
  assert.equal(search.provider, 'kugou');
  assert.equal(search.candidates[0].accessKey, 'AK');
  const lyric = await handler({ source: 'kugou', action: 'lyric', mediaId: '77', accessKey: 'AK' });
  assert.equal(lyric.ok, true);
  assert.equal(lyric.provider, 'kugou');
  assert.equal(lyric.format, 'krc');
  assert.equal(isQrcPayload(lyric.text), true, '桥交给服务端的酷狗词必须是既有的逐字形状');
  assert.deepEqual(seen[1][0], 'lyric', '取词走的是白名单里的 operation 名');
  // 缺 accesskey 时不要去敲包（实测它会抛一个非 Error 对象）
  const noKey = await handler({ source: 'kugou', action: 'lyric', mediaId: '77' });
  assert.equal(noKey.ok, false);
  assert.match(noKey.reason, /accesskey/);
  assert.equal(seen.length, 2, '缺参数时不得再敲包');
});

test('桥侧异常不许变成抛出：包抛非 Error 对象时也要落成一句可读原因（实测酷狗会抛对象）', async () => {
  const routes = new Map();
  const backends = { kugou: { state: 'ready', invoke: async () => { throw { code: -1, message: '内部炸了' } } } };
  registerLyricRoutes({ routes, backends });
  const result = await routes.get('/bridge/lyrics')({ source: 'kugou', action: 'search', keywords: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'kugou');
  assert.match(result.reason, /酷狗 通道异常/, `实测回的是：${result.reason}`);
});

// ── R224 · 平台身份：不再设 `process.env.platform`（= 与原版桥同形状，全部酷狗跳跑非 lite 族）────
test('R224（i）桥树里不再有任何 platform 赋值，且 applyBackendEnv 跑完 env 仍是"没设"（反向钉：加回去就红）', async () => {
  // 源码级：扫整棵桥树（剥掉注释行——注释里写"原来设过什么"是说明，不是设）
  const { readdir } = await import('node:fs/promises');
  const files = [];
  const collect = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collect(full); else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  await collect(join(SCRIPTS, 'bridge'));
  const hits = [];
  for (const file of files) {
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      const bare = line.trim();
      if (bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*')) continue;
      if (/process\.env\.platform\s*(?:\|\||\+|\?|&&)?=(?!=)/.test(bare)) hits.push(`${file.split(sep).slice(-2).join('/')}：${bare.slice(0, 64)}`);
    }
  }
  assert.ok(files.length >= 15, `桥树只扫到 ${files.length} 个文件（这棵树有 18 个 .mjs），这条判据在空转`);
  assert.deepEqual(hits, [], `平台身份只能"什么都不设"（原版桥就是这样），不许有任何一处赋值：\n${hits.join('\n')}`);

  // 行为级：真调用我们那一个函数，跑完必须是"没设"（加回那一行 ⇒ 这里红）
  const { applyBackendEnv } = await import('./bridge/backends/bootstrap.mjs');
  const had = Object.prototype.hasOwnProperty.call(process.env, 'platform');
  const saved = process.env.platform;
  delete process.env.platform;
  try {
    applyBackendEnv();
    assert.equal(process.env.platform, undefined, 'applyBackendEnv 不再设平台身份（设回去就把酷狗主机发回 http-only 那一族）');
    assert.equal(process.env.ENABLE_GENERAL_UNBLOCK, 'false', '本批只删一行：网易那条默认值照旧在');
  } finally {
    if (had) process.env.platform = saved; else delete process.env.platform;
    delete process.env.ENABLE_GENERAL_UNBLOCK;
  }

  // 三条老规矩不许被"顺手"改掉：注释要说清不能窗口式注入、公共 env 仍在任何后端 require 之前、不许用 withEnv 绕回来
  const boot = await read('scripts/bridge/backends/bootstrap.mjs');
  assert.match(boot, /每次请求/, '注释要写清包是每次请求读它（否则这条会被"顺手优化"成窗口式注入）');
  const entry = await read('scripts/bridge/online-bridge.mjs');
  const at = entry.indexOf('applyBackendEnv()');
  assert.ok(at > 0 && at < entry.indexOf("start('netease'"), '公共 env 仍在任何后端 require 之前调用');
  assert.doesNotMatch(entry, /withEnv\(\{ platform/, '不许改用窗口式注入把这一格绕回来');
});

test('酷狗歌词响应形状：缺 candidates 字段是故障，空数组才是"没词"（真机踩过：混成一句会把故障说成没词）', async () => {
  const routes = new Map();
  const backends = { kugou: { state: 'ready', invoke: async () => ({ status: 200, body: {} }) } };   // 身份没带对时包的真实形状
  registerLyricRoutes({ routes, backends });
  const result = await routes.get('/bridge/lyrics')({ source: 'kugou', action: 'search', keywords: 'x' });
  assert.equal(result.ok, false, '缺 candidates 字段是故障，不是空结果');
  assert.match(result.reason, /不是"没有词"/);
  // 对照：真的有 candidates 但为空数组 ⇒ ok:true + 空表（让编排层给出"这个源没有候选"）
  const empty = new Map();
  registerLyricRoutes({ routes: empty, backends: { kugou: { state: 'ready', invoke: async () => ({ status: 200, body: { status: 200, candidates: [] } }) } } });
  const second = await empty.get('/bridge/lyrics')({ source: 'kugou', action: 'search', keywords: 'x' });
  assert.equal(second.ok, true);
  assert.deepEqual(second.candidates, []);
});

test('桥的内部一跳只认环回前缀：别的地址当场拒（这一句把 R75 的例外变成有闸的例外）', async () => {
  const { loopbackFetch, isLoopbackBridgeTarget } = await import('./bridge/loopback.mjs');
  assert.equal(isLoopbackBridgeTarget('http://127.0.0.1:1234/lyric/new?id=1'), true);
  for (const bad of ['http://localhost:1234/x', 'http://127.0.0.1.evil.example/x', 'https://u.y.qq.com/cgi-bin/x',
    'http://[::1]:1234/x', 'file:///etc/passwd', '', 'http://127.1/x']) {
    assert.equal(isLoopbackBridgeTarget(bad), false, `${bad} 不该被当成环回`);
    await assert.rejects(() => loopbackFetch(bad), /只允许打/, `${bad} 必须被拒`);
  }
});

// ── Task 3：music-server 侧的在线路由（开关判定排在任何桥调用之前）────────────

const { createMusicServer } = await import('./music-server.mjs');

/** 只实现路由要用到的那几件事的假曲库；在线开关走真的四张子表。 */
function routeStore(online = { lyrics: true, search: true, streaming: true, covers: true }) {
  const calls = { match: 0, updateConfig: 0 };
  const store = {
    calls,
    dataDir: 'D:/rhine-music-route-test',
    config: { version: 1, roots: [], online: { ...online }, onlineEnabled: false, foobarBaseUrl: null, musicBrainzContact: '' },
    musicBrainzContact: '',
    scanPromise: null,
    scan: async () => ({}),
    reloadRules: async () => {},
    snapshot: () => ({
      version: 1, albums: [], genres: [], roots: [], scan: { running: false },
      enrich: { running: false, completed: 0, total: 0 }, introductions: { running: false },
      onlineEnabled: false, online: { ...store.config.online },
      onlineLyrics: { enabled: store.config.online.lyrics === true },
    }),
    // 真校验由 check-music-online.mjs 的 R77 那条用真 store 覆盖；这里只复刻"抛出必须兑现成 4xx"所需的那几条。
    updateConfig: async (value) => {
      calls.updateConfig += 1;
      if (value.online) {
        if (typeof value.online !== 'object' || Array.isArray(value.online)) throw new Error('online 必须是 { lyrics, search, streaming, covers } 的布尔表');
        const unknown = Object.keys(value.online).filter((key) => !['lyrics', 'search', 'streaming', 'covers'].includes(key));
        if (unknown.length) throw new Error(`online 里有不认识的开关：${unknown.join('、')}`);
      }
      if (value.online?.lyrics !== undefined && value.onlineLyrics !== undefined
        && value.online.lyrics !== value.onlineLyrics.enabled) throw new Error('online.lyrics 与旧字段 onlineLyrics.enabled 冲突：请只提交一项');
      if (value.online) store.config.online = { ...store.config.online, ...value.online };
      if (value.onlineLyrics !== undefined) store.config.online = { ...store.config.online, lyrics: value.onlineLyrics.enabled };
      return { ...store.config, onlineLyrics: { enabled: store.config.online.lyrics === true } };
    },
    trackForOnlineMatch: () => null,
  };
  return store;
}

/** 只数调用、不起进程的假桥。 */
function routeBridge(phase = 'ready') {
  const calls = [];
  return {
    calls,
    ensureCalls: 0,
    shutdownCalls: 0,
    status: () => ({
      phase, port: phase === 'ready' ? 4599 : 0, backends: [{ id: 'netease', state: 'ready' }],
      unauthorized: 0, restarts: 0, lastError: phase === 'unavailable' ? '桥进程退出（code=1）' : null,
      hosts: ['netease', 'kugou'],
    }),
    ensure: () => { calls.push(['ensure', phase]); return Promise.resolve() },
    call: async (route, payload) => { calls.push([route, payload]); return { ok: false, reason: '假桥不应答' } },
    shutdown: async () => { calls.push(['shutdown', phase]); return { forced: false } },
  };
}

async function withRouteServer(store, bridge, run) {
  const { server } = await createMusicServer({
    store, distDir: SCRIPTS, autoScan: false, bridgeClient: bridge,
    onlineLyricsMatcher: { match: async () => ({ matched: false }), clearCache: () => {} },
  });
  // R211（A 类第 1 处）：升级到 R198 的 listenAndReady（连不上就关掉这台、换端口重听），且**坏探测不许漏服务句柄** ——
  // 抛错前先把这台关干净再原样抛（这个夹具的 store 是假对象、没有真实临时目录 ⇒ 第②条落在"服务已关 + 错误原样抛"）。
  let origin;
  try {
    ({ origin } = await listenAndReady(server));
  } catch (error) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  try { await run(origin) } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
  return server;
}

test('GET /api/online/status 报的是桥的真实阶段与四张开关，且不因为读状态而调用桥', async () => {
  const bridge = routeBridge('ready');
  await withRouteServer(routeStore(), bridge, async (origin) => {
    const body = await (await fetch(`${origin}/api/online/status`)).json();
    assert.equal(body.phase, 'ready');
    assert.equal(body.port, 4599);
    assert.deepEqual(body.switches, { lyrics: true, search: true, streaming: true, covers: true });
    assert.deepEqual(body.backends, [{ id: 'netease', state: 'ready' }]);
    assert.equal(bridge.calls.length, 0, '读状态只读客户端自己的表，不该发一次桥调用');
    assert.equal((await fetch(`${origin}/api/online/status`, { method: 'POST' })).status, 405);
  });
  const down = routeBridge('unavailable');
  await withRouteServer(routeStore(), down, async (origin) => {
    const res = await fetch(`${origin}/api/online/status`);
    assert.equal(res.status, 200, '桥不可用时状态仍然要能读（这正是它存在的意义）');
    assert.match((await res.json()).lastError, /code=1/);
  });
});

test('关着零暴露：四张开关全关时在线歌词路由 404，且一次桥调用都没发生', async () => {
  const off = { lyrics: false, search: false, streaming: false, covers: false };
  const bridge = routeBridge('ready');
  await withRouteServer(routeStore(off), bridge, async (origin) => {
    const res = await fetch(`${origin}/api/online/lyrics/match`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"trackId":"track-a"}',
    });
    assert.equal(res.status, 404, '关闭时必须是 404，不是 503（根本没走到桥那一层）');
    assert.match((await res.json()).error, /已关闭/);
    assert.equal(bridge.calls.length, 0, '关闭时不得调用桥');
    const status = await (await fetch(`${origin}/api/online/status`)).json();
    assert.deepEqual(status.switches, off, '面板要能读回"这四张都是关的"');
    // 本地核心一条都不能受影响：曲库快照照常 200。
    assert.equal((await fetch(`${origin}/api/library`)).status, 200);
  });
});

test('开关判定排在方法判定之前：关闭时 GET 也回 404，不用 405 泄露"这里有个在线路由"', async () => {
  const bridge = routeBridge('ready');
  await withRouteServer(routeStore({ lyrics: false, search: true, streaming: true, covers: true }), bridge, async (origin) => {
    assert.equal((await fetch(`${origin}/api/online/lyrics/match`)).status, 404);
    assert.equal(bridge.calls.length, 0);
  });
});

test('R77 落到路由上：/api/config 收新表也收旧字段，响应里的 onlineLyrics 是镜像不是第二处真源', async () => {
  const store = routeStore();
  const bridge = routeBridge('off');
  await withRouteServer(store, bridge, async (origin) => {
    const post = async (body) => {
      const res = await fetch(`${origin}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return [res.status, await res.json()];
    };
    let [status, saved] = await post({ online: { covers: false } });
    assert.equal(status, 200);
    assert.equal(saved.online.covers, false, '新表部分提交要原样回读');
    assert.equal(saved.online.lyrics, true, '没提交的那一项不受影响');
    assert.equal(saved.onlineLyrics.enabled, true, '镜像跟着新表走');
    [status, saved] = await post({ onlineLyrics: { enabled: false } });
    assert.equal(status, 200, '面板今天还只发旧字段，必须继续接受');
    assert.equal(store.config.online.lyrics, false, '旧字段写的其实是 online.lyrics');
    assert.equal(saved.onlineLyrics.enabled, false);
    [status] = await post({ online: { lyrics: true }, onlineLyrics: { enabled: false } });
    assert.equal(status, 400, '两处同时提交且不一致 ⇒ 拒绝（真源只能有一个）');
    const got = await (await fetch(`${origin}/api/config`)).json();
    assert.equal(got.onlineLyrics.enabled, false, 'GET 也带镜像（前端读的是这一项）');
    assert.equal('onlineLyrics' in got, true);
    assert.equal(store.calls.updateConfig, 3, '三次都进到 updateConfig；冲突那次在里面抛出，配置不该被改写');
    assert.equal(store.config.online.lyrics, false, '被拒的那次提交不得留下半个改动');
  });
});

test('开关一改变就要兑现到进程层面：全关 ⇒ 关掉桥；从全关再打开 ⇒ 重新 ensure', async () => {
  const bridge = routeBridge('ready');
  await withRouteServer(routeStore(), bridge, async (origin) => {
    const res = await fetch(`${origin}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ online: { lyrics: false, search: false, streaming: false, covers: false } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(bridge.calls, [['shutdown', 'ready']], '全关必须真的把子进程关掉，而不是只在调用前挡一下');
  });
  const reopen = routeBridge('off');
  await withRouteServer(routeStore({ lyrics: false, search: false, streaming: false, covers: false }), reopen, async (origin) => {
    const res = await fetch(`${origin}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ online: { covers: true } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(reopen.calls, [['ensure', 'off']], '从全关回到开启 ⇒ 踢一次重启（顺带重置退避计数由客户端负责）');
  });
});

test('客户端读的是实时开关表：updateConfig 会整个换掉 config 对象，抓引用会一直看到旧开关', async () => {
  let current = { online: { lyrics: true, search: true, streaming: true, covers: true } };
  const spawned = [];
  const client = createBridgeClient({
    getConfig: () => current,
    spawnOverride: () => { const c = fakeChild(); spawned.push(c); return c },
    backoffMs: [1], readyMs: 300,
  });
  await client.ensure();
  assert.equal(spawned.length, 1);
  current = { online: { lyrics: false, search: false, streaming: false, covers: false } };
  assert.deepEqual(client.status().hosts, [], '开关表必须是活的，不然"关着零暴露"只在第一次成立');
  assert.deepEqual(await client.call('/bridge/status', {}), { ok: false, reason: 'bridge-off' });
  assert.equal(spawned.length, 1, '关掉之后不得再起新的子进程');
  // 再打开：走"服务端那条 reconcile 序列"（全关时先 shutdown，再打开时 ensure）⇒ 应该起一个**新**桥。
  await client.shutdown();
  current = { online: { lyrics: true, search: true, streaming: true, covers: true } };
  await client.ensure();
  assert.equal(client.status().phase, 'ready');
  assert.equal(spawned.length, 2, 'shutdown 之后重新打开 ⇒ 起一个新的桥');
  assert.equal(spawned[0].killCalls, 1, 'shutdown 走的是 kill 当前子进程那一步（假子进程不肯自己退）');
});

test('P0：桥的环回一跳不吃 globalThis.fetch —— 守卫换档期间它也必须打得通自己', async () => {
  const http = await import('node:http');
  const { loopbackFetch } = await import('./bridge/loopback.mjs');
  // 一个真的环回服务：这一跳是桥内所有网易路由（取址/搜索/歌单）的共同通路。
  const target = http.createServer((request, response) => { response.writeHead(200); response.end('pong') });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${target.address().port}`;
  const before = globalThis.fetch;
  let swallowed = 0;
  try {
    // 模拟"全局被人换了档"（守卫在飞、或曾经泄漏过一次）：环回一跳必须不受影响。
    globalThis.fetch = async () => { swallowed += 1; throw new Error('守卫接管了全局 fetch') };
    const response = await loopbackFetch(`${origin}/song/url?id=1`);
    assert.equal(await response.text(), 'pong', '环回一跳要照旧打得通');
    assert.equal(swallowed, 0, 'loopbackFetch 不许调用"当前全局那一份"——它打的是我们自己，不是出网');
  } finally {
    globalThis.fetch = before;
    target.close();
  }
  // 判据本身还在：非环回的地址照样被这道前缀关拒掉（免疫不等于放开）。
  await assert.rejects(() => loopbackFetch('https://music.163.com/x'), /只允许打 http:\/\/127\.0\.0\.1:/);
});

// ── R154（任务一）：酷狗设备身份与取址/检索两跳 ────────────────────────────────
// 这一段的每一条都对应一次一手实测，或一条被批准但**默认不用**的路线，注释里写明是哪一条。

const kugouDevice = await import('./bridge/providers/kugou-device.mjs');
const { registerAudioRoutes: registerAudioRoutesR154 } = await import('./bridge/audio-routes.mjs');
const { registerSearchRoutes: registerSearchRoutesR154 } = await import('./bridge/search-routes.mjs');

/** 假酷狗后端：按 operation 回预设，并把每一笔 (operation, params) 记下来（"调用点唯一"就靠数这个）。 */
function fakeKugou(replies) {
  const calls = [];
  return {
    calls,
    state: 'ready',
    invoke: async (operation, params) => {
      calls.push({ operation, params });
      const reply = replies[operation];
      const resolved = typeof reply === 'function' ? reply(params, calls.filter((c) => c.operation === operation).length) : reply;
      if (resolved && resolved.__throw) throw resolved.__throw;
      return resolved;
    },
  };
}

test('R154/R218 权益闸：只用 priv_status:1 那一档；上游给了地址但 priv_status:0 ⇒ 判「没有权益」，不拿整首文件播片段', () => {
  // 传进去的是**响应体**（桥那一侧取完 `result.body` 才交给这一层），与真机回读的形状一致。
  const playable = kugouDevice.kugouSongUrlToSource({ status: '1', priv_status: '1', extName: 'mp3', fileSize: 4069795, timeLength: 254, bitRate: 128000, url: ['http://fsandroid.kugou.com/a.mp3', 'http://fsmobile.tx.kugou.com/a.mp3'] });
  assert.equal(playable.ok, true);
  assert.equal(playable.url, 'http://fsandroid.kugou.com/a.mp3', 'url 仍是第一条（兼容单条消费方）');
  // R218：候选表**整份带出桥**（实测上游按曲目给不同 CDN，其中一部分只有明文主机）——
  // 挑哪台由父进程按出口白名单定；桥这一层如实搬运，不许悄悄丢候选。
  assert.deepEqual(playable.urls, ['http://fsandroid.kugou.com/a.mp3', 'http://fsmobile.tx.kugou.com/a.mp3'],
    '第二条候选要活着到父进程：从前丢掉它正是「素颜能播、坏女孩 502」的机制（R218）');
  assert.equal(playable.scope, 'full', 'scope 来自实测的两格数字，不是拿时长猜的（R101）');
  assert.equal(playable.size, 4069795);

  // 实测形状：无权益那一档**照样回了 url**，但 priv_status 是 0 ⇒ 那是「整首文件 + 片段偏移」的形态。
  const denied = kugouDevice.kugouSongUrlToSource({ status: '1', priv_status: '0', url: ['http://fsandroid.kugou.com/a.mp3'], hash_offset: { start_ms: 0, end_ms: 30000 } });
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, true, '这一档要单独分类：界面与回落都不许把它当成「通道坏了」');
  assert.equal(denied.unavailable, true);
  assert.match(denied.reason, /不拿片段冒充整首/);

  const noFile = kugouDevice.kugouSongUrlToSource({ status: '2', priv_status: '0' });
  assert.equal(noFile.ok, false);
  assert.equal(noFile.unavailable, true, '「这一家不给这首」是权益事实，与桥没起来分开（回落只认这一类）');
  assert.equal(noFile.noUrl, true, '「这一档没文件」要能和「这个账号没权益」分开：前者降档再问，后者直接停');
  const code20018 = kugouDevice.kugouSongUrlToSource({ status: '2', priv_status: '0', error_code: 20018 });
  assert.match(code20018.reason, /20018/);
  assert.equal(code20018.noUrl, undefined, '20018 是权益，降档也救不了 ⇒ 不许标成"换一档再问"');
  const shapeBad = kugouDevice.kugouSongUrlToSource({ status: '0' });
  assert.equal(shapeBad.unavailable, undefined, '认不出来的形状不当成「权益没有」，也不当成可用');
});

test('R154 dfid 那条实测分界：cookie 里必须**显式带 dfid**（空串 ⇒ 上游读成 -），不带就是让包塞一个随机设备号', () => {
  const cookie = kugouDevice.buildKugouCookie({ mid: '123456789012345678901234567890123456' });
  assert.equal('dfid' in cookie, true, '少这一格 ⇒ 包 song_url.js 自己 randomString(24)，实测那一档 502');
  assert.equal(cookie.dfid, '', '带的是空串：经 util/request.js 那句「或 -」折成「没有设备号」，不是伪造一个');
  assert.equal(cookie.KUGOU_API_MID, '123456789012345678901234567890123456');
  const empty = kugouDevice.buildKugouCookie({});
  assert.equal('KUGOU_API_MID' in empty, false, 'mid 没有就不带（带个空值等于对上游撒谎说「有但是空」）');
  assert.equal('token' in empty, false, '凭据缺席的键整格不存在（与 R148 那次「不给这个键」同一形状）');
  assert.equal(empty.dfid, '', 'dfid 是唯一「没值也要带」的，理由见上');
});

test('R154 只有「需要设备校验」才允许走注册那一跳：152 与 20018 都不算（把参数错/权益错当成设备问题就是误诊）', () => {
  assert.equal(kugouDevice.kugouNeedsDeviceVerification({ body: { error_code: 20028 } }), true);
  assert.equal(kugouDevice.kugouNeedsDeviceVerification({ body: { error_msg: '本次请求需要验证' } }), true);
  assert.equal(kugouDevice.kugouNeedsDeviceVerification({ body: { error_code: 152 } }), false, '152=Parameter Error（R153 那一格）');
  assert.equal(kugouDevice.kugouNeedsDeviceVerification({ body: { error_code: 20018 } }), false, '20018=权益不足，注册一台设备也救不了');
  assert.equal(kugouDevice.kugouNeedsDeviceVerification(undefined), false);
});

test('R154 成功路径一次都不注册；撞上 20028 且开关关着 ⇒ 也不注册，只给一句实话', async () => {
  const okHandle = fakeKugou({ song_url: { status: 200, body: { status: '1', priv_status: '1', url: ['http://fsandroid.kugou.com/a.mp3'] } } });
  const done = await kugouDevice.kugouDeviceCall(okHandle, 'song_url', { hash: 'abc' }, { guid: 'g'.repeat(36), mid: '123', deviceIdentity: false });
  assert.equal(done.ok, true);
  assert.deepEqual(okHandle.calls.map((c) => c.operation), ['song_url'], '成功就不该多一跳注册');

  const needHandle = fakeKugou({ song_url: { __throw: { status: 502, body: { error_code: 20028 } } } });
  const offSwitch = await kugouDevice.kugouDeviceCall(needHandle, 'song_url', { hash: 'abc' }, { guid: 'g'.repeat(36), mid: '123', deviceIdentity: false });
  assert.equal(offSwitch.ok, false);
  assert.match(offSwitch.reason, /开关是关着的/);
  assert.deepEqual(needHandle.calls.map((c) => c.operation), ['song_url'], '关着 ⇒ register_dev 一次都不许调（本批默认状态就长这样）');
});

test('R154 打开备用路时的序列恰好是「问 → 注册 → 再问一次」，第三次都不许有（原版 kugouTransport.ts:400-402 同一条）', async () => {
  const handle = fakeKugou({
    song_url: (params, nth) => (nth === 1 ? { __throw: { status: 502, body: { error_code: 20028 } } } : { status: 200, body: { status: '1', priv_status: '1', url: ['http://fsandroid.kugou.com/a.mp3'] } }),
    register_dev: { status: 200, body: { data: { dfid: 'A'.repeat(24) } } },
  });
  const done = await kugouDevice.kugouDeviceCall(handle, 'song_url', { hash: 'abc' }, { guid: 'g'.repeat(36), mid: '123', deviceIdentity: true });
  assert.equal(done.ok, true);
  assert.deepEqual(handle.calls.map((c) => c.operation), ['song_url', 'register_dev', 'song_url']);
  assert.equal(done.rotated, true);
  assert.equal(done.device.dfid, 'A'.repeat(24), '换到的 dfid 要回报给父进程落盘（桥自己不写文件）');
  // 注册那一跳带的是我们那把 guid，代码里不出现 IMEI 一类字面量（包自己从 cookie.KUGOU_API_GUID 回落）。
  assert.equal(handle.calls[1].params.cookie.KUGOU_API_GUID, 'g'.repeat(36));
  assert.equal('imei' in handle.calls[1].params, false, '不许由我们编一个 IMEI 出去');

  const stillFailing = fakeKugou({
    song_url: { __throw: { status: 502, body: { error_code: 20028 } } },
    register_dev: { status: 200, body: { data: { dfid: 'B'.repeat(24) } } },
  });
  const failed = await kugouDevice.kugouDeviceCall(stillFailing, 'song_url', { hash: 'abc' }, { guid: 'g'.repeat(36), mid: '123', deviceIdentity: true });
  assert.equal(failed.ok, false);
  assert.deepEqual(stillFailing.calls.map((c) => c.operation), ['song_url', 'register_dev', 'song_url'], '只重试一次：坏了就停下来报实话');
});

test('R154 mid 由包内 calculateMid 算，包拿不到就给空串（不猜一个数字当设备号）', () => {
  assert.equal(kugouDevice.kugouMidFromGuid(''), '', '没有 guid 就不算');
  const fromPackage = kugouDevice.kugouMidFromGuid('00000000-0000-4000-8000-000000000000');
  // 自检不加载第三方依赖树（上面那条离线纪律），所以这里只能钉「要么空串、要么是一串数字」，不钉具体值。
  assert.ok(fromPackage === '' || /^[0-9]+$/.test(fromPackage), `mid 形状不对：${fromPackage}`);
});

test('R154 桥的取址一跳：hash 形状、未登录不出网、质量序列从无损档起（R223 四档）', async () => {
  const routes = new Map();
  const handle = fakeKugou({ song_url: { status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 1, url: ['http://fsandroid.kugou.com/a.mp3'] } } });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const call = routes.get('/bridge/audio-source');
  const bad = await call({ provider: 'kugou', mediaId: 'not-a-hash', cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /32 位十六进制/);
  assert.equal(handle.calls.length, 0, '形状不对就连包都不碰');

  const anon = await call({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340', cookie: '', device: { guid: 'g'.repeat(36) } });
  assert.equal(anon.ok, false);
  assert.equal(anon.unavailable, true);
  assert.match(anon.reason, /没有酷狗登录态/);
  assert.equal(handle.calls.length, 0, '未登录时这一跳零出网（父进程没给凭据，桥就不问包）');

  const ok = await call({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340', cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36), deviceIdentity: false } });
  assert.equal(ok.ok, true, `该成功：${ok.reason}`);
  assert.equal(ok.provider, 'kugou');
  assert.equal(ok.scope, 'full');
  assert.equal(handle.calls.length, 1, '第一档就成了就不问第二档（每档都是一笔真出网）');
  assert.equal(handle.calls[0].params.quality, 'flac', 'R223：梯子第一档是无损（拍板"补齐原版全集、不砍无损"）');
  assert.equal(handle.calls[0].params.hash, '8f9478e068736878d6fe520a03c8a340', '上游两种大小写都收，我们统一小写（包内部也 lowercase，别留两处口径）');
  assert.equal(handle.calls[0].params.cookie.dfid, '', '这一格显式带空串就是这条链的开关：少了它包会塞随机值');
});

test('R154/R223 第一档不给文件 ⇒ 降下一档再问一次（无损档）；全都不给才报最后一句原因', async () => {
  const routes = new Map();
  const handle = fakeKugou({ song_url: (params, nth) => (nth === 1 ? { status: 200, body: { status: '2', priv_status: '0' } } : { status: 200, body: { status: '1', priv_status: '1', url: ['http://fsandroid.kugou.com/b.mp3'] } }) });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: '8F9478E068736878D6FE520A03C8A340', cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } });
  assert.equal(result.ok, true, `该降到第二档成功：${result.reason}`);
  assert.deepEqual(handle.calls.map((c) => c.params.quality), ['flac', 'high'], '降级序的前两档（R223 起是四档：flac/high/320/128）');
});

test('R154 桥的检索一跳：分页按页号×每页数换算，总数在 data.total，响应形状不对要说「没被正确接受」', async () => {
  const routes = new Map();
  const handle = fakeKugou({ search: { status: 200, body: { data: { total: 137, page: 2, lists: [{ OriSongName: '一首', SingerName: '某人', FileHash: '8F9478E068736878D6FE520A03C8A340', Duration: 200, Bitrate: 128, PayType: 0 }] } } } });
  registerSearchRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/search')({ provider: 'kugou', keywords: '某人', offset: 20, limit: 20, cookie: 'token=abc;userid=nine', device: { guid: 'g'.repeat(36), mid: '123' } });
  assert.equal(result.ok, true, `该成功：${result.reason}`);
  assert.equal(result.total, 137);
  assert.equal(result.hasMore, true, '20+1 < 137');
  assert.equal(handle.calls[0].params.page, 2, 'offset/limit 换算成页号（与酷狗歌单那一跳 R137 同一条口径）');
  assert.equal(handle.calls[0].params.pagesize, 20);
  // 真机抓到的一处接线缺陷：`device` 里没有账号那一对，凭据走的是 `cookie` 头。
  // 漏拆的那一版离线全绿（假桥不关心 cookie），真机上上游把请求当匿名 ⇒ 502 / 错误码 152。
  assert.equal(handle.calls[0].params.cookie.token, 'abc', '父进程带来的 token 必须交到包手里');
  assert.equal(handle.calls[0].params.cookie.userid, 'nine', 'userid 同理');
  assert.equal(handle.calls[0].params.cookie.KUGOU_API_MID, '123', 'mid 也要一起带上（缺一格就是 152）');
  assert.equal(handle.calls[0].params.cookie.dfid, '', '这一跳同样显式带"没有设备号"，不许让包塞随机值');
  assert.equal(result.items[0].mediaId, '8F9478E068736878D6FE520A03C8A340');
  assert.equal(result.device.mid, '123', '把这一跳实际用的身份带回去给父进程存');

  // 没有登录态 ⇒ 连包都不碰（父进程那一侧也有同一道闸，两道都要在：纵深，不是重复）
  const quietHandle = fakeKugou({ search: { status: 200, body: { data: { lists: [] } } } });
  const routes0 = new Map();
  registerSearchRoutesR154({ routes: routes0, backends: { kugou: quietHandle }, fetchImpl: async () => ({ ok: false }) });
  const noSession = await routes0.get('/bridge/search')({ provider: 'kugou', keywords: '某人', device: { guid: 'g'.repeat(36) } });
  assert.equal(noSession.ok, false);
  assert.match(noSession.reason, /没有酷狗登录态/);
  assert.deepEqual(quietHandle.calls, [], '未登录时这一跳零出网');

  const broken = fakeKugou({ search: { status: 200, body: { errcode: 0 } } });
  const routes2 = new Map();
  registerSearchRoutesR154({ routes: routes2, backends: { kugou: broken }, fetchImpl: async () => ({ ok: false }) });
  const r2 = await routes2.get('/bridge/search')({ provider: 'kugou', keywords: '某人', cookie: 'token=aa;userid=bb', device: { guid: 'g'.repeat(36) } });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /data\.lists/, '字段缺席与空数组是两件事');
});

test('R154 全仓 register_dev 的调用点恰好一处，而且就在设备身份那一个文件里', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = [];
  const collect = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await collect(full);
      else if (entry.name.endsWith('.mjs')) files.push(full);
    }
  };
  await collect(SCRIPTS);
  const hits = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // 只数**可执行行**里的调用形状：注释里出现这个词是说明这件事（本文件与 kugou-device.mjs 的头部都要写它），
    // 拿整行去匹配就会被自己的解释绊红 —— R153 那条"判据要圈在表里不是整份文件"的同一形状。
    for (const line of text.split(/\r?\n/)) {
      const bare = line.trim();
      if (bare.startsWith('//') || bare.startsWith('*') || bare.startsWith('/*')) continue;
      for (const match of bare.matchAll(/invoke\(\s*['"]register_dev['"]/g)) hits.push([file, bare.slice(0, 60)]);
    }
  }
  const product = hits.filter(([file]) => !file.includes('check-music'));
  assert.equal(product.length, 1, `产品代码里 register_dev 的调用点必须恰好一处，现在 ${product.length} 处：${product.map(([f]) => f).join(', ')}`);
  assert.match(product[0][0], /providers[/\\]kugou-device\.mjs$/, '那一处必须在设备身份那一个文件里，别处顺手加一发就是破例');
});

test('R154 mid 只可能来自包内那一份算法：算不出就是空串，绝不编一个（变异 A6 的判据）', () => {
  assert.equal(kugouDevice.kugouMidFromGuid(''), '', '没有 guid 就不算');
  // 这一条把"包拿不到"那一条分支变成**可达的**（注入口与 guardedFetch 的 `lookup`、桥的 `fetchImpl` 同一惯例）：
  // 不可达的分支不算判据——本批第一次变异（catch 里 return 一个假 mid）就是这么溜过去的。
  assert.equal(kugouDevice.kugouMidFromGuid('g-u-i-d', () => { throw new Error('包不在'); }), '',
    '算不出来必须给空串：编一个数字当设备号就是替上游做决定，界面上也说不清');
  assert.equal(kugouDevice.kugouMidFromGuid('abc', () => (value) => `mid-of-${value}`), 'mid-of-abc',
    '算法是委托给那一份实现的，不是这里自己抄的（R123 魔数、R153 参数名同一课）');
  const real = kugouDevice.kugouMidFromGuid('00000000-0000-4000-8000-000000000000');
  // 自检不加载第三方依赖树（离线纪律），所以这一档只钉"要么空串、要么一串数字"，不钉具体值。
  assert.ok(real === '' || /^[0-9]+$/.test(real), `mid 形状不对：${real}`);
});

// ── R222 · 酷狗取址补齐原版的两步（逐画质降级 + 同一档两个变体） ─────────────────
// 原版依据（一手读 `references/folia-major/src/services/onlineMusic/kugouProvider.ts:1004-1096`）：
//   · 画质从 preferred 逐档降级直到出 URL（`QUALITY_FALLBACKS` 的 high 档就是 ['high','standard'] = 320→128）；
//   · 同一档两个变体：先带 `album_id`+`album_audio_id` 问，失败再**纯 hash** 问一次
//     （原版注释原话：检索元数据里的专辑 id 可能根本不属于这个 hash）；
//   · 每一跳都注入 `userid/uid + token + cookie`（`kugouApiBridge.cjs:278-292`）。
const R222_HASH = '8F9478E068736878D6FE520A03C8A340';

test('R222（i）逐画质降级：上一档说"权益不给"也要接着问下一档（原版是"直到出 URL 为止"，不是"一档不成就停"）', async () => {
  const routes = new Map();
  // 第一档回的是**权益那一档**（`priv_status:0` 且给了 url）——R154 起我们在这里是直接返回的，
  // 而原版的降级不看失败类别 ⇒ 这一条正是本批要改的那一格（变异 M1 会把早停加回去，这里就红）。
  const handle = fakeKugou({ song_url: (params, nth) => (nth === 1
    ? { status: 200, body: { status: '1', priv_status: '0', extName: 'mp3', fileSize: 1, url: ['http://fs.youthandroid2.kugou.com/a.mp3'] } }
    : { status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 3344329, url: ['http://fsandroid.kugou.com/b.mp3'] } }) });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } });
  assert.equal(result.ok, true, `该降档成功：${result.reason}`);
  assert.deepEqual(handle.calls.map((c) => c.params.quality), ['flac', 'high'], '权益那一档不算"到头"，要接着问低画质（R223 起这是四档梯子的前两档）');
  assert.equal(result.size, 3344329, '带出去的是成功那一档的读数');
});

test('R222（ii）同一档两个变体：带专辑参数失败 ⇒ 用纯 hash 再问一次（原版那条注释的正身）', async () => {
  const routes = new Map();
  const handle = fakeKugou({ song_url: (params, nth) => (nth === 1
    // 变体一（带专辑）回"形状认不出"以外的失败：这里给权益那一档，模拟"专辑 id 与 hash 不匹配"的表现。
    ? { status: 200, body: { status: '1', priv_status: '0', extName: 'mp3', fileSize: 1, url: ['http://fs.youthandroid2.kugou.com/a.mp3'] } }
    : { status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 4112408, url: ['https://sharefs.kugou.com/x/yp/full/a.mp3'] } }) });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu',
    device: { guid: 'g'.repeat(36) }, albumId: '106374641', albumAudioId: '89872375' });
  assert.equal(result.ok, true, `该用纯 hash 那一次成功：${result.reason}`);
  assert.equal(handle.calls.length, 2, '同一档恰好两次：带专辑 → 纯 hash');
  assert.equal(handle.calls[0].params.album_id, '106374641');
  assert.equal(handle.calls[0].params.album_audio_id, '89872375');
  assert.equal(handle.calls[1].params.album_id, '', '第二次是纯 hash：两个键都在但为空（包内 Number 会把空串折成 0）');
  assert.equal(handle.calls[1].params.album_audio_id, '');
  assert.equal(handle.calls[0].params.quality, handle.calls[1].params.quality, '两个变体是**同一档**（换变体不是换档）');
  // 反向：没给专辑参数时不许拿空值冒充"带参数问过"——那一档只问一次。
  const routes2 = new Map();
  const quiet = fakeKugou({ song_url: { status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 1, url: ['http://fsandroid.kugou.com/a.mp3'] } } });
  registerAudioRoutesR154({ routes: routes2, backends: { kugou: quiet }, fetchImpl: async () => ({ ok: false }) });
  const none = await routes2.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } });
  assert.equal(none.ok, true);
  assert.equal(quiet.calls.length, 1, '没有专辑参数 ⇒ 这一档只有纯 hash 那一次（不许空转一次重复请求）');
  assert.equal(quiet.calls[0].params.album_id, undefined, '没带就是**不带这个键**，不是带空串');
});

test('R222（iii）会话注入：每一跳的 cookie 里 token/userid/mid/dfid 四样都在（源码级 + 行为级）', async () => {
  const routes = new Map();
  const handle = fakeKugou({ song_url: (params, nth) => (nth === 1
    ? { status: 200, body: { status: '2', priv_status: '0' } }   // 第一档"没文件"，逼出第二跳
    : { status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 1, url: ['http://fsandroid.kugou.com/a.mp3'] } }) });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const ok = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu',
    device: { guid: 'g'.repeat(36), mid: '123456789012345678901234567890123456', dfid: '', deviceIdentity: false } });
  assert.equal(ok.ok, true, `该成功：${ok.reason}`);
  assert.equal(handle.calls.length, 2, '两跳都得带会话（每跳一次真实出网，凭据一次都不能少）');
  for (const call of handle.calls) {
    assert.equal(call.params.cookie.token, 'tt', '每一跳都要带登录令牌（历史教训：凭据要在每一跳都传）');
    assert.equal(call.params.cookie.userid, 'uu', 'userid 同理');
    assert.equal(call.params.cookie.KUGOU_API_MID, '123456789012345678901234567890123456', 'mid 是设备身份那一格');
    assert.equal(call.params.cookie.dfid, '', '显式带空 dfid（不填包会塞随机值 ⇒ 实测 502，R154）');
  }
  // 源码级：那一跳的参数就是从 `device` 拼出来的，而 device 的 token/userid 来自父进程借来的 cookie（唯一出处）。
  const source = await readFile(`${SCRIPTS}/bridge/audio-routes.mjs`, 'utf8');
  assert.match(source, /token: String\(session\.token \?\? ''\), userid: String\(session\.userid \?\? ''\)/,
    '(源码级) 会话来自 `kugouCookieToObject(payload.cookie)` 这一个出处');
  assert.match(source, /kugouDeviceCall\(handle, 'song_url', \{ hash: hash\.toLowerCase\(\), quality, \.\.\.variant \}, device\)/,
    '(源码级) 每一跳都把 device 交给 kugouDeviceCall ⇒ 会话注入在那一个函数里统一做');
});

test('R222（iv）所有档、所有变体都不给 ⇒ 仍是权益事实（unavailable），不是"通道坏了"', async () => {
  const routes = new Map();
  // 八跳全是权益那一档（四档 × 两个变体）——用真实形状 `priv_status:0` + 有 url。
  const handle = fakeKugou({ song_url: { status: 200, body: { status: '1', priv_status: '0', extName: 'mp3', fileSize: 1, url: ['http://fs.youthandroid2.kugou.com/a.mp3'] } } });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu',
    device: { guid: 'g'.repeat(36) }, albumId: '106374641', albumAudioId: '89872375' });
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true, '标成权益事实 ⇒ R141 的回落才敢去试另一家');
  assert.match(result.reason, /完整播放权益/, `原因要说"权益"不是"通道坏了"：${result.reason}`);
  assert.deepEqual(handle.calls.map((c) => `${c.params.quality}:${c.params.album_id === '' ? 'hash' : 'album'}`),
    ['flac:album', 'flac:hash', 'high:album', 'high:hash', '320:album', '320:hash', '128:album', '128:hash'],
    '穷尽顺序：从无损档逐档降、每档先带专辑再纯 hash（R223 的梯子全集）');
  assert.equal(result.url, undefined, '被拒的地址一个都不许带出去');
});

// ── R223 · 画质梯子补齐为原版全集（拍板：['flac','high','320','128']，不自创不砍） ──────────
test('R223（i）逐档咬：flac 说付费⇒问 high、high 说付费⇒问 320、320 说付费⇒问 128（每一格都要问）', async () => {
  const routes = new Map();
  // 夹具按 R221 真机形状给"权益不给"那一档（`status:2 / priv_status:0 / fail_process:["pkg","buy"]`），
  // 只有最后的 128 给整首 —— 与今天真机那三首的读数同一形状（无损/高品都要权益）。
  const 付费 = { status: 200, body: { status: '2', priv_status: 0, fail_process: ['pkg', 'buy'] } };
  const handle = fakeKugou({ song_url: (params, nth) => (nth === 4
    ? { status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 3344329, url: ['http://fsandroid.kugou.com/a.mp3'] } }
    : 付费) });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } });
  assert.equal(result.ok, true, `最后一档该成：${result.reason}`);
  assert.deepEqual(handle.calls.map((c) => c.params.quality), ['flac', 'high', '320', '128'],
    '四档逐条问到：缺一档就是"砍档"，多一档就是"自创"');
  // 逐格点名（不是只看总数）：前一档的"付费"必须各自引出后一档
  assert.equal(handle.calls[0].params.quality, 'flac', '无损档先问（拍板理由：flac 正是会员价值所在）');
  assert.equal(handle.calls[1].params.quality, 'high', 'flac 被拒之后问 high');
  assert.equal(handle.calls[2].params.quality, '320', 'high 被拒之后问 320');
  assert.equal(handle.calls[3].params.quality, '128', '320 被拒之后问 128');
});

test('R223（ii）梯子常量逐字钉：只有那四档、顺序是无损优先；无损那一档给 flac 就采用 flac', async () => {
  const routes = new Map();
  const { KUGOU_QUALITY_ORDER } = await import('./bridge/audio-routes.mjs');
  assert.deepEqual([...KUGOU_QUALITY_ORDER], ['flac', 'high', '320', '128'],
    '档位表逐字就是这张（原版 `qualityValue` 的值域只有 128/320/flac/high ⇒ 不自创第五档、不砍无损）');
  // 无损档真给 flac 文件时：kind 要照上游说的写，不许固定成 mp3（"音质"那一格界面要说得清播的是什么）
  const handle = fakeKugou({ song_url: { status: 200, body: { status: '1', priv_status: '1', extName: 'flac', fileSize: 23096026, timeLength: 208, url: ['http://fsandroid.kugou.com/a.flac'] } } });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) } });
  assert.equal(result.ok, true, `无损档该直接成：${result.reason}`);
  assert.equal(result.kind, 'flac', 'kind 取上游的 extName（实测无损那一档 extName 就是 flac、sqfilesize 23MB 量级）');
  assert.equal(handle.calls.length, 1, '无损档成了就不再往下问');
});

test('R224（ii）取址那一跳不自己塞平台身份：pid/page_id 那一族由包按 env 选，我们代码里没有第二套常量', async () => {
  const routes = new Map();
  const handle = fakeKugou({ song_url: { status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 1, url: ['https://fsandroid.kugou.com/a.mp3'] } } });
  registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
  const result = await routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH, cookie: 'token=tt;userid=uu',
    device: { guid: 'g'.repeat(36) }, albumId: '106374641', albumAudioId: '89872375' });
  assert.equal(result.ok, true, `该成功：${result.reason}`);
  assert.ok(handle.calls.length >= 1);
  for (const call of handle.calls) {
    for (const key of ['pid', 'pidversion', 'page_id', 'ppage_id', 'appid', 'clientver', 'platform']) {
      assert.equal(call.params[key], undefined, `我们不往这一跳塞 ${key}：平台族由包自己按 env 决定，两处各写一份必然漂`);
    }
    // 会话注入（R222（iii）那条）在本批之后仍然齐：删 env 不能顺手把 cookie 删薄
    assert.equal(call.params.cookie.token, 'tt'); assert.equal(call.params.cookie.userid, 'uu');
    assert.equal(call.params.cookie.dfid, '', 'dfid 仍显式带空串（不填包会塞随机值）');
  }
  const src = await readScript('bridge/audio-routes.mjs');
  assert.equal(/151369488|967177915|pidversion/.test(src), false, '桥里不许硬写任何一族的平台常量来"自己实现身份"（那是第二个真相）');
});

test('R224（iii）行为级：一路打到**真包**，取址那一跳实际组装出去的 pid/page_id 是非 lite 族（2 / 151369488）', async () => {
  // 任务书判据 2 的落点。前两条只能证明"我们不设也不塞"，这一条证明**包真的因此换了身份族**。
  // 手法与 R223 的矩阵探针同源，但**零出网**：包只有一个发送口（`util/request.js` 的 `createRequest`），
  // 而 `main.js` 是**每次调用时**才 require 它 ⇒ 在它进 cache 之后把导出换掉，拿到的就是"包打算发出去的那一份参数"。
  // 这也是判据 3（反向钉）的红点：`applyBackendEnv` 一旦把 `platform` 设回 lite，这里量到的是 411 / 967177915。
  const { createRequire } = await import('node:module');
  const bridgeDir = join(SCRIPTS, 'bridge');
  const pkgRequire = createRequire(join(bridgeDir, 'package.json'));
  assert.ok(existsSync(join(bridgeDir, 'node_modules', 'kugoumusicapi', 'main.js')),
    '这条判据要吃桥的依赖树（scripts/bridge/node_modules）——没装就让它红，不许悄悄跳过');
  const requestPath = pkgRequire.resolve('kugoumusicapi/util/request.js', { paths: [join(bridgeDir, 'node_modules')] });
  pkgRequire(requestPath);
  const cached = pkgRequire.cache[requestPath];
  const originalExports = cached.exports;
  const sent = [];
  // 桩只回**形状**（一首能成的整首），音频字节一个都不碰；真机那半格的读数在 run log 的探针段。
  cached.exports = {
    createRequest: (options) => {
      sent.push({ params: { ...(options?.params ?? {}) }, cookie: { ...(options?.cookie ?? {}) } });
      return Promise.resolve({ status: 200, body: { status: '1', priv_status: '1', extName: 'mp3', fileSize: 4112408, timeLength: 254, url: ['https://fsandroid.kugou.com/a.mp3'] } });
    },
  };

  const had = { platform: Object.prototype.hasOwnProperty.call(process.env, 'platform'), unblock: Object.prototype.hasOwnProperty.call(process.env, 'ENABLE_GENERAL_UNBLOCK') };
  const saved = { platform: process.env.platform, unblock: process.env.ENABLE_GENERAL_UNBLOCK };
  const drive = async (routes) => routes.get('/bridge/audio-source')({ provider: 'kugou', mediaId: R222_HASH,
    cookie: 'token=tt;userid=uu', device: { guid: 'g'.repeat(36) }, albumId: '106374641', albumAudioId: '89872375' });
  try {
    delete process.env.platform;
    const { applyBackendEnv } = await import('./bridge/backends/bootstrap.mjs');
    applyBackendEnv();                       // 走**我们那一个**函数：它现在什么都不设（加回那行 ⇒ 本条红）
    const { startKugouBackend } = await import('./bridge/backends/kugou.mjs');
    const handle = await startKugouBackend();   // 真 require（withKugouRequire 会把它偷加的异常监听摘回去）
    assert.equal(handle.state, 'ready');
    try {
      const routes = new Map();
      registerAudioRoutesR154({ routes, backends: { kugou: handle }, fetchImpl: async () => ({ ok: false }) });
      const result = await drive(routes);
      assert.equal(result.ok, true, `该在第一档（无损）就成了：${result.reason}`);
      assert.equal(sent.length, 1, '无损档成了 ⇒ 只问一笔。多问说明梯子或"成了就停"被改动过');
      const first = sent[0].params;
      assert.equal(first.pid, 2, '不设 platform ⇒ 包按非 lite 族组装 pid（lite 是 411，见下面那段对照）');
      assert.equal(first.page_id, 151369488, '同上：page_id 的非 lite 值');
      assert.equal(first.quality, 'flac', '梯子头一档真的到达包（R223 那张表的第一个值）');
      assert.equal(first.album_id, 106374641, '专辑变体到达包（R222 那一步不是只在我们自己代码里绕）');
      assert.equal(sent[0].cookie.token, 'tt'); assert.equal(sent[0].cookie.userid, 'uu');
      assert.equal(sent[0].cookie.dfid, '', 'dfid 仍显式空串（不填包会塞随机设备号）');

      // 对照（自证不是空转）：把身份设回去 ⇒ 同一跳必须翻族。
      // 注意这里只验 pid/page_id：`util/index.js` 的 appid/clientver 是 **require 时**定值，本包实例已经按非 lite 加载完了
      // ⇒ 拿这一格冒充"窗口式注入也对"是错的（那条规矩由 R224（i）的注释与断言钉着）。
      sent.length = 0;
      process.env.platform = 'lite';
      await drive(routes);
      assert.equal(sent[0]?.params?.pid, 411, '对照：env 是包内 pid 的唯一杠杆 ⇒ 设回 lite 就翻（所以 env 那一行加回来，本条必红）');
      assert.equal(sent[0]?.params?.page_id, 967177915, '对照：page_id 同步翻 lite 值');
    } finally {
      await handle.close?.();
    }
  } finally {
    cached.exports = originalExports;
    if (had.platform) process.env.platform = saved.platform; else delete process.env.platform;
    if (had.unblock) process.env.ENABLE_GENERAL_UNBLOCK = saved.unblock; else delete process.env.ENABLE_GENERAL_UNBLOCK;
  }
});
