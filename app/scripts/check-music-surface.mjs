// 壁纸 surface（M0，台账 R203）· `?wallpaper=1` 那一档的自检。
//
// 这一档的规矩只有一条主判据：**判定只有一个出处**。上游 `utils/appSurface.ts` 头部注释写得很直白
// —— "features that only make sense in the main app window … read the same answer instead of
// re-parsing the URL"。本件把 `?wallpaper=1` 加进那一个模块（R203 白名单登记），宿主只读答案；
// 于是"第二处解析"这种形态本身就是违例，会被下面第一组断言当场抓住（变异 M1 验的就是这一刀）。
//
// 六格真值表是**运行时**跑的：这个模块在求值那一刻读 `window.location.search`，
// 所以每格都要换一个模块实例（`?case=` 只是缓存穿透用的查询串，与被测内容无关）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Task 3 那三路的运行时测试：这块是零 import 的自撰模块，自检可以直接驱动它。
import {
  createSurfaceExit,
  surfaceExitTarget,
  SURFACE_PARAM,
  SURFACE_EXIT_LABEL,
} from '../src/folia-host/surface-exit.ts';

const SRC = new URL('../src/', import.meta.url);
const APP_SURFACE = new URL('folia/utils/appSurface.ts', SRC);
const appSurfacePath = fileURLToPath(APP_SURFACE);

/** 逐格换一个模块实例（模块级 `searchParams` 只在求值时读一次 window，同一实例读不到第二格）。 */
async function surfaceFlags(search, pathname = '/') {
  globalThis.window = { location: { search, pathname } };
  return import(pathToFileURL(appSurfacePath).href + '?case=' + encodeURIComponent(search + '|' + pathname));
}

test('R203 ①：六格真值表——不带参数时 isMainAppSurface 仍为 true（判据②），wallpaper 只认 ?wallpaper=1', async () => {
  const none = await surfaceFlags('');
  assert.equal(none.isWallpaperSurface, false, '不带参数不是这个 surface');
  assert.equal(none.isMainAppSurface, true, '缺省仍必须是主应用窗口——老用户零观感变化的判据落在这格');
  assert.equal(none.isObsBrowserSourceSurface, false);
  assert.equal(none.isRemoteControlSurface, false);

  const on = await surfaceFlags('?wallpaper=1');
  assert.equal(on.isWallpaperSurface, true, '?wallpaper=1 必须是这个 surface');
  assert.equal(on.isMainAppSurface, false, '它不是主应用窗口（"只在主窗口有意义的能力"对它一律不成立）');

  // 只认 "1"：?wallpaper=0 / ?wallpaper= 都还是普通页面（沿上游 ?obs=1 / ?remote=1 的同一判据形状）。
  assert.equal((await surfaceFlags('?wallpaper=0')).isWallpaperSurface, false, '?wallpaper=0 不算表态');
  assert.equal((await surfaceFlags('?wallpaper=')).isWallpaperSurface, false, '空值不算表态');

  // 互斥：与上游同一条次序——obs 与 remote 各自排在前面，wallpaper 排最后（不许两个 surface 同时为真）。
  const obsWins = await surfaceFlags('?wallpaper=1&obs=1');
  assert.equal(obsWins.isObsBrowserSourceSurface, true);
  assert.equal(obsWins.isWallpaperSurface, false, 'obs 与 wallpaper 不许同时为真');
  const remoteWins = await surfaceFlags('?wallpaper=1&remote=1');
  assert.equal(remoteWins.isRemoteControlSurface, true);
  assert.equal(remoteWins.isWallpaperSurface, false, 'remote 与 wallpaper 不许同时为真');
});

/** 递归列 src/ 下的源码文件（跳过 node_modules；这一档自检不该看见构建产物）。 */
async function sourceFiles(dir = SRC, sink = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      await sourceFiles(url, sink);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      sink.push(url);
    }
  }
  return sink;
}

test('R203 ②：surface 相关的 URL 解析全仓只有一处（判据①——第二处就是第二个真相）', async () => {
  const files = await sourceFiles();
  const parsers = [];
  const directReads = [];
  for (const url of files) {
    const text = await readFile(url, 'utf8');
    const rel = fileURLToPath(url).replace(/\\/g, '/').split('/src/')[1];
    text.split('\n').forEach((line, index) => {
      // 形态 A：同一行既碰 `wallpaper` 又碰 URL 解析（URLSearchParams / location.search / searchParams）。
      if (/wallpaper/.test(line) && /(URLSearchParams|location\.search|searchParams)/.test(line)) {
        // 移植头里的注释（路径行 / 上游归属）不算解析。
        if (!/^(\/\/|\/?\*)/.test(line.trim())) parsers.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
      if (/(?:get|has)\(\s*['"]wallpaper['"]/.test(line)) directReads.push(`${rel}:${index + 1}`);
    });
  }
  const allowed = 'folia/utils/appSurface.ts';
  for (const hit of parsers) assert.ok(hit.includes(allowed), `第二处解析 ?wallpaper=1：${hit}`);
  for (const hit of directReads) assert.ok(hit.startsWith(allowed), `第二处直接读 wallpaper 参数：${hit}`);
  // 正面钉住"那一处确实在"（只查"别处没有"会被"整格删掉"蒙过去）。
  assert.ok(parsers.some((hit) => hit.startsWith(`${allowed}:`)), '判定必须落在 appSurface.ts 里（这一格现在不存在？）');
});

test('R203 ③：宿主读的是判定、不是参数（appSurface 那一个出处的消费者在案）', async () => {
  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  assert.match(
    host,
    /import\s*\{[^}]*isWallpaperSurface[^}]*\}\s*from\s*["']\.\/folia\/utils\/appSurface["']/,
    '宿主必须从 ./folia/utils/appSurface 取 isWallpaperSurface（自己解析 URL = 第二个真相）',
  );
  assert.ok(/isWallpaperSurface/.test(host), '宿主必须有读者：判定的存在不等于判定被用（R128 那一族）');
});

test('R203 ⑦：三格"喂岛/钉模式/筛命令"的 surface 分支都在，且缺省（主窗口）一格都不生效（判据②）', async () => {
  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  // ① 喂岛的那一格：公式只有一处，且必须被 `isWallpaperSurface` 门住（主窗口恒 false ⇒ 表现逐字节不变）。
  const formula = functionBody(host, 'islandChromeHidden');
  assert.match(formula, /isWallpaperSurface\s*&&/, '外壳读数必须被 surface 门住');
  assert.match(formula, /stage\.dataset\.chrome/, '外壳读数必须读那唯一的空闲计时器状态（不许另起一份时钟）');
  // 两个调用点共用这一个公式：空闲计时器 + 挂载完成（只留一处就会"面板变了、画面没变"，R118/R173 同族）。
  assert.ok(functionBody(host, 'applyChrome').includes('setPlayerChromeHidden(islandChromeHidden())'),
    '空闲计时器（applyChrome）必须推这一格');
  assert.ok(/islandHandle\.setPlayerChromeHidden\(islandChromeHidden\(\)\)/.test(host),
    '岛挂载完成那一次必须补推（新 root 从缺省起步，不补就是"挂载后停在缺省"）');
  // ② `displayMode` 的 surface 分支：真值走 "folia"，缺省仍走原来那条 `resolveDisplayMode(preferences…)`。
  assert.match(host, /let displayMode: DisplayMode = isWallpaperSurface\s*\?\s*"folia"\s*:\s*resolveDisplayMode\(preferences\.displayMode\)/,
    'displayMode 的 surface 分支必须只在 surface 生效（缺省那支一个字不许动）');
  // ③ 命令表：surface 走白名单、主窗口走**原表本身**（不是过滤后的副本 ⇒ 主窗口逐字节不变）。
  assert.match(host, /: commandDefinitions\)/, '命令表缺省分支必须是原表本身（不能被 filter 过一遍）');
  assert.match(host, /commandDefinitions\.filter\(\(command\) => SURFACE_COMMAND_IDS\.has\(command\.id\)\)/,
    'surface 那一支必须走白名单过滤');
  // 白名单是"允许清单"而不是"排除清单"：以后新加一条命令默认**不进**这个 surface（与 R194 同一条道理）。
  const list = host.slice(host.indexOf('const SURFACE_COMMAND_IDS'), host.indexOf('];', host.indexOf('const SURFACE_COMMAND_IDS')));
  assert.ok(!/open-settings|open-playlists|rescan|covers-refresh/.test(list), '白名单里不许出现"开面板/动曲库"那几条');
  for (const id of ['play-pause', 'layout-wall', 'theme-night', 'show-queue']) {
    assert.ok(list.includes(`"${id}"`), `白名单缺了 ${id}（画面与传输那几件事必须留着）`);
  }
  // ④ 岛侧：这一格的**缺省必须是 false**（主窗口表现不变的前提），且卸装要复位
  //   （复位清单由 `check-music-island-feed.mjs` 的 R173 那条钉着，这里不重复钉文本、只钉缺省值）。
  const island = await readFile(new URL('folia-host/island.tsx', SRC), 'utf8');
  const stateDefault = island.slice(island.indexOf('const useIslandUi'), island.indexOf('const AdapterContext'));
  assert.ok(/chromeHidden: false/.test(stateDefault), '岛状态缺省必须 chromeHidden=false（否则主窗口就被改了）');
  assert.match(island, /setPlayerChromeHidden: \(chromeHidden\) => useIslandUi\.setState\(\{ chromeHidden \}\)/,
    '喂料口只写这一处（与 setTunings / setSongLiked 同一形状）');
  assert.match(island, /isPlayerChromeHidden=\{chromeHidden\}/, 'FoliaView 必须把这一格喂给渲染器');
  // ⑤ 挂载通路：这一档必须排在 `displayMode` / `mode` 那两条判据**之前**（排在后面就永远轮不到 ⇒ 岛永不挂载）。
  const wanted = functionBody(host, 'lyricViewWanted');
  assert.ok(
    wanted.indexOf('if (isWallpaperSurface) return true;') < wanted.indexOf('if (displayMode !== "folia") return false;'),
    'surface 那一格必须排在原判据之前（Task 0 §0.4：新载入的页面 data-mode 是 archive，原判据永不放行）',
  );
  // ⑥ `setDisplayMode` 在这一档被钉住：早退必须排在 `savePrefs()` 之前（排在后面就是"从挂屏偷偷改主窗口偏好"）。
  const setModeBody = functionBody(host, 'setDisplayMode');
  assert.ok(setModeBody.indexOf('if (isWallpaperSurface) return') < setModeBody.indexOf('savePrefs()'),
    'setDisplayMode 的 surface 早退必须排在写偏好之前');
});

/** 读出 `stage.innerHTML = \`...\`` 那一段模板（外壳 DOM 的唯一作者）。 */
async function shellTemplate() {
  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  const start = host.indexOf('stage.innerHTML = `');
  assert.ok(start >= 0, '找不到 stage.innerHTML 那段模板（换了写法就要一起来改这条判据，别让它静默失效）');
  const end = host.indexOf('`;', start + 19);
  assert.ok(end > start, '模板的收尾反引号找不到');
  return { host, template: host.slice(start, end) };
}

test('R203 ④：外壳的隐藏只在 CSS 里做（判据①——新增的第二套隐藏逻辑必须为 0）', async () => {
  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  // ① 宿主里 `isWallpaperSurface` 的每一次出现都必须"带条件"：不许与任何隐藏原语同框。
  // 注意 `display` 只认 `display:` / `display =` 这种属性写法——`displayMode` 是那个变量的名字，不是隐藏动作。
  const HIDING = /(\.hidden\s*=|style\.|classList\.|visibility|opacity\s*[:=]|\.remove\(\)|\binert\b|\bdisplay\s*[:=])/;
  const offenders = [];
  host.split('\n').forEach((line, index) => {
    if (!line.includes('isWallpaperSurface')) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line.trim())) return; // 注释不算实现
    if (HIDING.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [], `宿主里出现"按 surface 直接动手隐藏"= 第二套隐藏逻辑：\n${offenders.join('\n')}`);
  // ② 外壳那段模板里不许出现任何按 surface 的分叉：DOM 结构只有一份，隐藏交给 CSS。
  const { template } = await shellTemplate();
  assert.ok(!/isWallpaperSurface|data-surface/.test(template), '模板里出现了 surface 分叉（默认态的 DOM 就不再逐字节不变了）');
});

test('R203 ⑤：常驻隐藏规则在 CSS 那一个出处，且外壳清单逐条点名（少一条就是漏隐）', async () => {
  const css = await readFile(new URL('lyric-folia-chrome.css', SRC), 'utf8');
  // Task 0 §0.3 那张分类表里"该隐藏"的每一格，一条都不许少（这一格防的就是"只隐了顶栏、状态行/面板根还活着"）。
  const SHELL = [
    '.music-header',
    '.music-vignette',
    '#music-browse',
    '#music-detail',
    '.music-progress',
    '.music-bottomline',
    '#music-panel-root',
    '#music-toast',
    '#music-empty',
    '#music-loading',
    '.folia-controls .folia-btn-exit',
  ];
  for (const selector of SHELL) {
    assert.ok(
      css.includes(`#stage[data-surface="wallpaper"] ${selector}`),
      `外壳清单里 ${selector} 没有在该 surface 下常驻隐藏`,
    );
  }
  // 每一条都必须带 `#stage[data-surface="wallpaper"]` 前缀：不带就变成"改了默认态"。
  const block = css.slice(css.indexOf('—— 9. R203'));
  const bare = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[.#][\w .#>-]+\{$/.test(line) && !line.startsWith('#stage[data-surface="wallpaper"]'));
  assert.deepEqual(bare, [], `第 9 段里出现了不带 surface 门控的选择器（默认态会被改掉）：${bare.join(' | ')}`);
  // 该 surface 的读状态那一行只许用既有的 #library-status（Task 4：不许另造一块状态 UI = 第二个作者）。
  assert.ok(
    css.includes('#stage[data-surface="wallpaper"] .library-status'),
    'surface 的可读状态行必须复用 #library-status（作者只有 updateStatus() 那一处）',
  );
});

/**
 * 取一个函数的函数体（按花括号配对数），**不用"往后截 N 个字符"那种窗口**。
 * 第一版就是拿 700 字符当窗口，`refreshPlaybackScope` 的路由名落在窗口之外 ⇒ 判据空转
 * （"没咬"先查跑没跑，再查判据——本仓那条老规矩，这次轮到我自己踩）。
 * 返回的是**去掉整行注释**的那一份（第二版踩到的另一格：给 `setDisplayMode` 写的那条理由里
 * 提到了 `savePrefs()`，于是"早退必须排在写偏好之前"被自己的注释判成违例 ⇒ 判据要落在代码上）。
 */
function functionBody(text, name) {
  const at = text.indexOf(`function ${name}`);
  assert.ok(at >= 0, `找不到 function ${name}`);
  const open = text.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return codeOnly(text.slice(at, i + 1));
    }
  }
  return codeOnly(text.slice(at));
}

/** 只剥**整行**注释（本仓的块注释一律起一行）：不动行内串，免得把 `https://` 那样的字面量截掉。 */
function codeOnly(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/**
 * 函数在**原文坐标**里的区间（`functionBody` 返回的是剥过注释的文本，长度比原文短；
 * 拿它的长度回推原文位置会算错行号——这一格我是被自己那条"状态行只有一个作者"的判据当场拦下来的）。
 */
function functionSpan(text, name) {
  const start = text.indexOf(`function ${name}`);
  assert.ok(start >= 0, `找不到 function ${name}`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return { start, end: text.length };
}

test('R203 ⑥：surface 不发播放器外壳的路由（判据③，三问逐条点名 + 正面钉住 /api/library 保留）', async () => {
  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  const bodies = [
    ['fetchPlaylistShelf', '/api/playlists/shelf'],
    ['refreshReportSetting', '/api/config'],
    ['refreshPlaybackScope', '/api/online/audio-scope'],
  ];
  for (const [name, route] of bodies) {
    const head = functionBody(host, name);
    assert.ok(
      head.includes('if (isWallpaperSurface) return'),
      `${name} 缺 surface 早退（这一问服务的是外壳）`,
    );
    assert.ok(head.includes(`"${route}"`), `${name} 的函数体里应当出现 ${route}（判据别落到空文件上）`);
    // 早退必须在发请求之前（写在 fetch 之后就是死代码）。
    assert.ok(
      head.indexOf('isWallpaperSurface') < head.indexOf(`"${route}"`),
      `${name} 的 surface 早退必须排在请求之前`,
    );
  }
  // 反向一格：曲库那一问是这个 surface 的**数据源**，不许被顺手关掉（run log §0.5 里那条按事实改道的读法 Q80）。
  const load = functionBody(host, 'loadLibrary');
  assert.ok(load.includes('"/api/library"'), '曲库那一问必须保留：没有它岛里没有任何曲目/封面/歌词');
  assert.ok(!/isWallpaperSurface/.test(load), '/api/library 不许被 surface 挡掉');
});

// —— Task 3 · 退出这三路（Esc / 双击 / 角落热点）——
// 这一组是**运行时**跑的：拿一份最小假 DOM 驱动 `createSurfaceExit`，三路各点一次。
// 为什么不写"文件里有没有 addEventListener 那一行"那种静态判据：那种断言查不出
// "这条路按下去到底退不退得出去"（R126 的课：判据要落在那句守卫上；下面 ⑩ 就是被这道守卫救下的一格）。
/** 最小假元素：只实现 `surface-exit` 真正用到的那几格（dataset / class / 监听 / 父子挂载）。 */
function fakeElement(name = "div") {
  const listeners = new Map();
  const el = {
    name,
    children: [],
    parent: null,
    dataset: {},
    attrs: {},
    className: "",
    textContent: "",
    type: "",
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener(type) { listeners.delete(type); },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((item) => item !== this);
      this.parent = null;
    },
    listenerCount: (type) => (listeners.get(type) ?? []).length,
    fire(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
  return el;
}

/** 造一个假页面场景；`activate` 缺省 true（"挂监听"这一步本身也是被测对象）。 */
function fakeScene(options = {}, activate = true) {
  const doc = fakeElement("document");
  doc.createElement = (tag) => fakeElement(tag);
  const host = fakeElement("section");
  host.ownerDocument = doc;
  const calls = { navigate: [], exitFullscreen: 0 };
  const handle = createSurfaceExit(host, {
    location: { search: "?wallpaper=1", pathname: "/", hash: "" },
    navigate: (url) => calls.navigate.push(url),
    exitFullscreen: () => { calls.exitFullscreen += 1; },
    ...options,
  });
  if (activate) handle.activate();
  return { doc, host, calls, handle };
}

/**
 * 造一个"落在这串选择器里某一条上"的事件目标。
 * 注意实现传给 `closest()` 的是**一整串**逗号选择器（`INTERACTIVE`）：
 * 第一版假元素按"逐条等值比较"写 ⇒ 一条都命不中 ⇒ "双击海报不许算退出"那条断言空转（自己踩到的）。
 */
const targetOn = (token) => ({
  closest: (selector) => (selector.split(",").some((one) => one.trim() === token) ? { token } : null),
});

test("R203 ⑧：退出三路各点一次都真退（Esc / 双击画面 / 角落热点），且各自只导航一次", () => {
  const viaKey = fakeScene();
  viaKey.doc.fire("keydown", { key: "Escape" });
  assert.deepEqual(viaKey.calls.navigate, ["/"], "Esc 必须退出去");
  assert.equal(viaKey.calls.exitFullscreen, 1, "退出要按需退全屏（顺序：先全屏、再导航）");

  const viaDoubleClick = fakeScene();
  viaDoubleClick.host.fire("dblclick", { target: { closest: () => null } });
  assert.deepEqual(viaDoubleClick.calls.navigate, ["/"], "双击画面必须退出去");

  const viaHotspot = fakeScene();
  const spot = viaHotspot.handle.hotspot();
  assert.ok(spot, "activate 必须在角上放那颗热点");
  spot.fire("click", { button: 0 });
  assert.deepEqual(viaHotspot.calls.navigate, ["/"], "角落热点必须退出去");

  // 三路共用同一个 exit() ⇒ 一次动作只有一次导航（两份导航=两份迟早漂）。
  for (const scene of [viaKey, viaDoubleClick, viaHotspot])
    assert.equal(scene.calls.navigate.length, 1, "一次动作不许导航两次");
});

test("R203 ⑨：三个不该退的条件（按键不是 Esc / 双击落在交互元件上 / 热点只认左键 / 读不出落点）", () => {
  const otherKey = fakeScene();
  otherKey.doc.fire("keydown", { key: "a" });
  otherKey.doc.fire("keydown", { key: "F11" });
  assert.deepEqual(otherKey.calls.navigate, [], "只认 Esc 那一键");

  // 封面墙的海报是 div[role=button]（一手读 LatticePoster.tsx:229-231：onClick + role=button/group）
  // ⇒ 双击它是一次真动作，不许当成退出（R121 那一族："这次点击还有没有主人"）。
  for (const token of ["button", "a", "input", "[role=button]", "[role=tab]",
    ".folia-controls", "#command-palette", "[data-surface-exit]"]) {
    const scene = fakeScene();
    scene.host.fire("dblclick", { target: targetOn(token) });
    assert.deepEqual(scene.calls.navigate, [], "双击落在 " + token + " 上不许算退出");
  }

  const rightButton = fakeScene();
  rightButton.handle.hotspot().fire("click", { button: 2 });
  assert.deepEqual(rightButton.calls.navigate, [], "右键不许触发退出");

  // 读不出落点（文本节点 / null）：按"不是退出"处理，别拿异常当退出。
  const odd = fakeScene();
  odd.host.fire("dblclick", { target: null });
  assert.deepEqual(odd.calls.navigate, [], "读不出落点就不动（宁可不退，也不误退）");
});

test("R203 ⑩：blocked 时三路一律不动作；挡开之后立刻恢复（面板那颗 Esc 已有主人，R134 那一课）", () => {
  let blocked = true;
  const scene = fakeScene({ blocked: () => blocked });
  scene.doc.fire("keydown", { key: "Escape" });
  scene.host.fire("dblclick", { target: { closest: () => null } });
  scene.handle.hotspot().fire("click", { button: 0 });
  assert.deepEqual(scene.calls.navigate, [], "被挡住时一条都不许动");
  assert.equal(scene.calls.exitFullscreen, 0, "挡住时连全屏都不该动（动作整个不发生）");
  blocked = false;
  scene.doc.fire("keydown", { key: "Escape" });
  assert.deepEqual(scene.calls.navigate, ["/"], "挡开之后 Esc 要能退（一次误判不该永久失灵）");
});

test("R203 ⑪：activate 幂等、dispose 真摘干净、退不了全屏（或没有这能力）也照样退得出", () => {
  const scene = fakeScene();
  scene.handle.activate();
  scene.handle.activate();
  assert.equal(scene.host.children.length, 1, "重复 activate 不许放两颗热点");
  assert.equal(scene.doc.listenerCount("keydown"), 1, "重复 activate 不许重复挂监听");

  scene.handle.dispose();
  assert.equal(scene.host.children.length, 0, "dispose 必须收掉热点");
  assert.equal(scene.doc.listenerCount("keydown"), 0, "dispose 必须摘掉按键监听");
  scene.doc.fire("keydown", { key: "Escape" });
  scene.host.fire("dblclick", { target: { closest: () => null } });
  assert.deepEqual(scene.calls.navigate, [], "dispose 之后三条路都不该再生效");

  // 没有全屏可退、或浏览器一口回绝，都不是拦住退出的理由：退不出去才是这一节要避免的事故。
  const throwing = fakeScene({
    exitFullscreen: () => { throw new Error("no fullscreen to exit"); },
  });
  throwing.handle.exit();
  assert.deepEqual(throwing.calls.navigate, ["/"], "exitFullscreen 抛错也要导航");

  const refused = fakeScene({
    exitFullscreen: () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); },
  });
  refused.handle.exit();
  assert.deepEqual(refused.calls.navigate, ["/"], "浏览器拒绝退全屏也要导航");
});

test("R203 ⑫：退出落点是纯函数——只摘掉 wallpaper 那一格，其余参数与 hash 一律保留，且必是同源相对地址", () => {
  const cases = [
    [{ search: "?wallpaper=1", pathname: "/" }, "/"],
    [{ search: "?wallpaper=1&lighting=baseline", pathname: "/" }, "/?lighting=baseline"],
    [{ search: "?nav=previous&wallpaper=1&scene=archive", pathname: "/" }, "/?nav=previous&scene=archive"],
    [{ search: "?wallpaper=1", pathname: "/", hash: "#top" }, "/#top"],
    [{ search: "", pathname: "/any/path" }, "/any/path"],
    [{ search: "?wallpaper=1&obs=1", pathname: "/" }, "/?obs=1"],
    // 同源红线。下面这三格是**先写断言、后被断言拦下实现**的：第一版只夹"不以 / 开头"，
    // 于是 `//evil.example` 那种协议相对地址被原样当成退出落点 ⇒ 实现补上"也不许以 // 开头"。
    [{ search: "?wallpaper=1", pathname: "//evil.example" }, "/"],
    [{ search: "?wallpaper=1", pathname: "https://evil.example/" }, "/"],
    [{ search: "?wallpaper=1", pathname: "evil.example/x" }, "/"],
  ];
  for (const entry of cases) {
    assert.equal(surfaceExitTarget(entry[0]), entry[1],
      JSON.stringify(entry[0]) + " 应该退到 " + entry[1]);
  }
  // 参数名只有一个出处：判读在 appSurface.ts、删除在这一格（不许出现第二个名字）。
  assert.equal(SURFACE_PARAM, "wallpaper");
});

test("R203 ⑬：界面上不叫「壁纸模式」（Q53 执行侧意见落地，等验收侧确认）", async () => {
  assert.equal(SURFACE_EXIT_LABEL, "退出沉浸（浏览器内）", "那颗热点的字与 aria-label 逐字钉住");
  assert.ok(!SURFACE_EXIT_LABEL.includes("壁纸"), "界面文案不许出现「壁纸」");
  // 用户能看到的**字符串字面量**里不许有"壁纸"二字（注释与 URL 参数名不上屏，不算）。
  for (const rel of ["folia-host/surface-exit.ts", "music-app.ts", "folia-host/island.tsx"]) {
    const text = codeOnly(await readFile(new URL(rel, SRC), "utf8"));
    const offenders = [...text.matchAll(/(["'`])([^"'`\n]*壁纸[^"'`\n]*)\1/g)].map((m) => m[2]);
    assert.deepEqual(offenders, [], rel + " 的界面字符串里出现了「壁纸」：" + offenders.join(" | "));
  }
  // 那颗热点只有一个制造者：宿主不另造第二颗、也不自己写第二句退出话。
  const host = await readFile(new URL("music-app.ts", SRC), "utf8");
  assert.ok(!/createElement\("button"\)/.test(host), "宿主不许另造一颗退出按钮（第二套退出 UI）");
  // 只许**一次调用**（那条 import 不带括号，不会被这个式子计进来）：两处调用就是两颗热点。
  assert.equal([...host.matchAll(/createSurfaceExit\(/g)].length, 1,
    "宿主里 createSurfaceExit 只许调用一次（那颗热点只有一个制造者）");
  // 悬停热点不收起 chrome 这一格必须在（否则"慢慢把指针移到角上准备退出"会让那颗自己淡掉）。
  assert.match(host, /keepOpen:[\s\S]{0,240}\.folia-surface-exit:hover/,
    "chromeReveal 的 keepOpen 必须把这颗热点也算进悬停不收起");
  const css = await readFile(new URL("lyric-folia-chrome.css", SRC), "utf8");
  assert.ok(css.includes("#stage[data-surface=\"wallpaper\"] .folia-surface-exit"),
    "热点的样式必须挂在这一档的门控下（默认态不许多出东西）");
});

// —— Task 4 · 空态与失败态：不许黑屏、不许静默 ——
// 这一档将来是挂在墙上的：出问题时的"一句话"是它唯一的自我说明渠道（没人会去开控制台）。
// 三条讲究：① **作者只有一处**（`updateStatus()`）、**载体只有一个元素**（既有那行 `#library-status`）
// ——不另造一块状态 UI 就是不开第二个真相（R128"接口的存在不等于接口被用"那一族的反面：别再造一套）；
// ② surface 那几格必须排在既有缺省格**之前**（缺省格是 `""`＝隐行，写在它后面永远读不到）；
// ③ 岛挂载失败那条降级路径是既有的，但"回落了"这件事必须**跟着刷新一次状态行**才说得出（否则只写在 data 属性上）。
test("R203 ⑭：三种画不出东西的状态各有一句话说得出，且状态行只有一个作者、一个载体", async () => {
  const host = await readFile(new URL("music-app.ts", SRC), "utf8");
  const status = functionBody(host, "updateStatus");
  // ① 后端未就绪：既有那一格仍在**最前**（它一旦排到 surface 分支之后，服务坏时就会被后面的话盖掉）。
  assert.ok(status.indexOf('"本地音乐服务尚未连接"') < status.indexOf("isWallpaperSurface"),
    "「本地音乐服务尚未连接」必须排在所有 surface 分支之前");
  // ② 岛没挂上 / 曲库空的 / 被要求切演出模式：三格都在，都带 `isWallpaperSurface` 门，都在缺省那格之前。
  const cases = [
    ['islandState === "failed"', "画面组件没能加载"],
    ["!library.albums.length", "本地曲库还没有专辑"],
    ["pinned", "不切换演出/歌词模式"],
  ];
  for (const [guard, phrase] of cases) {
    // 判据落在"这一格确实被 `isWallpaperSurface` 开头短路"上：门与条件之间不许有别的东西插进来
    // （第一版我是"从条件那段往后截 400 字符再找门"⇒ 门在截取的起点**之前**，判据永远不可能满足）。
    const at = status.indexOf(`isWallpaperSurface && ${guard}`);
    assert.ok(at >= 0, `状态行少了这一格（或它没被 isWallpaperSurface 门住）：${guard}`);
    const branch = status.slice(at, at + 400);
    assert.ok(branch.includes(phrase), `${guard} 那一格说的话里缺「${phrase}」`);
    assert.ok(status.indexOf("演示专辑 · 加入音乐后显示真实封面") > at,
      `${guard} 那一格必须排在缺省那格（demo/""）之前，否则永远读不到`);
  }
  // ③ 岛失败要**当场**把这句话刷出来（既有 catch 只往 data-fallback 写原文，那不说话）。
  const failAt = host.indexOf('islandState = "failed"');
  assert.ok(failAt >= 0 && /updateStatus\(\);/.test(host.slice(failAt, failAt + 500)),
    "岛挂载失败的分支里必须补一次 updateStatus()：降级路径在跑，但没人把那句话说到屏幕上");
  // ③b 但那句话**只许报一次**：`syncFoliaIsland` 的既有形状是"状态不是 on/loading 就再试一次"，
  //     而帧循环每帧都问 ⇒ failed 之后每帧都会进 catch。不设闸就是每帧重写状态行（无人值守挂久了白烧）。
  const guard = host.slice(failAt, failAt + 500);
  assert.ok(/if \(!islandFailureAnnounced\) \{/.test(guard),
    "岛失败那句必须有一道「只报一次」的闸（否则帧循环会把状态行每帧重写）");
  assert.ok(/islandFailureAnnounced = true;\s*\n\s*updateStatus\(\);/.test(guard),
    "闸要在报之前落下（报完才置位就是自己拦不住自己）");
  const mountOk = host.slice(host.indexOf('islandState = "on";'), host.indexOf('islandState = "on";') + 400);
  assert.ok(/islandFailureAnnounced = false/.test(mountOk),
    "挂载成功要把闸重新打开：下一次真再挂不上时，那句话还得能再说一遍");
  // ④ 状态行只有一个作者：`#library-status` 的写入只许出现在 updateStatus 的函数体里。
  const writers = [];
  host.split("\n").forEach((line, index) => {
    if (!/library-status/.test(line)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line.trim()) || line.includes("<div id=\"library-status\"")) return;
    writers.push(index + 1);
  });
  const span = functionSpan(host, "updateStatus");
  const lineOf = (i) => host.slice(0, i).split("\n").length;
  const first = lineOf(span.start);
  const last = lineOf(span.end);
  const outside = writers.filter((line) => line < first || line > last);
  assert.deepEqual(outside, [], `状态行出现了第二个作者：第 ${outside.join(", ")} 行（这一行只归 updateStatus 写）`);
  assert.ok(writers.length >= 1, "状态行一个作者都没有？那这几句话谁也读不到");
  // ⑤ 不另造第二块状态 UI：宿主不许 createElement 一个状态元素，载体就是既有那一行。
  assert.ok(!/createElement\("aside"\)|surface-status|statusLine/.test(host),
    "不许为这一档另造第二块状态 UI（第二个作者迟早与 updateStatus 漂）");
  // ⑥ 一次性那句（被拒的演出/歌词切换）：读过就清，且**不另起计时器**（计时器是第二个真相）。
  const pinnedAt = status.indexOf("displayModePinnedNotice = false");
  assert.ok(pinnedAt >= 0 && pinnedAt < status.indexOf("const label"),
    "displayModePinnedNotice 要在算 label 之前读并清掉（一句话只说一次，不留常驻）");
  assert.equal([...host.matchAll(/setTimeout\(\s*\(\)\s*=>\s*updateStatus/g)].length, 0,
    "清这句话不许靠一个新计时器（那既是第二个真相，也拦不住用户连按）");
});

// —— 判据⑤ · 零新增出网：主机表与白名单零改动，这里给可机检的对应物 ——
/**
 * 这是一份**快照**：把守卫里那十张按用途分表的主机名逐字钉住。
 * 本件的口径是"这一档是纯显示特性，一条出网都不该新增"（方案 §四.3），
 * 可机检的对应物就得是快照本身——往里加一个名字会当场红，逼来人补 R 号与一手实测理由
 * （那些表的注释里每张都写着"这个名字是一手实测换来的"，快照替这句话守门）。
 * 以后真要加主机：改这张快照**必须和加白名单同一笔提交**，且带 R 号，否则只改代码不改快照也是红。
 */
const EGRESS_TABLES = {
  LYRICS_HOSTS: ['amll-ttml-db.stevexmh.net', 'u.y.qq.com'],
  METADATA_HOSTS: ['en.wikipedia.org', 'musicbrainz.org', 'www.wikidata.org', 'zh.wikipedia.org'],
  INTRODUCTION_HOSTS: ['en.wikipedia.org', 'www.wikidata.org', 'zh.wikipedia.org'],
  AUDIO_HOSTS: {
    // R221（2026-10-14）加的后两个名字 = 酷狗**网页档**那台 CDN 的一手实测：
    // TLS 握手 TLSv1.3 + 一次 4KB Range 读头 ⇒ HTTP 206、`content-range` 总长与响应 `fileSize` 逐位相等。
    // 与本快照同笔提交改（这张表就是"加名字要逼来人补 R 号与实测理由"那一道门）。
    exact: ['aqqmusic.tc.qq.com', 'fsandroid.kugou.com', 'sharefs.kugou.com', 'sharefs.tx.kugou.com'],
    suffix: ['.music.126.net', '.stream.qqmusic.qq.com'],
  },
  AUTH_HOSTS: { exact: ['api.tencentmusic.com', 'u.y.qq.com'], suffix: [] },
  COVER_HOSTS: { exact: ['archive.org', 'itunes.apple.com'], suffix: ['.mzstatic.com'] },
  TRACK_COVER_HOSTS: {
    exact: ['p1.music.126.net', 'p2.music.126.net', 'p3.music.126.net', 'p4.music.126.net', 'y.gtimg.cn'],
    suffix: [],
  },
  SHORTLINK_HOSTS: { exact: ['t1.kugou.com'], suffix: [] },
  SHARE_HOSTS: { exact: ['m.kugou.com'], suffix: [] },
  // R221：酷狗**网页取址**那一跳的专用表。名字与上一张相同、用途不同，所以是**两张表**
  // （共表等于让分享页那一路白得音频用途的余地）。它一样受"加名字要带实测理由"这道门管。
  KUGOU_PLAYINFO_HOSTS: { exact: ['m.kugou.com'], suffix: [] },
  PLAYLIST_HOSTS: ['c.y.qq.com'],
};

test('R203 ⑮：出网面只许与快照逐字相同（加名字要同一笔提交带 R 号与实测理由；R221 就是这么加的两个）——且这一档自己的新代码根本没有出网那格能力', async () => {
  const guard = await import('../scripts/online-guard.mjs');
  const sorted = (set) => [...set].sort();
  for (const [name, expected] of Object.entries(EGRESS_TABLES)) {
    const actual = guard[name];
    assert.ok(actual, `守卫里找不到 ${name} 这张表（改名要一起来改这条，别让它静默空转）`);
    if (Array.isArray(expected)) {
      assert.deepEqual(sorted(actual), expected, `${name} 这张主机表与快照不一致（本件口径：零新增）`);
    } else {
      assert.deepEqual(sorted(actual.exact), expected.exact, `${name}.exact 与快照不一致`);
      assert.deepEqual(sorted(actual.suffix), sorted(expected.suffix), `${name}.suffix 与快照不一致`);
    }
  }
  // 这一档自己的代码：**不是"没调用出网"，是根本没有那个 API**（少一层"哪天顺手加一跳"的空间）。
  for (const rel of ['folia-host/surface-exit.ts', 'folia/utils/appSurface.ts']) {
    const text = codeOnly(await readFile(new URL(rel, SRC), 'utf8'))
      // 测试里那几个 evil.example 是本判据的对照物，不该出现在被测源码里；出现就是实现有问题。
      .replace(/export /g, 'export ');
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'import('])
      assert.ok(!text.includes(forbidden), `${rel} 出现了 ${forbidden}——这一档只画东西，不该带任何出网能力`);
    assert.ok(!/["']https?:\/\//.test(text), `${rel} 出现了绝对地址字面量（退出落点只许是同源相对路径）`);
  }
  // 判定那块必须仍然零依赖（它一旦被加上 import，主入口就跟着多背一块，R53 的逐字面也一起变味）。
  const surfaceText = await readFile(APP_SURFACE, 'utf8');
  const body = surfaceText.replace(/^\/\*\*[\s\S]*?\*\//, "");
  assert.ok(!/^\s*import\s/m.test(body), "appSurface.ts 除了移植头之外不许出现 import（上游那份就是零依赖）");
});

test("R203 ⑯：这一档不走开场镜头（真机抓到的两处：外壳按钮浮在画上 + 遮罩吃掉 Esc 与空格）", async () => {
  const host = await readFile(new URL("music-app.ts", SRC), "utf8");
  // 走的是既有的那一条"立即显示档案架"的路（与 `?scene=archive` 同一条），不新造跳过逻辑。
  assert.match(host,
    /const skipOpening = isWallpaperSurface\s*\|\|\s*new URLSearchParams\(location\.search\)\.get\("scene"\) === "archive";/,
    "开场镜头的开关必须写成「isWallpaperSurface || 既有那条 scene=archive」（沿用既有通路，且这两格各占一行）");
  assert.match(host, /if \(albums\.length && !skipOpening\) \{\s*\n\s*boot\?\.start\(/,
    "boot?.start() 必须只被这一个开关管着（两处各判一份迟早漂）");
  assert.equal([...host.matchAll(/boot\?\.start\(/g)].length, 1, "只许一处起开场镜头");
  // 换曲要重算那一行：否则"还没有歌在播"那句话会一直挂着（它说的是当前状态，不是历史）。
  const sync = functionBody(host, "syncTransportControls");
  const idChange = sync.slice(sync.indexOf("favoriteTrackId = state.currentTrack"));
  assert.ok(/if \(isWallpaperSurface\) updateStatus\(\);/.test(idChange),
    "换曲那一格里要补一次 updateStatus()（只在 surface）：那句话得跟着曲目走");
  const status = functionBody(host, "updateStatus");
  assert.ok(/isWallpaperSurface && !player\.state\.currentTrack/.test(status),
    "缺「没在播」那一格：有曲库、没按播放时屏幕上只剩一片糊底，没人知道它在等什么");
});

// ─────────────── R206 ③ · 歌词面右下那颗「沉浸全屏」 ───────────────

import { createImmersiveToggle, IMMERSIVE_ENTER_LABEL, IMMERSIVE_EXIT_LABEL, IMMERSIVE_SURFACE_VALUE } from '../src/folia-host/immersive.ts';

/** 假全屏：三种失败形态都造得出来（抛错 / reject / 根本没有这个 API）。 */
function fakeFullscreen({ mode = 'ok', active = false } = {}) {
  const calls = { request: 0, release: 0, subscribe: 0 };
  let handler = null;
  const state = { active };
  return {
    calls,
    state,
    fullscreen: {
      request() {
        calls.request += 1;
        if (mode === 'throw') throw new Error('全屏被拒');
        if (mode === 'reject') return Promise.reject(new Error('not allowed'));
        if (mode === 'none') return undefined;
        state.active = true;
        return Promise.resolve();
      },
      release() {
        calls.release += 1;
        state.active = false;
      },
      active: () => state.active,
      subscribe(fn) {
        calls.subscribe += 1;
        handler = fn;
        return () => { handler = null; };
      },
    },
    fire() { handler?.(); },
  };
}

function fakeImmersiveHost() {
  const doc = fakeElement('document');
  doc.createElement = (tag) => fakeElement(tag);
  const host = fakeElement('section');
  host.ownerDocument = doc;
  return { doc, host };
}

test('R206 ③-1：那颗按钮在歌词面右下的**唯一出处**（宿主只挂一次，别处不许再造一颗）', async () => {
  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  const module = await readFile(new URL('folia-host/immersive.ts', SRC), 'utf8');
  assert.equal((host.match(/createImmersiveToggle\(/g) ?? []).length, 1, '宿主里挂这颗按钮只许一处');
  assert.match(host, /immersive\.activate\(\)/, '挂上这一步必须真调用（接口的存在不等于接口被用）');
  assert.match(host, /documentFullscreenAdapter\(document\)/, '全屏走模块给的那份适配器，不在宿主里另写一份 requestFullscreen');
  const offenders = [];
  for (const entry of await readdir(new URL('folia-host/', SRC))) {
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (entry === 'immersive.ts') continue;
    const text = await readFile(new URL(`folia-host/${entry}`, SRC), 'utf8');
    if (text.includes('folia-immersive-toggle')) offenders.push(entry);
  }
  assert.deepEqual(offenders, [], '同名元素只许 immersive.ts 一个作者');
  assert.match(module, /className = 'folia-immersive-toggle'/, '那颗按钮的 class 在模块里钉住');
  // 默认态（既不是壁纸也没开沉浸）不许留下这个属性：判据② 的"属性缺席"要逐字成立
  assert.match(host, /else delete stage\.dataset\.surface;/, '退出沉浸要**删掉**属性，不是写一个空串');
  assert.match(host, /if \(isWallpaperSurface\) return;/, '壁纸那一档不挂这颗（两头不抢同一个属性）');
});

test('R206 ③-2：进入后让位的外壳逐格点名 —— 与壁纸那一档同一批，唯一差别是那颗有主人的「演出」按钮', async () => {
  const css = await readFile(new URL('lyric-folia-chrome.css', SRC), 'utf8');
  const PREFIX = '#stage[data-surface="immersive"] ';
  const SHELL = [
    '.music-header',
    '.music-vignette',
    '#music-browse',
    '#music-detail',
    '.music-progress',
    '.music-bottomline',
    '#music-panel-root',
    '#music-toast',
    '#music-empty',
    '#music-loading',
  ];
  for (const selector of SHELL) {
    assert.ok(css.includes(`${PREFIX}${selector}`), `沉浸这一档漏隐了 ${selector}（少一条就是"顶栏还在、别的没了"那种割裂态）`);
  }
  // 唯一允许的差别：壁纸档隐、这一档**不隐**的那颗（这一档里它是活的）
  assert.ok(!css.includes(`${PREFIX}.folia-controls .folia-btn-exit`),
    '沉浸这一档不许隐「演出」那颗 —— 这一档 data-display 是活的，那颗按钮有主人');
  assert.ok(css.includes('#stage[data-surface="wallpaper"] .folia-controls .folia-btn-exit'),
    '壁纸那一档那一条原样在册（本件不改上一档）');
  // 底部中间那条控制条与歌词面本身都不许被隐（这就是"只留它"那一格）
  for (const keep of ['.folia-controls', '#lyric-stage', '#folia-island']) {
    assert.ok(!css.includes(`${PREFIX}${keep}`), `${keep} 是这一档要**留下**的东西，不许出现在隐藏清单里`);
  }
  const block = css.slice(css.indexOf('—— 11. R206'));
  const bare = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[.#][\w .#>-]+\{$/.test(line) && !line.startsWith('#stage[data-surface=') && !line.startsWith('#stage[data-display='));
  assert.deepEqual(bare, [], `第 11 段里出现了不带门控的选择器（默认态会被改掉）：${bare.join(' | ')}`);
  assert.match(css, /\[data-chrome="off"\] \.folia-immersive-toggle/,
    '静息淡出那一趟不许把出口一起淡掉（与 R203 把热点加进 keepOpen 同一条理由）');
});

test('R206 ③-3：进入 / 退出逐项还原 —— 挂的那一格只有 true→false 两个值，属性交回宿主写', () => {
  const { host } = fakeImmersiveHost();
  const written = [];
  const fake = fakeFullscreen({ mode: 'ok' });
  const changes = [];
  const handle = createImmersiveToggle(host, {
    fullscreen: fake.fullscreen,
    onSurfaceChange: (on) => written.push(on ? IMMERSIVE_SURFACE_VALUE : null),
    onChange: (on) => changes.push(on),
  });
  handle.activate();
  assert.equal(handle.isOn(), false, '没点之前不许是沉浸态（默认态逐字节不变的前提）');
  assert.equal(host.children.length, 1, 'activate 挂一颗按钮');
  handle.activate();
  assert.equal(host.children.length, 1, '幂等：重复 activate 不许挂第二颗');
  assert.equal(fake.calls.subscribe, 1, '全屏变化只订一次');

  assert.equal(handle.toggle(), true, '点第一下进入');
  assert.deepEqual(written, [IMMERSIVE_SURFACE_VALUE], '进入 = 把这一档交回宿主写那一个属性');
  assert.deepEqual(changes, [true]);
  const button = handle.button();
  assert.equal(button.textContent, IMMERSIVE_EXIT_LABEL, '那颗按钮自己要说得出"退出"');
  assert.equal(button.dataset.immersiveOn, '1');

  assert.equal(handle.toggle(), false, '再点一次退出');
  assert.deepEqual(written, [IMMERSIVE_SURFACE_VALUE, null], '退出要把那一格**交回去**（不是留在 immersive 上）');
  assert.equal(fake.calls.release, 1, '退出顺带把全屏按下来');
  assert.equal(button.textContent, IMMERSIVE_ENTER_LABEL, '文案回到进入前那句');

  // 浏览器自己退的那一趟（用户按 Esc 退全屏）⇒ fullscreenchange 带着还原
  handle.toggle();
  fake.state.active = false;
  fake.fire();
  assert.equal(handle.isOn(), false, '全屏被浏览器自己退掉时外壳跟着还原（不另起按键监听、不抢 Esc）');
  assert.deepEqual(written, [IMMERSIVE_SURFACE_VALUE, null, IMMERSIVE_SURFACE_VALUE, null]);

  handle.dispose();
  assert.equal(host.children.length, 0, 'dispose 要把按钮摘干净');
});

test('R206 ③-4：全屏拿不到也要能进 —— 抛错 / reject / 根本没有这个 API 三格都不许把整颗按钮变成死的', () => {
  for (const mode of ['throw', 'reject', 'none']) {
    const { host } = fakeImmersiveHost();
    const fake = fakeFullscreen({ mode });
    const written = [];
    const handle = createImmersiveToggle(host, {
      fullscreen: fake.fullscreen,
      onSurfaceChange: (on) => written.push(on),
    });
    handle.activate();
    assert.equal(handle.toggle(), true, `${mode}：全屏那一格失败不拦沉浸（拦了就是"因为拿不到全屏所以整颗按钮没用"）`);
    assert.deepEqual(written, [true], `${mode} 之后仍然出得来（第二下必须能退）`);
    assert.equal(handle.toggle(), false, `${mode}：退出这一格同样成立`);
  }
  const bare = fakeImmersiveHost();
  const handle = createImmersiveToggle(bare.host, { onSurfaceChange: () => {} });
  handle.activate();
  assert.equal(handle.toggle(), true, '连 fullscreen 适配器都不给（非浏览器环境）也不许抛');
  handle.dispose();
});

test('R206 ③-5：命名沿 Q53 —— 叫「沉浸全屏」并明写窗口内，不许蹭「壁纸模式」那个名字', () => {
  assert.ok(IMMERSIVE_ENTER_LABEL.includes('沉浸全屏'), '这一档在界面上叫「沉浸全屏」');
  assert.ok(IMMERSIVE_ENTER_LABEL.includes('窗口内'), '必须与第三期那个真壁纸分开（文案写清是窗口内全屏）');
  assert.doesNotMatch(IMMERSIVE_ENTER_LABEL, /壁纸/, '不许出现"壁纸"字样（两件事两个名字）');
  assert.doesNotMatch(IMMERSIVE_EXIT_LABEL, /壁纸/, '退出那句同样');
  assert.equal(IMMERSIVE_SURFACE_VALUE, 'immersive', '挂到 data-surface 上的值');
});

// ─────────────── R206 ④ · 窄窗口时顶栏收敛 ───────────────

import {
  TOPBAR_HIDDEN,
  TOPBAR_HIDDEN_COMMANDS,
  TOPBAR_MEDIUM_MIN_WIDTH,
  TOPBAR_WIDE_MIN_WIDTH,
  topbarHiddenEntries,
  topbarTier,
} from '../src/topbar-tiers.ts';

/** 顶栏里那颗元素的标识 → CSS 里那条收起它的选择器（对表用）。 */
const TOPBAR_SELECTOR_FOR = {
  "mode-switch": '#stage[data-topbar="TOP"] .music-topnav .mode-switch',
  playlists: '#stage[data-topbar="TOP"] .music-topnav > button[data-action="playlists"]',
  favorites: '#stage[data-topbar="TOP"] .music-topnav > button[data-action="favorites"]',
};

test('R206 ④-1：阈值与清单只有一个出处（CSS 里不许再写一遍数字，宿主只写那一个属性）', async () => {
  assert.equal(TOPBAR_WIDE_MIN_WIDTH, 1240, '宽档下界');
  assert.equal(TOPBAR_MEDIUM_MIN_WIDTH, 1024, '中档下界');
  assert.equal(topbarTier(1240), 'wide');
  assert.equal(topbarTier(1239), 'medium', '差 1 px 就该换档（阈值是这一格唯一的判据）');
  assert.equal(topbarTier(1024), 'medium');
  assert.equal(topbarTier(1023), 'narrow');
  assert.equal(topbarTier(0), 'wide', '宽度量不到时按宽档 —— 不许因为读不到就乱收东西');
  assert.equal(topbarTier(Number.NaN), 'wide');
  assert.deepEqual(topbarHiddenEntries('wide'), [], '宽档恒为空');

  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  assert.equal((host.match(/dataset\.topbar/g) ?? []).length, 1, '档位只许写进那一个属性的那一处');
  assert.match(host, /stage\.dataset\.topbar = topbarTier\(stage\.clientWidth\)/, '读的是**窗口**宽度（clientWidth），不是屏幕宽度');
  assert.match(host, /syncTopbarTier\(\);/, '启动那一趟也要定一次档（不能只在 resize 里）');

  const css = await readFile(new URL('music.css', SRC), 'utf8');
  const block = css.slice(css.indexOf('R206 ④ · 窄窗口'));
  assert.ok(block.length > 0, 'CSS 里那一段要在');
  assert.ok(!/1240|1024/.test(block.split('}').slice(1).join('}')), 'CSS 里不许再写一遍阈值数字（两处数字迟早漂）');
});

test('R206 ④-2：三档各自收哪几项逐格点名 —— 清单与 CSS 双向对表（少一条漏隐，多一条越权）', async () => {
  const css = await readFile(new URL('music.css', SRC), 'utf8');
  for (const tier of ['medium', 'narrow']) {
    for (const entry of TOPBAR_HIDDEN[tier]) {
      const selector = TOPBAR_SELECTOR_FOR[entry]?.replace(/TOP/g, tier);
      assert.ok(selector, `${entry} 没有登记对应的选择器写法（清单与 CSS 之间要有映射才能对表）`);
      assert.ok(css.includes(selector), `${tier} 档该收 ${entry}，CSS 里没有那条 ⇒ 漏隐`);
    }
  }
  // 反向：那一段里不许收清单之外的东西（四条选择器写在同一个规则块里 ⇒ 按**行**数，不按规则块数）
  const rules = css
    .split('\n')
    .map((line) => line.trim().replace(/[,{]\s*$/, '').trim())
    .map((line) => ({ match: /^#stage\[data-topbar="(medium|narrow)"\]\s+\S.*$/.exec(line), line }))
    .filter((item) => item.match)
    .map((item) => ({ tier: item.match[1], selector: item.line }));
  assert.equal(rules.length, 4, `那一段应当恰好四条（中 1 + 窄 3），实际 ${rules.length} 条`);
  for (const rule of rules) {
    const entry = Object.keys(TOPBAR_SELECTOR_FOR).find(
      (key) => rule.selector === TOPBAR_SELECTOR_FOR[key].replace(/TOP/g, rule.tier),
    );
    assert.ok(entry, `CSS 里冒出一条清单之外的规则：${rule.selector}`);
    assert.ok(TOPBAR_HIDDEN[rule.tier].includes(entry), `${rule.tier} 档不该收 ${entry}`);
  }
});

test('R206 ④-3：被收掉的每一项都有一条命令面板出路（无路可走就不许收）', async () => {
  const host = await readFile(new URL('music-app.ts', SRC), 'utf8');
  const commands = [...host.matchAll(/\{\s*id: "([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(commands.length > 10, '命令表要读得出来（读不出来这条判据就是空转）');
  for (const tier of ['medium', 'narrow']) {
    for (const entry of TOPBAR_HIDDEN[tier]) {
      const routes = TOPBAR_HIDDEN_COMMANDS[entry];
      assert.ok(Array.isArray(routes) && routes.length > 0, `${entry} 被收掉了却没有任何命令出路（无路可走 = 违本件判据）`);
      for (const id of routes) {
        assert.ok(commands.includes(id), `${entry} 登记的出路 ${id} 不在命令表里 ⇒ 那条路是假的`);
      }
    }
  }
  // 反向：登记了出路却没被收的项不算错，但清单里不许出现没登记的名字
  for (const entry of Object.keys(TOPBAR_HIDDEN_COMMANDS)) {
    assert.ok(Object.prototype.hasOwnProperty.call(TOPBAR_SELECTOR_FOR, entry), `${entry} 登记了出路却没有对应的选择器`);
  }
});

test('R206 ④-4：宽档与今天逐字节相同（不是"收了一份空清单"，而是那一条规则根本不存在）', async () => {
  const css = await readFile(new URL('music.css', SRC), 'utf8');
  assert.ok(!css.includes('[data-topbar="wide"]'), '宽档不许有自己的规则 —— 有就等于改了默认态');
  assert.deepEqual(topbarHiddenEntries('wide'), []);
  // 已有那两条 @media（1100 / 700）原样在册：本件不顺手改它们
  assert.ok(css.includes('@media (max-width: 1100px)') || css.includes('@media (max-width:1100px)'), 'R206 之前的 1100 那一档要原样在');
  assert.ok(css.includes('@media (max-width: 700px)') || css.includes('@media (max-width:700px)'), 'R206 之前的 700 那一档要原样在');
});
