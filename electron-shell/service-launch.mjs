// R204（Electron 壳最小件）· 服务这一侧的全部"怎么起、怎么收"。
//
// 三条形状决定，都是 Task 0 一手量出来的，不是风格偏好：
//  1. **不在这里实现第二套复用判定**。端口、复用、启动锁、"复用已运行服务时补一次扫描"
//     全部住在 `app/scripts/launch-music.mjs`，本文件只把它本来就设计成可注入的三个口子
//     （prepare / start / open）换成壳的版本。理由：`probeMusicService` 逐字比较 projectDir，
//     正斜杠形态会回 `occupied` ⇒ 壳在用户那台还在跑的服务旁边**再起一个**（Task 0 实测四格）。
//     而 `realpath` 那一格在 `launchMusic()` 第一行 —— 所以壳必须走它，不能自己拼。
//  2. **可执行文件 = 壳自己**（`process.execPath`）+ `ELECTRON_RUN_AS_NODE=1`。
//     不带这个环境变量，electron.exe 会把 `.mjs` 当应用目录（Task 0 实测）。
//     带上了，服务里那条 `spawn(process.execPath, [桥入口])`（online-bridge-client.mjs:132）
//     会继承同一份环境 ⇒ 在线的桥在壳下也是同一条路，不需要 Node 安装。
//  3. **壳不跑 npm**：Task 0 实测 Windows 上 `spawnSync('npm')` = ENOENT、`npm.cmd` = EINVAL ⇒
//     启动器那条 prepareBuild 在 Windows 本来就走不通；壳只检查"构建产物在不在"，
//     不在就给一句实话，不偷偷构建、也不把缺构建伪装成"起来了"。
import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 壳所在目录的上一级 = 仓库根；再进 `app/` = 渲染层与服务所在处。 */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

export const SERVICE_SCRIPT = path.join('scripts', 'music-server.mjs');
export const LAUNCHER_SCRIPT = path.join('scripts', 'launch-music.mjs');
/** 日志落点与启动器同一份（`<dataDir>/player-service.log`，追加）⇒ 排查时只有一个地方要看。 */
export const SERVICE_LOG_NAME = 'player-service.log';

export const SHELL_NO_BUILD_MESSAGE = '播放器界面还没有构建过：请先按浏览器那条路构建一次，构建完成后这个壳才画得出画面。';

/** 构建检查（纯函数）：产物在 ⇒ 什么都不做；不在 ⇒ 一句实话。壳绝不代替用户构建。 */
export function prepareShellBuild({ distIndexExists }) {
  return distIndexExists ? { ok: true } : { ok: false, message: SHELL_NO_BUILD_MESSAGE };
}

/** 子进程规格（纯函数）：命令行与启动器/自检/真机取证用的是同一条，只有可执行文件换成壳自己。 */
export function serverSpawnSpec({ execPath, serverScript, projectDir, dataDir, fd, port, dataDirSource }) {
  return {
    command: execPath,
    args: [serverScript, '--port', String(port)],
    options: {
      cwd: projectDir,
      detached: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        MUSIC_DATA_DIR: dataDir,
        // R209：`/api/data-dir` 的 `source` 一档（env / packaged-default / dev-default）——
        // 只有壳知道"这一档是谁赢的"（服务只看得见 MUSIC_DATA_DIR 被设了，看不出是用户设的还是壳补的）。
        ...(dataDirSource ? { RHINE_DATA_DIR_SOURCE: dataDirSource } : {}),
      },
      stdio: ['ignore', fd, fd],
    },
    port,
  };
}

/** 该不该收这个子进程 —— 只有"壳自己起的"才收，复用在跑的那一个一个字都不动。 */
export function shouldStopOwnedService({ reused, childPid }) {
  return !reused && Number.isSafeInteger(childPid) && childPid > 0;
}

/**
 * 收掉壳自己起的那一棵树：`/PID <我们 spawn 的 pid> /T /F`。
 * `/T` 是 Task 0 实测加的：有一次那个进程旁边挂着一个辅助子进程，单收 pid 不可预期。
 * 绝不按映像名或命令行粗匹配 —— 本项目有过一次误杀用户常驻服务的事故（教训写在 AGENTS.md 与各期日志）。
 */
export function stopOwnedService({ reused, childPid, kill = (pid) => execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } = {}) {
  if (!shouldStopOwnedService({ reused, childPid })) return { killed: false, reason: reused ? 'reused' : 'not-owned' };
  kill(childPid);
  return { killed: true, pid: childPid };
}

export async function loadLauncher(appDir = APP_DIR) {
  // Windows 上 ESM 只能 import file:// URL（Task 0 实测 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
  return import(pathToFileURL(path.join(appDir, LAUNCHER_SCRIPT)).href);
}

/**
 * 壳的服务生命周期。所有会碰外部世界的东西都做成参数，自检因此能真调用这些逻辑而不必真起进程。
 */
export function createShellService({
  appDir = APP_DIR,
  dataDir,
  execPath = process.execPath,
  spawnChild = spawn,
  openLog = (logPath) => open(logPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY),
  stopService = stopOwnedService,
  onUrl = async () => {},
  launcherLoader = loadLauncher,
  dataDirSource = null,
} = {}) {
  let childPid = null;
  let reused = true; // 默认"不收"：只有 start() 真的被调用过（= 确实是壳起的）才改成收
  let exitReason = null;
  // R206 ②：壳要把"只差一两像素"这种不成缺口的事写成日志，就得知道那个文件在哪。
  // 复用在跑的服务时壳**没有开过**日志文件 ⇒ 这一格保持 null，写日志那一步自己退化成主进程输出。
  let serviceLogFile = null;

  async function startService(projectDir, serviceDataDir, port) {
    const logPath = path.join(serviceDataDir, SERVICE_LOG_NAME);
    serviceLogFile = logPath; // R206 ②：壳自己起的那一次才留得到路径
    const handle = await openLog(logPath);
    const fd = typeof handle === 'number' ? handle : handle.fd;
    const spec = serverSpawnSpec({
      execPath,
      serverScript: path.join(projectDir, SERVICE_SCRIPT),
      projectDir,
      dataDir: serviceDataDir,
      fd,
      port,
      dataDirSource,
    });
    const child = spawnChild(spec.command, spec.args, spec.options);
    if (typeof child.unref === 'function') child.unref();
    if (typeof handle !== 'number' && typeof handle?.close === 'function') await handle.close();
    childPid = child?.pid ?? null;
    reused = false;
    const dead = () => Boolean(child?.exitCode !== null && child?.exitCode !== undefined) || Boolean(child?.signalCode);
    return { child, logPath, dead };
  }

  return {
    async launch() {
      const launcher = await launcherLoader(appDir);
      const result = await launcher.launchMusic({
        projectDir: appDir,
        dataDir,
        prepare: async (projectDir) => {
          const distIndexExists = await access(path.join(projectDir, 'dist', 'index.html'), constants.F_OK).then(() => true, () => false);
          const checked = prepareShellBuild({ distIndexExists });
          if (!checked.ok) throw new Error(checked.message);
        },
        start: async (projectDir, serviceDataDir, port) => {
          const { child, logPath, dead } = await startService(projectDir, serviceDataDir, port);
          const ready = await launcher.waitForService(port, projectDir, { isDead: dead });
          if (!ready) {
            const tail = await access(logPath, constants.F_R_OK)
              .then(() => import('node:fs/promises').then((fs) => fs.readFile(logPath, 'utf8')))
              .catch(() => '');
            throw new Error(`本地服务没有就绪（壳没有反复重启它，也没有动它没起的进程）。日志：${logPath}\n${tail.split('\n').slice(-12).join('\n')}`);
          }
        },
        open: async (url) => { await onUrl(url); },
      });
      reused = Boolean(result?.reused);
      return result;
    },
    /** 退出时调用：只收壳自己起的那一棵。 */
    stop() {
      return stopService({ reused, childPid });
    },
    state() {
      return { childPid, reused, exitReason };
    },
    /** 壳自己起服务那一次的日志文件路径（没起过 = null）。R206 ② 的"降级成日志"只有这一个落点。 */
    logPath() {
      return serviceLogFile;
    },
  };
}
