// R194（Q70）· `check:music` 的 runner —— 段与段之间**收回本段 spawn 的子树**。
//
// 为什么需要它（R189/R190 两轮实测出来的因果链，不是猜的）：
//   ① 一条测试红掉之后，它那条进程**不一定退**（R189 整跑里真机看到过：`node --test scripts/check-music-online-search.mjs`
//      与它下面那个 `node scripts\check-music-online-search.mjs` 都还活着，`127.0.0.1:6000` 仍是 LISTENING）；
//   ② Windows 上 `SO_REUSEADDR` 允许另一个 socket 绑同一端口 ⇒ 后续某个测试的 `listen(0)` 真拿到 6000 时，
//      连接会跑去那个**不 accept 的孤儿**上 ⇒ 表现是"连续 9 秒连不上"，**退避重试治不了**（它连的是别人的端口）；
//   ③ 于是"红一次"会制造"后面再红"，整条链的读数被污染。
// 所以收口在这一层：每段跑完（无论绿红）都把**本段留下的、还在跑本项目自检脚本的**进程收掉。
//
// 三条边界（都写在代码里，免得下一个人放宽）：
//   · **只收"自己 spawn 的"**：按命令行判，只认 `check-*.mjs`（含 `--test` 那种父进程）；
//     `music-server.mjs`（用户那台实例）与 `bridge/*.mjs` 一律**不碰**。
//     —— R178 那次误杀的教训：`taskkill` 按命令行粗匹配会连带杀掉用户 5175 的桥，
//     教训是"先按 PPID 认领自己 spawn 的子树"。这里进一步把判据写成**白名单式**（只认 check 脚本），
//     而不是"排除法"（排除法会随着新加的脚本类型漏掉新的误杀面）。
//   · **正常路径不误杀**：段是串行跑的（与原来的 `&&` 链同语义），本段跑完时不该有别人的服务在跑；
//     真的是"本段留下的"才收，收到谁都会打进 stdout（看得见）。
//   · **判据 / 输出一个字不动**：这里只做编排与收口，段里的命令逐字照抄（见 SEGMENTS）。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 段清单：**唯一真源**（package.json 的 `check:music` 只是 `node scripts/check-music-chain.mjs`）。 */
export const SEGMENTS = [
  'node --test scripts/check-music-library.mjs scripts/check-album-introductions.mjs',
  'node scripts/check-music-scene.mjs',
  'node --experimental-strip-types --test scripts/check-music-player.mjs',
  'node scripts/check-music-motion.mjs',
  'node scripts/check-music-camera.mjs',
  'node scripts/check-music-lighting.mjs',
  'node scripts/check-music-presentation.mjs',
  'node scripts/check-music-model.mjs',
  'node --experimental-strip-types --test scripts/check-music-scene-theme.mjs',
  'node --experimental-strip-types --test scripts/check-music-camera-orbit.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-parser.mjs',
  'node --test scripts/check-music-lyrics-library.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-clock.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-client.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-stage.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-pulse.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-controls.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-motion.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-intensity.mjs',
  'node --experimental-strip-types --test scripts/check-music-lyrics-palette.mjs',
  'node --experimental-strip-types --test scripts/check-music-theme-ui.mjs',
  'node --test scripts/check-folia-port.mjs',
  'node --test scripts/check-music-online.mjs scripts/check-music-online-discipline.mjs',
  'node --experimental-strip-types --test scripts/check-music-shelf-layout.mjs',
  'node --test scripts/check-music-startup-scan.mjs',
  'node --test scripts/check-music-bridge.mjs',
  'node --test scripts/check-music-online-audit.mjs',
  'node --test scripts/check-music-auth.mjs',
  'node --test scripts/check-music-auth-flow.mjs',
  'node --test scripts/check-music-streaming.mjs',
  'node --test scripts/check-music-online-search.mjs',
  'node --test scripts/check-music-playlists.mjs',
  'node --test scripts/check-music-playlist-match.mjs',
  'node --experimental-strip-types --test scripts/check-music-online-ui.mjs',
  'node --test scripts/check-music-covers.mjs',
  'node --test scripts/check-music-track-covers.mjs',
  'node --experimental-strip-types --test scripts/check-music-island-feed.mjs',
  'node --experimental-strip-types --test scripts/check-music-wall-covers.mjs',
  'node --test scripts/check-music-artist-groups.mjs',
  'node --experimental-strip-types --test scripts/check-music-favorites.mjs',
  'node --experimental-strip-types --test scripts/check-music-command-palette.mjs',
  'node --experimental-strip-types --test scripts/check-music-surface.mjs',
  // R204：这个文件早就存在，但**从来没进过链**（SEGMENTS 里 grep 不到 launcher，package.json 也没有别的入口），
  // 而本件要改 `launch-music.mjs` ⇒ 先把安全网接上再动它。
  // 里面那格 macOS Finder 启动件（`.command` + POSIX 执行位）的测试按本文件既有的写法加了平台门（macOS 上照跑），
  // 另给 R204 抽出来的 `waitForService` 补了一格 —— 于是这一段现在是 14 条。
  'node --test scripts/check-music-launcher.mjs',
  'node --test scripts/check-music-shell.mjs',
];

/** 命令行判据：只认"本项目自检脚本"。`music-server.mjs` 与 `bridge/*.mjs` 天然不匹配（白名单式，不是排除法）。 */
const CHECK_SCRIPT = /check-[a-z0-9-]*\.mjs/i;
/** **runner 自己不算孤儿**（它也叫 check-*.mjs；第一版就因此把自己收了 —— 真机跑出来的）。 */
const SELF_SCRIPT = /check-music-chain\.mjs/i;

/** 导出来给自检用（判据要落在这一句上，不是落在源码文本上）。 */
export const isStray = (cmd) => CHECK_SCRIPT.test(cmd) && !SELF_SCRIPT.test(cmd);

/** 列出当前还在跑的、命令行匹配自检脚本的 node 进程（Windows 用 CIM 查，其它平台用 ps）。 */
export function listStrayChainProcesses() {
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
      + 'ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
    ], { encoding: 'utf8' });
    if (ps.status !== 0 || !ps.stdout) return [];
    return ps.stdout.split(/\r?\n/).map((line) => {
      const [pid, ppid, ...rest] = line.split('\t');
      const cmd = rest.join('\t') ?? '';
      if (!pid || !cmd) return null;
      if (!isStray(cmd)) return null;
      if (Number(pid) === process.pid) return null;
      return { pid: Number(pid), ppid: Number(ppid), cmd: cmd.trim() };
    }).filter(Boolean);
  }
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
  if (ps.status !== 0 || !ps.stdout) return [];
  return ps.stdout.split('\n').map((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !isStray(m[3])) return null;
    if (Number(m[1]) === process.pid) return null;
    return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3].trim() };
  }).filter(Boolean);
}

/** 收掉这些进程（连它们的子树）。返回真正收到的那几个，**打出来**（收到了谁要看得见）。 */
export function reapStrayChainProcesses(reason) {
  const strays = listStrayChainProcesses();
  if (strays.length === 0) return [];
  for (const s of strays) {
    console.log(`[chain] 收孤儿(${reason})：pid=${s.pid} ppid=${s.ppid} cmd=${s.cmd.slice(0, 120)}`);
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(s.pid, 'SIGKILL'); } catch { /* 已经退了 */ }
    }
  }
  return strays;
}

/** 单段最长时长（毫秒）：超了就当这一段失败并把它那棵子树收掉。
 *  R198 真机踩到的：一条测试红掉之后**它的进程不退**（实测 `check-music-artist-groups` 红在
 *  "连不上 6000" 之后 PID 一直挂着、6000 一直 LISTENING），而 runner 的 spawnSync 会**无限等**它
 *  ⇒ 整条链永远停在那一段（比红更糟：连读数都拿不到）。所以给每段加一道上限。 */
export const SEGMENT_TIMEOUT_MS = 10 * 60 * 1000;

function main() {
  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const segments = only.length > 0 ? only.map((n) => SEGMENTS[n - 1]).filter(Boolean) : SEGMENTS;
  const onExit = () => { reapStrayChainProcesses('中断'); process.exit(130); };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  for (const [index, command] of segments.entries()) {
    console.log(`[chain] 段 ${index + 1}/${segments.length}：${command}`);
    const result = spawnSync(command, { shell: true, stdio: 'inherit', timeout: SEGMENT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    // **无论绿红**都收一次：红的那一条正是会留孤儿的那一条。
    reapStrayChainProcesses(`段 ${index + 1} 之后`);
    if (result.error?.code === 'ETIMEDOUT') {
      console.log(`[chain] 段 ${index + 1} 超时（${SEGMENT_TIMEOUT_MS / 60000} 分钟）—— 当失败处理，子树已收`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.log(`[chain] 段 ${index + 1} 未通过（exit=${result.status ?? 'null'}），链条就此停下`);
      process.exit(result.status ?? 1);
    }
  }
  reapStrayChainProcesses('收尾');
  console.log(`[chain] ${segments.length} 段全部通过`);
}

const SELF = fileURLToPath(import.meta.url);
const isEntry = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]).toLowerCase() === realpathSync(SELF).toLowerCase(); }
  catch { return false; }
})();
if (isEntry) main();
