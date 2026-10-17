// 本项目自撰（非移植代码）。三个后端封装包在 require 之前必须做的准备，全部来自一手实测
// （memory/folia-port-p5-run-log.md 的 Task 0 段）。缺其中任何一条，桥会在 require 的那一刻
// 要么崩掉、要么多出一个 0.0.0.0 端口——后者是硬约束 violation，比崩更糟。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 网易包 `util/request.js:29` 在 require 时**同步** readFileSync(tmpdir/anonymous_token)，
 * 文件不存在 ⇒ ENOENT 直接把进程带走（实测复现过）。上游同样用空文件占位（main.cjs:3818-3821）。
 * `xeapi_public_key` 那枚包内是 existsSync 容错的，一并预建，省掉第一次请求的额外往返。
 */
export function prepareNeteaseTmpFiles({ tmpDir = os.tmpdir() } = {}) {
  const created = [];
  for (const name of ['anonymous_token', 'xeapi_public_key']) {
    const tmpFile = path.resolve(tmpDir, name);
    if (!fs.existsSync(tmpFile)) { fs.writeFileSync(tmpFile, '', 'utf8'); created.push(name) }
  }
  return created;
}

/**
 * 在 `body` 执行期间临时设置若干环境变量，结束后原样恢复。
 * QQ 包靠它把 `NODE_ENV=test` 的作用范围限制在 require 那一瞬（`app.js:145` 的 isTestEnv 分支），
 * 不留全局污染——上游 `qqApiStartup.cjs:89-104` 就是这个"注入 → require → 恢复"的三段式。
 */
export function withEnv(values, body) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = String(value);
  try {
    return body();
  } finally {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

/**
 * 后端公共默认值。
 *   · `ENABLE_GENERAL_UNBLOCK=false` 取上游 main.cjs:3810 同值（必须在任何 require 之前）。
 *
 * **R224：这里原来还有一行 `process.env.platform = 'lite'`，本批删掉了**（= 用户拍板 Q34 的"丙"，与原版同形状 ——
 * 原版桥 `kugouApiBridge.cjs` 根本不设这个变量 ⇒ 它全部酷狗跳都跑非 lite 族）。为什么现在可以删：
 *   · 非 lite 那族回的 CDN 主机是 `fsandroid.kugou.com` / `fsmobile.tx.kugou.com`，**两台 TLS 都可用**
 *     （`fsandroid` 本来就在 `AUDIO_HOSTS` 里）；lite 那族只给 `fs.youthandroid*`，升 https 直接
 *     `ERR_TLS_CERT_ALTNAME_INVALID` ⇒ 在"不为音频走明文"的纪律下等于播不了（R223 矩阵一手读数）。
 *   · 代价面也量过：`search` 与 `search_lyric` 在**每个值起一个干净进程**的两态下读数逐字相同
 *     （`search_lyric` 两态都回 `status:200` + 有 `candidates`）⇒ 老台账（R154）那句"非 lite 会让歌词回空表"
 *     今天不复现，当年的因由是**窗口式注入**（env 在 require 时没设好 ⇒ 混合态），不是"非 lite 本身"。
 *   · **窗口式注入仍然是错的**：包是**每次请求**读它的（`util/request.js` / `util/helper.js` / `module/song_url.js`），
 *     而 `util/index.js` 的 `appid/clientver` 是 **require 时**定值 ⇒ 只在 require 窗口里翻它必然量出混合态。
 *     本批的做法是"什么都不设"，不是"换个值设窗口"，所以这条风险面是空的。
 * 因此这里不再设任何酷狗身份；要改回去就是加回那一行，并同步改 `check-music-bridge.mjs` 里那族判据与账面。
 */
export function applyBackendEnv() {
  if (process.env.ENABLE_GENERAL_UNBLOCK === undefined) process.env.ENABLE_GENERAL_UNBLOCK = 'false';
}

/**
 * 加载酷狗包专用：它会在 require 时注册**进程级** `uncaughtException` 处理器
 * （Task 2 实测：加载完再抛一个错，被它吃掉、进程以 0 退出，桥"安静地坏了"）。
 * 桥不能接受第三方包咽掉异常 ⇒ require 前后对比监听表，把它新加的摘掉，
 * 交还给桥自己的处理器（发 fatal 并非零退出，父进程按退避重启处理）。
 */
export function withKugouRequire(load) {
  const before = {
    uncaughtException: process.listeners('uncaughtException').slice(),
    unhandledRejection: process.listeners('unhandledRejection').slice(),
  };
  try {
    return load();
  } finally {
    for (const name of Object.keys(before)) {
      for (const listener of process.listeners(name)) {
        if (!before[name].includes(listener)) process.removeListener(name, listener);
      }
    }
  }
}
