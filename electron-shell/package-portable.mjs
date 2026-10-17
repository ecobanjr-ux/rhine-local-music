// R209 · 免安装绿色版打包（自撰；唯一新增依赖 = @electron/packager，只服务构建期、住在壳的依赖树里）。
//
// 产物形状（方案 §一.2 / §一.3）：
//   <out>/RhineMusic-win32-x64/
//     RhineMusic.exe + *.dll/*.pak/locales…      ← Electron 运行时（@electron/packager 铺）
//     resources/app/                             ← Electron 的"应用根"（**普通目录，不是 asar**）
//       package.json                             ← 薄壳：main = electron-shell/main.mjs
//       electron-shell/*.mjs                     ← 壳代码（不带 node_modules）
//       app/{dist, scripts, public/icons, LICENSE, NOTICE.md}   ← 渲染层 + 服务（含 bridge 的 node_modules）
//     说明.txt                                   ← 数据在哪 / Win+R 最短路径 / 卸不卸载由你
//
// 三条不许变的（方案 §一.2）：**整棵 app 不进 asar**（普通目录 ⇒ 子进程 cwd/路径/ESM 与开发形态逐字一致）、
// **服务只有一条启动路径**（本脚本不碰 service-launch）、**不依赖 GitHub 取数**（electron 二进制走本机缓存 zip）。
//
// 用法：node electron-shell/package-portable.mjs [--out <目录>] [--zip] [--keep-staging]
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHELL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SHELL_DIR, '..');
export const APP_DIR = path.join(REPO_ROOT, 'app');
/** 产物默认落在**仓库外**（避免 500 MB 的东西进版本库） */
export const DEFAULT_OUT = path.resolve(REPO_ROOT, '..', 'rhine-portable-build');

/** 从 `app/` 里带走的（**白名单**，不是"排除法"）：漏一样就在判据里红。 */
export const APP_COPY_LIST = ['dist', 'scripts', 'public/icons', 'LICENSE', 'NOTICE.md'];
/**
 * 白名单内部还要**排除**的（R209 验收侧预检点名的那一条）：
 * `app/scripts/check-*.mjs` 是 61 个自检脚本（1.9 MB），里面含本机绝对路径（`D:/音乐软件开发`、`D:\音乐测试曲库`），
 * 而**运行期一个都不 import**（服务/启动器/桥三棵树的 import 面零命中 —— 判据 ㊽ 钉住）。
 * 绿色版是要发给别人的 ⇒ 这些既不必要、又会把本机路径带出去。
 */
export const APP_COPY_EXCLUDES = { scripts: [
  /(^|[\\/])check-[^\\/]*\.mjs$/,
  // R211 七：`.mimosa/` 是**开发工具的会话状态**（本仓库 `.gitignore` 里就有这一条），R211 重打包与上一版产物件数
  // 对表时抓到它被 `scripts` 整目录捎进包（解压树多出 1 个文件）⇒ 按**目录**排掉（工具会在会话里持续写新文件，
  // 排单个文件防不住）。它与 `check-*.mjs` 同族：都不是产品件，不该发出去。
  /(^|[\\/])\.mimosa([\\/]|$)/,
] };
/** 壳目录里不许进包的（打包脚本自己 + 依赖树）。 */
export const SHELL_COPY_SKIP = ['node_modules', 'package.json', 'package-lock.json', 'package-portable.mjs', '.npmrc'];

/**
 * R211（五）：**非字面量说明符的显式登记处**（闭包扫描器读不懂的那些，逐条写清是谁、为什么必须动态）。
 * 这条表是"防将来"那一格的出口：扫描器扫到 `require(变量)` / `` import(`模板`) `` 时 ——
 *   · 文件在这张表里 ⇒ 把登记的说明符**并入闭包**（不是放过它：登记了就要被解析，解析不到照样抛）；
 *   · 不在表里 ⇒ 直接抛（不许静默跳过 —— 静默跳过就是 R209 那次"看起来打包成功、用户机器上 ERR_MODULE_NOT_FOUND"的形状）。
 * 粒度是**文件级**（一个文件里所有非字面量都靠这张表兜），所以每条都必须写 `why`：写不出理由就别登记。
 */
export const RUNTIME_SPEC_REGISTRATIONS = [
  { file: 'bridge/providers/qq-auth.mjs', spec: '@yakult-green-tea/qq-music-api/serverless',
    why: '懒加载：离线自检 import 这个文件时不该把包拖进进程；两个子路径写在文件顶的常量表里是**刻意的单一出处**（那里明写"别在调用点写字面量"），所以不改字面量而是登记' },
  { file: 'bridge/providers/qq-auth.mjs', spec: '@yakult-green-tea/qq-music-api/mqtt', why: '同上（MQTT 长连那一路）' },
];

/** 薄 package.json（Electron 只读应用根这一份；`main` 指到壳里那一个入口）。 */
export function stagingPackageJson({ version, name = 'RhineMusic' }) {
  return {
    name: name.toLowerCase(),
    productName: name,
    version: String(version),
    type: 'module',
    main: 'electron-shell/main.mjs',
    // packager 要求这两个字段（缺 author 直接报错，冒烟跑出来的）；用**项目名**，不写个人信息
    description: '本地音乐播放器（免安装绿色版）· 自带运行时，数据放在 %LOCALAPPDATA%\\RhineMusic',
    author: name,
    private: true,
  };
}

/**
 * 本机那份 electron zip 所在的目录（`@electron/get` 的缓存形状：`<cache>/<sha>/electron-v<版本>-<平台>-<架构>.zip`）。
 * 找到就传 `electronZipDir` 给 packager ⇒ **零联网**。找不到返回 null（那时才让它按镜像去取）。
 */
export function findElectronZipDir({ localAppData, version, platform = 'win32', arch = 'x64', fs, path: pathImpl = path }) {
  const cacheRoot = pathImpl.join(localAppData ?? '', 'electron', 'Cache');
  let entries = [];
  try { entries = fs.readdirSync(cacheRoot); } catch { return null; }
  const wanted = `electron-v${version}-${platform}-${arch}.zip`;
  for (const entry of entries) {
    const dir = pathImpl.join(cacheRoot, entry);
    try {
      fs.statSync(pathImpl.join(dir, wanted));
      return dir;
    } catch { /* 这个 sha 目录里没有那一份 */ }
  }
  return null;
}

/** packager 的选项（`asar:false` = 整棵 app 普通目录；`prune:false` = --no-prune，不跑 npm）。 */
export function packagerOptions({ staging, out, version, electronZipDir }) {
  return {
    dir: staging,
    out,
    name: 'RhineMusic',
    appVersion: String(version),
    platform: 'win32',
    arch: 'x64',
    electronVersion: '43.7.9',
    asar: false,
    prune: false,
    overwrite: true,
    ...(electronZipDir ? { electronZipDir } : {}),
  };
}

async function copyInto(from, to, excludes = []) {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true,
    // 白名单里的每一项还能再排掉几样（`check-*.mjs` 那一条就是）；
    // filter 收到的 src 是**源**路径，两边都拿得到，用它判就够。
    ...(excludes.length ? { filter: (src) => !excludes.some((re) => re.test(src)) } : {}),
  });
}

/** 纯复制逻辑（自检可以直接对着临时目录跑它，不必真打包）。 */
export async function stageApp({ staging, appDir = APP_DIR, shellDir = SHELL_DIR }) {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  // 壳代码（.mjs 全带，跳过 node_modules 与打包脚本自己）
  const shellOut = path.join(staging, 'electron-shell');
  await mkdir(shellOut, { recursive: true });
  for (const entry of await readdir(shellDir)) {
    if (SHELL_COPY_SKIP.includes(entry)) continue;
    if (!entry.endsWith('.mjs')) continue;
    await copyInto(path.join(shellDir, entry), path.join(shellOut, entry));
  }
  // 渲染层 + 服务 + 图标 + 合规件（白名单逐项；`scripts` 里再排掉 `check-*.mjs` —— 见 APP_COPY_EXCLUDES）
  for (const item of APP_COPY_LIST) {
    await copyInto(path.join(appDir, item), path.join(staging, 'app', item), APP_COPY_EXCLUDES[item] ?? []);
  }
  const appPkg = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  await writeFile(path.join(staging, 'package.json'), `${JSON.stringify(stagingPackageJson({ version: appPkg.version }), null, 2)}\n`, 'utf8');
  // 服务端运行期的第三方包（闭包约十来包、几 MB）——**必须带**：真机抓过一次漏带（`music-metadata`）
  const runtime = runtimePackages({
    scriptsDir: path.join(appDir, 'scripts'),
    nodeModulesRoots: [path.join(appDir, 'node_modules'), path.join(appDir, 'scripts', 'bridge', 'node_modules')],
  });
  for (const [name, dir] of runtime.packages) {
    await copyInto(dir, path.join(staging, 'app', 'node_modules', name));
  }
  await copyInto(path.join(shellDir, 'portable-notes.txt'), path.join(staging, '说明.txt'));
  return { staging, version: appPkg.version, runtimePackages: [...runtime.packages.keys()].sort() };
}

async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else { files += 1; bytes += (await stat(full)).size; }
    }
  };
  await walk(dir);
  return { files, bytes };
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * 服务端**运行期**要的第三方包闭包（R209 真机抓出来的漏带：`music-metadata` 在 `app/node_modules` 里，
 * 一开始被当"开发依赖"整目录排掉 ⇒ 打包态服务 `ERR_MODULE_NOT_FOUND` 起不来）。
 *
 * 做法：**从运行期入口沿 import 图走**（`music-server.mjs` / `launch-music.mjs` / 桥入口
 * `bridge/online-bridge.mjs` 三个种子），只跟相对 import（那是运行期真会加载的文件），
 * 收集裸说明符 → 按 Node 的解析顺序找到包 → 沿 `dependencies` 递归闭包。
 * 两条讲究：
 *  · **不按 package.json 的全量 dependencies 算** —— 那会把只为构建 `dist` 的 three/pixi/react 也拖进来；
 *  · **已在 `scripts/` 树里的包跳过**（桥自己的 `bridge/node_modules` 随 scripts 白名单一起进包，
 *    这里再拷一份就是 83 MB 的重复）。
 * 扫不到就抛（"打包态服务起不来"这种错要在打包时就红，不是等真机）。
 */
export function runtimePackages({ scriptsDir, nodeModulesRoots, entries = ['music-server.mjs', 'launch-music.mjs', 'bridge/online-bridge.mjs'],
  registrations = RUNTIME_SPEC_REGISTRATIONS }) {
  const fsMod = process.getBuiltinModule('node:fs');
  const pathMod = process.getBuiltinModule('node:path');
  const files = [];
  const bare = new Map(); // name → 第一个导入它的文件所在目录（解析起点按导入点走）
  const packageNameOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  const visited = new Set();
  const importPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  const queue = entries.map((name) => pathMod.join(scriptsDir, name));
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let text;
    try { text = fsMod.readFileSync(file, 'utf8'); } catch { continue; }
    files.push(file);
    // R211（五 · 防将来）：**非字面量的动态 import/require** 静态算不出闭包 ⇒ 显式失败，不许静默跳过。
    // 表现：哪天运行期写成 `await import(name)` / `` import(`opencc-js`) `` / `'pkg-' + v` —— 闭包会漏掉那个包，
    // 打包"看起来成功"，直到用户机器上 ERR_MODULE_NOT_FOUND（这正是 R209 真机那一课的形状）。
    // 认法四条边界（第一版只写了①②，被 51 号判据当场抓到误伤 —— `playlist-import.mjs` 里有个对象方法简写
    // `async import({ text, name } = {}) {`，那是**定义**不是调用；加固自己先被既有闭包判据拦下，说明两道都在真跑）：
    //   ① 前面是点的不算 —— `store.import({ text })` 是**方法调用**，运行期文件里真有这样的行；
    //   ② 注释里的提及不算 —— 行注释与块注释续行都跳过（宁可漏判注释，也不许误伤真代码）；
    //   ③ 第一个参数以 `{` 开头的不是动态 import —— 动态 import 的说明符不可能长成解构模式；
    //   ④ 整行是方法/函数定义的跳过 —— 参数表后面直接跟 `{`（对象简写与类方法都算）。
    for (const dynamic of text.matchAll(/(?:^|[^.\w])(?:import|require)\s*\(\s*/g)) {
      const after = text.slice(dynamic.index + dynamic[0].length);
      if (after.startsWith("'") || after.startsWith('"')) continue;   // 引号字面量：上面 importPattern 已经收走
      if (after.startsWith('{')) continue;                            // ③ 解构参数 ⇒ 是定义
      const lineStart = text.lastIndexOf('\n', dynamic.index) + 1;
      const lineEnd = text.indexOf('\n', lineStart);
      const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
      if (line.slice(0, dynamic.index - lineStart).includes('//')) continue;   // ② 这一行的行注释里
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;   // ② 块注释里
      if (/^(?:async\s+)?(?:import|require)\s*\([^)]*\)\s*\{/.test(trimmed)) continue;                 // ④ 定义行
      // 比对方式：把**登记表那一侧**（本脚本里写的正斜杠字面量）按本平台分隔符拼一次再比 ——
      // 运行时路径的形态一个字都不动（R204 ⑩ 钉着：改写分隔符形态会撞 `projectDir` 逐字比较那格）。
      // 直接 endsWith 正斜杠字面量在 Windows 上会**静默不命中**（R209 那个混斜杠 startsWith 的同族坑）。
      const registered = registrations.filter((r) => file.endsWith(pathMod.join(...String(r.file).split('/'))));
      if (registered.length > 0) {
        for (const r of registered) {
          if (!r.why) throw new Error(`登记表里 ${r.file} 那条缺 why —— 登记必须说得出为什么必须动态：${r.spec}`);
          const name = packageNameOf(r.spec);
          if (!bare.has(name)) bare.set(name, pathMod.dirname(file));
        }
        continue;
      }
      throw new Error(`运行期有**非字面量**的动态 import/require：${file}\n`
        + `  附近：${trimmed.slice(0, 90)}\n`
        + '  ⇒ 打包没法静态算闭包（漏一个包 = 用户机器上 ERR_MODULE_NOT_FOUND）。'
        + '要么改成引号字面量，要么在 RUNTIME_SPEC_REGISTRATIONS 里显式登记那个包并写明为什么必须动态。');
    }
    for (const match of text.matchAll(importPattern)) {
      const spec = match[1];
      if (spec.startsWith('node:') || spec.startsWith('/')) continue;
      if (spec.startsWith('.')) {
        const resolved = pathMod.resolve(pathMod.dirname(file), spec);
        queue.push(/\.mjs$/.test(resolved) ? resolved : `${resolved}.mjs`);
        continue;
      }
      const name = packageNameOf(spec);
      if (!bare.has(name)) bare.set(name, pathMod.dirname(file));
    }
  }
  const found = new Map(); // name → 绝对目录（**只装 scripts 树之外的那些**）
  const resolveRoot = (fromDir, name) => {
    let dir = fromDir;
    while (true) {
      const candidate = pathMod.join(dir, 'node_modules', name);
      if (fsMod.existsSync(pathMod.join(candidate, 'package.json'))) return candidate;
      const parent = pathMod.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const root of nodeModulesRoots) {
      const candidate = pathMod.join(root, name);
      if (fsMod.existsSync(pathMod.join(candidate, 'package.json'))) return candidate;
    }
    return null;
  };
  const visit = (name, fromDir) => {
    if (found.has(name)) return;
    const dir = resolveRoot(fromDir, name);
    if (!dir) throw new Error(`打包清单里找不到运行期依赖：${name}（从 ${fromDir} 往上都没找到）—— 绿色版会起不来，先修清单`);
    // 已经在 scripts 树里的（桥自己的 node_modules）随 scripts 白名单进包，这里不再拷。
    // 用 `path.relative` 判归属 —— `startsWith` 会在正/反斜杠混用的路径上静默失手
    // （第一版就是这么把桥的 kugoumusicapi 当成"要拷的包"，顺带拖进 127 个 express 系依赖）。
    const rel = pathMod.relative(scriptsDir, dir);
    if (rel !== '' && !rel.startsWith('..') && !pathMod.isAbsolute(rel)) return;
    found.set(name, dir);
    let pkg = {};
    try { pkg = JSON.parse(fsMod.readFileSync(pathMod.join(dir, 'package.json'), 'utf8')); } catch { return; }
    for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir);
  };
  for (const [name, fromDir] of bare) visit(name, fromDir);
  return { files, bare: [...bare.keys()].sort(), packages: found };
}

async function main() {
  const argv = process.argv.slice(2);
  const outRoot = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : DEFAULT_OUT;
  const wantZip = argv.includes('--zip');
  const keepStaging = argv.includes('--keep-staging');
  const { packager } = await import('@electron/packager');

  const staging = path.join(outRoot, '.staging');
  const { version } = await stageApp({ staging });
  const appPkg = JSON.parse(await readFile(path.join(APP_DIR, 'package.json'), 'utf8'));
  const { readdirSync, statSync } = await import('node:fs');
  const zipDir = findElectronZipDir({ localAppData: process.env.LOCALAPPDATA, version: '43.7.9', fs: { readdirSync, statSync } });
  console.log(`[stage] 版本 ${version}；electron zip 目录：${zipDir ?? '(未找到 ⇒ 将按镜像取)'}`);
  console.log(`[stage] ${staging} ← electron-shell/*.mjs + app/{${APP_COPY_LIST.join(', ')}}`);

  const outPaths = await packager(packagerOptions({ staging, out: outRoot, version, electronZipDir: zipDir }));
  const packagedDir = outPaths[0];
  console.log(`[pack] ${packagedDir}`);
  // R209（验收侧预检修正②）：`说明.txt` 必须躺在**解压后的顶层**（与 RhineMusic.exe 并排）——
  // 用户解压完第一眼看到的是这一层，藏在 `resources\app\` 里等于没有。staging 里那份留着（应用根自解释），
  // 这里再往产物根拷一份。
  await copyInto(path.join(staging, '说明.txt'), path.join(packagedDir, '说明.txt'));

  const stats = await dirStats(packagedDir);
  console.log(`[size] 解压后 ${mb(stats.bytes)}（${stats.files} 个文件）`);

  let zipPath = null;
  if (wantZip) {
    zipPath = path.join(outRoot, `RhineMusic-${version}-win-x64.zip`);
    await rm(zipPath, { force: true });
    // 用**系统自带**的 bsdtar（`-a` 按扩展名自动选 zip）。注意要写绝对路径：
    // Git Bash 的 PATH 里 `/usr/bin/tar` 是 GNU tar，它不认 `-a`（冒烟跑出来 status 128）。
    const bsdtar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(bsdtar, ['-a', '-c', '-f', zipPath, '-C', path.dirname(packagedDir), path.basename(packagedDir)], { stdio: 'inherit' });
    console.log(`[zip]  ${mb((await stat(zipPath)).size)}  ${zipPath}`);
  }
  if (!keepStaging) await rm(staging, { recursive: true, force: true });
  console.log('[done]');
  return { packagedDir, zipPath, stats, version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
