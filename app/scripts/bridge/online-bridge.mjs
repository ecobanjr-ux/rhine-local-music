// 本项目自撰（非移植代码）。在线后端的唯一宿主子进程。
//
// 为什么要有这个文件：三个第三方 API 封装包（网易 / QQ / 酷狗）里，网易包要预建 tmp 文件且不 await 自己的
// listen、酷狗包 require 时注册进程级 uncaughtException 并吞异常——它们任一崩溃都不该带走本地播放核心。
// 装进独立子进程后：崩溃只杀这个进程、在线能力全部关闭时根本不 spawn（零暴露面）、可以单独杀掉重启。
// 这是第四期计划第 5 节的存档设计在此转正（一手依据见 memory/folia-port-p5-run-log.md 的 Task 0 段）。
//
// 桥今天只起**两个**包后端（网易 / 酷狗），QQ 不在其中。这是 2026-10-05 的证伪改判，理由三条：
//   ① Task 2 当时记的"包根导出的 serverless dispatcher"在 3.1.2 **不存在**：root keys 实测是
//      `server,configureAuthSessionRepository,default`，`mod.callback === undefined`，而 `default` 的
//      constructor.name 是 `Application`（Koa 实例）⇒ 唯一可用的形态是桥自己挂一个回环 server。
//   ② 而 QQ 侧这一期要做的三件事（搜索、歌词、匿名音源 vkey）**都不需要包**：走的是本项目自写的
//      fcg 通道（scripts/online-lyrics.mjs 起），出网经 guardedFetch ⇒ 进得出网审计表。
//      包内是 axios，绕开我们的安全层，接进来反而把审计红线破掉。
//   ③ 没有调用方就不开监听 ⇒ 桥少一个 127.0.0.1 端口与一次冷启动。
// 包仍在 scripts/bridge/package.json 的依赖树里（M3 的扫码登录要用它的 qrLogin/MQTT 实现，那部分自写不划算），
// 到时按 ① 的实测形态挂载，并把可访问路由收窄成一份字面白名单——一手数据与两条撤回都记在 R83。
//
// 三条与安全有关的形状，改动前先读它们：
//   ① 端口从不"猜"：server.listen(0, '127.0.0.1') 之后从 server.address() 读真值（上游的
//      "拿号再 close 再把号交给包"有 TOCTOU，且包可能 bind 到 0.0.0.0）。
//   ② 每次 spawn 一把令牌，只经 env 传入（Windows 上 argv 可被同机进程枚举）；每个请求与每条控制
//      消息都要过它，不符一律 401 并计数。
//   ③ 桥内失败一律 200 + 可读 reason：不许用 5xx 把"没配上"伪装成"出错了"，父进程据此回退到本地。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const MAX_BRIDGE_BODY_BYTES = 256 * 1024;
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 定长比较，不留时序侧信道。 */
export function tokenOk(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { req.destroy(); reject(new Error(`请求体超过 ${limit} 字节`)); return }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (!chunks.length) { resolve({}); return }
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
    catch { reject(new Error('请求体不是合法 JSON')) }
  });
  req.on('error', reject);
});

/**
 * 桥的业务路由表。各任务往这里挂 handler（Task 5 歌词、Task 6 音源、Task 7 搜索、Task 10 歌单、
 * Task 12 登录、Task 14 封面）。签名统一为 `(payload, ctx) -> 可 JSON 序列化的结果`，
 * ctx 里有 `backends`（真实后端句柄）与 `emit`（往父进程发 NDJSON）。
 */
export const ROUTES = new Map();

/**
 * 起一个桥。`hosts` 为空时它是一个"只会应答 status 的空壳"——自检就跑在这一档上，
 * 因此本文件与它 import 的东西都不许在模块加载期碰第三方包。
 */
export async function startBridge({ host = '127.0.0.1', token, hosts = [], emit = () => {}, backends = {}, routes = ROUTES, watchParent = false, exitOnShutdown = false } = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('ONLINE_BRIDGE_TOKEN 缺失或长度不足 32');
  if (host !== '127.0.0.1') throw new Error(`桥只允许 bind 127.0.0.1，收到 ${host}`);
  let unauthorized = 0;
  let port = 0;
  let shuttingDown = false;
  const state = new Map(hosts.map((id) => [id, { id, state: 'starting' }]));
  for (const [id, handle] of Object.entries(backends)) if (handle?.state) state.set(id, { id, state: handle.state, reason: handle.reason });
  // 状态表要**现读**：独立运行时聚合口先 ready，三个包是之后才陆续起来的（main 里先 listen 后 boot），
  // 只在构造时抄一次的话 /bridge/status 会永远报 starting。
  const backendTable = () => hosts.map((id) => {
    const handle = backends[id];
    if (handle?.state) return { id, state: handle.state, ...(handle.reason ? { reason: handle.reason } : {}), ...(handle.port ? { port: handle.port } : {}) };
    return state.get(id) ?? { id, state: 'starting' };
  });

  const server = http.createServer(async (request, response) => {
    if (!tokenOk(request.headers['x-online-token'], token)) { unauthorized += 1; return json(response, 401, { error: 'unauthorized' }) }
    const route = new URL(request.url, 'http://bridge').pathname;
    if (route === '/bridge/status') return json(response, 200, { backends: backendTable(), unauthorized, port });
    const handler = routes.get(route);
    if (!handler) return json(response, 404, { error: 'unknown bridge route' });
    if (request.method !== 'POST') return json(response, 405, { error: '该路由只接受 POST' });
    const started = Date.now();
    let result;
    let failure;
    try {
      const payload = await readBody(request, MAX_BRIDGE_BODY_BYTES);
      result = await handler(payload, { state, backends, emit });
    } catch (error) {
      failure = error;
    }
    // 每次业务调用记一笔审计：第三方包内部自己发的请求我们包不住（R75 的诚实边界），
    // 但"桥被叫了几次、每次多久、成没成"必须能摊给用户看。
    // via 用 'backend'：这一行的含义是"经桥调用第三方后端的一次"，与 guard 那种"我们自己去打"分开列。
    // host 取 handler 报回的 provider（网易/酷狗/QQ…）——包内部打了谁我们不知道，但"哪一家被叫了一次"是事实。
    emit({ evt: 'audit', via: 'backend', kind: route, host: typeof result?.provider === 'string' ? result.provider : undefined, ms: Date.now() - started, ok: failure ? false : result?.ok !== false });
    if (failure) return json(response, 200, { ok: false, reason: failure?.message ?? String(failure) });
    return json(response, 200, result);
  });
  server.requestTimeout = 60_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      port = server.address().port;                     // 真端口：从已 listen 的 server 上读
      emit({ evt: 'ready', aggregate: { host, port }, backends: backendTable() });
      resolve();
    });
  });

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    emit({ evt: 'fatal', reason });
    for (const handle of Object.values(backends)) {
      // 单个后端关不掉不阻塞退出，而且**不能让它的 close 挂住整个退出**：
      // 包里的 keep-alive / 定时器可能让 close() 的回调永远不来，那时桥就变成孤儿进程了。
      const capped = Promise.race([
        Promise.resolve().then(() => handle?.close?.()),
        new Promise((resolve) => setTimeout(resolve, 2000).unref()),
      ]);
      try { await capped } catch { /* 后端关闭失败只影响它自己，不影响桥退出 */ }
    }
    // close() 会等所有连接结束，而 fetch/undici 的 keep-alive 连接不会自己断 ⇒ 必须先掐连接，
    // 否则"关掉桥"这一步会永远挂着（自检里就是这么挂住的）。
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    // 独立运行时必须真的退出去：第三方包可能留着定时器不让事件循环自然结束，
    // 那样"父进程没了但桥还活着"就成了孤儿进程，正是要防的事。自检里不能退（会杀掉测试进程），
    // 所以这一条由 exitOnShutdown 控制。
    if (exitOnShutdown) setTimeout(() => process.exit(0), 20).unref();
  };

  // 孤儿防治：Windows 没有 SIGTERM 传播，"父进程消失 ⇒ OS 关管道"是这里唯一可靠的一条。
  // 只在独立运行时挂：进程内被自检直接调用时，resume() 会把测试自己的 stdin 变成活动句柄，
  // 测试进程就再也退不出去了（第一版就是这么挂住的）。
  if (watchParent) {
    // 桥内部出了我们没预料到的异常时，"安静地坏掉"是最坏的结局（父进程还以为它活着）。
    // 酷狗包自己注册过进程级 uncaughtException 并吞掉异常（backends/bootstrap.mjs 的 withKugouRequire
    // 就是为此）；这里补上桥自己的那份：发一条 fatal、把状态说清楚，再以非零码退出，让父进程按退避处理。
    const die = (label, error) => {
      emit({ evt: 'fatal', reason: `${label}：${error?.message ?? String(error)}` });
      void shutdown(label);
      setTimeout(() => process.exit(1), 50).unref();
    };
    process.on('uncaughtException', (error) => die('uncaughtException', error));
    process.on('unhandledRejection', (error) => die('unhandledRejection', error));
    process.stdin.resume();
    process.stdin.on('end', () => void shutdown('parent-gone'));
    process.stdin.on('close', () => void shutdown('parent-closed'));
    process.on('message', (message) => {
      if (!tokenOk(message?.token, token)) { unauthorized += 1; return }
      if (message.cmd === 'ping') emit({ evt: 'pong' });
      else if (message.cmd === 'shutdown') void shutdown('parent-request');
      else if (message.cmd === 'query-status') emit({ evt: 'backend', id: 'aggregate', state: 'ready' });
      else if (message.cmd === 'restart-backend') {
        const handle = backends[message.backend];
        if (!handle) { emit({ evt: 'backend', id: String(message.backend), state: 'error', reason: '没有这个后端' }); return }
        void Promise.resolve(handle.restart?.()).then(
          (result) => emit({ evt: 'backend', id: message.backend, state: 'ready', ...result }),
          (error) => emit({ evt: 'backend', id: message.backend, state: 'error', reason: error?.message ?? String(error) }),
        );
      }
    });
  }

  return {
    port,
    unauthorized: () => unauthorized,
    backendState: () => backendTable(),
    close: () => shutdown('test-teardown'),
  };
}

/**
 * 独立运行入口：由 music-server 的桥客户端 spawn（见 scripts/online-bridge-client.mjs）。
 *
 * 次序是定的：**先让聚合口 listen 并 emit ready，再后台起三个包**。
 * 反面写法（先 await 完所有后端再起聚合口）会让"包冷启动慢/卡住"表现为"桥根本没有 ready"，
 * 父进程只能超时 + 退避重启，用户看到的是在线能力整块消失，而后端其实还在陆续起来。
 */
async function main() {
  const { applyBackendEnv, prepareNeteaseTmpFiles } = await import('./backends/bootstrap.mjs');
  const { registerLyricRoutes } = await import('./lyric-routes.mjs');
  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  // M3-a Task A 造的 sink 在这里装配（Task D 才有第一个生产者）：桥是**独立进程**，
  // 它那份 online-guard 的记录若不转发，父进程与出网面板永远看不到——QQ 登录的每一跳都是我们
  // 自己经 guardedFetch 发的（不是包内部黑箱），所以它们必须以 via='guard' 出现在同一张表里。
  const { setEgressSink } = await import('../online-audit.mjs');
  setEgressSink((row) => emit({ evt: 'audit', ...row }));
  const hosts = (process.env.ONLINE_BRIDGE_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const backends = {};
  // 路由表在独立运行时才装配（自检里 startBridge 传的是自己的空表，保证"离线可测"那条断言成立）。
  const routes = new Map();
  registerLyricRoutes({ routes, backends });
  // 音源与搜索通道都只有网易（Task 6 / Task 7）：QQ 在父进程经 guardedFetch 自写 fcg，酷狗本期不接——
  // 理由分别写在 audio-routes.mjs 与 search-routes.mjs 头部。
  const { registerAudioRoutes } = await import('./audio-routes.mjs');
  const { registerSearchRoutes } = await import('./search-routes.mjs');
  const { registerPlaylistRoutes } = await import('./playlist-routes.mjs');
  // R161（任务八）：播放上报（缺省关；开关在父进程那一层判，桥这一层只负责"给了才发、形状不对不发"）。
  const { registerReportRoutes } = await import('./report-routes.mjs');
  // R165（任务十一）：加歌到账号歌单（写侧）。四条红线写在 playlist-write-routes.mjs 头部，
  // 其中一条是"桥里不存在删除分支"——所以这一路只有 add，没有 del。
  const { registerPlaylistWriteRoutes } = await import('./playlist-write-routes.mjs');
  const { registerAuthRoutes } = await import('./providers/auth.mjs');
  const { loopbackFetch } = await import('./loopback.mjs');
  registerAudioRoutes({ routes, backends, fetchImpl: loopbackFetch });
  registerSearchRoutes({ routes, backends, fetchImpl: loopbackFetch });
  registerPlaylistRoutes({ routes, backends, fetchImpl: loopbackFetch });
  registerPlaylistWriteRoutes({ routes, backends, fetchImpl: loopbackFetch });
  registerReportRoutes({ routes, backends, fetchImpl: loopbackFetch });
  // M3-a Task C：网易扫码登录。QQ 那一半在 Task D 也接上了（同一个路由按 provider 分叉）。
  // `emit` 传进去是为了桥内的 note 行（例如"MQTT 没连上"）能回到父进程的日志——那条通道是脱敏的，见 online-bridge-client。
  registerAuthRoutes({ routes, backends, fetchImpl: loopbackFetch, emit });
  const start = async (id, loader) => {
    emit({ evt: 'backend', id, state: 'starting' });
    try {
      backends[id] = await loader();
      emit({ evt: 'backend', id, state: 'ready', port: backends[id].port ?? null });
    } catch (error) {
      // 单个后端起不来不带走整个桥：其它后端与本地核心照常（"不阻塞本地核心"的具体形态）
      backends[id] = { state: 'error', reason: error?.message ?? String(error) };
      emit({ evt: 'backend', id, state: 'error', reason: error?.message ?? String(error) });
    }
  };
  const bootBackends = async () => {
    applyBackendEnv();                         // 身份类 env 必须最先设：包是**每次请求**读它，不是 require 时读一次
    prepareNeteaseTmpFiles();                    // 缺 anonymous_token 会在 require 的那一刻 ENOENT 崩进程
    if (hosts.includes('netease')) await start('netease', async () => (await import('./backends/netease.mjs')).startNeteaseBackend());
    // 没有 qq 这一行：见文件头 ①②③——包在 3.1.2 没有 dispatcher，而本期 QQ 的三件事都走自写 fcg + guardedFetch。
    if (hosts.includes('kugou')) await start('kugou', async () => (await import('./backends/kugou.mjs')).startKugouBackend());
  };
  await startBridge({ token: process.env.ONLINE_BRIDGE_TOKEN, hosts, emit, backends, routes, watchParent: true, exitOnShutdown: true });
  // ready 已经发出去了；后端起来各自发一条 backend 事件，父进程按 id 更新状态表。
  void bootBackends().catch((error) => emit({ evt: 'fatal', reason: `后端引导失败：${error?.message ?? error}` }));
}

// Windows 上这个判定不能用 ===：argv[1] 写成 `D:/…/online-bridge.mjs`（正斜杠）或盘符大小写不同，
// 与 fileURLToPath 给出的反斜杠路径就不相等 ⇒ main() 不跑，桥"活着但一声不吭"，父进程只能等到超时。
// 真实翻车过一次（探针脚本里就是这么写的路径），所以这里做分隔符与大小写归一。
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  void main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ evt: 'fatal', reason: error?.message ?? String(error) })}\n`);
    process.exitCode = 1;
  });
}
