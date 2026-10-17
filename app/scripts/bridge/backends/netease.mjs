// 本项目自撰（非移植代码）。网易云后端的嵌入形态。
//
// 一手依据（Task 0 + Task 2 真实 boot 取证，数字在 memory/folia-port-p5-run-log.md）：
//   · `server.js:443` 把 `app.listen(...)` 的句柄挂在返回值的 `.server` 上，且 `.close()` 真的释放端口、
//     **同进程可再启一个**（实测监听数 2 → 关一个剩 1 → 全关剩 0 → 再启 200）
//     ⇒ 上游 main.cjs:4232-4233 那句"serveNcmApi has no shutdown hook"在 4.40.1 不成立。
//   · 但那次 listen **没被 await** ⇒ serveNcmApi 一返回就 `address()` 读到 null（实测就是这么报的），
//     必须等 `'listening'`。
//   · 更要紧的是它的 bind 地址：`server.js:420` 是 `options.host || process.env.HOST || ''`，
//     而 **空字符串意味着所有网卡**。第一版桥传 `host:'127.0.0.1'`，实测 netstat 确实只有 127.0.0.1:端口；
//     但这条完全靠一个 falsy 分支撑着，所以这里把"不是回环就拒绝继续"钉成运行期检查，而不是注释。
//   · `server.js:419` 是 `Number(options.port || process.env.PORT || '3000')` ⇒ 传 `port:0` 会被 falsy
//     吞成 3000；要拿 OS 随机端口只能 `env.PORT='0'`，再从 `server.address().port` 读真值。
//   · `options.checkVersion` 为真时包会去查 npm 版本 ⇒ 那是一笔不被审计的出网，显式关掉。
import { createRequire } from 'node:module';
import { prepareNeteaseTmpFiles, withEnv, applyBackendEnv } from './bootstrap.mjs';

const require = createRequire(import.meta.url);
// R211（五）：从前这里是 `const MODULE = '...'` + `require(MODULE)` —— 打包的闭包扫描器只认**字面量说明符**，
// 变量形态是它的盲区（今天没出事只因为这个包住在 `scripts/bridge/node_modules` 里、随 scripts 白名单整目录进包）。
// 改成字面量让扫描器看得见它；行为等价（同一个 require、同一个子路径）。

export async function startNeteaseBackend() {
  prepareNeteaseTmpFiles();          // 缺 anonymous_token 会在 require 的那一刻 ENOENT 崩掉整个桥
  applyBackendEnv();
  const { serveNcmApi } = require('@neteasecloudmusicapienhanced/api/server.js');
  const app = await withEnv({ PORT: '0' }, () => serveNcmApi({ host: '127.0.0.1', checkVersion: false }));
  const server = app?.server;
  if (!server) throw new Error('serveNcmApi 没返回 server 句柄，桥拿不到真实端口');
  await new Promise((resolve, reject) => {
    if (server.listening) { resolve(); return }
    const timer = setTimeout(() => reject(new Error('网易后端 10 秒内没进入监听态')), 10_000);
    timer.unref();
    server.once('error', (error) => { clearTimeout(timer); reject(error) });
    server.once('listening', () => { clearTimeout(timer); resolve() });
  });
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('网易后端进了监听态却读不到地址，拒绝继续');
  if (address.address !== '127.0.0.1') {
    // 通配监听比"桥起不来"严重得多：关掉它并报告，让本地服务退回纯离线形态。
    server.closeAllConnections?.();
    server.close(() => {});
    throw new Error(`网易后端 bind 到了 ${address.address}，只允许 127.0.0.1`);
  }

  const handle = {
    state: 'ready',
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();          // keep-alive 连接不掐，close() 的回调永远不来
      server.close(resolve);
    }),
    restart: async () => {
      await handle.close();
      const next = await startNeteaseBackend();
      handle.port = next.port;
      handle.baseUrl = next.baseUrl;
      handle.close = next.close;
      handle.restart = next.restart;
      return { port: handle.port };
    },
  };
  return handle;
}
