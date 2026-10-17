// Electron 壳（M1 最小件，台账 R204）· 自检。
//
// 这一件的红线只有一句话：**壳只做窗口系统的事，别的东西一个字都不新增**。
// 所以这一段的判据分三类，缺一类都算没验：
//   A 撤法可机检 —— 壳是独立目录，主树里不许有任何东西认识它（②③）；
//   B 只吃本机地址 —— 判定只有一个出处，导航四条红线都走它（④⑤⑥⑪⑫）；
//   C 服务带法不许写第二套 —— 复用判定继续住在启动器里（⑦⑧⑨⑩）。
//
// B/C 两类的核心形状都是**纯函数**（零 electron import），所以这里的运行时测试
// 是拿真函数跑的；main.mjs / window.mjs 那两份要 import `electron`，纯 Node 跑不起来，
// 只能按源码形状判 —— 这一点在每条断言的注释里写清"为什么这格只能是形状判据"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELL = new URL('../../electron-shell/', import.meta.url);
const shellPath = (name) => new URL(name, SHELL);

/** 实现件还不存在时给一条**说清原因的失败**（不是模块找不到的报错 —— 红要红在预期那一格）。 */
async function loadShell(name) {
  try {
    return await import(shellPath(name).href + '?case=' + name);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail(`electron-shell/${name} 还不存在 —— 这是 R204 的实现件，判据先于实现写在（TDD）`);
    }
    throw error;
  }
}

async function shellSource(name) {
  try {
    return await readFile(shellPath(name), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') assert.fail(`electron-shell/${name} 还不存在 —— R204 的实现件缺文件`);
    throw error;
  }
}

/**
 * 剥掉**整行**注释后的代码文本。
 * 为什么只剥整行、不用 `//.*$` 那种行内正则：字符串里的 `http://…` 会被一起吃掉，
 * 那等于把"代码里真写了某个地址"这种违例藏进注释扫描里 —— 判据只能变弱，不许这样。
 * 用在"字面量只许一个出处"这一族判据上：说明性注释里提到 `occupied` / `127.0.0.1` 不算抄了第二套判定。
 */
function codeOnly(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

async function shellCode(name) {
  return codeOnly(await shellSource(name));
}

async function shellCodeFiles() {
  const files = (await shellFiles()).filter((name) => /\.mjs$/.test(name));
  const entries = [];
  for (const name of files) entries.push([name, codeOnly(await readFile(shellPath(name), 'utf8'))]);
  return entries;
}

async function shellFiles() {
  const entries = await readdir(SHELL, { recursive: true });
  return entries.filter((name) => !name.startsWith('node_modules/') && /\.(mjs|cjs|json)$/.test(name));
}

const APP_ROOT = new URL('../', import.meta.url);

// ───────────────────────── A · 撤法可机检 ─────────────────────────

test('R204 ①（R209 改写）：新增依赖恰好两个 —— electron 与打包工具，都钉到具体版本；主树不受影响', async () => {
  const pkg = JSON.parse(await shellSource('package.json'));
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), ['@electron/packager', 'electron'], 'devDependencies 恰好两个：运行时 + 打包工具（第二期批准的那一个）；别的一律不许顺手加');
  assert.equal(pkg.devDependencies.electron, '43.7.9', '必须钉具体版本：^/~ 会让下一个人装到 44.x，而本件的窗口形状全部按 43 的量测写');
  assert.deepEqual(pkg.dependencies ?? {}, {}, '壳没有运行时依赖（"只加载本机地址"的东西不该有 dependencies）');
  assert.equal(pkg.type, 'module', '主进程用 ESM（Task 0 实测：ESM 入口在 Electron 43 可用）');
  assert.match(pkg.scripts?.start ?? '', /^electron(\s|\b)/, '跑法在案：npm start = electron .');
  assert.equal(pkg.private, true, '壳不发布到任何 registry');
});

test('R204 ②：撤法可机检 —— 主树里没有任何东西认识这个壳（整目录删掉即回到纯浏览器形态）', async () => {
  const offenders = [];
  // 唯一的例外是这一段自己：自检必须能点名它检查的东西（同 R203 那条"判据文件不算消费者"的规矩）。
  // 例外按**文件名**收，不按内容放宽 —— 除这一个文件之外任何主树文件提到壳都是违例。
  const SELF = 'check-music-shell.mjs';
  for (const dir of ['src/', 'scripts/']) {
    const entries = await readdir(new URL(dir, APP_ROOT), { recursive: true });
    // 递归 readdir 在 Windows 上会给反斜杠，而 new URL() 把反斜杠当普通字符 ⇒ 一律先归成正斜杠再拼 URL。
    for (const rawEntry of entries.filter((name) => !name.endsWith(SELF))) {
      const entry = rawEntry.split('\\').join('/');
      if (!/\.(ts|tsx|mjs|cjs|css|html)$/.test(entry)) continue;
      const text = await readFile(new URL(dir + entry, APP_ROOT), 'utf8');
      // 只认"真的引用"：import/require 到 electron、或写死 electron-shell 路径。
      // 注释里提到"Electron 壳"是允许的（本项目文档一直在谈阶段 7），所以判据落在引用形态上，不落在词上。
      if (/from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)|electron-shell/.test(text)) {
        offenders.push(`${dir}${entry}`);
      }
    }
  }
  assert.deepEqual(offenders, [], '主树（app/src、app/scripts）里出现了对壳的引用 ⇒ 删掉 electron-shell/ 就不再是自洽的一版，撤法失效');
});

test('R204 ③：主树依赖表一字未动（"零新增依赖"这条既有判据在壳进来之后仍然可机检）', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', APP_ROOT), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', APP_ROOT), 'utf8'));
  for (const section of ['dependencies', 'devDependencies']) {
    assert.equal(manifest[section]?.electron, undefined, `app/package.json 的 ${section} 里不许有 electron`);
    for (const name of Object.keys(manifest[section] ?? {})) {
      assert.ok(name !== 'electron' && !name.startsWith('electron/'), `${name} 是壳系依赖，不该进主树`);
    }
  }
  // 按**包路径名**认，不按子串认：主树里本来就有一个 `electron-to-chromium`（browserslist 的数据集、
  // autoprefixer 的传递依赖，第一版我用子串匹配把它误判成"electron 进来了"）。
  const lockNames = Object.keys(lock.packages ?? {}).map((key) => key.replace(/^node_modules\//, '').replace(/^.*\/node_modules\//, ''));
  assert.deepEqual(lockNames.filter((name) => name === 'electron' || name.startsWith('electron/')), [], 'app/package-lock.json 里不许出现 electron 包');
});

// ───────────────────────── B · 只吃本机地址 ─────────────────────────

test('R204 ④：本机地址判定真值表 —— 只有 127.0.0.1:那个端口 过， hostname 戏法一律拒', async () => {
  const { isAllowedShellUrl } = await loadShell('shell-url.mjs');
  const port = 5175;
  const cases = [
    ['http://127.0.0.1:5175/', port, true, '本页'],
    ['http://127.0.0.1:5175/assets/app.js', port, true, '同源资源'],
    ['http://127.0.0.1:5175/api/library', port, true, '同源接口'],
    ['http://127.0.0.1:5176/', port, false, '别的端口不是我们的服务'],
    ['http://127.0.0.1/', port, false, '缺端口 = 80，不是本机服务'],
    ['https://127.0.0.1:5175/', port, false, '不是 http ⇒ 不是我们起的那一个'],
    ['http://localhost:5175/', port, false, 'localhost 与 127.0.0.1 等价的字符串戏法不收（服务只用 127.0.0.1 绑与拼）'],
    ['http://[::1]:5175/', port, false, 'IPv6 回环不是这个服务的绑定地址（服务 listen 的是 127.0.0.1）'],
    ['http://127.1:5175/', port, true, 'WHATWG 把 127.1 归一成 127.0.0.1 ⇒ 落的还是本机那个服务，不是出网（一手量：hostname=127.0.0.1）'],
    ['http://0x7f000001:5175/', port, true, '同上：十六进制写法也被归一成 127.0.0.1（判定按解析后的组分，不按字面串 —— 第一版我按字面串判 false，是量错的）'],
    ['http://127.0.0.1.evil.example:5175/', port, false, '后缀伪装 hostname（一手量：解析后 hostname 就是这个带后缀的串 ⇒ 拒）'],
    ['http://evil.example/', port, false, '远程主机'],
    ['https://example.invalid/', port, false, '远程主机（加密也不算）'],
    ['file:///D:/音乐软件开发/app/dist/index.html', port, false, 'file:// 一律拒（壳不打包渲染层）'],
    ['//127.0.0.1:5175/', port, false, '协议相对地址没有 origin 可比（一手量：new URL 直接抛 ERR_INVALID_URL）'],
    ['http://0.0.0.0:5175/', port, false, '0.0.0.0 不是 127.0.0.1'],
    ['not a url', port, false, '解析不了就拒，不猜'],
  ];
  for (const [input, p, expected, why] of cases) {
    assert.equal(isAllowedShellUrl(input, p), expected, `${input} ⇒ 期望 ${expected}（${why}）`);
  }
});

test('R204 ⑤：地址只有一个拼法 —— shellOrigin(port) 拒绝非法端口，NaN 不许进 URL', async () => {
  const { shellOrigin } = await loadShell('shell-url.mjs');
  assert.equal(shellOrigin(5175), 'http://127.0.0.1:5175/');
  assert.equal(shellOrigin('5176'), 'http://127.0.0.1:5176/', '字符串端口也收（启动器回的是数字，但传串不该炸）');
  for (const bad of [0, -1, 1.5, Number.NaN, 'abc', undefined, null, 70000]) {
    assert.throws(() => shellOrigin(bad), /端口/, `非法端口 ${String(bad)} 必须抛，不许拼出 http://127.0.0.1:undefined/`);
  }
});

test('R204 ⑥：导航四条红线都在案，决定全部走同一个判定（第二处 hostname 比较即违例）', async () => {
  // 这格只能是形状判据：will-navigate / setWindowOpenHandler 这些回调在 Electron 进程里才有，纯 Node 跑不起来。
  const window = await shellCode('window.mjs');
  for (const hook of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'setWindowOpenHandler', 'onBeforeRequest']) {
    assert.ok(window.includes(hook), `导航红线缺 ${hook} —— Task 0 实测：没有守卫时 Electron 自己不拦远程地址（探针那次能取到外部站点的错是 DNS 错，不是被拦）`);
  }
  assert.ok(/isAllowedShellUrl\(/.test(window), '导航决定必须读那一个判定');
  // 真正的不变式是"别处不再自己比一次 hostname"，不是"调用了几次"（次数会随一次正常的抽助手而变 —— R203 的 Q84 就记过这一族）。
  assert.doesNotMatch(window, /hostname\s*[!=]==/, 'window.mjs 里自己比 hostname = 第二个判定出处');
  assert.doesNotMatch(window, /loadFile\s*\(/, '不许 loadFile：Task 0 实测上游是 loadFile(dist/index.html)，我们不适配（渲染层必须由服务提供同源接口）');
  assert.match(window, /loadURL\(\s*target\s*\)/, 'loadURL 的实参必须来自拼好并验过的那个地址');
  // 代码里出现的 `http(s)://` 只许是 webRequest 的通配过滤器（`http://*/*` 那一族），不许是任何具体地址。
  const urlLiterals = window.match(/https?:\/\/[^\s'"`)，（]+/g) ?? [];
  for (const literal of urlLiterals) {
    assert.match(literal, /^https?:\/\/\*\//, `window.mjs 的代码里出现了具体地址字面量（应当只有通配过滤器）：${literal}`);
  }
  assert.match(window, /action:\s*'deny'/, '新窗口一律拒（M1 只有一块画面）');
  assert.doesNotMatch(window, /action:\s*'allow'/, '本件不许放行任何新窗口');
});

test('R204 ⑦：本机地址的字面量在壳里只有一个出处', async () => {
  const owners = [];
  for (const [name, code] of await shellCodeFiles()) {
    if (code.includes('127.0.0.1')) owners.push(name);
  }
  assert.deepEqual(owners, ['shell-url.mjs'], '地址字面量只许住在 shell-url.mjs（判定只有一个出处 —— R203 立的同一规矩）');
});

test('R204 ⑧：窗口安全口径三件套在案且唯一，远程调试与 devtools 一处都不许有', async () => {
  const window = await shellSource('window.mjs');
  for (const key of ['contextIsolation', 'nodeIntegration', 'sandbox']) {
    const hits = window.match(new RegExp(`${key}:\\s*(true|false)`, 'g')) ?? [];
    assert.equal(hits.length, 1, `${key} 必须出现且只出现一次（多处 = 第二份口径，改一处漏一处）`);
  }
  assert.match(window, /contextIsolation:\s*true/);
  assert.match(window, /nodeIntegration:\s*false/);
  assert.match(window, /sandbox:\s*true/, '上游 webPreferences 没有 sandbox（Task 0 实测 4800-4801 / 5073-5074）⇒ 这一格是比上游更严，不是照搬');
  assert.match(window, /webSecurity:\s*true/, '上游 5076 那句 webSecurity:true 沿下来（它的注释写着 "Disable for local app"，值本身是开的）');
  const all = (await Promise.all((await shellFiles()).filter((n) => /\.mjs$/.test(n)).map((n) => readFile(shellPath(n), 'utf8')))).join('\n');
  for (const banned of ['remote-debugging-port', 'ELECTRON_ENABLE_LOGGING', 'openDevTools', 'inspect=', 'disable-web-security']) {
    assert.ok(!all.includes(banned), `壳里不许出现 ${banned}（任务书 2.3：不开远程调试）`);
  }
});

// ───────────────────────── C · 服务带法不许写第二套 ─────────────────────────

test('R204 ⑨：壳复用启动器的 launchMusic（带 realpath 那一格），且壳内零第二套复用判定', async () => {
  const service = await shellCode('service-launch.mjs');
  assert.match(service, /launch-music\.mjs/, '必须从 app/scripts/launch-music.mjs 取（Task 0 实测：正斜杠形态问 projectDir 回 occupied ⇒ 壳会再起一个服务，realpath 那一格住在 launchMusic 里）');
  assert.match(service, /pathToFileURL/, 'Windows 上 ESM 只能 import file:// URL（Task 0 实测 ERR_UNSUPPORTED_ESM_URL_SCHEME）');
  assert.match(service, /launchMusic\s*\(/, '调用启动器那一个入口');
  assert.match(service, /waitForService\s*\(/, '就绪判定也走启动器那一个出处（R204 抽出来的那格）；壳自己再写一遍 kind 判据即违例');
  // 这些字面量是启动器判定的"内部词汇"：壳代码里出现任何一个 = 抄了第二套判定。
  // 说明性注释里提到不算（codeOnly 只剥整行注释，剥不掉的真字面量才会被抓）。
  for (const banned of ['/api/health', "'ours'", '"ours"', 'occupied', 'SERVICE_ID', 'choosePort(']) {
    for (const [name, code] of await shellCodeFiles()) {
      assert.ok(!code.includes(banned), `${name} 的代码里出现了 ${banned} —— 复用判定的词汇只许住在启动器里，壳不许抄第二份`);
    }
  }
});

test('R204 ⑩：路径形态一个字都不许改（把反斜杠换成正斜杠 = 实测会再起一个服务）', async () => {
  for (const [name, code] of await shellCodeFiles()) {
    assert.doesNotMatch(code, /replace\(\s*\/\\\\\/g|replaceAll\(\s*['"]\\\\['"]|split\(\s*path\.sep\s*\)\.join\(\s*['"]\/['"]/, `${name} 在改写路径分隔符形态 ⇒ 会撞 Task 0 量到那格（projectDir 逐字比较，改形态就误判 occupied、壳再起一个服务）`);
  }
});

test('R204 ⑪：服务子进程规格逐格在案（壳自带的 Node + ELECTRON_RUN_AS_NODE + 同一份命令行 + 日志追加）', async () => {
  const { serverSpawnSpec } = await loadShell('service-launch.mjs');
  const spec = serverSpawnSpec({
    execPath: 'D:\\somewhere\\electron.exe',
    serverScript: 'D:\\app\\scripts\\music-server.mjs',
    projectDir: 'D:\\app',
    dataDir: 'D:\\data',
    logPath: 'D:\\data\\player-service.log',
    fd: 7,
    port: 5175,
  });
  assert.equal(spec.command, 'D:\\somewhere\\electron.exe', '可执行文件 = 壳自己（process.execPath），不是系统 node');
  assert.deepEqual(spec.args, ['D:\\app\\scripts\\music-server.mjs', '--port', '5175'], '命令行与启动器/自检/取证用的是同一条');
  assert.equal(spec.options.env.ELECTRON_RUN_AS_NODE, '1', '不带它 electron.exe 会把 .mjs 当应用目录（Task 0 实测）');
  assert.equal(spec.options.env.MUSIC_DATA_DIR, 'D:\\data', '数据目录交给服务自己认');
  assert.equal(spec.options.cwd, 'D:\\app');
  assert.equal(spec.options.detached, true, 'detached：Task 0 实测父进程退出后服务仍活着，这是既有语义');
  assert.deepEqual(spec.options.stdio, ['ignore', 7, 7], '日志落点 = <dataDir>/player-service.log（追加，与启动器同一份）');
  assert.equal(spec.port, 5175);
});

test('R204 ⑫：构建检查不跑 npm（Windows 上 spawnSync(npm) 实测 ENOENT），缺构建只给一句实话', async () => {
  const { prepareShellBuild, SHELL_NO_BUILD_MESSAGE } = await loadShell('service-launch.mjs');
  assert.deepEqual(prepareShellBuild({ distIndexExists: true }), { ok: true }, '已构建 ⇒ 什么都不做（壳不重复构建，也不碰 npm）');
  const missing = prepareShellBuild({ distIndexExists: false });
  assert.equal(missing.ok, false, '没构建过必须说实话，不许"看起来起来了"');
  assert.ok(missing.message.includes('构建'), `实话里要点名"构建"：${missing.message}`);
  assert.equal(missing.message, SHELL_NO_BUILD_MESSAGE, '文案只有一个出处');
  assert.doesNotMatch(missing.message, /npm|install|依赖/, '实话不许承诺跑 npm（这条路在 Windows 上实测走不通）');
  for (const [name, code] of await shellCodeFiles()) {
    assert.doesNotMatch(code, /spawnSync\(\s*['"]npm|runNpm|npm ci|npm run build/, `${name} 在壳里跑 npm —— 那是第二个构建路径，且 Windows 上实测起不来`);
  }
});

test('R204 ⑬：壳退出只收自己起的进程（按 pid + /T），复用的那一个一个字都不动', async () => {
  const { shouldStopOwnedService, stopOwnedService } = await loadShell('service-launch.mjs');
  // 运行时真调用：这三格是"不杀它没起的服务"那条红线唯一能正面钉的地方。
  assert.equal(shouldStopOwnedService({ reused: true, childPid: 4242 }), false, '复用在跑的服务 ⇒ 绝不收');
  assert.equal(shouldStopOwnedService({ reused: false, childPid: null }), false, '没起过 ⇒ 没有可收的 pid');
  assert.equal(shouldStopOwnedService({ reused: false, childPid: 0 }), false, 'pid 0 不是进程');
  assert.equal(shouldStopOwnedService({ reused: false, childPid: 4242 }), true, '自己起的那一个才收');
  const killed = [];
  assert.deepEqual(stopOwnedService({ reused: true, childPid: 4242, kill: (pid) => killed.push(pid) }), { killed: false, reason: 'reused' });
  assert.deepEqual(killed, [], '复用那一格连 kill 都不许被调到');
  assert.deepEqual(stopOwnedService({ reused: false, childPid: 4242, kill: (pid) => killed.push(pid) }), { killed: true, pid: 4242 });
  assert.deepEqual(killed, [4242], '只有壳自己 spawn 的 pid 会走到 kill');

  // 形状：Windows 上收子树用 taskkill /PID <自己起的 pid> /T /F（/T 是 Task 0 实测加的）。
  const service = await shellCode('service-launch.mjs');
  assert.match(service, /taskkill/, 'Windows 上收子进程用 taskkill（Task 0 实测：端口释放、无残留）');
  assert.match(service, /'\/T'/, '带 /T：实测出现过一次"辅助子进程随行"，单收 pid 不可预期');
  assert.match(service, /'\/PID'/, '只按 PID');
  assert.doesNotMatch(service, /taskkill[^\n]*\/IM\b/, '不许按映像名粗匹配 —— 那条历史事故（误杀用户 5175 的桥）就是这么来的');
  assert.doesNotMatch(service, /taskkill[^\n]*node\.exe/, '不许按命令行里的 node.exe 粗匹配，同一场事故');
});

// ───────────────────── D · 托盘 / 快捷键 / 单实例（Task 2） ─────────────────────

test('R204 ⑭（R209 改写）：托盘项按总开关出现，并带上数据管理两件 —— 关着时**恰五项**（逐项点名），开着时六项', async () => {
  const { buildTrayMenuItems, TRAY_ITEM_IDS, DATA_TRAY_LABELS } = await loadShell('tray-menu.mjs');
  // ① 关着（缺省 = 读 `wallpaper-switch.mjs` 那一个常量）：**恰五项**、逐项点名、不留空位也不留灰项
  const off = buildTrayMenuItems({ windowVisible: true, wallpaperEnabled: false });
  assert.equal(off.length, 5, `R209：壁纸入口藏起来时菜单是五项（显示/隐藏 · 打开数据目录 · 清空全部数据 · 分隔 · 退出），实际 ${off.length} 项`);
  assert.deepEqual(
    off.map((item) => item.id ?? (item.separator ? 'separator' : '?')),
    [TRAY_ITEM_IDS.toggleWindow, TRAY_ITEM_IDS.openDataDir, TRAY_ITEM_IDS.clearData, 'separator', TRAY_ITEM_IDS.quit],
    '五项的顺序与身份逐项点名（数据两件排在壁纸项之后、分隔线之前）',
  );
  // R208 那条**继续钉住**：壁纸那一项仍不在（不许因为加了别的项就顺手放回来）
  assert.ok(!JSON.stringify(off).includes('壁纸'), `五项里不许出现壁纸那一项的文案：${JSON.stringify(off)}`);
  assert.ok(!JSON.stringify(off).includes('toggle-wallpaper'), '也不许出现它的动作 —— 灰项、隐形占位都不行');
  // 数据两件：标签与动作逐条点名
  assert.equal(off.find((item) => item.id === TRAY_ITEM_IDS.openDataDir).label, DATA_TRAY_LABELS.open);
  assert.equal(off.find((item) => item.id === TRAY_ITEM_IDS.openDataDir).action, 'open-data-dir');
  assert.equal(off.find((item) => item.id === TRAY_ITEM_IDS.clearData).action, 'clear-data');
  assert.equal(off.filter((item) => item.type === 'checkbox').length, 0, '那一格 checkbox 整项不在菜单里（数据两件不是勾选项）');
  const offToggle = off.find((item) => item.id === TRAY_ITEM_IDS.toggleWindow);
  assert.match(offToggle.label, /隐藏/, '窗口开着时这一项该说"隐藏"');
  assert.match(buildTrayMenuItems({ windowVisible: false, wallpaperEnabled: false }).find((item) => item.id === TRAY_ITEM_IDS.toggleWindow).label, /显示/, '窗口关着时该说"显示"（读的是窗口那份事实，不另记一份）');
  assert.equal(off.find((item) => item.id === TRAY_ITEM_IDS.quit).action, 'quit', '退出项必须对应"真的关干净"那一个动作');

  // ② 开着（把开关传成 true —— 只为把"放回来是什么样"也钉住；接线侧不传，只读常量）
  const items = buildTrayMenuItems({ windowVisible: true, wallpaperEnabled: false, wallpaperAvailable: true });
  assert.equal(items.length, 6, '壁纸放回来之后是六项');
  const ids = items.filter((item) => item.id).map((item) => item.id);
  for (const required of [TRAY_ITEM_IDS.toggleWindow, TRAY_ITEM_IDS.wallpaper, TRAY_ITEM_IDS.openDataDir, TRAY_ITEM_IDS.clearData, TRAY_ITEM_IDS.quit]) {
    assert.ok(ids.includes(required), `开关打开时托盘必须有 ${required}`);
  }
  assert.ok(items.some((item) => item.separator), '分组必须有分隔线（上游 2600-2705 那一份就是分隔线分组）');
  const wallpaper = items.find((item) => item.id === TRAY_ITEM_IDS.wallpaper);
  assert.equal(wallpaper.type, 'checkbox', '壁纸模式是一格开关');
  assert.equal(wallpaper.checked, false, '默认关（常驻 + 穿透这种画面不该在双击就开时默认出现）');
  const on = buildTrayMenuItems({ windowVisible: true, wallpaperEnabled: true, wallpaperAvailable: true }).find((item) => item.id === TRAY_ITEM_IDS.wallpaper);
  assert.equal(on.checked, true, '开关状态读的是传进来的那份，不在菜单里另算');
  assert.ok(!wallpaper.label.includes('尚未生效') && !on.label.includes('尚未生效'), 'R205 之后"尚未生效"就是假话');
  assert.match(wallpaper.label, /铺满|穿透/, `关着的时候要说得出这一档做什么：${wallpaper.label}`);
  assert.match(on.label, /退出/, `Q56 那一格：托盘项必须自己说得出怎么出去：${on.label}`);
  assert.equal(wallpaper.action, 'toggle-wallpaper', '两态共用同一个动作，不换 id');
  assert.equal(on.action, wallpaper.action);
});
test('R204 ⑮：全局快捷键四条在案，且不劫持媒体键（媒体键继续走页面那条 Media Session）', async () => {
  const { SHELL_SHORTCUTS, shortcutAction } = await loadShell('shortcuts.mjs');
  assert.equal(SHELL_SHORTCUTS.length, 4, `R208：开关关着时接线读的那张表恰好四条（壁纸那一条不注册），量到 ${SHELL_SHORTCUTS.length}`);
  const actions = SHELL_SHORTCUTS.map((item) => item.action);
  for (const required of ['play-pause', 'track-next', 'track-prev', 'toggle-window']) {
    assert.ok(actions.includes(required), `缺一条：${required}`);
  }
  const accels = SHELL_SHORTCUTS.map((item) => item.accel);
  assert.equal(new Set(accels).size, accels.length, 'accel 不许重复（重复 = 后一条永远不响）');
  for (const item of SHELL_SHORTCUTS) {
    assert.match(item.accel, /^(CommandOrControl|Super|Alt)\+/, `每条全局键都必须带显式修饰键：${item.accel}`);
    assert.doesNotMatch(item.accel, /Media/i, `不许注册媒体键：系统媒体键本来由页面的 Media Session 处理（src/media-session.ts），壳再抢一次会在"浏览器里也在放歌"时一处按键两处动 —— 决策见 run log §二`);
    assert.ok(shortcutAction(item.accel) === item.action, 'accel → 动作必须双向对得上');
  }
  assert.equal(shortcutAction('Nope+Nope'), null, '认不出的 accel 不许映射到任何动作');
});

test('R204 ⑯：快捷键与托盘只转发既有动作，壳里没有第二套播放真相', async () => {
  const { SHELL_COMMAND_SELECTORS, commandClickScript } = await loadShell('page-commands.mjs');
  for (const [id, selector] of Object.entries(SHELL_COMMAND_SELECTORS)) {
    // 正面钉：转发的目标必须是页面里**已经存在**的那颗按钮（"点了没反应"这一族在 R121/R128 反复出现）
    const action = selector.match(/data-action="([^"]+)"/)?.[1];
    assert.ok(action, `${id} 的选择器必须指向一颗 data-action 按钮`);
    const host = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
    assert.ok(host.includes(`data-action="${action}"`), `页面里没有 data-action="${action}" 这颗按钮 ⇒ ${id} 转发到一个不存在的地方`);
  }
  const script = commandClickScript('play-pause');
  assert.match(script, /disabled/, '按钮禁用时必须回"不可用"，不许静默（R109 那一格：绕过 disabled 会替缺陷圆场）');
  assert.match(script, /\.click\(\)/, '只许点既有按钮');
  assert.doesNotMatch(script, /fetch|localStorage|new Audio|player\./, '壳不许在页面里另算一份播放状态');
  assert.throws(() => commandClickScript('no-such-command'), /未知命令/, '不认识的命令必须抛，不许默默什么都不做');
  // 壳侧代码里不许出现任何"自己算传输状态"的形状
  for (const [name, code] of await shellCodeFiles()) {
    assert.doesNotMatch(code, /mediaSession|Audio\(|audioElement/, `${name} 在壳里另起了音频/Media Session 那一份真相`);
  }
});

test('R204 ⑰：单实例 —— 拿不到锁的那个进程不建窗、不建托盘、直接退；已有窗口只被激活', async () => {
  const { decideStartup, describeSecondInstance } = await loadShell('single-instance.mjs');
  assert.equal(decideStartup({ gotLock: true }), 'continue');
  assert.equal(decideStartup({ gotLock: false }), 'quit-duplicate', '第二次启动不许开出第二个窗口（Task 0 实测：lock=false ⇒ 立即退）');
  assert.deepEqual(describeSecondInstance({ windowExists: true }), { action: 'activate' }, '第二实例的命令行不读（Task 0 实测 argv 里被 Electron 塞了自己的开关）');
  assert.deepEqual(describeSecondInstance({ windowExists: false }), { action: 'activate' }, '窗口被关掉但进程还在时也只回"激活"，不重建服务');
  const main = await shellCode('main.mjs');
  assert.match(main, /requestSingleInstanceLock\(\)/, '主进程必须真去拿那把锁');
  assert.ok(main.indexOf('requestSingleInstanceLock') < main.indexOf('whenReady'), '锁必须在 whenReady 之前拿（上游 2733 与 1531 就是这个次序）');
  assert.match(main, /second-instance/, 'second-instance 事件必须有读者（"接口的存在不等于接口被用"）');
});

test('R204 ⑱：托盘与快捷键都在主进程接上了，退出路径同时收服务', async () => {
  const main = await shellCode('main.mjs');
  assert.match(main, /new Tray\(/, '托盘必须真建（不是只有一张菜单表）');
  assert.match(main, /setContextMenu/, '托盘菜单必须挂上');
  assert.match(main, /globalShortcut\.register\(/, '快捷键必须真注册');
  assert.match(main, /globalShortcut\.unregisterAll\(\)/, '退出前必须全部注销（全局键留在系统里 = 关掉应用还劫持按键）');
  assert.match(main, /setAppUserModelId/, 'Windows 任务栏/通知归属（上游 5349 那一格）');
  const stopOrder = main.indexOf('service.stop()');
  assert.ok(stopOrder > 0, 'before-quit 里要收服务');
  assert.ok(main.lastIndexOf('globalShortcut.unregisterAll()') < stopOrder || main.indexOf('before-quit') < stopOrder,
    '注销全局键必须发生在退出流程里（不能等窗口都没了才想起来）');
});

// ───────────────── 壁纸模式那一格：只做开关与二次确认（Task 3） ─────────────────

// 上游那两行确认文案（一手取自 references/folia-major/src/i18n/locales/zh-CN.ts:1661-1663，
// 基准 commit 369c34e6）。这里放**字面量副本**：判据不许去读 references/（那目录可能不在别人机器上，
// 而且它是只读参考、不该被自检依赖）。副本存在的意义就是"逐字沿用"这一格可机检。
const UPSTREAM_WALLPAPER_TITLE = '进入壁纸模式？';
const UPSTREAM_WALLPAPER_DETAIL =
  '窗口会沉到桌面最底层，作为歌词壁纸常驻显示。进入后窗口无法关闭、最小化或移动，键盘也无法操作应用。\n\n' +
  '要退出，请打开系统托盘（macOS 为菜单栏）中的 Folia 菜单，再次点击“壁纸模式”。';
const UPSTREAM_WALLPAPER_ACTION = '进入壁纸模式';

test('R204 ⑲（R205 改写）：标题与两颗按钮仍一字不改沿上游；正文按形态 A 重写 —— 与 A 不符的那几句必须消失', async () => {
  const m = await loadShell('wallpaper-switch.mjs');
  assert.equal(m.WALLPAPER_CONFIRM_TITLE, UPSTREAM_WALLPAPER_TITLE, '标题一字不改');
  assert.equal(m.WALLPAPER_ENTER_ACTION, UPSTREAM_WALLPAPER_ACTION, '按钮文案一字不改');
  // 产品名那一格沿用 M1 的判法（上游字面量副本 + replaceAll）：副本仍在案、"唯一允许的差异 = 产品名"仍是基准。
  // 但**基准本身不再等于我们的正文** —— 这是本件的形状变化，不是放宽：上游那句写的是
  // "窗口会沉到桌面最底层…进入后窗口无法关闭、最小化或移动"，那是 WorkerW 沉底形态的话，
  // 形态 A（置顶 + 真穿透）照抄就是撒谎 ⇒ 任务书 Task 3 明令"不许照抄与 A 形态不符的话"。
  const upstreamRenamed = UPSTREAM_WALLPAPER_DETAIL.replaceAll('Folia', '本地音乐播放器');
  assert.notEqual(m.WALLPAPER_CONFIRM_DETAIL, upstreamRenamed, '正文已按 A 形态重写（改前是什么、为什么改，见台账 R205 与 run log §三）');
  assert.notEqual(m.WALLPAPER_CONFIRM_DETAIL, UPSTREAM_WALLPAPER_DETAIL, '连换名那一格都不许等于上游原句');
  for (const [name, code] of await shellCodeFiles()) {
    assert.ok(!code.includes('Folia'), `${name} 里出现了 Folia —— 我们不是 Folia，产品名那一格只许是 本地音乐播放器`);
  }
  const detail = m.WALLPAPER_CONFIRM_DETAIL;
  // 反向钉：与 A 形态不符的几句，一个字都不许留下（"沉底到图标之下"这种我们没做的事）
  for (const stale of ['沉到桌面最底层', '最底层', '无法关闭、最小化或移动', 'macOS', '尚未生效', '不会改变窗口层级']) {
    assert.ok(!detail.includes(stale), `正文里还留着与实现不符的那句：${stale}`);
  }
  // 正向钉：这一档真的做到的，逐格点名（缺一格 = 文案漏说一件事）
  assert.match(detail, /铺满整块屏幕/, '① 铺满');
  assert.match(detail, /桌面图标.*之上/, '② 在图标之上（形态 A 与上游最大的那格差别）');
  assert.match(detail, /系统壁纸（桌面背景那张图）不会被改动/, '③ 不动系统壁纸（判据 ㉒ 那条红线的用户侧说法）');
  assert.match(detail, /鼠标会穿过去/, '④ 真穿透');
  assert.match(detail, /键盘到不了这个窗口/, '⑤ 键盘到不了窗口（上游那句里与我们**仍然相符**的一格，任务书点名要留）');
  assert.match(detail, /任务栏上不再占一格/, '⑥ 任务栏不占格（Q56 那一格要如实写）');
  assert.match(detail, /歌词面/, '⑦ 画的是 M0 那一档，不是普通页');
  // 三条退出通道必须逐条说得出（方案四.5：少一条都不许进入，文案里也不能少一条）
  assert.match(detail, /①[^\n]*系统托盘[^\n]*壁纸模式/, '退出① 托盘');
  assert.match(detail, /②[^\n]*Ctrl\+Alt\+W/, '退出② 全局键（这一条是穿透态下唯一必然按得到的按键）');
  assert.match(detail, /③[^\n]*右上角/, '退出③ 角落热点');
  assert.match(detail, /三条路/, '得说清是三条');
  // 三段的顺序也是判据：先说什么、再说什么、最后说怎么出来
  assert.ok(detail.indexOf(m.WALLPAPER_DOES_NOTE) === 0, '第一段：做什么');
  assert.ok(detail.indexOf(m.WALLPAPER_COST_NOTE) > m.WALLPAPER_DOES_NOTE.length, '第二段：代价');
  assert.ok(detail.indexOf(m.WALLPAPER_EXIT_NOTE) > detail.indexOf(m.WALLPAPER_COST_NOTE), '第三段：怎么出来');
  // 真机截图抓出来的两格（`**之上**` 的星号原样显示在系统对话框里、内部编号也进了用户可见文案）
  // ⇒ 钉成机检：原生对话框不渲染 Markdown，台账编号不是给用户看的话。
  assert.doesNotMatch(detail, /[*_~#]{2}/, '系统对话框不渲染 Markdown：星号/下划线/井号会原样显示给用户看（真机截图量到）');
  assert.doesNotMatch(detail, /[QRM]\d{2,3}\b/, '台账与批次的内部编号不许出现在用户看得见的文案里');
});

test('R204 ⑳（R205 改写）：确认框三段实话同框；?wallpaper=1 与「沉浸」都改成"只许出现在那一个出处"', async () => {
  const m = await loadShell('wallpaper-switch.mjs');
  const dialog = m.wallpaperConfirmDialog();
  for (const [label, note] of [['做什么', m.WALLPAPER_DOES_NOTE], ['代价', m.WALLPAPER_COST_NOTE], ['怎么出来', m.WALLPAPER_EXIT_NOTE]]) {
    assert.ok(dialog.detail.includes(note), `${label}那一段必须出现在同一个确认框里（不能写在别处等用户自己找）`);
  }
  assert.equal(dialog.type, 'warning', '这是一次有代价的操作，语气不能是 info');
  assert.equal(dialog.cancelId, 0, '缺省选中"取消"（回车不许直接进）');
  assert.equal(dialog.buttons[0], '取消');
  assert.equal(dialog.buttons[1], UPSTREAM_WALLPAPER_ACTION);
  // Q53 落在**用户看得见的字符串**上。M0 那一档的界面文案由 R203 判据 ⑬ 在 check-music-surface.mjs 里
  // **运行时**钉住（那一段开了 strip-types 才 import 得动 .ts）；这一段是纯 Node，不去抄一份弱化的文本判据。
  // R205 改的这一格（**范围没放宽，只是挪准了**）：M1 的正文里不会出现「沉浸」那三个字，所以当时钉的是
  // "整壳零命中"；本件的第三段必须指认真机上那颗按钮的名字（它就叫「退出沉浸（浏览器内）」，
  // 渲染层一个字不改 ⇒ 文案不许改成另一个名字，否则用户在画面上找不到那句）。
  // ⇒ 于是钉成两条更精确的：① 那个名字只许出现在指认它的那一个模块里；② 托盘项与工具提示仍一个字都不许有。
  const namingOwners = [];
  for (const [name, code] of await shellCodeFiles()) if (code.includes('沉浸')) namingOwners.push(name);
  assert.deepEqual(namingOwners, ['wallpaper-switch.mjs'], '「沉浸」只许出现在确认文案那一句引用里');
  const tray = await loadShell('tray-menu.mjs');
  assert.ok(!JSON.stringify(tray).includes('沉浸'), '托盘那一格不许叫 M0 那档的名字（两个名字各管各的，Q53 原样在册）');
  assert.match(tray.WALLPAPER_TRAY_LABEL, /壁纸模式/, '托盘这一格确实说的是壳这一层的真壁纸');
  // ── R205 改写的那一半（**形状变了，不是放宽**）──
  // M1 那一版"本件不做层级" ⇒ 壳整树不许出现 `wallpaper=1`（那一版连加载都不加载，禁令就是最严的形状）。
  // 本件壁纸模式加载的正是 M0 那一档 surface（任务书：渲染层一个字不动）⇒ 这一格从"禁"改成"可证"：
  // 只许住在 `wallpaper-window.mjs`（层级那一跳的唯一出处，判据 ㉗），且必须由 shellOrigin(port) 的返回值拼
  // ⇒ 判定与拼装不许分叉（判据 ⑤「127.0.0.1 只在 shell-url.mjs」原样在册，这里再加一道：那一跳里连字面量都不许出现）。
  const urlOwners = [];
  for (const [name, code] of await shellCodeFiles()) if (/wallpaper=1/.test(code)) urlOwners.push(name);
  assert.deepEqual(urlOwners, ['wallpaper-window.mjs'],
    '?wallpaper=1 只许出现在层级那一跳的唯一模块里；别处再拼一遍 = 第二个地址出处');
  const layer = await shellCode('wallpaper-window.mjs');
  assert.match(layer, /\$\{origin\}\?wallpaper=1/, '那一档地址由 shellOrigin 的返回值拼（参数名就是它）');
  assert.doesNotMatch(layer, /127\.0\.0\.1|localhost|:5175/, '壁纸那一跳里不许出现第二处地址字面量或硬编码端口');
});

test('R204 ㉑：开关真值表 —— 默认关、进入要确认、取消不改状态、退出方向不问', async () => {
  const { decideWallpaperToggle, WALLPAPER_DEFAULT_ENABLED, WALLPAPER_SETTING_KEY } = await loadShell('wallpaper-switch.mjs');
  assert.equal(WALLPAPER_DEFAULT_ENABLED, false, '缺省必须关（任务书 2.6）');
  assert.equal(typeof WALLPAPER_SETTING_KEY, 'string');
  assert.ok(WALLPAPER_SETTING_KEY.length > 0 && !WALLPAPER_SETTING_KEY.includes(' '));
  assert.deepEqual(decideWallpaperToggle({ current: false, wants: true, confirmed: true }), { enabled: true, asked: true }, '确认过才进');
  assert.deepEqual(decideWallpaperToggle({ current: false, wants: true, confirmed: false }), { enabled: false, asked: true }, '取消 ⇒ 状态一个字都不动（上游 2622-2641 那一格就是这个语义）');
  assert.deepEqual(decideWallpaperToggle({ current: true, wants: false, confirmed: false }), { enabled: false, asked: false }, '离开这一档不需要确认');
  assert.deepEqual(decideWallpaperToggle({ current: true, wants: true, confirmed: false }), { enabled: true, asked: false }, '重复打开不再问第二次（免得确认框连环弹）');
});

// R205 改写（**形状变了，不是放宽**）：M1 那一版把"层级那一跳"整格禁掉（`setAlwaysOnTop` / `setIgnoreMouseEvents` /
// `skipTaskbar` / `setResizable` / `movable` 全禁），那是"本件不做"的形状。R205 做的正是那一跳 ⇒ 这五格
// **从"禁"改成"可证"**：由判据 ㉗ 钉"只许住在一个模块里、且进入/退出成对"。
// 而**这一条判据原本禁的另一半一条都没松**：系统壁纸、沉底、嵌父窗口、输入注入、设备伪装、按映像名杀进程、
// 注册表 / 开机自启 / 系统服务 —— 仍然一个字节都不许出现。
test('R204 ㉒（R205 改写）：系统壁纸 / 沉底 / 嵌父窗口 / 输入注入仍然零命中；层级那一组改由 ㉗ 分层钉', async () => {
  const banned = [
    'SPI_SETDESKWALLPAPER', 'SystemParametersInfo', 'WorkerW', 'Progman', 'SetParent',
    'sendInputEvent', 'register_dev', 'taskkill /IM',
  ];
  const offenders = [];
  for (const [name, code] of await shellCodeFiles()) {
    for (const word of banned) if (code.includes(word)) offenders.push(`${name}:${word}`);
  }
  assert.deepEqual(offenders, [], '形态 A 不引任何原生件、不动系统壁纸、不注入输入 —— 这些一个字节都不许回来（任务书 2.10 + 方案四.4）');
  // 壳目录整目录可删（撤法）：除 electron-shell 外，仓库里不许有别的文件引用它 —— 判据 ② 已钉，
  // 这里再钉"壳目录里也不许出现注册表/开机自启/系统服务那三格"。
  for (const [name, code] of await shellCodeFiles()) {
    assert.doesNotMatch(code, /RegEdit|reg\s+add|New-Item\s+-Path\s+HKCU|RunOnce|currentversion\\Run|schtasks|sc\s+create/i, `${name} 在写注册表 / 开机自启 / 系统服务`);
  }
  const main = await shellCode('main.mjs');
  assert.match(main, /wallpaperConfirmDialog|showMessageBox/, '进入方向必须真去弹那个确认框（只在纯函数里写文案不算接上）');
  assert.match(main, /decideWallpaperToggle/, '确认结果必须过那一格真值表，不在接线里另算');
});

// ─────────── 窗口层级那一跳：成对进入/还原 + 热点 + 三把保险（R205 Task 1~2） ───────────

test('R205 ㉓：进入/退出成对 —— 进入设几项，退出就按"进入那一刻的快照"逐项还原（漏一项就红）', async () => {
  const { createWallpaperWindowController, WALLPAPER_APPLIED_FIELDS } = await loadShell('wallpaper-window.mjs');
  assert.ok(Array.isArray(WALLPAPER_APPLIED_FIELDS) && WALLPAPER_APPLIED_FIELDS.length >= 6,
    '进入项清单必须逐格点名（bounds / alwaysOnTop / skipTaskbar / resizable / movable / simpleFullScreen / url / ignoreMouseEvents）');
  const made = () => {
    const calls = [];
    const record = (name) => (...args) => calls.push([name, ...args]);
    const state = {
      bounds: { x: 120, y: 90, width: 1102, height: 702 },
      alwaysOnTop: false, skipTaskbar: false, resizable: true, movable: true, simpleFullScreen: false, ignoreMouse: false,
    };
    const win = {
      getBounds: () => state.bounds, setBounds: (b) => { state.bounds = { ...b }; calls.push(['setBounds', b]); },
      isAlwaysOnTop: () => state.alwaysOnTop,
      setAlwaysOnTop: (v, level) => { state.alwaysOnTop = v; calls.push(['setAlwaysOnTop', v, level ?? null]); },
      setSkipTaskbar: (v) => { state.skipTaskbar = v; calls.push(['setSkipTaskbar', v]); },
      isResizable: () => state.resizable,
      setResizable: (v) => { state.resizable = v; calls.push(['setResizable', v]); },
      isMovable: () => state.movable,
      setMovable: (v) => { state.movable = v; calls.push(['setMovable', v]); },
      isSimpleFullScreen: () => state.simpleFullScreen,
      setSimpleFullScreen: (v) => { state.simpleFullScreen = v; calls.push(['setSimpleFullScreen', v]); },
      setIgnoreMouseEvents: (v, options) => { state.ignoreMouse = v; calls.push(['setIgnoreMouseEvents', v, options ? JSON.stringify(options) : null]); },
      loadURL: record('loadURL'),
    };
    return { win, calls, state };
  };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, workArea: { x: 0, y: 0, width: 1707, height: 1019 }, scaleFactor: 1.5 };
  const origin = 'http://127.0.0.1:5175/';

  const a = made();
  const controller = createWallpaperWindowController({ win: a.win, origin, display, initial: { skipTaskbar: false } });
  const entered = controller.enter();
  assert.equal(entered.ok, true, '进入必须成功');
  const names = a.calls.map(([name]) => name);
  for (const field of WALLPAPER_APPLIED_FIELDS) {
    assert.ok(names.some((n) => n.toLowerCase().includes(field.setter.toLowerCase())), `进入时没设 ${field.name}`);
  }
  // R207（形态 A′）：进入**不再置顶**（这一行从 true 改成 false —— 形状变了，不是放宽：
  // "进入时不许置顶"由 ㊲ 正面钉，全壳文件里出现 `setAlwaysOnTop(true` 即红）。
  assert.equal(a.state.alwaysOnTop, false, '进入时不许置顶：别的窗口要能盖住它（用户口径 R207）');
  assert.equal(a.state.skipTaskbar, true);
  assert.equal(a.state.resizable, false);
  assert.equal(a.state.movable, false);
  assert.equal(a.state.simpleFullScreen, true, '无边框那一格走运行时可逆的 simple-full-screen（Electron 43 没有 setFrame，实测）');
  assert.equal(a.calls.find(([n]) => n === 'loadURL')[1], `${origin}?wallpaper=1`, '地址必须切到 M0 那一档 surface');
  assert.equal(a.state.ignoreMouse, true, '进入即真穿透');
  assert.equal(a.calls.find(([n]) => n === 'setIgnoreMouseEvents')[2], JSON.stringify({ forward: true }), '穿透必须带 forward');

  const restored = controller.exit();
  assert.equal(restored.ok, true);
  assert.equal(a.state.alwaysOnTop, false, 'alwaysOnTop 必须还原');
  assert.equal(a.state.skipTaskbar, false, 'skipTaskbar 必须还原（漏这一项 = 窗口在任务栏里消失，最典型的漏还原）');
  assert.equal(a.state.resizable, true);
  assert.equal(a.state.movable, true);
  assert.equal(a.state.simpleFullScreen, false);
  assert.equal(a.state.ignoreMouse, false, '退出必须把点击还给窗口');
  assert.equal(a.calls.filter(([n]) => n === 'loadURL').pop()[1], origin, '地址要切回普通那一页');
  assert.deepEqual(a.state.bounds, { x: 120, y: 90, width: 1102, height: 702 }, 'bounds 回到进入那一刻的快照');
  assert.deepEqual(restored.mismatch, [], '还原后逐项读回，不许有不一致');

  assert.equal(controller.enter().ok, true, '还原之后可以再进一次');
  controller.exit();
  const b = made();
  const second = createWallpaperWindowController({ win: b.win, origin, display, initial: { skipTaskbar: false } });
  assert.equal(second.exit().ok, false, '没进过就不许退（否则按未知快照把窗口改坏）');
  assert.equal(second.enter().ok, true);
  assert.equal(second.enter().ok, false, '已在壁纸态时重复进入必须被拒（否则快照会被壁纸态自己覆盖）');
});

test('R205 ㉔：铺满整块屏按不变式判（DIP 拿不到"逐字等于 bounds"，实测差 1~6 px）', async () => {
  const { coversWholeDisplay, coversTaskbarStrip } = await loadShell('wallpaper-window.mjs');
  const display = { bounds: { x: 0, y: 0, width: 1707, height: 1067 }, workArea: { x: 0, y: 0, width: 1707, height: 1019 } };
  assert.equal(coversWholeDisplay({ x: 0, y: 0, width: 1707, height: 1067 }, display), true, '逐字相等当然算覆盖');
  assert.equal(coversWholeDisplay({ x: 0, y: 0, width: 1709, height: 1068 }, display), true, '溢出 2 px 也算（Windows 对 frameless 有舍入补偿，实测）');
  assert.equal(coversWholeDisplay({ x: -1, y: -1, width: 1709, height: 1069 }, display), true, '负原点 + 溢出也算');
  assert.equal(coversWholeDisplay({ x: 0, y: 0, width: 1707, height: 1019 }, display), false, '只铺到工作区 = 没铺满（任务栏条还露着）');
  assert.equal(coversWholeDisplay({ x: 10, y: 0, width: 1707, height: 1067 }, display), false, '右边露出一条就不算');
  assert.equal(coversTaskbarStrip({ x: 0, y: 0, width: 1707, height: 1067 }, display), true);
  assert.equal(coversTaskbarStrip({ x: 0, y: 0, width: 1707, height: 1019 }, display), false, '下边没越过 workArea 底 = 盖不住任务栏');
});

test('R205 ㉕：解锁热点四个常量在壳里只有一处定义，判定按上游那一份算法', async () => {
  const m = await loadShell('wallpaper-hotspot.mjs');
  assert.deepEqual(m.CLICK_THROUGH_UNLOCK_HOTSPOT, { width: 84, height: 40, rightInset: 176, topInset: 4 },
    '四个常量逐字沿上游（main.cjs:1796-1801 与 clickThroughUnlockHotspot.ts:13-18 那两份一致，我们只留一处）');
  assert.equal(m.HOTSPOT_POLL_MS, 150, '轮询节奏沿上游 MAIN_WINDOW_CLICK_THROUGH_UNLOCK_HOVER_INTERVAL_MS');
  const bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  assert.equal(m.isCursorInUnlockHotspot({ x: 1707 - 176 - 42, y: 20 }, bounds), true, '热点中心必须命中');
  assert.equal(m.isCursorInUnlockHotspot({ x: 1707 - 176 - 84 - 5, y: 20 }, bounds), false, '左边外面不命中');
  assert.equal(m.isCursorInUnlockHotspot({ x: 1707 - 176 - 42, y: 4 + 40 + 5 }, bounds), false, '下边外面不命中');
  assert.equal(m.isCursorInUnlockHotspot({ x: 2000 + 1920 - 176 - 42, y: 20 }, { x: 2000, y: 0, width: 1920, height: 1080 }), true,
    '判定按窗口原点算（副屏原点非 0；四步粘滞会落到别的屏）');
  for (const [name, code] of await shellCodeFiles()) {
    if (name === 'wallpaper-hotspot.mjs') continue;
    assert.ok(!/rightInset/.test(code), `${name} 里又定义了一遍热点常量 ⇒ 两份不一致正是上游警告过的那格`);
  }
});

test('R205 ㉖：三把退出保险 —— 进入前必须都已就位，缺一把就不许进入', async () => {
  const { decideWallpaperEntry } = await loadShell('wallpaper-window.mjs');
  const allGood = { trayReady: true, shortcutReady: true, hotspotReady: true };
  assert.deepEqual(decideWallpaperEntry(allGood), { allow: true }, '三把都在 ⇒ 允许进入');
  for (const missing of ['trayReady', 'shortcutReady', 'hotspotReady']) {
    const gate = decideWallpaperEntry({ ...allGood, [missing]: false });
    assert.equal(gate.allow, false, `${missing} 没就位时不许进入（方案四.5：三把保险任一失效都算缺陷）`);
    assert.ok(typeof gate.message === 'string' && gate.message.length > 8, '拒绝必须给一句实话');
    assert.doesNotMatch(gate.message, /undefined|null|NaN/, `实话不能说谎：${gate.message}`);
  }
  const main = await shellCode('main.mjs');
  assert.match(main, /decideWallpaperEntry\(preflightState\(\)\)/, '确认框之前先预验那两把（少一把就别弹一个注定进不去的确认）');
  assert.match(main, /decideWallpaperEntry\(insuranceState\(\)\)/, '做那一跳之前必须真过这道门 —— 只 import 不调用不算（变异 W9 就是这么溜过去的）');
  assert.match(main, /isCursorInUnlockHotspot|createHotspotWatcher/, '热点必须真接上（不只在纯模块里）');
});

test('R205 ㉗：窗口层级那一跳只有一个出处（R204 ㉒ 的改写：从"禁"变成"可证"，不是放宽）', async () => {
  const LAYERED = ['setAlwaysOnTop', 'setSkipTaskbar', 'setIgnoreMouseEvents', 'setResizable', 'setMovable', 'setSimpleFullScreen'];
  const owners = {};
  for (const [name, code] of await shellCodeFiles()) {
    for (const api of LAYERED) if (code.includes(`${api}(`)) (owners[api] ??= []).push(name);
  }
  for (const api of LAYERED) {
    assert.deepEqual(owners[api] ?? [], ['wallpaper-window.mjs'],
      `${api} 只许住在 wallpaper-window.mjs（这一跳的唯一出处）；出现在别处 = 第二份层级真相`);
  }
  const stillBanned = ['SPI_SETDESKWALLPAPER', 'SystemParametersInfo', 'WorkerW', 'Progman', 'SetParent', 'sendInputEvent', 'register_dev', 'SHELLDLL_DefView'];
  const offenders = [];
  for (const [name, code] of await shellCodeFiles()) for (const word of stillBanned) if (code.includes(word)) offenders.push(`${name}:${word}`);
  assert.deepEqual(offenders, [], '形态 A 不引任何原生件、不注入输入、不动系统壁纸 —— 这些一个字节都不许回来');
  const layer = await shellCode('wallpaper-window.mjs');
  assert.match(layer, /enter/, '要有进入那一半');
  assert.match(layer, /exit/, '要有退出那一半（只有进入 = 把人关在里面）');
});

test('R205 ㉘：三把保险的真接线 —— 全局键里有一条管壁纸、退出壳之前先把层级还原', async () => {
  const sc = await loadShell('shortcuts.mjs');
  // R208 改写（形状变了不是放宽）："表里恰好一条"这条不变式**钉在完整表**上，
  // 再钉"开关关着时接线读的那张表里一条都没有"（那才是"Ctrl+Alt+W 不注册"的证据）。
  assert.equal(sc.WALLPAPER_SHORTCUT.action, sc.SHELL_WALLPAPER_ACTION, '壁纸那一条的动作就是那一格');
  assert.equal(sc.ALL_SHELL_SHORTCUTS.filter((item) => item.action === sc.SHELL_WALLPAPER_ACTION).length, 1,
    '挂壁纸的只许一条（两条 = 同一件事两个入口，状态会漂）—— 关掉开关也仍是"一条定义"');
  assert.equal(sc.SHELL_SHORTCUTS.filter((item) => item.action === sc.SHELL_WALLPAPER_ACTION).length, 0,
    'R208：开关关着时接线读的那张表里**没有**壁纸那一条 ⇒ Ctrl+Alt+W 不会注册');
  const main = await shellCode('main.mjs');
  assert.match(main, /case 'toggle-wallpaper'/, '托盘那一项必须真走到进入/退出，不再只记一个布尔值');
  assert.match(main, /SHELL_WALLPAPER_ACTION/, '全局键那条动作要在主进程被路由 ⇒ 不许落到"转发给页面"那一格（穿透态下页面收不到键）');
  assert.match(main, /getCursorScreenPoint/, '热点看守真的在轮询光标：Task 0 实测 forward:true 不把 mousemove 送进页面，靠页面 hover 会一套静默失效的保险');
  const quitAt = main.indexOf("app.on('before-quit'");
  assert.ok(quitAt > 0, 'before-quit 那一格必须在');
  const quitBody = main.slice(quitAt);
  const restoreAt = quitBody.indexOf('exitWallpaperMode(');
  const keysAt = quitBody.indexOf('globalShortcut.unregisterAll()');
  const stopAt = quitBody.indexOf('service.stop()');
  // 三格都必须**读得到**再比次序 —— 拿 -1 去比 "<" 会永远为真（变异 W12 就是这么溜过去的：
  // 我原先搜的是 `exitWallpaperMode()`，而真代码写的是 `exitWallpaperMode({ navigate: false })`）。
  assert.ok(restoreAt >= 0 && keysAt >= 0 && stopAt >= 0,
    `before-quit 里三格都得真出现（读不到就是判据永不匹配）：还原=${restoreAt} 注销键=${keysAt} 收服务=${stopAt}`);
  assert.ok(restoreAt < keysAt, '层级还原必须排在注销全局键之前 —— 先注销键就等于把人留在一个只剩托盘能退的画面上');
  assert.ok(restoreAt < stopAt, '以及收服务之前（服务没了，退出的那一站也就没了）');
});

test('R205 ㉙：页面自己退出那一档时，壳跟着逐项还原层级（地址已经换了 ⇒ 不再导航第二次）', async () => {
  const m = await loadShell('wallpaper-window.mjs');
  assert.equal(m.isWallpaperSurfaceUrl('http://127.0.0.1:5175/?wallpaper=1'), true);
  assert.equal(m.isWallpaperSurfaceUrl('http://127.0.0.1:5175/?wallpaper=1&lighting=baseline'), true,
    '别的参数在案时也算（渲染层 appSurface.ts 读的是那一格，不是整串相等）');
  assert.equal(m.isWallpaperSurfaceUrl('http://127.0.0.1:5175/'), false, '普通页那一档');
  assert.equal(m.isWallpaperSurfaceUrl('http://127.0.0.1:5175/?wallpaper=0'), false, '值不是 1 就不算');
  assert.equal(m.isWallpaperSurfaceUrl('not-a-url'), false, '解析不了就算"不是"，不许抛');

  const state = { bounds: { x: 120, y: 90, width: 900, height: 600 }, alwaysOnTop: false, resizable: true, movable: true, simpleFullScreen: false, ignoreMouse: true };
  const loaded = [];
  const win = {
    getBounds: () => state.bounds, setBounds: (b) => { state.bounds = { ...b }; },
    isAlwaysOnTop: () => state.alwaysOnTop, setAlwaysOnTop: (v) => { state.alwaysOnTop = v; },
    setSkipTaskbar: () => {},
    isResizable: () => state.resizable, setResizable: (v) => { state.resizable = v; },
    isMovable: () => state.movable, setMovable: (v) => { state.movable = v; },
    isSimpleFullScreen: () => state.simpleFullScreen, setSimpleFullScreen: (v) => { state.simpleFullScreen = v; },
    setIgnoreMouseEvents: (v) => { state.ignoreMouse = v; },
    loadURL: (u) => loaded.push(u),
  };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, workArea: { x: 0, y: 0, width: 1707, height: 1019 } };
  const controller = m.createWallpaperWindowController({ win, origin: 'http://127.0.0.1:5175/', display, initial: { skipTaskbar: false } });
  controller.enter();
  const result = controller.exit({ navigate: false });
  assert.deepEqual(loaded, ['http://127.0.0.1:5175/?wallpaper=1'], '进入导航一次、退出那趟**不许**再导航（页面已经回普通页，再来一次就是一次多余的重载）');
  assert.equal(result.ok, true);
  assert.equal(state.ignoreMouse, false, '穿透要收回');
  assert.equal(state.alwaysOnTop, false, '置顶要收回');
  assert.equal(state.simpleFullScreen, false, '无边框铺满要收回');
  assert.equal(state.resizable, true, '缩放要还回来');
  assert.equal(state.movable, true, '移动要还回来');
  assert.deepEqual(state.bounds, { x: 120, y: 90, width: 900, height: 600 }, '尺寸回到进入那一刻');
  assert.deepEqual(result.mismatch, []);

  const main = await shellCode('main.mjs');
  const navAt = main.indexOf("did-navigate'");
  assert.ok(navAt > 0, '壳必须真的在听导航（页面那三路退出走 location.replace，不发这一格就看不见）');
  // 判到**那一段处理函数里面**去：整文件级 `assert.match` 会被别处的同名调用替我们圆场
  // （变异 W13 就是把 did-navigate 里那一行删掉，而 before-quit 里还留着一行同样的调用）。
  const navBody = main.slice(navAt, main.indexOf('screen.on(', navAt));
  assert.ok(navBody.includes('isWallpaperSurfaceUrl'), '认不认这一档由唯一出处判，接线里不写第二份');
  assert.ok(navBody.includes('exitWallpaperMode({ navigate: false })'), '那一趟只还原层级、不再导航');
  assert.ok(navBody.includes('if (!wallpaper?.isWallpaper()) return;'), '普通态的导航不许被当成退出（否则第一次进壁纸就被自己弹回来）');
});

test('R205 ㉚：功耗那一格只说做得到的 —— 电池提示在案可关，且壳不接管系统电源（powerSaveBlocker / 电源事件订阅零调用）', async () => {
  const p = await loadShell('wallpaper-power.mjs');
  const sw = await loadShell('wallpaper-switch.mjs');
  assert.equal(p.powerTier({ onBattery: true }), 'battery', '档位在案（读的是唯一出处那一次结果）');
  assert.equal(p.powerTier({ onBattery: false }), 'ac');
  assert.equal(p.WALLPAPER_BATTERY_NOTICE_ENABLED, true, '缺省开（用户没表过态就要被告知）');
  const notice = p.batteryNoticeFor({ onBattery: true });
  assert.ok(typeof notice === 'string' && notice.length > 20, '电池那一格必须说得出话');
  assert.equal(p.batteryNoticeFor({ onBattery: false }), null, '交流电时不许谎称在用电池');
  assert.equal(p.batteryNoticeFor({ onBattery: true, enabled: false }), null, '关掉之后那段必须消失（"可关"不是写在注释里的空话）');
  assert.doesNotMatch(notice, /已经|自动为你|已为你/, '不许宣称壳替用户做了什么省电动作 —— 本件一件都没做（做不到的那一半登记 Q91）');
  assert.match(notice, /减少动态效果/, '指的路必须是页面上真有的那一格（一手核：music-app.ts:4443 那颗复选框就叫这个名字）');

  const ac = sw.wallpaperConfirmDialog({ onBattery: false });
  const bat = sw.wallpaperConfirmDialog({ onBattery: true });
  assert.ok(!ac.detail.includes('续航'), '交流电时那一段不许出现');
  assert.ok(bat.detail.includes(notice), '电池时那一段必须挂在**同一次**确认里（拆开弹就是两次打断）');
  assert.ok(bat.detail.startsWith(ac.detail), '前三段的字一个不改，电池那一格追加在最后');
  assert.equal(sw.wallpaperConfirmDialog({ onBattery: true, noticeEnabled: false }).detail, ac.detail, '关掉提示 = 与交流电时逐字相同');
  assert.doesNotMatch(bat.detail, /[*_~#]{2}|[QRM]\d{2,3}\b/, '电池那一段同样是用户可见文案：不许 Markdown 星号、不许内部编号');

  for (const [name, code] of await shellCodeFiles()) {
    assert.ok(!code.includes('powerSaveBlocker'), `${name} 里出现了 powerSaveBlocker —— 一个播放器不该接管用户的睡眠与屏幕（方案四.7 的落法：不做，并机检）`);
    assert.ok(!/powerMonitor\.(?:on|once|removeListener)\b/.test(code), `${name} 订阅了电源事件 ⇒ 就得负责解除；本件不订 ⇒ "退出后与进入前一致"是靠什么都没动保证的，不是靠还原`);
  }
  const owners = [];
  for (const [name, code] of await shellCodeFiles()) if (code.includes('isOnBatteryPower')) owners.push(name);
  assert.deepEqual(owners, ['main.mjs'], '电池读数只有一个出处（确认框那一刻）');
  assert.match(await shellCode('main.mjs'), /wallpaperConfirmDialog\(\{ onBattery: powerMonitor\.isOnBatteryPower\(\) \}\)/,
    '那一次读数必须真进确认框（纯函数写得再好，没人调用等于没有 —— R128 那一族）');
});

// ─────────── R206 ① 出得去 + 说得清 / ② 还原按容差（验收侧 F1） ───────────

test('R206 ㉛：光标进解锁热点那一跳必须顺手把窗口焦点拿回来（否则用户点过桌面之后 `Esc` 永久失效）', async () => {
  const main = await shellCode('main.mjs');
  const at = main.indexOf('onEnter: () => {');
  assert.ok(at > 0, '热点看守的 onEnter 必须真接上（找不到的话下面每条都会空转）');
  const enterBody = main.slice(at, main.indexOf('onLeave:', at));
  assert.ok(enterBody.includes('setPenetrated(false)'), '进去 = 先把鼠标还给窗口（R205 既有那一格）');
  assert.ok(enterBody.includes('focusShellWindow(mainWindow)'),
    '并且把**焦点**也拿回来：验收侧实测"点了桌面 ⇒ 窗口穿透、点不回去、焦点还得不到 ⇒ Esc 从此永久失效"');
  assert.ok(enterBody.includes('showHotspot()'), '同一趟还要给出可见反馈（光标进到热点里这件事屏幕上得有回应）');

  const leaveAt = main.indexOf('onLeave: () => {');
  assert.ok(leaveAt > 0, 'onLeave 也必须真接上');
  const leaveEnds = [main.indexOf('});', leaveAt), main.indexOf('onInside:', leaveAt)].filter((i) => i > 0);
  const leaveBody = main.slice(leaveAt, Math.min(...leaveEnds));
  assert.ok(leaveBody.includes('setPenetrated(true)'), '离开 = 收回穿透');
  assert.ok(!leaveBody.includes('focusShellWindow'), '离开时不许抢焦点 —— 穿透态是常态，光标每次划过都抢一次就是打扰');
  assert.ok(leaveBody.includes('hideHotspot()'), '反馈跟着消失（常驻挡画就是另一处缺陷）');

  // 焦点动作仍然只许住在 window.mjs：本件用的是它已有的那一个出处，不另写 restore/show/focus 序列。
  const others = [];
  for (const [name, code] of await shellCodeFiles()) {
    if (name === 'main.mjs' || name === 'window.mjs') continue;
    if (/\bfocus\(/.test(code)) others.push(name);
  }
  assert.deepEqual(others, [], '窗口焦点动作只许 window.mjs 一份、由 main.mjs 调（第二份迟早与托盘那条漂）');
});

test('R206 ㉜：进入壁纸态后屏幕上出现一条退出提示，并且**自己消失**（出现与消失是两格，时长只有一个出处）', async () => {
  const hints = await loadShell('page-hints.mjs');
  const scripts = [];
  const timers = [];
  const layer = hints.createHintLayer({
    runInPage: (script) => scripts.push(script),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancel: () => { timers.splice(0, timers.length); },
  });
  assert.equal(layer.state().enter, false, '没进入之前屏幕上什么都没有');
  layer.showEnter();
  assert.equal(scripts.length, 1, '进入要挂一条');
  assert.equal(layer.state().enter, true, '出现这一格要在记账里看得见');
  assert.equal(timers.length, 1, '只出现不消失 = 长期挡画，"排定自己消失"必须是独立的一格');
  assert.equal(timers[0].ms, hints.HINT_AUTO_DISMISS_MS, '时长读唯一出处那个常量，不在调用点写数字');
  assert.ok(hints.HINT_AUTO_DISMISS_MS >= 4000 && hints.HINT_AUTO_DISMISS_MS <= 15000,
    `几秒 = 读得完又不常驻（当前 ${hints.HINT_AUTO_DISMISS_MS} ms）`);
  timers[0].fn();
  assert.equal(layer.state().enter, false, '时间到 ⇒ 提示消失');
  assert.equal(scripts.length, 2, '消失走的是"摘掉那一个层"');
  assert.match(scripts[1], /getElementById[\s\S]*\?\.remove\(\)/, '摘的就是同一个 id，不另留第二份引用');

  // 注入那一段的形状：只加一个纯文本层，绝不吃鼠标。
  const shown = scripts[0];
  assert.match(shown, /document\.body\.appendChild/, '挂在文档上（壁纸画面之外没有第二块壳窗口）');
  assert.match(shown, /textContent = /, '文案走 textContent：把字符串当标记解析就是自造的一个注入面');
  assert.doesNotMatch(shown, /innerHTML|insertAdjacentHTML|outerHTML/, '不许用 HTML 字符串');
  assert.match(shown, /pointerEvents: 'none'/, '不许吃鼠标 —— 解锁之后这条提示挡在退出按钮上就是新障碍');
  assert.doesNotMatch(shown, /\b6000\b|\b8000\b/, '时长不写进注入脚本（只有一个出处 = 那个常量）');

  // 文案三件事都得是壳真做得到 的，并且说人话（沿 R205 ⑲/㉚ 那两条反向判据）。
  const text = hints.HINT_ENTER_TEXT;
  for (const needle of ['Ctrl+Alt+W', '托盘', '右上角']) {
    assert.ok(text.includes(needle), `退出提示缺了「${needle}」这一条：屏幕上写的那三件退出方式一件都不能少`);
  }
  assert.doesNotMatch(text, /[*_~#]{2}|[QRM]\d{2,3}\b|`/, '用户可见文案：不许 Markdown 星号、不许内部编号、不许反引号');
  assert.ok(hints.hintTextFor('hotspot').length > 10, '热点那一条也要说得出话');
  assert.throws(() => hints.hintTextFor('whatever'), '未知种类必须拒（不许把外部字符串当文案注入画面）');
  assert.throws(() => hints.hintShowScript(undefined), '没有默认分支：调用点写错种类要当场红');

  for (const [name, code] of await shellCodeFiles()) {
    if (name === 'page-hints.mjs') continue;
    assert.ok(!/\b6000\b/.test(code), `${name} 里又写了一遍提示时长 ⇒ 两处迟早漂`);
  }

  // 接线：进入那一路真挂、并且等文档换完（挂早了会被 enter() 里那次导航清掉 = 静默失效）。
  const main = await shellCode('main.mjs');
  const enterAt = main.indexOf('const entered = wallpaper.enter()');
  const exitAt = main.indexOf('function exitWallpaperMode');
  assert.ok(enterAt > 0 && exitAt > enterAt, '进入与退出两格都得在 main.mjs 里');
  const enterBody = main.slice(enterAt, exitAt);
  assert.ok(enterBody.includes('showEnter()'), '进入成功那一趟必须真挂提示（纯模块写得再好，没人调用等于没有）');
  assert.ok(enterBody.includes('did-finish-load'), '刚导航过一次 ⇒ 等新文档加载完再挂');
  assert.ok(enterBody.includes('wallpaper?.isWallpaper()'), '等加载这段时间里用户可能已经退出 ⇒ 不许把提示挂在普通窗口上');
  const exitBody = main.slice(exitAt, main.indexOf('function refreshTrayMenu'));
  assert.ok(exitBody.includes('hints?.clear()'), '退出把提示与热点反馈一起清掉');
});

test('R206 ㉝：热点反馈只在光标进去那一趟出现 —— 离开即摘、不常驻，且摘的时候不多跑一次脚本', async () => {
  const hints = await loadShell('page-hints.mjs');
  const scripts = [];
  const layer = hints.createHintLayer({ runInPage: (script) => scripts.push(script), schedule: () => 0, cancel: () => {} });
  assert.equal(layer.state().hotspot, false, '常态下屏幕上不许有这一条（任务书：不许常驻挡画面）');
  layer.showHotspot();
  assert.equal(layer.state().hotspot, true);
  assert.ok(scripts[0].includes(hints.HINT_HOTSPOT_TEXT.slice(0, 8)), '挂上去的就是热点那一条');
  assert.equal(layer.hideHotspot(), true, '离开要摘掉');
  assert.equal(layer.state().hotspot, false);
  assert.equal(scripts.length, 2, '摘一次跑一条脚本');
  assert.equal(layer.hideHotspot(), false, '本来就没有 ⇒ 不许再摘一次（那是每次划过都往页面丢脚本）');
  assert.equal(scripts.length, 2, '没东西可摘时一条脚本都不许多跑');
  // 退出时 clear 把两种一起收掉，并回收取走的那几格
  layer.showHotspot();
  assert.deepEqual(layer.clear(), ['hotspot'], 'clear 要说清取走的是哪几条（接线与取证都读这一格）');
  assert.equal(layer.state().hotspot, false);
});

test('R206 ㉞：退出还原按**容差**判 —— 一两像素的 DIP 舍入差不许报成"没还原到位"（验收侧 F1）', async () => {
  const m = await loadShell('wallpaper-window.mjs');
  assert.equal(m.RESTORE_TOLERANCE_DIP, 2, '容差是这个数量级（验收侧量的正是 1289x803 → 1291x805 = 差 2 DIP）');

  const inTol = m.classifyBoundsRestore({ x: 213, y: 109, width: 1291, height: 805 }, { x: 213, y: 109, width: 1289, height: 803 });
  assert.deepEqual(inTol.over, [], '验收侧那两格必须落在容差内：报给用户就是假话');
  assert.equal(inTol.rounding.length, 2, '但也不能当作逐字相等 —— 差值要看得见（降级成日志的内容）');

  const out = m.classifyBoundsRestore({ x: 213, y: 109, width: 1707, height: 1067 }, { x: 213, y: 109, width: 1289, height: 803 });
  assert.equal(out.over.length, 2, '差得远就是真没回去，必须报');
  assert.equal(out.rounding.length, 0);
  const words = m.describeRestoreGaps(out.over);
  assert.match(words, /bounds\.width（量到 1707、进入前是 1289，差 418 DIP）/, '弹的时候要写清差在哪一项、差多少');
  assert.doesNotMatch(words, /undefined|NaN/, '实话不能说谎');
  const unreadable = m.classifyBoundsRestore({ x: 1, y: 1, width: 1, height: 1 }, {});
  assert.equal(unreadable.over.length, 4, '读不到分量 = 不知道有没有回到，按"没回到"报（舍入那一档必须是量得出的差）');
  assert.deepEqual(unreadable.rounding, []);
  assert.deepEqual(unreadable.over[0], { field: 'bounds.x', got: 1, want: null, delta: null }, '报出来要带 got，且 delta 是 null 不是 NaN');

  // 运行时：造一个"还原时总是多 compensate DIP"的假窗口（正是真机那个形状）。
  const makeWin = (compensate) => {
    let state = { x: 213, y: 109, width: 1289, height: 803 };
    let forced = null; // 进了壁纸之后被别的东西改掉、且再也回不去 —— 真缺口那一档的形状
    let boundsCalls = 0;
    const win = {
      getBounds: () => forced ?? state,
      setBounds: (b) => { boundsCalls += 1; state = compensate ? { ...b, width: b.width + compensate, height: b.height + compensate } : { ...b }; },
      isAlwaysOnTop: () => false, setAlwaysOnTop: () => {},
      setSkipTaskbar: () => {},
      isResizable: () => true, setResizable: () => {},
      isMovable: () => true, setMovable: () => {},
      isSimpleFullScreen: () => false, setSimpleFullScreen: () => {},
      setIgnoreMouseEvents: () => {},
      loadURL: () => {},
    };
    return { win, force: (value) => { forced = value; }, boundsCalls: () => boundsCalls };
  };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, workArea: { x: 0, y: 0, width: 1707, height: 1019 } };
  const run = ({ compensate = 0, stuck = null } = {}) => {
    const notices = [];
    const logs = [];
    const fake = makeWin(compensate);
    const controller = m.createWallpaperWindowController({
      win: fake.win, origin: 'http://127.0.0.1:5175/', display,
      initial: { skipTaskbar: false }, onNotice: (text) => notices.push(text), onLog: (text) => logs.push(text),
    });
    controller.enter();
    if (stuck) fake.force(stuck);
    const boundsCallsAfterEnter = fake.boundsCalls();
    const result = controller.exit();
    return { notices, logs, result, boundsCallsAfterEnter, boundsCalls: fake.boundsCalls() };
  };

  const rounded = run({ compensate: 2 });
  assert.deepEqual(rounded.result.mismatch, [], '容差内的差**不许**进 mismatch —— mismatch 正是那条弹窗的判据（变异把容差改回 0 就红在这里）');
  assert.equal(rounded.notices.length, 0, '一条都不许多弹给用户：验收侧每次退出都看到的那句假话就是这么来的');
  assert.equal(rounded.logs.length, 1, '但差值要落进日志，不许静默吞掉');
  assert.match(rounded.logs[0], /写回一次/, 'R207（Q94 批复落地）：容差内也要按快照**写回一次**，不是只记一行日志');
  assert.match(rounded.logs[0], /差 2 DIP/);
  assert.match(rounded.logs[0], /残差/, '写回之后的残差要报进同一行日志（不留一个"写回了但结果如何"的黑箱）');
  assert.equal(rounded.result.rounding.length, 2);
  assert.equal(rounded.boundsCalls - rounded.boundsCallsAfterEnter, 2,
    '退出那一路 setBounds 应当**两次**：一次按快照还原、一次是容差内的纠正性写回（Q94）');

  const exact = run({ compensate: 0 });
  assert.deepEqual(exact.result.mismatch, [], '逐字回到快照 ⇒ 本来就没有缺口');
  assert.equal(exact.notices.length, 0);
  assert.equal(exact.logs.length, 0, '没有差就不要写日志（否则日志会被空行淹掉）');
  assert.equal(exact.boundsCalls - exact.boundsCallsAfterEnter, 1, '逐字回到快照时**不许**多写一次（纠正性写回只在容差内有差时发生）');

  const broken = run({ stuck: { x: 0, y: 0, width: 900, height: 600 } });
  assert.equal(broken.result.mismatch.length, 4, '四项全不在位 ⇒ 四项都要报出来（弹窗那一句由 main.mjs 拼，形状判据在下面）');
  assert.equal(broken.notices.length, 0, '控制器自己不弹 —— 弹不弹是接线那一层的事，一处只做一件事');
  const brokenWords = m.describeRestoreGaps(broken.result.mismatch);
  assert.match(brokenWords, /bounds\.width（量到 900、进入前是 1289，差 389 DIP）/, '那句弹窗要说得出差在哪一项、差多少');
  assert.match(brokenWords, /bounds\.height/, '并且逐项都点到');

  // 接线：main.mjs 那一句弹的是**带差值**的描述，不是光秃秃的字段名。
  const main = await shellCode('main.mjs');
  assert.match(main, /describeRestoreGaps\(result\.mismatch\)/, '缺口文案读唯一出处那个描述函数');
  assert.match(main, /onLog: logRestoreNote/, '容差内那一档交给日志（弹窗那一条不许接它）');
  assert.match(main, /function logRestoreNote/, '日志落点在壳里只有一个出处');
  assert.match(main, /service\.logPath\(\)/, '读的是壳自己起服务那一次的日志文件（复用时拿不到 ⇒ 退化成主进程输出，仍不弹窗）');
});

// ─────────── R206 ①② 收口：焦点重试与日志落点（真机那两格抓出来的） ───────────

test('R206 ㉟：日志落点与焦点重试都得真跑一遍 —— 只写形状判据会放过"变量名没落地"那种崩（真机 Error 框抓出来的）', async () => {
  const { createShellService } = await loadShell('service-launch.mjs');
  // (a) 复用在跑的服务：壳从没开过日志文件 ⇒ logPath() 必须老实给 null（读的是**函数调用**，不是源码文本）
  const { APP_DIR: APP_DIR_FOR_REUSE } = await loadShell('service-launch.mjs');
  const reused = createShellService({
    launcherLoader: async () => ({ launchMusic: async (hooks) => { await hooks.prepare(APP_DIR_FOR_REUSE); return { reused: true, port: 5175 }; } }),
  });
  await reused.launch();
  assert.equal(reused.logPath(), null, '复用那一趟没有日志文件路径 ⇒ null（写日志那一步退化成主进程输出，绝不弹窗）');

  // (b) 壳自己起的服务：路径要留得到，而且就是启动器那份 `<dataDir>/player-service.log`
  const opened = [];
  const { APP_DIR } = await loadShell('service-launch.mjs');
  const owned = createShellService({
    spawnChild: () => ({ pid: 4242, unref: () => {}, exitCode: null, signalCode: null }),
    openLog: (logPath) => { opened.push(logPath); return { fd: 7, close: async () => {} }; },
    launcherLoader: async () => ({
      waitForService: async () => true,
      launchMusic: async (hooks) => {
        await hooks.prepare(APP_DIR);
        await hooks.start(APP_DIR, 'D:\data', 5175);
        return { reused: false, port: 5175 };
      },
    }),
  });
  await owned.launch();
  assert.equal(opened.length, 1, 'openLog 必须真被走到一次（否则这条测试什么都没验）');
  assert.ok(String(owned.logPath()).endsWith('player-service.log'), `壳自己起服务时要把日志路径留住：${owned.logPath()}`);
  assert.match(owned.logPath(), /data/, '留的是启动器给的那个数据目录里的文件');

  // (c) 热点看守：停在里面的每一拍都要上报（焦点不是一次就能拿到的），外面一拍都不许多报
  const hs = await loadShell('wallpaper-hotspot.mjs');
  const events = [];
  let clock = null;
  const watcher = hs.createHotspotWatcher({
    getCursor: () => ({ x: 1707 - 176 - 42, y: 20 }),   // 热点中心（常量沿上游那四个）
    getContentBounds: () => ({ x: 0, y: 0, width: 1707, height: 1067 }),
    onEnter: () => events.push('enter'),
    onLeave: () => events.push('leave'),
    onInside: () => events.push('inside'),
    setInterval: (fn) => { clock = fn; return 1; },
    clearInterval: () => { clock = null; },
  });
  watcher.start();
  assert.deepEqual(events, ['enter'], '进去那一拍报 enter');
  clock(); clock(); clock();
  assert.deepEqual(events, ['enter', 'inside', 'inside', 'inside'],
    '停在里面时每拍都上报 —— onEnter 那一次 focus 会被 Windows 的前台锁挡掉（真机量到：样式位摘了、前台还是别人的）');
  const far = hs.createHotspotWatcher({
    getCursor: () => ({ x: 10, y: 10 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1707, height: 1067 }),
    onEnter: () => events.push('far-enter'), onInside: () => events.push('far-inside'),
    setInterval: (fn) => fn, clearInterval: () => {},
  });
  far.start();
  assert.ok(!events.includes('far-inside'), '光标不在热点里时一拍都不许多报（每 150 ms 白调一次 focus 就是打扰）');

  // (d) 接线：重试必须带 isFocused 的门（不许无脑刷），并且仍然只走 window.mjs 那一个出处
  const main = await shellCode('main.mjs');
  const at = main.indexOf('onInside: () => {');
  assert.ok(at > 0, 'main.mjs 要把 onInside 真接上（纯模块写得再好，没人调用等于没有）');
  const body = main.slice(at, main.indexOf('});', at));
  assert.match(body, /isFocused\(\)/, '拿到焦点之后就停（不门住 = 每 150 ms 抢一次前台）');
  assert.match(body, /focusShellWindow\(mainWindow\)/, '重试走的还是 window.mjs 那一个出处');
  assert.match(body, /wallpaper\?\.isWallpaper\(\)/, '退出之后残余的几拍不许再动窗口');
});

test('R206 ㊱：解锁要有宽限 —— 离开热点那一拍不许立刻把穿透收回去（否则"点右下角那颗退出按钮"物理上点不到）', async () => {
  const hs = await loadShell('wallpaper-hotspot.mjs');
  assert.equal(hs.HOTSPOT_UNLOCK_LINGER_MS, 2500, '宽限量级 = 够把手从右上角移到右下角，又不至于常驻');
  const bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  const insidePoint = { x: 1707 - 176 - 42, y: 20 };
  const outsidePoint = { x: 400, y: 600 };
  let cursor = insidePoint;
  let now = 100000;
  const events = [];
  let tick = null;
  const watcher = hs.createHotspotWatcher({
    getCursor: () => cursor,
    getContentBounds: () => bounds,
    onEnter: () => events.push('enter'),
    onLeave: () => events.push('leave'),
    nowMs: () => now,
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { tick = null; },
  });
  watcher.start();
  assert.deepEqual(events, ['enter'], '进去那一拍把交互还回来');
  cursor = outsidePoint;
  now += 150; tick();
  assert.deepEqual(events, ['enter'], '离开后 150 ms：还在宽限里，不许收回（真机量到的正是这一格——移过去的路上就穿回去了）');
  assert.equal(watcher.inside(), false, '光标确实已经不在热点里了（宽限不是"没判出来"）');
  assert.equal(watcher.engaged(), true, 'engaged 与 inside 是两格：前者才是"交互在不在窗口"');
  now += hs.HOTSPOT_UNLOCK_LINGER_MS; tick();
  assert.deepEqual(events, ['enter', 'leave'], '过了宽限就收回穿透（壁纸该穿的还是穿）');

  // 宽限期内回到热点：重新计时，不许"用掉一次就没了"
  cursor = insidePoint; now += 100; tick();
  assert.deepEqual(events, ['enter', 'leave', 'enter'], '再进去算新一轮');
  cursor = outsidePoint; now += 100; tick();
  assert.deepEqual(events, ['enter', 'leave', 'enter'], '新一轮的宽限同样从最后一次在里面的时刻算');
  cursor = insidePoint; now += 100; tick();
  cursor = outsidePoint; now += hs.HOTSPOT_UNLOCK_LINGER_MS - 500; tick();
  assert.deepEqual(events, ['enter', 'leave', 'enter'], '在里面时每拍都续期（手停在边缘抖动不该把交互抽走）');
  now += 600; tick();
  assert.deepEqual(events, ['enter', 'leave', 'enter', 'leave'], '续期之后仍然会到期收回（不是永久解锁）');

  // 唯一出处：宽限那个数字不许在别处再写一遍
  for (const [name, code] of await shellCodeFiles()) {
    if (name === 'wallpaper-hotspot.mjs') continue;
    assert.ok(!/\b2500\b/.test(code), `${name} 里又写了一遍宽限时长 ⇒ 两处迟早漂`);
  }
  // 接线：主进程不许自己另掐一份表（宽限的算法只住在看守那一格）
  const main = await shellCode('main.mjs');
  assert.ok(!/Date\.now\(\)/.test(main), '主进程接线里不许自己掐表（表住在看守那一格，可注入、可自检）');
  assert.ok(!/setTimeout\(/.test(main), '主进程不许为壁纸另起定时器（退出与还原的次序全靠看守那一拍驱动）');
});

// ─────────── R207 · 形态 A′（不置顶）：进入不抢焦点 / 其余七项照旧 / 文案如实 ───────────

/** 假窗口：可指定"进入之前是不是置顶的"，用来钉"退出照快照还原"而不是写死。 */
function makeWallpaperWindow({ alwaysOnTop = false, bounds = { x: 120, y: 90, width: 1102, height: 702 } } = {}) {
  const calls = [];
  const state = { bounds: { ...bounds }, alwaysOnTop, skipTaskbar: false, resizable: true, movable: true, simpleFullScreen: false, ignoreMouse: false };
  const win = {
    getBounds: () => state.bounds,
    setBounds: (b) => { state.bounds = { ...b }; calls.push(['setBounds', b]); },
    isAlwaysOnTop: () => state.alwaysOnTop,
    setAlwaysOnTop: (v, level) => { state.alwaysOnTop = v; calls.push(['setAlwaysOnTop', v, level ?? null]); },
    setSkipTaskbar: (v) => { state.skipTaskbar = v; calls.push(['setSkipTaskbar', v]); },
    isResizable: () => state.resizable,
    setResizable: (v) => { state.resizable = v; calls.push(['setResizable', v]); },
    isMovable: () => state.movable,
    setMovable: (v) => { state.movable = v; calls.push(['setMovable', v]); },
    isSimpleFullScreen: () => state.simpleFullScreen,
    setSimpleFullScreen: (v) => { state.simpleFullScreen = v; calls.push(['setSimpleFullScreen', v]); },
    setIgnoreMouseEvents: (v, options) => { state.ignoreMouse = v; calls.push(['setIgnoreMouseEvents', v, options ? JSON.stringify(options) : null]); },
    loadURL: (u) => calls.push(['loadURL', u]),
  };
  return { win, calls, state };
}
const DISPLAY_1707 = { id: 1, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, workArea: { x: 0, y: 0, width: 1707, height: 1019 }, scaleFactor: 1.5 };

test('R207 ㊲：进入时**不置顶**（形态 A′），其余七项一项没动；"进入即置顶"那种写法全壳零命中', async () => {
  const m = await loadShell('wallpaper-window.mjs');
  // ① 真驱动：故意从"进入之前就是置顶的"开始 —— 进入之后必须是 false（说明这一行不是"没写"，是"主动清掉"）
  const a = makeWallpaperWindow({ alwaysOnTop: true });
  const controller = m.createWallpaperWindowController({ win: a.win, origin: 'http://127.0.0.1:5175/', display: DISPLAY_1707, initial: { skipTaskbar: false } });
  assert.equal(controller.enter().ok, true);
  assert.equal(a.state.alwaysOnTop, false, '进入时不许置顶：别的窗口要能盖住它（用户口径 R207）');
  // ② 其余七项照旧：清单逐格点名 + 每一项都真被设过
  assert.deepEqual(m.WALLPAPER_APPLIED_FIELDS.map((f) => f.name),
    ['alwaysOnTop', 'skipTaskbar', 'bounds', 'resizable', 'movable', 'simpleFullScreen', 'url', 'ignoreMouseEvents'],
    '进入项清单**形状未变**（R207 只是把 alwaysOnTop 那一格的值从 true 改成 false）');
  const names = a.calls.map(([n]) => n);
  for (const field of m.WALLPAPER_APPLIED_FIELDS) {
    assert.ok(names.some((n) => n.toLowerCase().includes(field.setter.toLowerCase())), `进入时没设 ${field.name}`);
  }
  assert.equal(a.state.skipTaskbar, true, '不占任务栏照旧');
  assert.equal(a.state.resizable, false, '不可缩放照旧');
  assert.equal(a.state.movable, false, '不可移动照旧');
  assert.equal(a.state.simpleFullScreen, true, '铺满那一格照旧');
  assert.equal(a.state.ignoreMouse, true, '真穿透照旧');
  assert.equal(a.calls.find(([n]) => n === 'loadURL')[1], 'http://127.0.0.1:5175/?wallpaper=1', '画的那一档 surface 照旧');
  // ③ 全壳零命中：不许再出现"进入即置顶"，也不许再用 screen-saver 那个层级
  for (const [name, code] of await shellCodeFiles()) {
    assert.ok(!/setAlwaysOnTop\(\s*true/.test(code), `${name} 里出现"设成置顶"⇒ 形态 A′ 的进入那一格被写回去了`);
    assert.ok(!code.includes('screen-saver'), `${name} 里又出现了 screen-saver 层级（R207 起这一档不置顶，这个字面量没有主人了）`);
  }
});

test('R207 ㊳：进入壁纸那一刻**不许抢焦点**（showInactive）；热点那条路的 focus 一个字没动（R206 的 P0）', async () => {
  const win = await shellCode('window.mjs');
  const revealAt = win.indexOf('export function revealShellWindow');
  assert.ok(revealAt > 0, 'window.mjs 里要有"露出来但不激活"那一格');
  const revealBody = win.slice(revealAt, win.indexOf('\n}', revealAt));
  assert.ok(revealBody.includes('showInactive()'), '这一格用 Electron 的 showInactive()：显示但不激活');
  assert.ok(!revealBody.includes('win.focus()'), '这条路里不许 focus');
  assert.ok(revealBody.includes('isDestroyed()'), '与另外两个窗口助手同一条防御（窗口没了就什么都不做）');

  const main = await shellCode('main.mjs');
  const enterAt = main.indexOf('function enterWallpaperMode');
  const exitAt = main.indexOf('function exitWallpaperMode');
  assert.ok(enterAt > 0 && exitAt > enterAt);
  const enterBody = main.slice(enterAt, exitAt);
  assert.ok(enterBody.includes('revealShellWindow(mainWindow)'), '进入那一路走 showInactive（R207）');
  assert.ok(!enterBody.includes('focusShellWindow('), '进入那一路不许抢焦点 —— 它会盖住用户正在用的应用（R207 用户口径）');

  // 热点那条路（R206 的 P0：光标进热点 ⇒ 取消穿透 + 拿回焦点，Esc 才管用）**正面钉，一个字不许动**
  const hotAt = main.indexOf('onEnter: () => {');
  const hotBody = main.slice(hotAt, main.indexOf('});', hotAt));
  assert.ok(hotBody.includes('focusShellWindow(mainWindow)'), '热点 onEnter 里那次 focus 必须还在（R206 的 P0）');
  const insideAt = main.indexOf('onInside: () => {');
  const insideBody = main.slice(insideAt, main.indexOf('});', insideAt));
  assert.ok(insideBody.includes('focusShellWindow(mainWindow)'), 'onInside 的每拍重试也要在（前台锁那一格的实测结论）');
  // 调用点清单：focusShellWindow 在 main.mjs 里恰好这些地方（多一处就是"又有别的地方在抢前台"）
  const callSites = [...main.matchAll(/focusShellWindow\(/g)].length;
  assert.equal(callSites, 5, `focusShellWindow 的调用点应当是 5 处（托盘显示 / 托盘点击 / 热点 onEnter / onInside / 第二实例），实际 ${callSites}`);
});

test('R207 ㊴：退出仍然按"进入那一刻的快照"还原 —— 进入前是置顶的机器上要还原成置顶，不是写死', async () => {
  const m = await loadShell('wallpaper-window.mjs');
  // 进入前置顶 ⇒ 退出必须回到置顶（照快照；"写死 false"会在这里红）
  const a = makeWallpaperWindow({ alwaysOnTop: true });
  const ca = m.createWallpaperWindowController({ win: a.win, origin: 'http://127.0.0.1:5175/', display: DISPLAY_1707, initial: { skipTaskbar: false } });
  ca.enter();
  assert.equal(a.state.alwaysOnTop, false, '进入时不置顶');
  ca.exit();
  assert.equal(a.state.alwaysOnTop, true, '退出要照**快照**还原（进入前是置顶的就得回置顶）—— 不许为这一格加特例');
  // 进入前不置顶 ⇒ 退出还是不置顶（"写死 true"会在这里红，㊲ 那一条全壳零命中也会红）
  const b = makeWallpaperWindow({ alwaysOnTop: false });
  const cb = m.createWallpaperWindowController({ win: b.win, origin: 'http://127.0.0.1:5175/', display: DISPLAY_1707, initial: { skipTaskbar: false } });
  cb.enter();
  assert.deepEqual(cb.exit().mismatch, [], '还原后逐项读回不许有不一致');
  assert.equal(b.state.alwaysOnTop, false, '这一格完全由快照决定');
  // 两条路都不许"多还原一项"：setAlwaysOnTop 在进入+退出各一次
  for (const made of [a, b]) {
    assert.equal(made.calls.filter(([n]) => n === 'setAlwaysOnTop').length, 2, '进入一次、退出一次 —— 成对，多一次就是"多还原了一项"');
  }
});

test('R207 ㊵：文案与"不再置顶"这个新行为一致 —— 旧话（常驻最上）一个字都不许留，且要说得出会被盖住', async () => {
  const m = await loadShell('wallpaper-switch.mjs');
  const detail = m.WALLPAPER_CONFIRM_DETAIL;
  for (const stale of ['停在其它窗口之上', '盖在所有窗口之上', '始终在最前']) {
    assert.ok(!detail.includes(stale), `文案里还留着已经不成立的那句：${stale}（R207 起这一档不置顶）`);
  }
  assert.match(detail, /盖住/, '要说得出"被别的窗口盖住"这件事');
  assert.match(detail, /看不见/, '要说得出"盖住之后就看不见了"（用户口径点名要写）');
  assert.match(detail, /显示桌面|Win\+D/, '任务书点名：Win+D / 显示桌面会把它一起盖住，必须写出来');
  // R205 ⑲ 那几条正向钉仍然在（本件只改"置顶"那一句，别的如实描述一个字没动）
  for (const stillTrue of [/铺满整块屏幕/, /桌面图标.*之上/, /系统壁纸（桌面背景那张图）不会被改动/, /鼠标会穿过去/, /键盘到不了这个窗口/, /任务栏上不再占一格/, /三条路/]) {
    assert.match(detail, stillTrue, `R205 ⑲ 那条正向钉被本件弄丢了：${stillTrue}`);
  }
});

// ─────────── R208 · 壁纸入口先藏起来（机制原样留着，一条开关就放回来） ───────────

test('R208 ㊶：总开关是**唯一出处** —— 托盘与快捷键两条都读它，恢复只改这一个常量', async () => {
  const sw = await loadShell('wallpaper-switch.mjs');
  assert.equal(sw.WALLPAPER_MODE_AVAILABLE, false,
    'R208：壁纸入口先藏起来（理由写在常量注释里：进入那一档会**换掉页面文档** ⇒ 打断播放）');
  // 定义只有一处
  const owners = [];
  for (const [name, code] of await shellCodeFiles()) {
    if (/export const WALLPAPER_MODE_AVAILABLE/.test(code)) owners.push(name);
  }
  assert.deepEqual(owners, ['wallpaper-switch.mjs'], `这个开关只许有一个定义出处，实际 ${owners.join(',')}`);
  // 两个消费者都**读同一个名字**（各自写一份布尔 = 恢复时要改两处）
  const tray = await shellCode('tray-menu.mjs');
  const keys = await shellCode('shortcuts.mjs');
  assert.match(tray, /wallpaperAvailable = WALLPAPER_MODE_AVAILABLE/, '托盘那一格缺省读常量（不是自己写 false）');
  assert.match(keys, /shellShortcuts\(wallpaperAvailable = WALLPAPER_MODE_AVAILABLE\)/, '快捷键那条缺省读**同一个**常量');
  // 接线侧不许再算一次
  const main = await shellCode('main.mjs');
  assert.ok(!/WALLPAPER_MODE_AVAILABLE|wallpaperAvailable/.test(main),
    'main.mjs 不许自己再算一次"开放与否"（缺省即读常量 ⇒ 恢复只改一处）');
  // "放回来是什么样"：两边都传 true 时入口就回来 —— 这就是把常量改回 true 之后的样子
  const { buildTrayMenuItems, TRAY_ITEM_IDS } = await loadShell('tray-menu.mjs');
  const trayOn = buildTrayMenuItems({ windowVisible: true, wallpaperAvailable: true });   // R209：六项（含数据两件）
  assert.equal(trayOn.length, 6, '开关打开 ⇒ 托盘六项（R209 起还有数据管理两件；这一格是**形状变化**，逐项点名在 ⑭）');
  assert.ok(trayOn.some((item) => item.id === TRAY_ITEM_IDS.wallpaper), '开关打开 ⇒ 壁纸那一项回来');
  const { shellShortcuts, SHELL_WALLPAPER_ACTION } = await loadShell('shortcuts.mjs');
  assert.equal(shellShortcuts(true).length, 5, '开关打开 ⇒ 快捷键五条');
  assert.ok(shellShortcuts(true).some((item) => item.action === SHELL_WALLPAPER_ACTION), '开关打开 ⇒ Ctrl+Alt+W 那条回来');
});

test('R208 ㊷：机制与既有判据**原样留着**（只藏入口，不删代码不删测试）—— 删掉任何一格必须红', async () => {
  const files = await shellFiles();
  for (const f of ['wallpaper-window.mjs', 'wallpaper-hotspot.mjs', 'wallpaper-power.mjs', 'wallpaper-switch.mjs']) {
    assert.ok(files.includes(f), `R208 只藏入口不删机制：${f} 必须还在`);
  }
  // 机制的对外面貌仍在（不是"文件还在但掏空了"）
  const m = await loadShell('wallpaper-window.mjs');
  for (const key of ['createWallpaperWindowController', 'decideWallpaperEntry', 'WALLPAPER_APPLIED_FIELDS', 'RESTORE_TOLERANCE_DIP', 'classifyBoundsRestore', 'coversWholeDisplay']) {
    assert.ok(key in m, `wallpaper-window.mjs 的 ${key} 必须还在（那些判据就钉在它上面）`);
  }
  const hot = await loadShell('wallpaper-hotspot.mjs');
  assert.ok('CLICK_THROUGH_UNLOCK_HOTSPOT' in hot && 'HOTSPOT_UNLOCK_LINGER_MS' in hot, '热点那两格机制仍在');
  const power = await loadShell('wallpaper-power.mjs');
  assert.ok('WALLPAPER_BATTERY_NOTICE_ENABLED' in power, '功耗那一格机制仍在');
  // 既有判据也在（按标题点名 —— 删掉判据和删掉代码同样是"藏入口"藏过头了）
  // 判据标题按**编号 + 分隔符**匹配（不写成裸 includes：那样 `㉔` 被改成 `㉔X` 也照样命中 ——
  // 这是本件变异 S4 第一轮没咬的原因，属于判据写弱，改强不改松）。
  const self = await readFile(new URL('check-music-shell.mjs', import.meta.url), 'utf8');
  const hasTest = (id) => new RegExp(`test[(]'R20[0-9] ${id}[：:]`).test(self);
  for (const id of ['㉓', '㉔', '㉕', '㉖', '㉗', '㉘', '㉙', '㉚', '㉛', '㉜', '㉝', '㉞', '㉟', '㊱', '㊲', '㊳', '㊴', '㊵']) {
    assert.ok(hasTest(id), `既有判据 ${id} 必须还在（R208 只关入口，不删判据）—— 编号后必须紧跟分隔符，改名同样算删`);
  }
  // 顺带一条：每个编号只许有一条（重复定义会让"还在不在"这句话没法判）
  for (const id of ['㉓', '㉔', '㉘', '㉞']) {
    assert.equal((self.match(new RegExp(`test[(]'R20[0-9] ${id}[：:]`, 'g')) ?? []).length, 1, `${id} 只许有一条判据`);
  }
});

test('R208 ㊸：沉浸全屏那一档（页内切换、**不打断播放**）一个字没动', async () => {
  // 判据仍在（surface 段那五条）
  const surface = await readFile(new URL('check-music-surface.mjs', import.meta.url), 'utf8');
  for (const t of ['R206 ③-1', 'R206 ③-2', 'R206 ③-3', 'R206 ③-4', 'R206 ③-5']) {
    assert.ok(surface.includes(t), `${t} 必须还在（本件不动沉浸那一档）`);
  }
  // 实现仍在（那几个导出仍在同一份自撰模块里）
  const immersive = await readFile(new URL('../src/folia-host/immersive.ts', import.meta.url), 'utf8');
  for (const needle of ['IMMERSIVE_ENTER_LABEL', 'IMMERSIVE_EXIT_LABEL', 'IMMERSIVE_SURFACE_VALUE', 'createImmersiveToggle', 'documentFullscreenAdapter']) {
    assert.ok(immersive.includes(needle), `沉浸那一档的 ${needle} 必须还在`);
  }
  // 壳这一侧不许出现"顺手把沉浸也关掉"的写法（代码面扫，注释不算）
  for (const [name, code] of await shellCodeFiles()) {
    assert.ok(!code.includes('immersive'), `${name} 的代码里出现了沉浸那一档的名字 —— 本件不许碰它`);
  }
});

// ─────────── R209 · 免安装绿色版：数据目录 / 数据管理两件 / 打包形状 ───────────

test('R209 ㊹：数据目录三段式 —— MUSIC_DATA_DIR 优先、打包态默认 %LOCALAPPDATA%\\RhineMusic、开发形态默认**逐字未变**', async () => {
  const m = await loadShell('app-paths.mjs');
  // ① env 赢（最高优先 —— 真便携的出口）
  assert.deepEqual(
    m.resolveDataDir({ env: { MUSIC_DATA_DIR: 'D:\\便携\\数据' }, isPackaged: true, localAppData: 'C:\\LA' }),
    { dataDir: 'D:\\便携\\数据', source: 'env' },
    'MUSIC_DATA_DIR 优先于打包默认',
  );
  // ② 打包态默认
  assert.deepEqual(
    m.resolveDataDir({ env: {}, isPackaged: true, localAppData: 'C:\\LA' }),
    { dataDir: 'C:\\LA\\RhineMusic', source: 'packaged-default' },
    '打包态默认 = %LOCALAPPDATA%\\RhineMusic',
  );
  // ③ 开发形态：null ⇒ 交给启动器按今天的默认走（那两行一个字不动）
  assert.deepEqual(
    m.resolveDataDir({ env: {}, isPackaged: false, localAppData: 'C:\\LA' }),
    { dataDir: null, source: 'dev-default' },
    '开发形态不许用打包默认（用户那台 5175 正跑在开发默认上）',
  );
  // 边界：空白 env 不算"设过"；没有 LOCALAPPDATA 也不许瞎猜
  assert.equal(m.resolveDataDir({ env: { MUSIC_DATA_DIR: '   ' }, isPackaged: true, localAppData: 'C:\\LA' }).source, 'packaged-default',
    'MUSIC_DATA_DIR="" / 空白不许被当成有效值（否则数据目录会变成当前目录）');
  assert.equal(m.resolveDataDir({ env: {}, isPackaged: true, localAppData: '' }).dataDir, null, '拿不到 LOCALAPPDATA 就不猜（宁可退化，也不许指到别处）');
  // ④ 那两行默认**逐字未变**（判据③ 的第三格）+ 壳里不许出现那份默认的字面量
  const launcher = await readFile(new URL('../scripts/launch-music.mjs', import.meta.url), 'utf8');
  assert.ok(launcher.includes("dataDir = path.resolve(projectDir, dataDir ?? process.env.MUSIC_DATA_DIR ?? '../music-data-v3')"),
    '启动器的默认解析必须逐字未变');
  const server = await readFile(new URL('../scripts/music-server.mjs', import.meta.url), 'utf8');
  assert.ok(server.includes("dataDir = process.env.MUSIC_DATA_DIR ?? path.join(PROJECT_DIR, '..', 'music-data-v3')"),
    '服务端的默认解析必须逐字未变');
  for (const [name, code] of await shellCodeFiles()) {
    assert.ok(!code.includes('music-data-v3'), `${name} 里出现了开发默认的字面量 ⇒ 第二处默认（打包默认只住 app-paths.mjs）`);
  }
});

test('R209 ㊺：浏览器配置目录**只在打包态**重定向到 <数据目录>\\shell-profile，且 setPath 必须排在 whenReady / 单实例锁之前', async () => {
  const m = await loadShell('app-paths.mjs');
  assert.equal(m.SHELL_PROFILE_SUBDIR, 'shell-profile');
  assert.equal(m.shellProfileDir({ dataDir: 'C:\\LA\\RhineMusic' }), 'C:\\LA\\RhineMusic\\shell-profile');
  assert.equal(m.shellProfileDir({ dataDir: null }), null, '开发形态不重定向（与数据目录同一条原则）');
  // 首次提示只在"目录不存在或空"时说一次
  const emptyFs = { readdirSync: () => [] };
  const missingFs = { readdirSync: () => { throw new Error('ENOENT'); } };
  const usedFs = { readdirSync: () => ['config.json'] };
  assert.equal(m.dataDirLooksNew({ dataDir: 'D:\\d', fs: emptyFs }), true, '空目录 = 新');
  assert.equal(m.dataDirLooksNew({ dataDir: 'D:\\d', fs: missingFs }), true, '还没有 = 新');
  assert.equal(m.dataDirLooksNew({ dataDir: 'D:\\d', fs: usedFs }), false, '有东西在里面 = 不是新（别每次启动都提醒）');
  assert.equal(m.dataDirLooksNew({ dataDir: null, fs: emptyFs }), false, '没有独立数据目录就不提这一句');
  // 接线次序（三条实现字里最硬的那条）：setPath 在 whenReady **与**单实例锁之前
  const main = await shellCode('main.mjs');
  const setAt = main.indexOf("app.setPath('userData'");
  const readyAt = main.indexOf('app.whenReady()');
  const lockAt = main.indexOf('requestSingleInstanceLock()');
  assert.ok(setAt > 0 && readyAt > 0 && lockAt > 0, '三格都得在（读不到 = 换了写法，要一起来改判据）');
  assert.ok(setAt < readyAt, 'setPath 必须在 whenReady 之前（ready 之后改不动 —— 验收侧复核点名的那条实现字）');
  assert.ok(setAt < lockAt, '也要在单实例锁之前（锁的载体就在 userData 里 ⇒ 换目录等于换锁）');
  assert.match(main, /if \(profileDir\) \{/, '只在解析出数据目录时才重定向（开发形态 profileDir 是 null ⇒ 一个字不动）');
  assert.match(main, /dataDir: dataPaths\.dataDir \?\? undefined/, '解析结果显式喂给服务（启动器那个参数本来就有 ⇒ 零新通路）');
});

test('R209 ㊻：清空只删**白名单**里的东西 + 三条安全闸 + 二次确认逐项点名 + 回执说得出"已退出登录"', async () => {
  const m = await loadShell('data-admin.mjs');
  const dataDir = 'C:\\LA\\RhineMusic';
  const fakeFs = (present) => ({
    existsSync: (p) => present.some((rel) => p === `${dataDir}\\${rel}`),
    readFileSync: (p) => (present.includes('config.json') && p.endsWith('config.json')
      ? JSON.stringify({ roots: ['D:\\音乐测试曲库'] })
      : (() => { throw new Error('ENOENT'); })()),
  });
  // ① 白名单 ∩ 存在的：只挑出来真正在的
  const plan = m.clearDataPlan({ dataDir, libraryRoots: ['D:\\音乐测试曲库'], programDirs: ['D:\\app'], fs: fakeFs(['favorites.json', 'playlists', 'artwork']) });
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.targets.map((t) => t.path), ['favorites.json', 'playlists', 'artwork'], '只列出数据目录里真实存在的那几项');
  assert.ok(m.CLEAR_DATA_ENTRIES.some((e) => e.path === 'online-session'), '登录凭据在清单里（口径第 9 条点名要它）');
  assert.ok(m.CLEAR_DATA_ENTRIES.some((e) => e.path === 'shell-profile'), '壳自己那份浏览器配置也在清单里（R209 拍板：一起清）');
  // ② 三条安全闸
  assert.equal(m.clearDataPlan({ dataDir, libraryRoots: ['C:\\LA\\RhineMusic\\我的歌'], fs: fakeFs([]) }).reason, 'library-inside-data-dir',
    '曲库根落在数据目录里面 ⇒ 宁可不删（那会连音乐文件一起删）');
  assert.equal(m.clearDataPlan({ dataDir, libraryRoots: [], programDirs: ['C:\\LA\\RhineMusic\\program'], fs: fakeFs([]) }).reason, 'overlaps-program-dir',
    '数据目录与程序目录重叠 ⇒ 不删');
  assert.equal(m.clearDataPlan({ dataDir: null, fs: fakeFs([]) }).reason, 'no-data-dir', '没有独立数据目录 ⇒ 不删');
  // ③ 确认框：逐项点名 + 明写音乐文件不会被删 + 缺省选中"取消"
  const dialog = m.clearDataConfirmDialog({ dataDir, targets: plan.targets, libraryRoots: ['D:\\音乐测试曲库'] });
  assert.equal(dialog.type, 'warning', '这是有代价的操作，语气不能是 info');
  assert.deepEqual(dialog.buttons, ['取消', '清空全部数据']);
  assert.equal(dialog.defaultId, 0, '缺省选中"取消"（回车不许直接清空）');
  assert.equal(dialog.cancelId, 0);
  for (const t of plan.targets) assert.ok(dialog.detail.includes(t.label), `确认框必须逐项列出：${t.label}`);
  assert.ok(dialog.detail.includes('你的音乐文件不会被删'), '那句必须逐字在（口径第 9 条）');
  assert.ok(dialog.detail.includes('D:\\音乐测试曲库'), '还要指得出曲库目录在哪');
  assert.ok(dialog.detail.includes('退出登录'), '凭据也在清单里 ⇒ 得先说清清完会退出登录');
  assert.doesNotMatch(dialog.detail, /[*_~#]{2}|[QRM]\d{2,3}\b/, '系统对话框不渲染 Markdown（R205 那两条反向判据照旧）');
  // ④ 回执
  const summary = m.clearDataSummary({ removed: ['收藏'], failed: [], leftover: ['unknown.bin'] });
  assert.match(summary, /已退出登录/, '回执要说"已退出登录"（凭据在数据目录里）');
  assert.match(summary, /没有动它们/, '不认识的东西要如实说没动（不许静默）');
  assert.match(m.clearDataSummary({ removed: [], failed: ['封面缓存'], leftover: [] }), /关掉播放器再试一次/, '删不掉要说清怎么办');
  // ⑤ 曲库根从 config.json 读（零新通道）
  assert.deepEqual(m.libraryRootsFromConfig(fakeFs(['config.json']), dataDir), ['D:\\音乐测试曲库']);
  assert.deepEqual(m.libraryRootsFromConfig(fakeFs([]), dataDir), [], '读不到就当没有（不许猜）');
  // ⑥ 实现形状：绝不整目录删
  const src = await shellCode('data-admin.mjs');
  assert.ok(!/rm(Sync)?\(dataDir\)/.test(src), '白名单删除，不许删整个数据目录');
  const main = await shellCode('main.mjs');
  assert.ok(!/rmSync\(dataDir\b/.test(main), 'main 里同样不许出现"删整个数据目录"');
  assert.match(main, /for \(const entry of plan\.targets\)/, '按清单逐项删');
  assert.match(main, /const choice = dialog\.showMessageBoxSync\([\s\S]{0,140}clearDataConfirmDialog/, '二次确认必须真弹（只在纯函数里写文案不算接上）');
  assert.match(main, /if \(choice !== 1\) return;/, '缺省/取消（0）必须早退 —— 没有这一行就等于"点了就删"');
});

test('R209 ㊼：数据目录那条路是**只读**的 —— 单独一个 /api/data-dir（不混进可写的 /api/config），面板那一行也只读', async () => {
  const server = await readFile(new URL('../scripts/music-server.mjs', import.meta.url), 'utf8');
  assert.match(server, /if \(route === '\/api\/data-dir' && get\)/, '只回 GET');
  const block = server.slice(server.indexOf("route === '/api/data-dir'"), server.indexOf("['/api/config', '/api/library/config']"));
  assert.ok(block.length > 0, '路由块要读得出来（读不出来这条判据就是空转）');
  assert.ok(!block.includes('POST'), '没有写的那一半（口径第 8 条：只读接口）');
  assert.match(block, /path: dataDir/, '回真实解析出来的路径');
  assert.match(block, /source: process\.env\.RHINE_DATA_DIR_SOURCE \?\? 'server-default'/, 'source 一档按实回（谁定的这个位置）');
  const configAt = server.indexOf("['/api/config', '/api/library/config']");
  const nextRouteAt = server.indexOf('if (route ', configAt + 10);
  const configBlock = server.slice(configAt, nextRouteAt > configAt ? nextRouteAt : configAt + 4000);
  assert.ok(!configBlock.includes('dataDir') && !configBlock.includes('data-dir'), '/api/config 那一块不许混进数据目录（它是可写的，会被回写进 config.json）');
  // 面板那一行：只读 + 从只读接口取 + 复制按钮有主人
  const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8');
  assert.match(app, /id="data-dir-path"[^>]*readonly/, '那一行是只读的（口径第 8 条）');
  assert.match(app, /request<\{ path\?: string; source\?: string \}>\("\/api\/data-dir"\)/, '路径从服务端只读接口取（页面自己不知道进程外的数据目录）');
  assert.match(app, /case "copy-data-dir":/, '复制那颗按钮要有主人（R121 那条"这次点击还有没有主人"）');
  assert.match(app, /void syncDataDirRow\(\);/, '面板渲染完要真去取一次（接口的存在不等于接口被调用）');
  assert.ok(!/data-dir-path[\s\S]{0,200}?(POST|bodyJson)/.test(app), '这一格不许变成写入口');
  // R210（Q108 结案）：这一句**两种形态下**都必须成立 —— 纯浏览器形态没有托盘，指过去就是指向不存在的东西。
  // 采用"最省的写法"（同一句两边都成立），不新造形态判定：现有信号里没有一个能分辨"壳在不在"——
  // source 那一档分不出开发形态的壳与纯浏览器（开发壳的 dataDir 也是 null ⇒ server-default），
  // isMainAppSurface 说的是壁纸 surface。"绿色版"这个名号面板里已有先例（source 命名表那句）。
  assert.match(app, /要彻底清除：直接删掉这个目录就行；绿色版另有托盘菜单的「清空全部数据」入口。/,
    '文案要两种形态都成立：删目录那条无壳也可用，托盘那条明确限定在绿色版名下（Q108）');
  assert.ok(!/要彻底清除：[^。]{0,40}用托盘的/.test(app),
    'Q108 负钉：不许再把"用托盘的…"写成无条件指令 —— 纯浏览器形态里那是一个不存在的东西');
  // R211（四）：来源命名表**四档齐全** —— 开发壳**自起**服务那一趟的来源是 `dev-default`，
  // 从前表里没这一档 ⇒ 那行小字是**空的**（R210 §三末如实记过）。缺档的表现是"静默空字符串"，只有机检抓得到。
  const namingAt = app.indexOf('const naming: Record<string, string>');
  const namingBlock = app.slice(namingAt, app.indexOf('};', namingAt));
  assert.ok(namingAt > 0 && namingBlock.length > 20 && namingBlock.length < 600,
    '命名表要读得出来（读不出来这条判据就是空转 —— 别拿 EOF 当块尾）');
  for (const tier of ['env', 'packaged-default', 'dev-default', 'server-default']) {
    // 键写不写引号都认（`env:` 与 `"packaged-default":` 在表里同时存在）—— 但**四档必须都在**。
    assert.ok(new RegExp(`["']?${tier}["']?\\s*:`).test(namingBlock), `来源命名表缺 ${tier} 档 ⇒ 那一档的来源在界面上会变成空字符串`);
  }
  assert.match(app, /"dev-default": "开发形态的默认位置"/, 'dev-default 那一档的中文文案逐字钉住');
});

test('R209 ㊽：打包脚本的形状 —— 白名单带 public/icons、整棵 app 不进 asar、--no-prune、离线取 dist、ZIP 走系统 bsdtar', async () => {
  const m = await loadShell('package-portable.mjs');
  assert.deepEqual(m.APP_COPY_LIST, ['dist', 'scripts', 'public/icons', 'LICENSE', 'NOTICE.md'],
    '必带清单逐项点名（缺口图标 public/icons 就出不来 —— 判据⑦ 的源头）');
  assert.ok(m.DEFAULT_OUT.includes('rhine-portable-build') && !m.DEFAULT_OUT.startsWith(m.REPO_ROOT),
    '产物默认落在**仓库外**（500 MB 的东西不许进版本库）');
  const thin = m.stagingPackageJson({ version: '9.9.9' });
  assert.equal(thin.main, 'electron-shell/main.mjs', '应用根的 main 指到壳里那一个入口（布局保持"同名兄弟"⇒ 路径零改动）');
  assert.equal(thin.productName, 'RhineMusic');
  assert.equal(thin.version, '9.9.9');
  assert.ok(thin.author && thin.description, 'packager 要 author/description（冒烟跑出来的两个必需字段）');
  const opts = m.packagerOptions({ staging: 'S', out: 'O', version: '1', electronZipDir: 'Z' });
  assert.equal(opts.asar, false, '整棵 app **不进 asar**（打包态服务那一跳零分支 —— 方案 §一.2）');
  assert.equal(opts.prune, false, '--no-prune（打包不许跑 npm）');
  assert.equal(opts.electronZipDir, 'Z', 'electron 二进制走本机缓存 zip（不依赖 GitHub 取数）');
  assert.equal(opts.platform, 'win32');
  assert.equal(opts.electronVersion, '43.7.9', '运行时版本与壳里那份钉在一起');
  // findElectronZipDir：找得到 / 找不到两种（假 fs）
  const fakeFs = (entries) => ({
    readdirSync: () => Object.keys(entries),
    statSync: (p) => {
      const hit = Object.entries(entries).some(([dir, files]) => p.includes(dir) && files.some((f) => p.endsWith(f)));
      if (!hit) throw new Error('ENOENT');
      return {};
    },
  });
  const fakePath = { join: (...parts) => parts.filter(Boolean).join('\\') };
  assert.equal(
    m.findElectronZipDir({ localAppData: 'C:\\LA', version: '43.7.9', fs: fakeFs({ sha1: ['electron-v43.7.9-win32-x64.zip'] }), path: fakePath }),
    'C:\\LA\\electron\\Cache\\sha1',
  );
  assert.equal(
    m.findElectronZipDir({ localAppData: 'C:\\LA', version: '9.9.9', fs: fakeFs({ sha1: ['electron-v43.7.9-win32-x64.zip'] }), path: fakePath }),
    null,
    '缓存里没有这一版就老实返回 null（那时才按镜像去取）',
  );
  // ZIP 那一步走**系统** tar 的绝对路径（Git 的 GNU tar 不认 -a，冒烟跑出来 status 128）
  const src = await shellSource('package-portable.mjs');
  assert.match(src, /System32'?, ?'tar\.exe'|System32[\s\S]{0,40}tar\.exe/, '用 %SystemRoot%\\System32\\tar.exe（bsdtar），不用 PATH 里那个');
  assert.ok(!/Compress-Archive|CompressArchive/.test(src), '不走 PowerShell 的 Compress-Archive（7000+ 小文件太慢）');
  // 壳目录的排除清单：node_modules 与打包脚本自己不许进包
  assert.ok(m.SHELL_COPY_SKIP.includes('node_modules') && m.SHELL_COPY_SKIP.includes('package-portable.mjs'));
  // R209（验收侧预检①）：白名单里的 scripts 再排掉自检脚本（61 个、含本机绝对路径），且运行期确实不用它们
  const scriptExcludes = m.APP_COPY_EXCLUDES?.scripts ?? [];
  assert.ok(scriptExcludes.some((re) => re.test('D:/x/scripts/check-music-shell.mjs')), 'check-*.mjs 必须在排除清单里（自检脚本含本机绝对路径，绿色版不许带出去）');
  // R211 七：开发工具的会话状态目录也不许进包 —— 重打包与上一版对表时真抓到过一次（解压树多出 1 个文件，
  // 定位到 `scripts/.mimosa/hook-state/sess_*.json`；本仓库 .gitignore 已经 ignore 了它，这条把产物面也堵上）。
  assert.ok(scriptExcludes.some((re) => re.test('D:/x/scripts/.mimosa/hook-state/sess_a.json')), '.mimosa/ 会话状态目录必须在排除清单里');
  const importPattern = new RegExp("from\\s+['\"][^'\"]*check-");
  const serverSrc = await readFile(new URL('../scripts/music-server.mjs', import.meta.url), 'utf8');
  const launcherSrc = await readFile(new URL('../scripts/launch-music.mjs', import.meta.url), 'utf8');
  for (const [name, text] of [['music-server.mjs', serverSrc], ['launch-music.mjs', launcherSrc]]) {
    assert.ok(!importPattern.test(text), `${name} 不许 import 自检脚本（排除了也得起得来）`);
  }
  const bridgeDir = new URL('../scripts/bridge/', import.meta.url);
  for (const raw of await readdir(bridgeDir, { recursive: true })) {
    const entry = String(raw).split('\\').join('/');
    if (!/\.mjs$/.test(entry) || /(^|\/)check-/.test(entry)) continue;
    const text = await readFile(new URL(entry, bridgeDir), 'utf8');
    assert.ok(!importPattern.test(text), `桥里不许 import 自检脚本：${entry}`);
  }
  // R209（验收侧预检②）：说明.txt 要拷到**产物根**（与 exe 并排），不是只躺在 resources/app 里
  assert.ok(src.includes("path.join(packagedDir, '说明.txt')"),
    '打包后要往产物根再拷一份 说明.txt（用户解压完第一眼看到的是那一层）');
});

test('R209 ㊾：说明.txt 如实写清 —— 数据在哪 / Win+R 最短路径 / 删程序目录不丢数据 / **exe 图标是 Electron 默认**', async () => {
  const notes = await shellSource('portable-notes.txt');
  for (const needle of ['%LOCALAPPDATA%\\RhineMusic', 'Win+R', 'MUSIC_DATA_DIR', '不会', 'exe', 'Electron 默认']) {
    assert.ok(notes.includes(needle), `说明.txt 缺了「${needle}」这一格`);
  }
  assert.match(notes, /删掉程序目录/, '口径第 7 条末：要说清"删掉程序目录不影响数据"');
  assert.match(notes, /图标仍是 Electron 默认图标/, '验收侧点名的那句如实声明（不许默默略过）');
  const src = await shellSource('package-portable.mjs');
  assert.match(src, /portable-notes\.txt[\s\S]{0,120}说明\.txt/, '打包脚本要把它带成包里的 说明.txt');
});

test('R209 ㊿：不写注册表 / 不设开机自启 / 不装服务 —— 连 Electron 那两条 API（setLoginItemSettings / winreg）也零命中', async () => {
  // ㉒ 已经钉了 reg.exe / RunOnce / currentversion\Run / schtasks / sc create 那几格；
  // 这一条补的是**在 Electron 里真会用到**的那两条 API（它们写的也是注册表/启动项）与几个别名。
  const banned = ['setLoginItemSettings', 'getLoginItemSettings', 'winreg', 'Registry.CurrentUser', 'HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE', 'createShortcut'];
  const offenders = [];
  for (const [name, code] of await shellCodeFiles()) {
    for (const word of banned) if (code.includes(word)) offenders.push(`${name}:${word}`);
  }
  assert.deepEqual(offenders, [], '绿色版：不装、不写注册表、不开机自启（口径第 1、4 条）——这几条 API 一个都不许出现');
  // 反证一格：这两条 API 连"包起来备用"都不许（有读者才算，没读者的口子就是下一个人的捷径）
  for (const [name, code] of await shellCodeFiles()) {
    assert.ok(!/autostart|autoLaunch|startupShortcut/i.test(code), `${name} 里出现了自启相关的名字 ⇒ 与"要么不做、要么显式开关且默认关"不符（本件选的是不做）`);
  }
});

test('R209 ５１：打包清单必须覆盖运行期 import 图的**每一个裸说明符**（防漏带：真机抓过一次 music-metadata）', async () => {
  const m = await loadShell('package-portable.mjs');
  const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url));
  const nodeModulesRoots = [fileURLToPath(new URL('../node_modules/', import.meta.url)), fileURLToPath(new URL('../scripts/bridge/node_modules/', import.meta.url))];
  const scan = m.runtimePackages({ scriptsDir, nodeModulesRoots });
  assert.ok(scan.bare.includes('music-metadata'), '运行期 import 面里必须有 music-metadata（服务端解析音频标签用它）');
  assert.ok(scan.bare.includes('opencc-js'), '也要有 opencc-js（繁简归一）');
  assert.ok(scan.packages.has('music-metadata'), '它必须在**要拷的包**里 —— 这条就是真机那次漏带的防复发格');
  assert.ok(scan.packages.has('opencc-js'), 'opencc-js 同样');
  // 桥自己的包**不重复拷**（它在 scripts/bridge/node_modules 里，随 scripts 白名单进包）
  assert.ok(!scan.packages.has('kugoumusicapi'), '桥的包不该被算进"要拷的包"（否则 83 MB 白拷一遍）');
  assert.ok(existsSync(path.join(scriptsDir, 'bridge', 'node_modules', 'kugoumusicapi', 'package.json')),
    '而它确实在 scripts 树里（随 scripts 一起进包 ⇒ 解析得到）');
  // 产物的解析面：每个要拷的包都得有 package.json（stageApp 逐包拷的就是这些目录）
  for (const [name, dir] of scan.packages) {
    assert.ok(existsSync(path.join(dir, 'package.json')), `要拷的包 ${name} 目录里必须有 package.json`);
  }
  // 接线：stageApp 真把它们拷进 <staging>/app/node_modules
  const src = await shellSource('package-portable.mjs');
  assert.match(src, /for \(const \[name, dir\] of runtime\.packages\)/, 'stageApp 要按闭包逐包拷');
  assert.match(src, /path\.join\(staging, 'app', 'node_modules', name\)/, '落点是 <staging>/app/node_modules');
  // 不为构建 dist 用的那几包买单（three/pixi/react 只服务渲染层的构建，dist 里已经打进去了）
  for (const heavy of ['three', 'pixi.js', 'react', 'react-dom']) {
    assert.ok(!scan.packages.has(heavy), `${heavy} 只服务构建 dist，不许进"要拷的包"`);
  }
});

test('R211 ５２：闭包扫描器对**非字面量动态 import** 显式失败 —— 误伤防线四格 + 抛/不抛双向夹具', async () => {
  const fsp = await import('node:fs/promises');
  const osMod = await import('node:os');
  const m = await loadShell('package-portable.mjs');
  const root = await fsp.mkdtemp(path.join(osMod.tmpdir(), 'rhine-r211-closure-'));
  const scriptsDir = path.join(root, 'scripts');
  const nmRoot = path.join(root, 'node_modules');
  await fsp.mkdir(path.join(scriptsDir, 'bridge'), { recursive: true });
  await fsp.mkdir(path.join(nmRoot, 'fakepkg'), { recursive: true });
  await fsp.writeFile(path.join(nmRoot, 'fakepkg', 'package.json'), '{"name":"fakepkg","version":"1.0.0"}');
  const writeEntry = (body) => fsp.writeFile(path.join(scriptsDir, 'music-server.mjs'), body, 'utf8');
  const scan = (registrations) => m.runtimePackages({ scriptsDir, nodeModulesRoots: [nmRoot], entries: ['music-server.mjs'], registrations });
  try {
    // (i) 误伤防线四格（这四格就是本件加固第一版踩过的形态，全是**真代码**里存在的写法）⇒ 都不许抛，
    //     而且字面量说明符必须照常进闭包（新加固不许把正常路径一起卡死）。
    await writeEntry([
      "import { a } from 'fakepkg';",
      'const store = { import({ text } = {}) { return text; } };',   // ③ 解构参数（playlist-import.mjs 的同款）
      'async import(spec2) { return spec2; },',                      // ④ 方法定义行（对象简写/类方法）
      "const x = store.import({ text: 'n' });",                      // ① 方法调用（点号在前）
      '// 注释里的提及不算：await import(name) 与 require(spec)',      // ② 行注释
      '/* 块注释里的：await import(name) */',                        // ② 块注释
      'export const y = a + x;',
    ].join('\n'));
    const ok = scan([]);
    assert.ok(ok.bare.includes('fakepkg'), '字面量说明符必须照常进闭包（误伤防线不许把正常路径一起卡死）');
    assert.ok(ok.packages.has('fakepkg'), '要拷的包里也有它');
    // (ii) 变量说明符 ⇒ 抛（静默跳过 = R209 那个"看起来打包成功、用户机器上 ERR_MODULE_NOT_FOUND"的形状）
    await writeEntry("import { a } from 'fakepkg';\nexport const w = await import(a);\n");
    assert.throws(() => scan([]), /非字面量/, '变量说明符必须显式失败');
    // (iii) 模板串 ⇒ 同样抛（它其实能静态读出来，但要求显式登记一次，别靠猜）
    await writeEntry('export const w = await import(`fakepkg`);\n');
    assert.throws(() => scan([]), /非字面量/, '模板串一样算非字面量');
    // (iv) 登记出口：同文件登记一条 ⇒ 不抛，且登记的包**真的进闭包**（登记不是放过）；
    //      缺 why ⇒ 抛；登记了但解析不到 ⇒ 抛"找不到运行期依赖"。
    await writeEntry("const spec = 'fakepkg';\nexport const w = await import(spec);\n");
    const scanned = scan([{ file: 'music-server.mjs', spec: 'fakepkg', why: '夹具：证明登记出口真的把包并进闭包' }]);
    assert.ok(scanned.bare.includes('fakepkg'), '登记了就要被解析进 bare（登记≠放过）');
    assert.throws(() => scan([{ file: 'music-server.mjs', spec: 'fakepkg' }]), /缺 why/, '登记必须说得出理由');
    assert.throws(() => scan([{ file: 'music-server.mjs', spec: 'no-such-pkg', why: 'x' }]), /找不到运行期依赖/,
      '登记了也得真存在 —— 解析不到照样抛');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('R216 ５３：壳里不许有 __dirname / __filename（ESM）—— fileURLToPath(import.meta.url) 是唯一写法', async () => {
  const files = (await readdir(fileURLToPath(SHELL))).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length >= 10, `扫描面异常：只读到 ${files.length} 个壳文件（判据不许空转）`);
  // 注释里的"提提及"不算（R153 那课的写法）：扫前把注释剥掉，判的是**代码面**。
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  for (const name of files) {
    const src = stripComments(await readFile(shellPath(name), 'utf8'));
    assert.ok(!/\b__dirname\b/.test(src) && !/\b__filename\b/.test(src),
      `${name} 出现 __dirname/__filename —— .mjs 是 ESM、没有这个绑定（R216：真机点「清空全部数据」当场 ReferenceError）`);
  }
  const main = stripComments(await readFile(shellPath('main.mjs'), 'utf8'));
  assert.match(main, /const HERE_DIR = path\.dirname\(fileURLToPath\(import\.meta\.url\)\)/,
    '壳自己所在目录用 ESM 安全写法、文件顶部算一次');
});

test('R216 ５４：清空的参数组装走 clearPlanFor 一条接线 —— 真目录夹具三格（正常 / 曲库在数据目录里 / 与程序目录重叠）', async () => {
  const fsp = await import('node:fs/promises');
  const osMod = await import('node:os');
  const m = await loadShell('data-admin.mjs');
  assert.equal(typeof m.clearPlanFor, 'function', '接线函数必须导得出来（R209 那课：接口的存在不等于接口被调用，所以接线本身也要测）');
  const root = await fsp.mkdtemp(path.join(osMod.tmpdir(), 'rhine-r216-clear-'));
  try {
    const dataDir = path.join(root, 'data');
    const library = path.join(root, 'library');
    const program = path.join(root, 'program');
    await fsp.mkdir(path.join(dataDir, 'playlists'), { recursive: true });
    await fsp.mkdir(library, { recursive: true });
    await fsp.mkdir(program, { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'favorites.json'), '{}');
    await fsp.writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ version: 1, roots: [library] }));
    const realFs = { existsSync };
    // (i) 正常组合 ⇒ 放行；targets 只含白名单里**真实存在**的项、且都是数据目录里的相对路径
    const ok = m.clearPlanFor({ dataDir, libraryRoots: [library], programDirs: [program], fs: realFs });
    assert.equal(ok.allowed, true, '正常目录组合必须放行');
    assert.deepEqual(ok.targets.map((t) => t.path).sort(), ['config.json', 'favorites.json', 'playlists'],
      '只列真实存在的白名单项（不多列、不漏列）');
    const whitelist = new Set(m.CLEAR_DATA_ENTRIES.map((entry) => entry.path));
    assert.ok(ok.targets.every((t) => whitelist.has(t.path) && !path.isAbsolute(t.path) && !t.path.includes('..')),
      'targets 只能是白名单里的相对路径（绝不整目录删）');
    // (ii) 曲库根落在数据目录里 ⇒ 拒
    assert.equal(m.clearPlanFor({ dataDir, libraryRoots: [path.join(dataDir, 'playlists')], programDirs: [program], fs: realFs }).reason,
      'library-inside-data-dir', '曲库根在数据目录里 ⇒ 宁可不删');
    // (iii) 数据目录与程序目录重叠 ⇒ 拒（这里用"程序目录在数据目录里"的形态 —— 正是 main.mjs 传参这一环）
    assert.equal(m.clearPlanFor({ dataDir, libraryRoots: [library], programDirs: [path.join(dataDir, 'x')], fs: realFs }).reason,
      'overlaps-program-dir', '与程序目录重叠 ⇒ 不删');
    // 反例守卫：没有数据目录（开发形态直启）也拒
    assert.equal(m.clearPlanFor({ dataDir: null, libraryRoots: [], programDirs: [program], fs: realFs }).reason, 'no-data-dir');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
