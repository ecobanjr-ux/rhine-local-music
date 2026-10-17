// R209 · 数据目录与"浏览器配置目录"的解析 —— **三段式，全仓唯一出处**（方案 §一.4）。
//
//   ① `MUSIC_DATA_DIR`（环境变量，最高优先 —— 真便携的出口）
//   ② 打包态默认：`%LOCALAPPDATA%\RhineMusic`
//   ③ 开发形态默认：**返回 null**，交给启动器按今天的默认走（`../music-data-v3`）
//      —— 那两行（`launch-music.mjs` 与 `music-server.mjs`）**一个字都不许动**：用户那台 5175 正跑在它上面（口径第 7 条）。
//
// 闸门是 `app.isPackaged`：`electron .`（开发）为 false ⇒ 行为与今天逐字一致；打包态为 true ⇒ 走 ②。
// 纯函数 + 注入式（`path`/`env` 都从参数来）⇒ 自检能直接驱动三格，不需要真开 Electron。
import path from 'node:path';

/** 打包态的默认目录名（在 `%LOCALAPPDATA%` 之下）。 */
export const PACKAGED_DATA_DIR_NAME = 'RhineMusic';

/**
 * 浏览器配置/缓存住哪：**只有打包态才重定向**（开发形态一个字不动，与数据目录同一条原则）。
 * 为什么放数据目录里：绿色版"卸载 = 删目录"要成立 ⇒ 程序目录之外只许剩数据目录一处（今天那 240 MB 的
 * `%APPDATA%\local-music-shell` 就是反例）。连带一条**如实说明**：**单实例锁的载体也在 userData 里**
 * ⇒ 两套数据目录 = 两个实例都能起（可接受，台账 R209 已记）。
 */
export const SHELL_PROFILE_SUBDIR = 'shell-profile';

/**
 * 判一段路径是不是"空"，用来决定要不要说那句"数据目录在哪"（首次启动）。
 * 只看"在不在"，不读内容 —— 不猜、不动用户的东西。
 */
export function dataDirLooksNew({ dataDir, fs, path: p = path }) {
  if (!dataDir) return false;
  try {
    return fs.readdirSync(dataDir).length === 0;
  } catch {
    return true; // 读不到（还没建）⇒ 算"新"
  }
}

export function resolveDataDir({ env = {}, isPackaged = false, localAppData = '', path: p = path } = {}) {
  const fromEnv = typeof env.MUSIC_DATA_DIR === 'string' ? env.MUSIC_DATA_DIR.trim() : '';
  if (fromEnv) return { dataDir: p.resolve(fromEnv), source: 'env' };
  if (isPackaged) {
    const base = typeof localAppData === 'string' ? localAppData.trim() : '';
    if (!base) return { dataDir: null, source: 'packaged-default-missing-localappdata' };
    return { dataDir: p.join(base, PACKAGED_DATA_DIR_NAME), source: 'packaged-default' };
  }
  return { dataDir: null, source: 'dev-default' };
}

/** 浏览器配置目录（只在 dataDir 解析出来之后才有值；开发形态返回 null = 不重定向）。 */
export function shellProfileDir({ dataDir, path: p = path } = {}) {
  return dataDir ? p.join(dataDir, SHELL_PROFILE_SUBDIR) : null;
}
