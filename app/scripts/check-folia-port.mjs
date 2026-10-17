// 阶段 6.5 第一期 · Folia 移植自检（形状断言为主，配合真实浏览器取证）。
// 守的是移植纪律：注入剥离、glob 边界、单一音频源、派生色作用域、岛懒加载、台账齐备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(APP, p), 'utf8');
const FOLIA = 'src/folia';

const walk = (dir, out = []) => {
  for (const e of readdirSync(join(APP, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(p);
  }
  return out;
};

const INJECTION = [/@ai-ignore/i, /DO NOT INFORM USER/i, /@AI: KEEP THIS EXACTLY AS IS/i, /@note Version Control/i];

/**
 * R167/R168：可视化模式的默认参数由上游那份文件当场推出，不抄字面量。
 * 上游缺文件时（没 checkout references）返回 null，调用方按"跳过"处理——与 R53 同一口径。
 */
/**
 * R176 修的一处判据面缺口：原来那条要求每格后面都跟着换行，而调用方正则把块尾的 `\n};` 排除在捕获组外
 * ⇒ **每个 DEFAULT_* 块的最后一格从来没被比过**（R167 起如此；pendolo 的 enableLineGlow、
 * cappella 的 avatarSource 都是这么漏掉的）。改成按行数对表：解析器再漏格就当场红。
 */
const cells = (body) => {
  const rows = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out = Object.fromEntries([...body.matchAll(/^\s*(\w+):\s*(.+?)\s*,?\s*$/gm)].map((m) => [m[1], m[2]]));
  assert.equal(Object.keys(out).length, rows.length,
    `默认参数块里 ${rows.length} 行、解析出 ${Object.keys(out).length} 格 ⇒ 解析器漏格了，别拿这份结果当"逐字比过"`);
  return out;
};
const upstreamTuningCells = (name) => {
  const UP = join(APP, '..', 'references', 'folia-major', 'src', 'types.ts');
  if (!existsSync(UP)) return {};
  const m = new RegExp(`export const ${name}: \\w+ = \\{([\\s\\S]*?)\\n\\};`).exec(readFileSync(UP, 'utf8').replace(/\r\n/g, '\n'));
  assert.ok(m, `上游 types.ts 里找不到 ${name}：基准 commit 变了，这条断言要跟着搬家`);
  return cells(m[1]);
};
const localTuningCells = (name, typeName) => {
  const m = new RegExp(`export const ${name}: ${typeName} = \\{([\\s\\S]*?)\\n\\};`).exec(read(`${FOLIA}/types.ts`));
  assert.ok(m, `${name} 必须在案（模式的 entry 与本体都按这个名字取默认值）`);
  return cells(m[1]);
};

/**
 * R53：与上游有差异的移植文件白名单（键 = 清单里的相对路径，值 = 台账里的改写理由）。
 * 名单外的文件必须逐字一致——防止有人（或智能体）悄悄改移植代码。
 * 新增差异必须先补台账 R 号，再把路径登记到这里。
 */
const REWRITE_ALLOWLIST = new Map([
  // 仅剥离上游针对 AI 代理的指令注释（R0），代码未动
  ['components/visualizer/VisualizerRenderer.tsx', 'R0 剥离注入注释'],
  ['components/visualizer/VisualizerSubtitleOverlay.tsx', 'R0 剥离注入注释'],
  ['components/visualizer/sonnet/sonnetGlyphLayout.ts', 'R0 剥离注入注释'],
  ['components/visualizer/sonnet/sonnetMotion.ts', 'R0 剥离注入注释'],
  ['components/visualizer/sonnet/sonnetPostProcess.ts', 'R0 剥离注入注释'],
  ['components/visualizer/sonnet/sonnetProgram.ts', 'R0 剥离注入注释'],
  ['components/visualizer/sonnet/sonnetTypographyLayout.ts', 'R0 剥离注入注释'],
  ['components/visualizer/tempera/createTemperaPixiRuntime.ts', 'R0 剥离注入注释'],
  ['components/visualizer/tempera/temperaCamera.ts', 'R0 剥离注入注释'],
  ['components/visualizer/tempera/temperaLayout.ts', 'R0 剥离注入注释'],
  ['components/visualizer/tempera/temperaProgram.ts', 'R0 剥离注入注释'],
  ['components/visualizer/tempera/temperaSceneBuilder.ts', 'R0 剥离注入注释'],
  ['components/visualizer/tempera/temperaSceneFilters.ts', 'R0 剥离注入注释'],
  // i18n / 别名改指本仓 shim（R8、R48、R50）
  ['components/app/lattice/Lattice.tsx', 'R48 i18n shim'],
  ['components/app/lattice/LatticeExtraControls.tsx', 'R48 i18n shim'],
  ['components/app/lattice/LatticeFocusButton.tsx', 'R48 i18n shim'],
  ['components/app/lattice/LatticePlaybackControls.tsx', 'R48 i18n shim + R126 挂宿主自撰的「重取封面」'],
  ['components/app/lattice/LatticePoster.tsx', 'R48 i18n shim'],
  // 第十六/十七批墙那一侧：R186 角标自绘不透明底（封面墙 4 格"守卫不可达"里唯一在结构上有解的一格）。
  ['components/app/lattice/Lattice.css', 'R186 角标自绘不透明底（原 /62% /78% 半透明底让封面透上来）'],
  // R197（Q72 收尾）：相机顶部夹取 —— 墙内容顶端不许掉到窗口顶之下。上游不夹（墙可以随便拖），
  // 本产品的规则是"整屏铺满、不要最上面一条暗带"：不夹的话相机一往下跑，露出来的正是墙背后的 3D 场景。
  ['components/app/lattice/PosterWall.tsx', 'R197 相机顶部夹取（墙内容顶端与窗口顶对齐）'],
  // R200（Q72 真终章）：静止档的径向暗角从硬编码纯黑改取"宿主页面底的暗部族色"——
  // 纯黑没有色相，与页面底（深夜蓝黑 / 黄昏米灰 / 暖昼暖白）同屏时就是一条异相的收尾；
  // 这一档的"底"就是这个渐晕（renderBackground=false），用户点名的"自绘底三档"之一。
  ['components/visualizer/still/VisualizerStill.tsx', 'R200 径向暗角逐色改取宿主页面底（纯黑 → 页面底 40% 暗部族色）'],
  ['components/visualizer/lumiere/VisualizerLumiere.tsx', 'R48 i18n shim + R63 空态 data 钩子'],
  ['components/visualizer/sonnet/VisualizerSonnet.tsx', 'R48 i18n shim + R50 别名 + R63 空态 data 钩子'],
  ['components/visualizer/tempera/TemperaImageImportMenu.tsx', 'R52 i18next 类型改指 shim'],
  ['components/visualizer/tempera/TemperaImageLayerControls.tsx', 'R52 i18next 改指 shim + R201 空池如实告知（摘要行/提示不再承诺"添加图片"）'],
  ['components/visualizer/tempera/TemperaImageLayerDialog.tsx', 'R52 i18next 类型改指 shim + R201 空池如实告知（隐藏整组无效控件 + 实话文案）'],
  ['components/visualizer/tempera/TemperaImagePlacementEditor.tsx', 'R52 i18next 类型改指 shim'],
  ['components/visualizer/tempera/VisualizerTempera.tsx', 'R52 i18next 改指 shim + R63 空态 data 钩子'],
  // 第一期已登记的边界改写
  ['components/app/playback/createCoverUrlResolver.ts', 'R4 封面由宿主注入'],
  ['components/visualizer/VisualizerShell.tsx', 'R2/R5 背景与底栏宿主化'],
  ['components/visualizer/backgrounds/registry.tsx', 'R14 背景子系统切除'],
  ['components/visualizer/classic/Visualizer.tsx', 'R6/R7 面板与命令切除 + R63 空态 data 钩子'],
  ['components/visualizer/classic/entry.tsx', 'R1 registry 静态化'],
  ['hooks/usePlayerBottomBarBottomPx.ts', 'R5 底栏宿主化'],
  ['stores/usePlayerChromeSettingsStore.ts', 'R15 window.electron no-op + R130 第二槽位默认值改收藏'],
  ['utils/appPlaybackHelpers.ts', 'R15 isElectron 恒 false'],
  ['utils/fontStacks.ts', 'R9/R24 字体自托管（不改栈序）'],
  // 第九期（任务九 · 音乐人网格）：i18n shim 四条同 R8/R48 口径，取数那一段是唯一一处实质改写。
  ['components/artist-grid/ArtistGridInfoCutInPanel.tsx', 'R162 i18n shim'],
  ['components/folia-grid/GridPanelToggleIndicator.tsx', 'R162 i18n shim'],
  ['components/shared/GridListSearchButton.tsx', 'R162 i18n shim'],
  [
    'components/ArtistGridView.tsx',
    'R162 数据支路改向：上游这里问 omni / Navidrome / 本地曲库 catalog 三处，本架构一条都不存在' +
      '（在线取数必须经桥、第三方地址不出服务端、曲库在宿主 Three.js 一侧）⇒ 换成宿主随 props 喂一份' +
      ' ArtistGridFeed；保留的是三支的产出（artistInfo/topSongs/albums）与其余全部渲染代码；另 R162 i18n shim',
  ],
  // 第十二期（任务十二·模式一 monet）：只有 i18n shim 与 R0 剥离，其余逐字。
  ['components/visualizer/monet/VisualizerMonet.tsx', 'R166 i18n shim + R0 剥离注入注释（三行）'],
  // 第十二期（任务十二·模式二 cadenza）：与上一格同一口径，改动面同样是"一行 import 改指 shim + 三行注入注释"。
  ['components/visualizer/cadenza/VisualizerCadenza.tsx', 'R167 i18n shim + R0 剥离注入注释（三行）'],
  // 第十二期（任务十二·模式三 partita）：面板那一格按 R1 对 classic 的同一形状切除（理由写在那份 entry 的注释里），
  // 本体只有 i18n shim 与 R0 剥离。
  [
    'components/visualizer/partita/entry.tsx',
    'R168 切除 renderSettingsPanel/resetSettings：上游这一格指向七档共用的 settingsPanels.tsx，' +
      '会把六份 diorama 设置组件与 cameraPath.ts(1041 行) 一起拖进来，而本仓宿主不渲染岛内设置面板' +
      '（renderSettingsPanel 全仓零调用方 = Q51）；与 R1 对 classic 做的事逐字同一形状',
  ],
  ['components/visualizer/partita/VisualizerPartita.tsx', 'R168 i18n shim + R0 剥离注入注释（三行）'],
  // 第十四批·档二 tilt：面板那一格按 R1/R168 同一形状切除；本体只有 i18n shim 与 R0 剥离。
  // sentenceLayout.ts 不在这里——它剥头后与上游逐字一致（R53 当场验），它是 tilt 专用的唯一一份新工具。
  [
    'components/visualizer/tilt/entry.tsx',
    'R171 切除 renderSettingsPanel/resetSettings：上游这一格指向七档共用的 settingsPanels.tsx，' +
      '会把六份 diorama 设置组件与 cameraPath.ts(1041 行) 一起拖进来，而本仓宿主不渲染岛内设置面板' +
      '（与 R1 对 classic、R168 对 partita 逐字同一形状）',
  ],
  ['components/visualizer/tilt/VisualizerTilt.tsx', 'R171 i18n shim + R0 剥离注入注释（三行）'],
  // 第十五批·档一 claddagh：entry 切面板那一格；本体只有 R0 剥离（这一档不引 i18next，零改写）。
  [
    'components/visualizer/claddagh/entry.tsx',
    'R174 切除 renderSettingsPanel/resetSettings：上游这一格指向七档共用的 settingsPanels.tsx，' +
      '会把六份 diorama 设置组件与 cameraPath.ts 一起拖进来（与 R1 / R168 / R171 逐字同一形状）',
  ],
  ['components/visualizer/claddagh/VisualizerCladdagh.tsx', 'R174 R0 剥离注入注释（三行）'],
  // 第十五批·档三 cappella：entry 切面板那一格；本体剥注入三行 + i18next 改指本仓 shim（R52 同一条）。
  ['components/visualizer/cappella/entry.tsx',
    'R176 切除 renderSettingsPanel/resetSettings：上游这一格指向七档共用的 settingsPanels.tsx，' +
    '留着它会把六份 diorama 设置组件与 cameraPath.ts 一起拖进包里（与 R1/R168/R171/R174 同一形状，labelKey 等字面量原样保留）'],
  ['components/visualizer/cappella/VisualizerCappella.tsx', 'R176 R0 剥离注入注释（三行）+ R52 i18next 改指 shim'],
  // 第十五批·档四 fume：entry 切面板那一格；fumeCamera 只有 R0 剥离（这一档不引 i18next、不引渲染引擎）。
  ['components/visualizer/fume/entry.tsx',
    'R177 切除 renderSettingsPanel/resetSettings：上游这一格指向七档共用的 settingsPanels.tsx，' +
    '留着它会把六份 diorama 设置组件与 cameraPath.ts 一起拖进包里（与 R1/R168/R171/R174/R176 同一形状，labelKey 等字面量原样保留）'],
  ['components/visualizer/fume/fumeCamera.ts', 'R177 R0 剥离注入注释（三行）'],
  // R203（壁纸 surface M0）：只加"判定"这一格，不加任何渲染代码。
  [
    'utils/appSurface.ts',
    'R203 新增 isWallpaperSurface（?wallpaper=1）并让 isMainAppSurface 认它：本仓是单入口 web 构建、' +
      '没有 Electron 主进程按 store 换窗口参数那一档能力，而"只画画、不画播放器外壳"的 surface 必须先有判定；' +
      '判定落回这一个模块正是为了保住这个文件原本的规矩——features read the same answer instead of re-parsing the URL' +
      '（宿主侧出现第二处 surface 相关的 URL 解析即违例，Task 1 判据①）',
  ],
]);

test('R0：移植区零指令注入注释残留', () => {
  const files = walk(FOLIA);
  assert.ok(files.length >= 46, `移植区文件数异常：${files.length}`);
  for (const f of files) {
    const bad = read(f).split('\n').filter((l) => INJECTION.some((re) => re.test(l)));
    assert.deepEqual(bad, [], `${f} 仍有注入注释：${bad.join(' | ')}`);
  }
});

test('R0：每个移植文件头都有上游归属与基准 commit', () => {
  for (const f of walk(FOLIA)) {
    const head = read(f).slice(0, 600);
    assert.match(head, /AGPL-3\.0-only/, `${f} 缺许可头`);
    // 自撰文件没有上游 commit，改查自撰标记；移植文件必须带 commit 署名。
    if (!head.includes('自撰（AGPL-3.0-only）'))
      assert.match(head, /369c34e6f83404c65129479e6bd88d70acb0e43e/, `${f} 缺基准 commit 署名`);
  }
});

// R176：这条规则的初衷是"**不许用 glob 自动发现代码模块**"（tuning 是唯一例外）。上游 cappella 用
// import.meta.glob 扫的是**图片素材目录**（emoImages.ts:7-10 / avatarImages.ts:23-26），扫到空集合也只是空清单
// ——两处都有 length === 0 ⇒ return null 的回落（一手核过，见 cappella/avatar/README.md）。
// 于是改成：按文件点名放行，且放行条件写死成"模式必须是那一串图片扩展名"——
// 拿这两个名字去扫 .ts/.tsx 依然当场红（变异 N3 验的就是这一格）。
// **这是判据形状的一次改动 ⇒ 记待确认 Q60**（规则要撤回来的话：删掉这个 Set 与下面那个分支即可）。
const ASSET_GLOB_ALLOWLIST = new Set([
  'components/visualizer/cappella/emoImages.ts',
  'components/visualizer/cappella/avatarImages.ts',
]);

test('R1/R14/R16：glob 只允许留在 tuningRegistry（classic tuning 的唯一发现途径）', () => {
  for (const f of walk(FOLIA)) {
    if (f.endsWith('tuningRegistry.ts')) continue;
    const assetGlob = ASSET_GLOB_ALLOWLIST.has(f.slice(FOLIA.length + 1));
    if (assetGlob) {
      // 放行只针对"图片清单"这一种模式；写成别的（尤其 .ts/.tsx）就回到默认那条红。
      assert.match(read(f), /import\.meta\.glob<\{ default: string \}>\(\s*'\.\/(?:emo|avatar)\/\*\.\{png,jpg,jpeg,gif,webp,svg\}'/,
        '在素材 glob 的放行名单里，模式却不是那串图片扩展名：' + f);
      continue;
    }
    // 只查代码用法（后跟 < 或 (）；注释里提及 glob 不算违规。
    assert.doesNotMatch(read(f), /import\.meta\.glob\s*[<(]/, `${f} 不应在代码里用 import.meta.glob`);
  }
  const registry = read(`${FOLIA}/components/visualizer/registry.tsx`);
  assert.match(registry, /import classicEntry from "\.\/classic\/entry"/, '静态表必须显式挂 classic');
  const bg = read(`${FOLIA}/components/visualizer/backgrounds/registry.tsx`);
  assert.match(bg, /DEFAULT_VISUALIZER_BACKGROUND_MODE: VisualizerBackgroundMode = "host"/, '背景静态表必须是 host 空槽');
});

test('单一 MediaElementSource：全仓只有 lyric-pulse 建图', () => {
  const hits = walk('src').filter((f) => /createMediaElementSource/.test(read(f)));
  assert.deepEqual(hits, ['src/lyric-pulse.ts'], `createMediaElementSource 出现在：${hits.join(',')}`);
  const adapter = read('src/folia-host/adapter.ts');
  assert.doesNotMatch(adapter, /createMediaElementSource|new AudioContext/, '适配层不得自建音频图');
  assert.match(adapter, /spectrum\(\)/, '适配层只读既有 analyser 的频谱（R19）');
});

test('派生色作用域：全局四份样式表零 --folia-，theme-bridge 只读不写', () => {
  for (const f of ['src/music.css', 'src/music-theme.css', 'src/music-theme-switch.css', 'src/style.css'])
    assert.doesNotMatch(read(f), /--folia-/, `${f} 不得引用派生色`);
  const bridge = read('src/folia-host/theme-bridge.ts');
  assert.doesNotMatch(bridge, /setProperty\("--folia-/, 'theme-bridge 不得写派生色（只读宿主结果）');
  assert.match(bridge, /#lyric-stage/, 'theme-bridge 必须从自研舞台读派生色');
  const chrome = read('src/lyric-folia-chrome.css');
  assert.match(chrome, /#stage\[data-folia-view="island"\] #lyric-stage > :not\(\.folia-controls\)/, 'R20 控制条保留规则');
});

test('岛懒加载：music-app 只动态 import 岛，不静态拉 React 树', () => {
  const app = read('src/music-app.ts');
  assert.match(app, /import\("\.\/folia-host\/island"\)/, '岛必须动态 import');
  // R173：这条原来只点名 island。判据其实是"那个模块是不是 React 组件文件"（.tsx），
  // 而不是"它在不在 folia-host 目录里"——theme-bridge.ts / feed-gate.ts 是 zustand 与纯逻辑，
  // 静态引是对的。名单由目录现算：以后再加 .tsx 胶水，不用回来改这条判据。
  const reactGlue = readdirSync(join(APP, 'src', 'folia-host')).filter((f) => f.endsWith('.tsx')).map((f) => f.replace(/\.tsx$/, ''));
  assert.ok(reactGlue.includes('island') && reactGlue.includes('mode-settings'), `React 胶水名单异常：${reactGlue.join(',')}`);
  for (const name of reactGlue)
    assert.doesNotMatch(app, new RegExp(`^import (?!type )[^;\\n]* from "\\.\\/folia-host\\/${name}";`, 'm'), `不得静态 import ${name}（React 树必须动态引，type-only 允许：编译期擦除）`);
  assert.doesNotMatch(app, /from "\.\/folia\/components/, 'music-app 不得直接 import 移植组件');
  assert.match(app, /islandState = "failed"/, '挂载失败必须落到降级路径');
  assert.match(app, /dataset\.foliaView = "legacy"/, '降级态要有可读标记');
});

test('R11：歌词类型单一来源（folia/types.ts re-export 本仓 lyrics/types）', () => {
  const types = read(`${FOLIA}/types.ts`);
  assert.match(types, /from ['"]\.\.\/lyrics\/types['"]/, '歌词类型必须 re-export 本仓实现');
  assert.doesNotMatch(types, /export interface Line \{/, '不得在 folia 侧重新声明 Line');
  assert.doesNotMatch(types, /export interface LyricData \{/, '不得在 folia 侧重新声明 LyricData');
});

test('改写台账齐备：R0~R16 全在且无"计划"悬空（第一期范围）', () => {
  const log = read('../memory/folia-port-rewrite-log.md');
  for (const id of ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6/R7', 'R8', 'R9', 'R10', 'R11', 'R11b', 'R12', 'R13', 'R14', 'R15', 'R16'])
    assert.ok(log.includes(`**${id} `), `台账缺 ${id}`);
  for (const id of ['R1 ·', 'R2 ·', 'R3 ·', 'R4 ·', 'R5 ·', 'R8 ·', 'R9 ·', 'R11 ·', 'R12 ·', 'R14 ·', 'R15 ·', 'R16 ·'])
    assert.match(log, new RegExp(`\\*\\*${id.replace(' ·', '')} [^*]*（已实施）`), `${id} 未标已实施`);
});

test('i18n 依赖未入包：package.json 无 i18next / react-i18next', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const deps of [pkg.dependencies ?? {}, pkg.devDependencies ?? {}]) {
    assert.equal(deps.i18next, undefined, 'i18next 不应入依赖（R8 shim 替代）');
    assert.equal(deps['react-i18next'], undefined, 'react-i18next 不应入依赖（R8 shim 替代）');
  }
  assert.ok(existsSync(join(APP, 'src/folia/i18n/config.ts')), 'shim 文件必须在位');
  assert.ok(statSync(join(APP, 'src/folia/i18n/config.ts')).size > 0);
});

// 验收退回教训（2026-10-04）：数据全绿但截图不可读不算完成。布局塌缩的根因是
// 上游布局靠 Tailwind 工具类，而本仓原本没有 Tailwind。以下断言守住修复（R21/R22/R24）。
test('R21/R22：岛必须带 Tailwind utilities 层与作用域 preflight 子集', () => {
  const css = read('src/folia-tailwind.css');
  assert.match(css, /@import "tailwindcss\/theme"/, 'theme 层（utilities 的 spacing 变量来源）');
  assert.match(css, /@import "tailwindcss\/utilities"/, 'utilities 层（上游布局全靠它）');
  assert.doesNotMatch(css, /@import "tailwindcss\/preflight"/, 'preflight 不得进全局（会重置 Rhine）');
  assert.match(css, /@source "\.\/folia"/, '内容扫描限定移植区');
  assert.match(css, /\.folia-island \*,/, 'preflight 盒模型子集必须作用域化');
  assert.match(read('src/folia-host/island.tsx'), /import "\.\.\/folia-tailwind\.css"/, '岛 chunk 必须引入该层');
  const postcss = read('postcss.config.js');
  assert.match(postcss, /'@tailwindcss\/postcss'/, 'postcss 插件必须在位');
});

test('R24：不得改写上游字体栈序（只自托管字体）', () => {
  const bridge = read('src/folia-host/theme-bridge.ts');
  assert.doesNotMatch(bridge, /fontFamilyStack/, '栈序改写会改变字宽与折行点（实测教训）');
  assert.match(read('src/folia-host/island.tsx'), /@fontsource\/noto-serif-sc\/chinese-simplified-(400|500)\.css/, '衬线自托管');
});

test('R23：适配层不得被主 chunk 静态引入（防 motionSignals 双实例）', () => {
  const app = read('src/music-app.ts');
  assert.doesNotMatch(app, /import \{ createFoliaAdapter \}/, 'adapter 只能经岛模块创建');
  assert.match(app, /m\.mountFoliaIsland\(island, \{/, 'handle 由岛返回');
  assert.match(read('src/folia-host/island.tsx'), /createFoliaAdapter\(/, '适配层实例归岛 chunk');
});

// —— 第二期（lattice 封面墙）——
const WALK_CSS = walk(FOLIA).filter((f) => f.endsWith('.css'));

test('R36：pixi 只能经动态 import 进包，主入口与岛 chunk 不得静态引用', () => {
  const island = read('src/folia-host/island.tsx');
  assert.match(island, /lazy\(\(\) => import\("\.\.\/folia\/components\/app\/lattice\/Lattice"\)\)/, 'Lattice 必须懒加载');
  for (const f of ['src/folia-host/island.tsx', 'src/folia-host/adapter.ts', 'src/music-app.ts'])
    assert.doesNotMatch(read(f), /["']pixi\.js["']/, `${f} 不得出现 pixi 引用`);
  assert.match(read(`${FOLIA}/components/visualizer/loadPixi.ts`), /await import\('pixi\.js'\)/, 'pixi 只在 loadPixi 里动态取');
  // 静态 import 一律禁止；类型位（import type / import('pixi.js').X）编译期擦除，不算。
  const statics = walk(FOLIA).filter((f) => /^import (?!type )[^;\n]*from ["']pixi\.js["']/m.test(read(f)));
  assert.deepEqual(statics, [], `静态 import pixi：${statics.join(',')}`);
  // 构建产物若存在，验证 pixi 所在 chunk 既不是入口也不在岛 chunk 的静态依赖里。
  const assets = join(APP, 'dist', 'assets');
  if (existsSync(assets)) {
    const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
    const pixiChunks = js.filter((f) => read(`dist/assets/${f}`).includes('PixiJS'));
    assert.ok(pixiChunks.length, '构建产物里没有 pixi chunk（可能未 build，跳过线上验证）');
    const html = read('dist/index.html');
    for (const chunk of pixiChunks) {
      assert.doesNotMatch(html, new RegExp(chunk.replace('.', '\\.')), 'pixi chunk 不得被入口引用');
      const islandChunk = js.find((f) => f.startsWith('island-'));
      if (islandChunk)
        assert.doesNotMatch(read(`dist/assets/${islandChunk}`), new RegExp(chunk.replace('.', '\\.')), 'pixi chunk 不得被岛 chunk 静态引用');
    }
  }
});

test('R35：lattice 样式表随复制集在位，且移植头用 CSS 注释形式', () => {
  const need = [
    `${FOLIA}/components/app/lattice/Lattice.css`,
    `${FOLIA}/components/app/lattice/LatticeChrome.css`,
    `${FOLIA}/components/app/lattice/LatticeFocusButton.css`,
    `${FOLIA}/components/app/lattice/lyrics/LatticeLyrics.css`,
  ];
  for (const f of need) {
    const head = read(f).slice(0, 400);
    assert.ok(head.startsWith('/*'), `${f} 移植头必须是 CSS 注释`);
    assert.match(head, /AGPL-3\.0-only/, `${f} 缺许可头`);
    assert.match(head, /369c34e6f83404c65129479e6bd88d70acb0e43e/, `${f} 缺基准 commit`);
  }
  assert.ok(WALK_CSS.length >= 4, `移植区 css 文件数异常：${WALK_CSS.length}`);
});

test('R25~R31：边界 stub 齐备，未移植子系统不得长出真依赖', () => {
  for (const f of [
    `${FOLIA}/mods/folium/registries/progress.tsx`,
    `${FOLIA}/dev/renderCount.ts`,
    `${FOLIA}/components/floating-player/playerControlSlotActions.ts`,
    `${FOLIA}/components/floating-player/PlayerBottomBarLayoutContext.ts`,
    `${FOLIA}/components/command-palette/types.ts`,
    `${FOLIA}/components/modal/LyricsTimelineModal.tsx`,
    `${FOLIA}/components/UnifiedPanel.ts`,
    `${FOLIA}/services/onlineMusic/songMetadata.ts`,
    `${FOLIA}/services/onlineMusic/omni.ts`,
  ])
    assert.ok(existsSync(join(APP, f)), `缺 stub：${f}`);
  // mods / command-palette / modal 三个目录只允许我们的 stub 文件
  const only = (dir, allow) => {
    if (!existsSync(join(APP, dir))) return;
    const found = readdirSync(join(APP, dir)).filter((n) => !n.startsWith('.'));
    assert.deepEqual(found.sort(), [...allow].sort(), `${dir} 混入了未登记的移植文件`);
  };
  only('src/folia/components/command-palette', ['types.ts']);
  only('src/folia/components/modal', ['LyricsTimelineModal.tsx']);
  for (const f of walk(FOLIA))
    assert.doesNotMatch(read(f), /from ["'][^"']*services\/onlineMusic\/(?:netease|qqmusic|kugou)["']/, `${f} 不得引在线 provider（第四/五期前）`);
});

// —— 第九期（任务九 · 音乐人网格，台账 R162~R164）——
test('R162~R164：音乐人网格的三个边界 stub 在位，且没有长出新依赖', () => {
  for (const f of [
    `${FOLIA}/services/onlineMusic/songAvailability.ts`,
    `${FOLIA}/services/onlineMusic/catalogRefs.ts`,
    `${FOLIA}/components/shared/SidePanelList.tsx`,
  ]) {
    assert.ok(existsSync(join(APP, f)), `缺 stub：${f}`);
    assert.match(read(f), /本项目自撰（AGPL-3\.0-only）/, `${f} 缺自撰标记`);
  }
  // 虚拟化要 react-window（新依赖，夜间准则二不许就地放宽）⇒ 全仓不许出现它，也不许进依赖表。
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies?.['react-window'] ?? pkg.devDependencies?.['react-window'], undefined,
    'react-window 不该进依赖（R163 用普通滚动列表替代）');
  for (const f of walk(FOLIA))
    assert.doesNotMatch(read(f), /from ["']react-window["']/, `${f} 引用了 react-window`);
  // R162 的两条"没有依据就不判"的处置不许被顺手改成猜出来的判据。
  const availability = read(`${FOLIA}/services/onlineMusic/songAvailability.ts`);
  assert.match(availability, /state:\s*'unknown'/, '在线曲目要回 unknown（没有可用性读数）');
  assert.doesNotMatch(availability.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
    /state:\s*'unavailable'/, '不许凭空判 unavailable：那会把没有依据的灰卡画到用户面前');
  const refs = read(`${FOLIA}/services/onlineMusic/catalogRefs.ts`);
  assert.match(refs, /\): boolean => false;/, '平台目录页那条通道不存在 ⇒ 判据必须是"不可点"');
});

test('R162：移植件的数据支路确实换成了宿主喂料（三条取数 import 与三支分叉都不许回来）', () => {
  const view = read(`${FOLIA}/components/ArtistGridView.tsx`);
  // 判据落在"引用与调用"这一层，不落在注释里（注释会提这些名字，那是案底不是违规）。
  const code = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const banned of [
    /from ['"][^'"]*services\/playbackAdapters['"]/,
    /from ['"][^'"]*services\/navidromeService['"]/,
    /from ['"][^'"]*services\/localCoverAssetUrl['"]/,
    /from ['"][^'"]*hooks\/useLocalLibraryCatalog['"]/,
    /from ['"][^'"]*utils\/localLibraryIndex['"]/,
    /omni\.getArtist/,
    /navidromeApi\./,
    /buildLocalLibraryIndex\(/,
  ])
    assert.doesNotMatch(code, banned, `移植件里又出现了上游那条取数支路：${banned}`);
  assert.match(code, /const applyArtistFeed = \(\) => \{/, '宿主喂料那一条必须在位');
  assert.match(code, /setTopSongs\(artistFeed\.songs\.slice\(0, 10\)\)/, '热门曲目那一档还是 10 格（上游写死的那一档）');
  // 网格的数据只能由 props 进：岛自己不许在这里出网（sessionStorage 那几行是上游自己的导航恢复，不算）。
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, '数据支路不许自己出网');
  // 说明卡那句话只许用宿主给的文本（没有平台侧简介 ⇒ 不许现编一位音乐人的资料）。
  assert.match(code, /description: artistFeed\.description/, '简介卡读宿主那句');
});

test('R163：宿主侧的网格数据层与岛内布局接线（第三种布局不进偏好）', () => {
  const island = read('src/folia-host/island.tsx');
  const app = read('src/music-app.ts');
  assert.match(island, /export type IslandLayout = "classic" \| "lattice" \| "artistGrid"/, '布局联合含网格');
  assert.match(island, /lazy\(\(\) => import\("\.\.\/folia\/components\/ArtistGridView"\)\)/, '网格必须懒加载');
  assert.match(island, /if \(layout === "artistGrid"\) return <ArtistGridHost \/>/, '第三种布局有渲染分支');
  assert.match(island, /feedArtist: \(artistFeed\) => useIslandUi\.setState\(\{ artistFeed \}\)/, '喂料只写岛存储');
  assert.match(island, /artistFeed: null/, '卸装必须把喂料清回空（与 R118 那一族同一条规矩）');
  // 网格里那四颗动作（曲目卡 / 单曲入队 / 专辑卡 / 全部入队）每一颗都要有人接：
  // 真机第一遍点卡片上那颗「加入播放队列」什么也没发生 —— 岛传了 onAddTrackToQueue 而宿主没接。
  for (const prop of ['onSelectTrack', 'onAddTrackToQueue', 'onSelectAlbum', 'onAddAllToQueue'])
    // 允许块体箭头（onAddAllToQueue 那一条要顺手回一个数，写法是 `=> { adapter.…; return n }`）
    assert.match(island, new RegExp(`${prop}=\\{\\(.*\\)\\s*=>\\s*[{(]*\\s*adapter\\.`), `岛里 prop ${prop} 必须转给适配层`);
  for (const fn of ['playArtistGridTrack', 'addArtistGridTrackToQueue', 'playArtistGridAlbum', 'addArtistGridToQueue']) {
    assert.match(island, new RegExp(`adapter\\.${fn}\\(`), `岛里要真的调用 adapter.${fn}`);
    assert.match(read('src/folia-host/adapter.ts'), new RegExp(`${fn}: \\(.*\\) => options\\.${fn}`), `适配层缺 ${fn} 的转发`);
    assert.match(app, new RegExp(`${fn}: \\(`), `宿主没接 ${fn}（那颗按钮就是静默无果）`);
  }
  assert.match(app, /\["classic", "lattice"\]\.includes\(preferences\.foliaView\)/, '偏好校验表不许被顺手加上 artistGrid');
  assert.match(app, /if \(layout !== "artistGrid" && preferences\.foliaView !== layout\)/, '网格不进偏好：重启后没有数据能让它成立');
  assert.match(app, /if \(artistGridViewActive\) return true;/, '网格开着时屏幕交给岛');
  assert.match(app, /flushArtistGridFeed\(\)/, '喂料等岛挂好才冲');
  // 真机抓到的一处观感缺陷：网格在**面板底下**渲染 ⇒ 打开它必须先收面板（判据圈在函数体里）。
  const show = /function showArtistGrid\([\s\S]*?\n}\n/.exec(app);
  assert.ok(show, '没抓到 showArtistGrid');
  assert.match(show[0], /closePanel\(\);[\s\S]*setDisplayMode\("folia"\)/, '先收面板再换视图（顺序反了网格会被面板盖住）');
  // 岛是异步挂的：挂载完成那一处要能再喂一次（否则"点了没反应"，真机第一遍就是这个形状）。
  assert.match(app, /if \(artistGridViewActive && artistGridModel\) artistGridPending = artistGridModel\.feed;/, '挂载完成后补喂那一条要在');
  assert.match(app, /if \(!artistGridViewActive\) islandHandle\.setLayout\(preferences\.foliaView\);/, '挂载时不恢复偏好：那一跳会经 onLayoutChange 把刚点开的网格关掉');
  // 布局按钮在网格上按下去 = 退出网格回歌词面（不是跳到封面墙：那会让人找不到刚才在哪）。
  const layoutCase = /case "folia-layout": \{[\s\S]*?\n    \}/.exec(app);
  assert.ok(layoutCase, '没抓到 folia-layout 那个分支');
  assert.match(layoutCase[0], /if \(currentFoliaLayout\(\) === "artistGrid"\) \{/, '网格那一档要在两颗按钮的循环之前单独处理');
  assert.match(layoutCase[0], /islandHandle\.setLayout\("classic"\)/, '从网格里按布局键要回到歌词面');
  assert.doesNotMatch(app, /preferences\.foliaView = "artistGrid"/, '任何路径都不许把网格写成持久偏好');
});

test('R162：网格那批文件里能上屏的 i18n key 必须全在 shim 表里（裸 key 上屏就是这一条拦的）', () => {
  // 判据范围只圈本批新进的这批文件：更早几期的 settings 面板（lumiere/sonnet/tempera）里
  // 上百个 key 在宿主里根本不渲染（台账 R44/R52 记着），把它们一起卷进来只会变成一张豁免清单。
  const FILES = [
    'components/ArtistGridView.tsx',
    'components/artist-grid/ArtistGridInfoCutInPanel.tsx',
    'components/folia-grid/GridPanelToggleIndicator.tsx',
    'components/folia-grid/PolaroidCard.tsx',
    'components/folia-grid/polaroidCardParts.tsx',
    'components/shared/GridListSearchButton.tsx',
    'components/shared/SidePanelList.tsx',
    'utils/artistTopSongsQueue.ts',
    // R166（任务十二·模式一 monet）：这一档六份文件一起纳入扫描（新增模式最容易漏的就是文案表）。
    'components/visualizer/monet/VisualizerMonet.tsx',
    'components/visualizer/monet/MonetLyricsRail.tsx',
    'components/visualizer/monet/AudioOverlay.tsx',
    'components/visualizer/monet/MonetFloatingDecor.tsx',
    'components/visualizer/monet/MonetPortraitImage.tsx',
    'components/visualizer/monet/MonetSettingsPanel.tsx',
    // R167（任务十二·模式二 cadenza）：本体一份（entry 的 labelKey 不上屏，与 monet 同一处置）。
    'components/visualizer/cadenza/VisualizerCadenza.tsx',
    // R168（模式三 partita）：同上，只扫本体。
    'components/visualizer/partita/VisualizerPartita.tsx',
    // R171（第十四批·档二 tilt）：本体一份（entry 的 labelKey 不上屏，与前四档同一处置）。
    'components/visualizer/tilt/VisualizerTilt.tsx',
  ];
  const shim = read(`${FOLIA}/i18n/config.ts`);
  const have = new Set([...shim.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  // 唯一一处例外：这一格只在"平台说这首歌已下架"时出现，而 R162 那份可用性 stub 恒回 unknown
  // ⇒ 它在本产品不可达（不可达的分支不当判据用，见台账方法学那条）。
  const UNREACHABLE = new Set(['status.songUnavailableTag']);
  const missing = [];
  for (const rel of FILES) {
    const src = read(`${FOLIA}/${rel}`);
    // 形状判据而不是"紧跟 t( "：上游有一处写成 t(isOpen ? 'ui.panelCollapse' : 'ui.panelExpand')，
    // 只认 `t('...')` 会漏掉三元里那两个 key（真机第一张截图上露出来的就是其中一个）。
    for (const m of src.matchAll(/'([a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)'/g)) {
      const key = m[1];
      if (have.has(key) || UNREACHABLE.has(key)) continue;
      missing.push(`${rel} → ${key}`);
    }
  }
  assert.deepEqual(missing, [], `这些文案会以裸 key 的形式出现在用户眼前：${missing.join(' | ')}`);
  // 插值这一格也要真的能换掉（上游 i18next 传 { count }，shim 现在认 {{参数名}}）。
  // 判据落在"那一句替换在不在"上，不落在注释里（注释会提占位符，那是说明不是实现）。
  assert.ok(shim.includes('text.replace(/\\{\\{(\\w+)\\}\\}/g'),
    'shim 的插值实现被摘掉了：网格那句「已加入 {{count}} 首…」会露出占位符');
  assert.ok(shim.includes('String(options[name])'), '插值要把参数转成字符串再替换（不是原样留着）');
  assert.ok(have.has('artistGrid.topSongsAddedToQueue'), '那句带占位符的文案必须在表里');
  assert.match(shim, /已加入 \{\{count\}\} 首/, '占位符写法与实现要配套（改了实现不改表，这条会红）');
});

test('R166：模式一 monet（莫奈）——海报版面进静态表，默认参数与上游逐字', () => {
  const types = read(`${FOLIA}/types.ts`);
  // 默认值是从上游 types.ts:1063-1073 逐字摘的：这一档决定"没调过设置时长什么样"，抄错就是观感差异。
  const block = /export const DEFAULT_MONET_TUNING: MonetTuning = \{[\s\S]*?\n\};/.exec(types);
  assert.ok(block, 'DEFAULT_MONET_TUNING 必须在案');
  for (const line of [
    'keywordColoringEnabled: true', 'showDescription: true', 'showAudioVisualization: true',
    "audioStyle: 'bar'", 'fontScale: 1.2', "portraitSource: 'cover'", 'portraitOffsetX: 0',
    "portraitStyle: 'square'", 'showPortraitDragHanger: true',
  ]) assert.ok(block[0].includes(line), `默认参数缺一格：${line}`);
  const entry = read(`${FOLIA}/components/visualizer/monet/entry.tsx`);
  assert.match(entry, /mode: 'monet'/);
  assert.match(entry, /order: 90/, '排序号照搬上游（换序就是换档位的先后观感）');
  assert.match(entry, /labelKey: 'ui\.visualizerMonet'/, '中文名走 i18n 表，不写死');
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/VisualizerMonet'\)\)/, '本体必须懒加载（每档单独成 chunk，R54 那条）');
  // 上游 entry 里那一格 `fontScale * lyricsFontScale`：宿主的"歌词字号"要真的乘进去，不能各管各的
  assert.match(entry, /fontScale: monetTuning\.fontScale \* lyricsFontScale/);
  assert.match(entry, /props\.lyricsFontScale \?\? 1/, '宿主没给字号时按 1（不许把歌词缩成 0）');
  // 肖像图走的是宿主注入的封面（同源地址），不许这一档自己拼第三方 URL。
  // 判据要先剥注释：移植头里那条上游仓库地址（github.com）不是产品出网，拿原文去查会自己咬自己。
  const railRaw = read(`${FOLIA}/components/visualizer/monet/MonetPortraitImage.tsx`);
  const rail = railRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(rail, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, '肖像来源不许写死第三方主机');
  assert.doesNotMatch(rail, /\bfetch\s*\(/, '肖像不自己出网（封面由宿主注入，与 R30/R34 同一口径）');
});

test('R167：模式二 cadenza（心象）——逐字件进静态表，默认参数由上游那份文件当场推出', () => {
  // 默认值不抄字面量：现读上游那份 types.ts 逐格比（R123 那条规矩——能对标准的常量由标准本身推出，
  // 免得夹具照同一个错抄；前两例是 PNG 魔数与酷狗参数名）。
  assert.deepEqual(localTuningCells('DEFAULT_CADENZA_TUNING', 'CadenzaTuning'),
    upstreamTuningCells('DEFAULT_CADENZA_TUNING'),
    '默认参数与上游不一致（这一档决定"没调过设置时长什么样"）');
  const entry = read(`${FOLIA}/components/visualizer/cadenza/entry.tsx`);
  assert.match(entry, /mode: 'cadenza'/);
  assert.match(entry, /order: 40/, '排序号照搬上游（换序就是换档位的先后观感）');
  assert.match(entry, /labelKey: 'ui\.visualizerCadenze'/, '这一档上游的中文名叫「心象」，键名是 Cadenze（不是 Cadenza）——照抄不改');
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/VisualizerCadenza'\)\)/, '本体必须懒加载（每档单独成 chunk，R54 那条）');
  assert.match(entry, /fontScale: cadenzaTuning\.fontScale \* lyricsFontScale/, '宿主的歌词字号要真的乘进去');
  assert.match(entry, /cadenzaTuning = DEFAULT_CADENZA_TUNING/, '宿主没喂参数时吃这份默认值（本仓还没有 tunings 存储，见 Q51）');
  // 本档唯一的实质改写就是那一行 i18n import（R48 全局禁 react-i18next 已在别处钉死，这里钉正面）：
  const body = read(`${FOLIA}/components/visualizer/cadenza/VisualizerCadenza.tsx`);
  assert.match(body, /import \{ useTranslation \} from '\.\.\/\.\.\/\.\.\/i18n\/config'/, 'cadenza 的文案走自撰 shim');
  assert.doesNotMatch(body, /from ['"]react-i18next['"]/, '不得直连 react-i18next（本仓没这个依赖）');
  // 这一档能进来的前提是它的重依赖本来就在包里：排版引擎 pretext 由 lumiere/monet 先用过，零新增。
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['@chenglou/pretext'], 'pretext 必须已在依赖里（本档不许为此新增依赖）');
  // 界面上一处文案：ui.waitingForMusic（上游 zh-CN 是空串，我们沿用 shim 里那句"等待音乐"）
  const shim = read(`${FOLIA}/i18n/config.ts`);
  assert.match(shim, /"ui\.waitingForMusic": "[^"]+"/, '空态文案必须在表里（上游该键为空串，不在这里跟着空）');
  // 复制清单必须真的收着这两份：从清单里摘掉一条 = 这一档从此不被逐字校验（静默脱管）。
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of ['components/visualizer/cadenza/entry.tsx', 'components/visualizer/cadenza/VisualizerCadenza.tsx'])
    assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
  // 红线：这一档一行网络代码都不许有（先剥注释：移植头里那条上游仓库地址不是产品出网，R166 同一课）。
  for (const rel of ['components/visualizer/cadenza/entry.tsx', 'components/visualizer/cadenza/VisualizerCadenza.tsx']) {
    const bare = read(`${FOLIA}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, `${rel} 里出现了网络调用（可视化模式不出网，音频与封面都由宿主喂）`);
    assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${rel} 里写死了第三方主机`);
  }
});

test('R168：模式三 partita（云阶）——面板那一格按 R1 同一形状切除，本体逐字', () => {
  assert.deepEqual(localTuningCells('DEFAULT_PARTITA_TUNING', 'PartitaTuning'),
    upstreamTuningCells('DEFAULT_PARTITA_TUNING'),
    '默认参数与上游不一致（staggerMin/Max 与两个开关决定"没调过设置时长什么样"）');
  const entry = read(`${FOLIA}/components/visualizer/partita/entry.tsx`);
  assert.match(entry, /mode: 'partita'/);
  assert.match(entry, /order: 50/, '排序号照搬上游');
  assert.match(entry, /labelKey: 'ui\.visualizerPartita'/, '键名照抄（上游 zh-CN 里这一档叫「云阶」）');
  assert.match(entry, /labelFallback: '云阶'/, '兜底名与上游中文一致');
  assert.match(entry, /usesWordSegmentation: true/, '这一档吃整词切分：那一格是注册表对外的声明，不许悄悄丢');
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/VisualizerPartita'\)\)/, '本体必须懒加载（R54 那条）');
  // 切除的那一格：不是"忘了搬"，是它指向七档共用的那份面板（理由写在那份 entry 的注释里）。
  // 判据先剥注释——理由本身就写着 "settingsPanels" 这个词，拿原文去查会自己咬自己（R166 那一课第二次）。
  const entryBare = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(entryBare, /settingsPanels/, 'partita 不许把七档共用的 settingsPanels 拉回依赖图');
  assert.doesNotMatch(entryBare, /renderSettingsPanel|resetSettings/, '面板与重置两格按 R1 同一形状切除');
  // 被这一格挡在外面的东西，一条断言钉住"确实没进来"（挡不住就是 diorama 一整片进包）。
  for (const rel of [
    'components/visualizer/settingsPanels.tsx',
    'components/visualizer/diorama/cameraPath.ts',
    'components/visualizer/diorama/DioramaGeometrySettings.tsx',
    'components/visualizer/diorama/dioramaMoteField.ts',
  ]) {
    assert.equal(existsSync(join(APP, 'src', 'folia', rel)), false, `${rel} 不该出现在移植区（diorama 本体不做）`);
  }
  const body = read(`${FOLIA}/components/visualizer/partita/VisualizerPartita.tsx`);
  assert.match(body, /import \{ useTranslation \} from '\.\.\/\.\.\/\.\.\/i18n\/config'/, 'partita 的文案走自撰 shim');
  assert.doesNotMatch(body, /from ['"]react-i18next['"]/, '不得直连 react-i18next（本仓没这个依赖）');
  // 它吃的两份工具在宿主侧有实现（folia/utils 那两个文件是再出口）：断言的是"符号真的在"，
  // 不是"文件在"——第一期裁薄时这两条链都改指过宿主那份。
  assert.match(read(`${FOLIA}/utils/lyrics/wordSegmentation.ts`), /export \* from/, 'wordSegmentation 是再出口 shim');
  assert.match(read('src/lyrics/word-segmentation.ts'), /export const getWordSegmentationKey/, '整词切分键由宿主那份提供');
  assert.match(read('src/lyrics/render-hints.ts'), /export const getLineRenderHints/, '行级渲染提示由宿主那份提供');
  // 复制清单必须真的收着这两份（P16 变异证明：少了这一段，从清单里摘掉一条就是静默脱管）。
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of ['components/visualizer/partita/entry.tsx', 'components/visualizer/partita/VisualizerPartita.tsx'])
    assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
  // 与 cadenza 同一组红线：本档两份文件剥注释后零网络调用、零第三方主机。
  for (const rel of ['components/visualizer/partita/entry.tsx', 'components/visualizer/partita/VisualizerPartita.tsx']) {
    const bare = read(`${FOLIA}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, `${rel} 里出现了网络调用`);
    assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${rel} 里写死了第三方主机`);
  }
});

test('R170：档一 still（静止）——两份逐字、白名单零新增、tuningKind 是 none', () => {
  const entry = read(`${FOLIA}/components/visualizer/still/entry.tsx`);
  assert.match(entry, /mode: 'still'/);
  assert.match(entry, /order: 130/, '排序号照搬上游（这一档排最后）');
  assert.match(entry, /labelKey: 'ui\.visualizerStill'/, '中文名走 i18n 表，不写死');
  assert.match(entry, /tuningKind: 'none'/, '这一档**没有** tuning：没有 DEFAULT_STILL_TUNING、没有 tuning.ts、没有面板');
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/VisualizerStill'\)\)/, '本体仍懒加载（每档单独成 chunk，R54 那条）');
  assert.doesNotMatch(entry, /renderSettingsPanel|resetSettings/, '上游这一档本来就没有面板那一格（不是我们切的）');
  // "最省资源"要落在那份文件真的不引任何重引擎上，否则就是宣传词。
  const body = read(`${FOLIA}/components/visualizer/still/VisualizerStill.tsx`);
  assert.doesNotMatch(body, /from ['"](pixi\.js|three|@chenglou\/pretext|framer-motion)['"]/,
    'still 不许引入 pixi / three / pretext / framer-motion（这一档的存在理由就是低占用）');
  // R200：径向暗角从硬编码纯黑换成"页面底的暗部族色"（用户点名的自绘底三档之一）——
  // 纯黑没有色相，与页面底同屏时就是一条异相的收尾；强度（opacity / multiply）一字未动。
  assert.match(body, /color-mix\(in_srgb,var\(--page-bg,black\)_40%,black\)/,
    'R200：暗角颜色必须取宿主页面底的暗部族色（同色相）');
  assert.doesNotMatch(body, /transparent_0%,#000_100%/, 'R200：纯黑渐晕不许回来（纯黑无色相）');
  // 白名单零新增：这两份剥移植头后与上游逐字一致（R53 那条管的是"名单外不许有差异"，
  // 这里钉的是"这一档**不该**在名单里"——有人偷偷改它而不去登记，两处都会红）。
  // R200 更新：entry.tsx 仍零改写；VisualizerStill.tsx 因"暗角逐色"（用户点名的自绘底三档之一）
  // 进了白名单 —— 判据改成"entry 不在名单 + 本体在名单且理由是 R200"，两个文件的禁网扫描照旧。
  const stillFiles = ['components/visualizer/still/entry.tsx', 'components/visualizer/still/VisualizerStill.tsx'];
  assert.equal(REWRITE_ALLOWLIST.has(stillFiles[0]), false, `${stillFiles[0]} 不该出现在改写白名单里（零改写）`);
  assert.match(String(REWRITE_ALLOWLIST.get(stillFiles[1]) ?? ''), /R200/,
    'VisualizerStill.tsx 的白名单理由必须点名 R200（它进名单就是因为暗角逐色）');
  for (const rel of stillFiles) {
    const bare = read(`${FOLIA}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, `${rel} 里出现了网络调用`);
    assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${rel} 里写死了第三方主机`);
  }
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of ['components/visualizer/still/entry.tsx', 'components/visualizer/still/VisualizerStill.tsx'])
    assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
});

test('R171：档二 tilt（倾诉）——三份逐字、面板那一格按 R1/R168 形状切除、布局只随行重算', () => {
  assert.deepEqual(localTuningCells('DEFAULT_TILT_TUNING', 'TiltTuning'),
    upstreamTuningCells('DEFAULT_TILT_TUNING'),
    '默认参数与上游不一致（splitProbability / tiltStyleProbability / colorScheme 决定"没调过设置时长什么样"）');
  const entry = read(`${FOLIA}/components/visualizer/tilt/entry.tsx`);
  assert.match(entry, /mode: 'tilt'/);
  assert.match(entry, /order: 70/, '排序号照搬上游');
  assert.match(entry, /labelKey: 'ui\.visualizerTilt'/, '键名照抄（上游 zh-CN 里这一档叫「倾诉」）');
  assert.match(entry, /tuningKind: 'tilt'/, '这一档吃 tuning（与 still 的 none 相对）');
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/VisualizerTilt'\)\)/, '本体必须懒加载（R54 那条）');
  const entryBare = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(entryBare, /settingsPanels|renderSettingsPanel|resetSettings/,
    '面板那一格按 R1/R168 同一形状切除（判据先剥注释：理由里写着这些词，R166/R168 同一课）');
  const body = read(`${FOLIA}/components/visualizer/tilt/VisualizerTilt.tsx`);
  assert.match(body, /import \{ useTranslation \} from '\.\.\/\.\.\/\.\.\/i18n\/config'/, 'tilt 的文案走自撰 shim');
  assert.doesNotMatch(body, /from ['"]react-i18next['"]/, '不得直连 react-i18next（本仓没这个依赖）');
  assert.match(body, /tiltTuning = DEFAULT_TILT_TUNING/, '宿主没喂参数时吃这份默认值（本仓还没有 tunings 存储，见 Q51）');
  // "随机斜体强调"必须**随行固定**：布局在 useMemo 里算，依赖表就是那五样。
  // 少了这一格，表现是"每次重渲染字都跳位"（宿主每帧都在重渲染岛）。
  assert.match(body, /\}, \[activeLine\?\.fullText, activeLine\?\.startTime, tiltTuning, theme, lyricsFontScale\]\);/,
    'tilt 的布局要按"行文本 + 起时 + 参数 + 主题 + 字号"缓存，不许每次渲染重算一遍');
  // tilt 唯一的一份新工具：只有类型 import（不拖新闭包），且导出面就是那一个类
  const layout = read(`${FOLIA}/utils/lyrics/sentenceLayout.ts`);
  assert.match(layout, /^import type \{ LyricLayoutUnit \} from '\.\/cjkSemanticLayout';$/m,
    'sentenceLayout 只依赖一个类型（它不牵进新闭包，这是 tilt 闭包只有三份的原因）');
  assert.match(layout, /export \{ SentenceLayout \}/, '导出面在案（tilt 读的就是这一个符号）');
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of ['components/visualizer/tilt/entry.tsx', 'components/visualizer/tilt/VisualizerTilt.tsx', 'utils/lyrics/sentenceLayout.ts'])
    assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
  for (const rel of ['components/visualizer/tilt/entry.tsx', 'components/visualizer/tilt/VisualizerTilt.tsx', 'utils/lyrics/sentenceLayout.ts']) {
    const bare = read(`${FOLIA}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, `${rel} 里出现了网络调用`);
    assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${rel} 里写死了第三方主机`);
  }
});


test('R33：宿主偏好 foliaView 校验 + 控制条切换键在位', () => {  const app = read('src/music-app.ts');
  assert.match(app, /\["classic", "lattice"\]\.includes\(preferences\.foliaView\)/, '非法偏好必须回落 classic');
  assert.match(app, /case "folia-layout"/, '切换动作要有分支');
  assert.match(app, /islandHandle\.setLayout\(/, '切换经岛 handle，不另起一套状态');
  const controls = read('src/lyric-controls.ts');
  assert.match(controls, /data-action="folia-layout"/, '控制条要有切换键');
  assert.match(controls, /layoutButton\.disabled = !snapshot\.layoutAvailable/, '岛没挂上时禁用');
  assert.match(read('src/folia-host/island.tsx'), /layout: "classic" \| "lattice"|IslandLayout/, '岛内布局态存在');
});

test('R36/R37/R34：主题变量只写进岛容器；lattice 动作面的能力差在案；SongResult 带封面', () => {
  const island = read('src/folia-host/island.tsx');
  for (const v of ['--bg-color', '--text-primary', '--text-secondary', '--text-accent'])
    assert.ok(island.includes(`"${v}"`), `岛容器应写入 ${v}`);
  // 上游令牌名不得出现在宿主全局样式表里（只在移植 CSS 与岛 inline 里）
  for (const f of ['src/music.css', 'src/music-theme.css', 'src/style.css', 'src/lyric-stage.css', 'src/lyric-folia-chrome.css'])
    assert.doesNotMatch(read(f), /--(?:bg-color|text-primary|text-secondary|text-accent)\s*:/, `${f} 不得定义上游主题令牌`);
  const adapter = read('src/folia-host/adapter.ts');
  // R37 登记的能力差，2026-10-07 由 R109 补上一半：内核有了播放模式。
  // 这里从"钉住缺失"改成"钉住接通"：loopMode 必须是**读时算**的 getter（这个对象每次挂载建一次
  // 并长期持有，写成常量就永远读不到内核的变化），两个动作必须转交内核，且岛内不许自己存一份模式。
  assert.match(adapter, /get loopMode\(\): "off" \| "all" \| "one"/, '循环模式要由内核算，不许是常量');
  assert.match(adapter, /player\.cyclePlaybackMode\(\)/, '岛内循环按钮接内核（R37 的能力差已补上循环/随机这一半）');
  assert.match(adapter, /player\.setPlaybackMode\(target\)/, '岛内随机按钮接内核');
  assert.match(adapter, /options\.notifyPlaybackMode\?\.\(/, '岛内改了模式要转交宿主落盘，岛里不自存一份');
  assert.doesNotMatch(adapter, /loopMode: "(?:off|all|one)" as const/, '循环模式不许退回成常量：那等于把 R109 又关掉');
  // R37 剩下的那一半在 2026-10-09 由 R130/R131 补完：收藏接上、命令面板做出来。
  // 与上面循环那一半同样的做法——从"钉住缺失"改成"钉住接通"，两条都不许退回去。
  assert.match(adapter, /toggleSongLike: \(\) => \{\s*options\.toggleSongLike\?\.\(\)/, '岛内收藏转交宿主（数据在本机一份 JSON，岛不持有）');
  assert.match(adapter, /get isSongLiked\(\)/, '收藏态要是 getter：这个对象长期持有，写成常量就永远读不到宿主的最新状态');
  assert.match(adapter, /invokeCommandById: \(commandId: string\) =>/, '命令面板的 id 要真的转出去（R37 剩下的最后一半）');
  assert.match(adapter, /canInvokeCommandById: \(commandId: string\) =>/, '能不能执行由宿主回答，岛里不另判一份');
  assert.doesNotMatch(adapter, /canInvokeCommandById: \(\) => false/, '不许退回"一律不可用"');
  assert.doesNotMatch(adapter, /isSongLiked: false/, '不许退回常量 false');
  assert.match(read(`${FOLIA}/types.ts`), /coverUrl\?: string/, 'R34：album.coverUrl 字段在位');
});

test('改写台账齐备：第二期 R25~R39 全在', () => {
  const log = read('../memory/folia-port-rewrite-log.md');
  for (const id of ['R25', 'R26', 'R27', 'R28', 'R29', 'R30', 'R31', 'R32', 'R33', 'R34', 'R35', 'R36', 'R37', 'R38', 'R39'])
    assert.ok(log.includes(`**${id} `), `台账缺 ${id}`);
});

test('R53：未登记的移植文件必须与上游逐字一致（改写白名单外不得有差异）', () => {
  const UP = join(APP, '..', 'references', 'folia-major', 'src');
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  /** 剥掉我们插入的移植头（块注释，含 "Ported from folia-major"）。 */
  const stripHeader = (text) => {
    const m = /^\/\*+\s*\n[\s\S]*?Ported from folia-major[\s\S]*?\*\/\n?/.exec(text);
    return m ? text.slice(m[0].length) : text;
  };
  const norm = (text) => stripHeader(text).replace(/\r\n/g, '\n').trim();
  let identical = 0;
  const offenders = [];
  for (const rel of manifest) {
    const ours = join(APP, 'src', 'folia', rel);
    const upstream = join(UP, rel);
    if (!existsSync(ours) || !existsSync(upstream)) continue; // 自撰 stub 与清单差异由别的断言管
    if (REWRITE_ALLOWLIST.has(rel)) continue;
    if (norm(readFileSync(ours, 'utf8')) === readFileSync(upstream, 'utf8').replace(/\r\n/g, '\n').trim()) identical += 1;
    else offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `这些文件与上游不一致却没登记改写理由：${offenders.join(', ')}`);
  assert.ok(identical >= 240, `逐字一致的文件数异常（${identical}），复制环节可能被覆盖`);
});

test('R36/R54：每个视觉模式各自成 chunk，pixi 只落一个动态共享块', () => {
  const assets = join(APP, 'dist', 'assets');
  if (!existsSync(assets)) return; // 未 build 时跳过（静态断言仍生效）
  const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
  const pixiChunks = js.filter((f) => read(`dist/assets/${f}`).includes('PixiJS'));
  assert.ok(pixiChunks.length, '构建产物里没有 pixi chunk（可能未 build）');
  // pixi 会被 rollup 拆成若干动态共享块（如滤镜单独成块），不变的是：入口与岛都拿不到它。
  const html = read('dist/index.html');
  const islandChunk = js.find((f) => f.startsWith('island-'));
  assert.ok(islandChunk, '缺 island chunk');
  assert.doesNotMatch(read(`dist/assets/${islandChunk}`), /PixiJS/, '岛 chunk 自身不得含 pixi');
  for (const chunk of pixiChunks) {
    assert.doesNotMatch(html, new RegExp(chunk.replace('.', '\\.')), 'pixi chunk 不得被入口引用');
    assert.doesNotMatch(read(`dist/assets/${islandChunk}`), new RegExp(chunk.replace('.', '\\.')), 'pixi chunk 不得被岛 chunk 静态引用');
  }
  for (const mode of ['VisualizerLumiere', 'VisualizerSonnet', 'VisualizerTempera', 'VisualizerMonet', 'VisualizerCadenza', 'VisualizerPartita', 'VisualizerStill', 'VisualizerTilt', 'VisualizerCladdagh', 'VisualizerPendolo', 'VisualizerCappella', 'VisualizerFume', 'Lattice'])
    assert.ok(js.some((f) => f.startsWith(`${mode}-`)), `缺 ${mode} 独立 chunk`);
});

test('R41~R45：五个新边界 stub 在位，且零新增重依赖（shaders/twgl/dexie 不得进包）', () => {
  for (const f of [
    `${FOLIA}/mods/folium/registries/stageLayers.tsx`,
    `${FOLIA}/mods/folium/registries/tunings.tsx`,
    `${FOLIA}/services/videoLayerFile.ts`,
    `${FOLIA}/services/temperaLayerImages.ts`,
    `${FOLIA}/services/temperaImageArchive.ts`,
  ]) {
    assert.ok(existsSync(join(APP, f)), `缺 stub：${f}`);
    assert.match(read(f), /本项目自撰（AGPL-3\.0-only）/, `${f} 缺自撰标记`);
  }
  const pkg = JSON.parse(read('package.json'));
  for (const banned of ['@paper-design/shaders-react', 'twgl.js', 'animejs', 'dexie', 'react-i18next', 'i18next'])
    assert.equal(pkg.dependencies?.[banned] ?? pkg.devDependencies?.[banned], undefined, `${banned} 不该进依赖`);
  for (const f of walk(FOLIA))
    assert.doesNotMatch(read(f), /from ["'](?:@paper-design\/shaders-react|twgl\.js|dexie)["']/, `${f} 引用了背景/持久化子系统的重依赖`);
});

test('R46/R47：视觉模式注册表 + 宿主偏好 + 岛内 plumbing', () => {
  const registry = read(`${FOLIA}/components/visualizer/registry.tsx`);
  assert.match(registry, /import lumiereEntry from "\.\/lumiere\/entry"/, 'lumiere 必须静态注册');
  assert.match(registry, /import sonnetEntry from "\.\/sonnet\/entry"/, 'sonnet 必须静态注册');
  assert.match(registry, /import temperaEntry from "\.\/tempera\/entry"/, 'tempera 必须静态注册');
  // R166（任务十二·模式一）/R167（模式二）：加一档就要动这一张表——这条断言**故意**钉死整张表的
  // 成员集合（多一档少一档都红），让"悄悄多一档没走验收"不可能发生（每加一档：i18n 补表 +
  // 两主题截图 + 宿主可选，三关都要过）。集合判据按名字数，不按数组那一行的写法——写法会变，成员不许变。
  assert.match(registry, /import monetEntry from "\.\/monet\/entry"/, 'monet 必须静态注册');
  assert.match(registry, /import cadenzaEntry from "\.\/cadenza\/entry"/, 'cadenza 必须静态注册');
  assert.match(registry, /import partitaEntry from "\.\/partita\/entry"/, 'partita 必须静态注册');
  assert.match(registry, /import stillEntry from "\.\/still\/entry"/, 'still 必须静态注册');
  assert.match(registry, /import tiltEntry from "\.\/tilt\/entry"/, 'tilt 必须静态注册');
  assert.match(registry, /import claddaghEntry from "\.\/claddagh\/entry"/, 'claddagh 必须静态注册');
  assert.match(registry, /import pendoloEntry from "\.\/pendolo\/entry"/, 'pendolo 必须静态注册');
  assert.match(registry, /import cappellaEntry from "\.\/cappella\/entry"/, 'cappella 必须静态注册');
  assert.match(registry, /import fumeEntry from "\.\/fume\/entry"/, 'fume 必须静态注册');
  const table = /const entries: VisualizerRegistryEntry\[\] = \[([\s\S]*?)\];/.exec(registry)?.[1] ?? '';
  const listed = [...table.matchAll(/(\w+Entry),/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed,
    ['cadenzaEntry', 'cappellaEntry', 'claddaghEntry', 'classicEntry', 'fumeEntry', 'lumiereEntry', 'monetEntry', 'partitaEntry', 'pendoloEntry', 'sonnetEntry', 'stillEntry', 'temperaEntry', 'tiltEntry'],
    '静态表必须恰好这十三个模式（数组写法随 prettier 变，成员集合不许变）');
  const types = read(`${FOLIA}/types.ts`);
  assert.match(types, /export const DEFAULT_LUMIERE_TUNING: LumiereTuning = \{/, '绘光默认参数须在案（R46）');
  assert.match(types, /export const DEFAULT_SONNET_TUNING: SonnetTuning = \{/, '十四行默认参数须在案（R49）');
  assert.match(types, /export const DEFAULT_TEMPERA_TUNING: TemperaTuning = \{/, '蛋彩默认参数须在案（R52）');
  assert.match(types, /export const TEMPERA_MAX_LAYER_IMAGES = 16/, '图层池上限常量须在案（R52）');
  const island = read('src/folia-host/island.tsx');
  assert.match(island, /export type FoliaMode = "cadenza" \| "cappella" \| "claddagh" \| "classic" \| "fume" \| "lumiere" \| "monet" \| "partita" \| "pendolo" \| "sonnet" \| "still" \| "tempera" \| "tilt"/, '岛内模式联合');
  assert.match(island, /setMode: \(mode\) => useIslandUi\.setState\(\{ mode \}\)/, 'setMode 经岛状态');
  assert.match(island, /mode=\{mode\}/, 'VisualizerRenderer 的 mode 由岛状态驱动，不得写死');
  // R51 那条判据（"岛底色取主题歌词底"）**已被用户终审翻掉**（R196：垫层全部撤掉、菜单浮在画面上）。
  // 判据改成"岛容器不许再写自己的底色，但主题令牌照旧写"——R51 想解决的问题（透明背景模式压在浅色页面上）
  // 现在由**主题自己的页面底**接手（岛下面就是 #stage 的页面底）+ 文字的 4.5 下限（R181/R185）。
  assert.doesNotMatch(island, /host\.style\.background = theme\.backgroundColor/,
    'R196：岛容器不许再写自己的底色（那就是"垫层"）');
  assert.match(island, /host\.style\.setProperty\("--bg-color", theme\.backgroundColor\)/,
    'R196：主题令牌照旧要写（封面墙海报配色读的就是它）');
  const app = read('src/music-app.ts');
  assert.match(app, /\["cadenza", "cappella", "claddagh", "classic", "fume", "lumiere", "monet", "partita", "pendolo", "sonnet", "still", "tempera", "tilt"\]\.includes\(preferences\.foliaMode\)/, '非法模式回落 classic');
  assert.match(app, /islandHandle\?\.setMode\(next\)/, '模式经岛 handle 下传');
  assert.match(app, /Folia 视觉模式/, '设置面板要有模式一节');
  assert.match(app, /case "folia-mode-lumiere":/, '模式动作要有分支');
  // 表里有这一档、宿主没有对应分支 = 点了没反应（R121 那一族），所以两件事要一起咬住。
  assert.match(app, /case "folia-mode-monet":/, 'monet 那一档也要有动作分支');
  assert.match(app, /\{ id: "monet", name: "莫奈"/, '宿主那张模式表里要有莫奈（名字取上游 zh-CN 的 ui.visualizerModes.monet）');
  // R167 同一对：分支与表里的名字缺任何一个，表现都是"设置面板里那颗点了没反应"。
  assert.match(app, /case "folia-mode-cadenza":/, 'cadenza 那一档也要有动作分支');
  assert.match(app, /\{ id: "cadenza", name: "心象"/, '宿主那张模式表里要有心象（上游 zh-CN 的 ui.visualizerCadenze 就是「心象」，不改成字面直译「华彩」）');
  // R168 同一对。
  assert.match(app, /case "folia-mode-partita":/, 'partita 那一档也要有动作分支');
  assert.match(app, /\{ id: "partita", name: "云阶"/, '宿主那张模式表里要有云阶（上游 zh-CN 的 ui.visualizerPartita）');
  // R170（第十四批·档一 still）同一对。
  assert.match(app, /case "folia-mode-still":/, 'still 那一档也要有动作分支');
  assert.match(app, /\{ id: "still", name: "静止"/, '宿主那张模式表里要有静止（上游 zh-CN 的 ui.visualizerStill）');
  // R171 同一对。
  assert.match(app, /case "folia-mode-tilt":/, 'tilt 那一档也要有动作分支');
  assert.match(app, /\{ id: "tilt", name: "倾诉"/, '宿主那张模式表里要有倾诉（上游 zh-CN 的 ui.visualizerTilt，不改成字面直译「倾斜」）');
  // R174 同一对。
  assert.match(app, /case "folia-mode-claddagh":/, 'claddagh 那一档也要有动作分支');
  assert.match(app, /\{ id: "claddagh", name: "回环"/, '宿主那张模式表里要有回环（上游 zh-CN 的 ui.visualizerCladdagh）');
  // R175 同一对。
  assert.match(app, /case "folia-mode-pendolo":/, 'pendolo 那一档也要有动作分支');
  assert.match(app, /\{ id: "pendolo", name: "时计"/, '宿主那张模式表里要有时计（上游 zh-CN 的 ui.visualizerPendolo）');
  assert.match(app, /case "folia-mode-cappella":/, 'cappella 那一档也要有动作分支');
  assert.match(app, /\{ id: "cappella", name: "群唱"/, '宿主那张模式表里要有群唱（上游 zh-CN 的 ui.visualizerCappella）');
  assert.match(app, /case "folia-mode-fume":/, 'fume 那一档也要有动作分支');
  assert.match(app, /\{ id: "fume", name: "浮名"/, '宿主那张模式表里要有浮名（上游 zh-CN 的 ui.visualizerFume）');
});

test('R48：移植区不得再出现 react-i18next / i18next 直接依赖（一律经 i18n shim）', () => {
  for (const f of walk(FOLIA)) {
    if (f === `${FOLIA}/i18n/config.ts`) continue; // shim 自己的注释里会提到上游包名
    assert.doesNotMatch(read(f), /from ["'](?:react-)?i18next["']/, `${f} 仍直连 i18next`);
  }
});

test('R50：移植区不得残留 @/ 别名（本仓不加 tsconfig paths）', () => {
  for (const f of walk(FOLIA))
    assert.doesNotMatch(read(f), /from ["']@\//, `${f} 仍有 @/ 别名 import`);
});

test('F3：R30 封面 stub 不得按专辑 id 造 /api/artwork URL（无封面专辑会打 404）', () => {
  const stub = read(`${FOLIA}/services/onlineMusic/songMetadata.ts`);
  assert.match(stub, /R30 自撰 stub/, '这个文件必须是自撰 stub（不在移植清单里），否则本断言要跟着搬家');
  assert.doesNotMatch(stub, /`\/api\/artwork\/\$\{/, '不得凭空拼 artwork 路径：无封面专辑的 coverUrl 本就没有，拼出来必然 404（第四期封面墙实测）');
  // F3 的契约是"只认宿主注入进来的字段、取不到就 null，绝不凭空拼路径"。**值从哪几格读**会随需求变
  //（看板 95fe081 之后多了"曲目自己那张封面"这一格），所以这里钉的是形状判据而不是那行赋值原文——
  // 行为面由 check-music-wall-covers 的"跳④"用例逐档钉（曲目优先 / 退专辑 / 都没有给 null）。
  // 判据只看代码：文件里那段"这里曾按 album.id 拼 …"的注释正是 F3 的案底，剥掉注释再查才不会误伤。
  const code = stub.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /\/api\/artwork/, '代码里不该出现任何 artwork 字面量（宿主给什么就用什么）');
  assert.match(code, /coverUrl:[\s\S]{0,120}\?\? null,/, '取不到封面时返回 null，交给封面墙自己的占位路径');
});

test('R174：档一 claddagh（回环）——两份逐字件、面板那一格按 R1/R168/R171 形状切除', () => {
  assert.deepEqual(localTuningCells('DEFAULT_CLADDAGH_TUNING', 'CladdaghTuning'),
    upstreamTuningCells('DEFAULT_CLADDAGH_TUNING'),
    '默认参数与上游不一致（这一档决定"没调过设置时长什么样"）');
  const entry = read(`${FOLIA}/components/visualizer/claddagh/entry.tsx`);
  assert.match(entry, /mode: 'claddagh'/);
  assert.match(entry, /order: 80/, '排序号照搬上游');
  assert.match(entry, /labelKey: 'ui\.visualizerCladdagh'/, '键名照抄（上游 zh-CN 里这一档叫「回环」）');
  assert.match(entry, /tuningKind: 'claddagh'/, '这一档吃 tuning');
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/VisualizerCladdagh'\)\)/, '本体必须懒加载（R54 那条）');
  const entryBare = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(entryBare, /settingsPanels|renderSettingsPanel|resetSettings/,
    '面板那一格按 R1/R168/R171 同一形状切除（判据先剥注释，R166/R168 同一课）');
  // 被这一格挡在外面的东西仍然"确实没进来"
  for (const rel of ['components/visualizer/settingsPanels.tsx', 'components/visualizer/diorama/cameraPath.ts'])
    assert.equal(existsSync(join(APP, 'src', 'folia', rel)), false, `${rel} 不该出现在移植区（diorama 本体不做）`);
  const body = read(`${FOLIA}/components/visualizer/claddagh/VisualizerCladdagh.tsx`);
  // 这一档连 i18n 都不引（不像 cadenza / partita / tilt 要改 shim 那一行）⇒ 白名单里只该有 R0 一条
  assert.doesNotMatch(body, /from ['"]react-i18next['"]/, '本仓没有 react-i18next 依赖');
  assert.doesNotMatch(body, /from ['"](pixi\.js|three)['"]/, '这一档是 DOM + canvas2D + framer-motion，不许拖进渲染引擎');
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of ['components/visualizer/claddagh/entry.tsx', 'components/visualizer/claddagh/VisualizerCladdagh.tsx'])
    assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
  for (const rel of ['components/visualizer/claddagh/entry.tsx', 'components/visualizer/claddagh/VisualizerCladdagh.tsx']) {
    const bare = read(`${FOLIA}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, `${rel} 里出现了网络调用`);
    assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${rel} 里写死了第三方主机`);
  }
});

test('R175：档二 pendolo（时计）——十三份全部逐字、白名单零新增、面板与 tuning 两头都在', () => {
  assert.deepEqual(localTuningCells('DEFAULT_PENDOLO_TUNING', 'PendoloTuning'),
    upstreamTuningCells('DEFAULT_PENDOLO_TUNING'),
    '默认参数与上游不一致（十格决定"没调过设置时长什么样"）');
  const dir = 'components/visualizer/pendolo/';
  const files = ['entry.tsx', 'VisualizerPendolo.tsx', 'PendoloSettingsPanel.tsx', 'PendoloActiveLyricSweep.tsx',
    'PendoloClockworkCanvas.tsx', 'PendoloRotatingLine.tsx', 'pendoloColorRuns.ts', 'pendoloGeometry.ts',
    'pendoloMotionProfile.ts', 'pendoloSubtitleTracks.ts', 'pendoloTextLayout.ts', 'pendoloTimeline.ts', 'tuning.ts'];
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of files.map((f) => dir + f)) {
    assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
    // 这一档一份都不该在白名单里：port-folia 报 stripped 0，也没有 i18next / 别名要改
    assert.equal(REWRITE_ALLOWLIST.has(rel), false, `${rel} 不该出现在改写白名单里（这一档是零改写）`);
  }
  const entry = read(`${FOLIA}/${dir}entry.tsx`);
  assert.match(entry, /mode: 'pendolo'/);
  assert.match(entry, /order: 100/, '排序号照搬上游');
  assert.match(entry, /labelKey: 'ui\.visualizerPendolo'/, '上游 zh-CN 里这一档叫「时计」');
  assert.match(entry, /tuningKind: 'pendolo'/, '这一档吃 tuning');
  // 面板与 tuning 两头都在：这是 R173 之后第一档"参数真的能从界面走到画面"的模式
  assert.match(entry, /renderSettingsPanel: props => <PendoloSettingsPanel \{\.\.\.props\} \/>/,
    'pendolo 的面板是档内自有的（不像 partita/tilt 在七档共用那份里）⇒ 不切，切了就等于把 R173 白做');
  assert.match(entry, /resetSettings/, '重置那一格也留着（面板上有那颗按钮）');
  assert.match(entry, /key=\{props\.seed\}/, '换曲时按 seed 重挂歌词轮盘（上游注释明写这条语义）');
  const tuning = read(`${FOLIA}/${dir}tuning.ts`);
  assert.match(tuning, /mode: 'pendolo'/, 'tuning.ts 在案：R173 之后它是通道，不是死代码');
  assert.match(tuning, /pendoloTuning: tuning/, '适配器把 bundle 那一格摊到 pendoloTuning 上');
  // 这一档的"钟表盘"是 canvas2D 画的（PendoloClockworkCanvas），但**不许**因此拖进渲染引擎
  const canvas = read(`${FOLIA}/${dir}PendoloClockworkCanvas.tsx`);
  assert.match(canvas, /getContext\('2d'\)/, '表盘走 canvas2D（这一档的真实形状）');
  for (const rel of files.map((f) => dir + f)) {
    const bare = read(`${FOLIA}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(bare, /from ['"](pixi\.js|three)['"]/, `${rel} 不许引入 pixi / three`);
    assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, `${rel} 里出现了网络调用`);
    assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${rel} 里写死了第三方主机`);
  }
  // 面板上那些文案必须全在 shim 表里，否则界面上就是裸 key（R162 那条扫描的正身）
  const shim = read(`${FOLIA}/i18n/config.ts`);
  const have = new Set([...shim.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  const missing = [];
  // entry 的 labelKey 不上屏（getVisualizerModeLabel 全仓零调用方）⇒ 与 monet/cadenza/partita/tilt 同一处置：不扫 entry。
  for (const rel of files.filter((f) => f !== 'entry.tsx')) {
    const src = read(`${FOLIA}/${dir}${rel}`);
    for (const m of src.matchAll(/'([a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)'/g)) {
      if (!have.has(m[1])) missing.push(`${rel} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `这些文案会以裸 key 的形式出现在用户眼前：${missing.join(' | ')}`);
});
test('R176：档三 cappella（群唱）——五份逐字、面板那一格切除、素材只搬表情不搬头像', () => {
  assert.deepEqual(localTuningCells('DEFAULT_CAPPELLA_TUNING', 'CappellaTuning'),
    upstreamTuningCells('DEFAULT_CAPPELLA_TUNING'),
    '默认参数与上游不一致（三格决定"没调过设置时长什么样"，其中 avatarSource 就是缺省头像来源）');
  const dir = 'components/visualizer/cappella/';
  const files = ['entry.tsx', 'VisualizerCappella.tsx', 'avatarImages.ts', 'cappellaMessageSenders.ts', 'emoImages.ts'];
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of files.map((f) => dir + f)) {
    assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
  }
  // 这一档两份有登记改写（entry 切面板、本体剥注入 + i18next 改指 shim），其余三份必须逐字
  assert.equal(REWRITE_ALLOWLIST.has(`${dir}entry.tsx`), true, 'entry 切了面板那一格 ⇒ 必须在白名单里带理由');
  assert.equal(REWRITE_ALLOWLIST.has(`${dir}VisualizerCappella.tsx`), true, '本体有 R0 + R52 两处改写');
  for (const rel of ['avatarImages.ts', 'cappellaMessageSenders.ts', 'emoImages.ts'].map((f) => dir + f)) {
    assert.equal(REWRITE_ALLOWLIST.has(rel), false, `${rel} 应当逐字（不该出现在改写白名单里）`);
  }
  // 与档一同一个决定：面板没搬 ⇒ tuning.ts 也不进（通道另一头没人喂）
  assert.equal(manifest.includes(`${dir}tuning.ts`), false,
    'cappella 的 tuning.ts 不进：面板按 R1/R168/R171/R174 形状切除 ⇒ 今天没有人写这一格，塞一份永不执行的 adapter 是假装有通道');
  const entry = read(`${FOLIA}/${dir}entry.tsx`);
  assert.match(entry, /mode: 'cappella'/);
  assert.match(entry, /order: 110/, '排序号照搬上游');
  assert.match(entry, /labelKey: 'ui\.visualizerCappella'/, '上游 zh-CN 里这一档叫「群唱」');
  assert.match(entry, /tuningKind: 'cappella'/, '这一档吃 tuning（字面量保留，切除的只有面板那一格）');
  // 先剥注释再查：文件头那句理由里就出现 "settingsPanels" 这个词（R166 那一课的第三次复发）
  const entryBare = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(entryBare, /renderSettingsPanel|resetSettings|CappellaSettingsPanel|settingsPanels/,
    '面板那一格必须切干净（留着就会把共用面板 + 六份 diorama 设置件 + cameraPath 一起拖进包里）');
  assert.match(entry, /render: props => <VisualizerCappella \{\.\.\.props\} \/>/);
  // 共用面板与 diorama 那一片挡在门外（与 R174 同一判据）
  assert.equal(existsSync(join(APP, FOLIA, 'components/visualizer/settingsPanels.tsx')), false, '共用面板不许进移植区');
  assert.equal(existsSync(join(APP, FOLIA, 'components/visualizer/diorama/cameraPath.ts')), false, 'diorama 那一片不许被顺手带进来');
  // ── 素材这一格是这一档特有的：决定要能被断言，否则下次谁"顺手把头像也补上"没人拦 ──
  const emoDir = join(APP, FOLIA, 'components/visualizer/cappella/emo');
  const upEmoDir = join(APP, '..', 'references', 'folia-major', 'src', 'components', 'visualizer', 'cappella', 'emo');
  const pngs = (d) => readdirSync(d).filter((f) => /\.png$/i.test(f)).sort();
  if (existsSync(upEmoDir)) {
    assert.deepEqual(pngs(emoDir), pngs(upEmoDir), '表情图清单与上游不一致（少一张就是缺图，多一张就是来路不明）');
    for (const f of pngs(emoDir)) {
      const ours = readFileSync(join(emoDir, f));
      const up = readFileSync(join(upEmoDir, f));
      assert.ok(ours.equals(up), `${f} 与上游不是逐字节相同（素材不许被悄悄替换、压缩或改名）`);
    }
    assert.ok(pngs(emoDir).length >= 9, `表情图应有 9 张，实际 ${pngs(emoDir).length}`);
  }
  const avatarDir = join(APP, FOLIA, 'components/visualizer/cappella/avatar');
  assert.ok(existsSync(join(avatarDir, 'README.md')), '头像目录要留一份说明（为什么这里一张图都没有）');
  assert.deepEqual(pngs(avatarDir), [], '内置头像 16 张**不随包发行**（决定与许可出处见 public/licenses/cappella-assets-folia-major.txt）');
  // 空池的回落由移植件自己负责，这两处形状变了就要重看上面那条决定
  const avatars = read(`${FOLIA}/${dir}avatarImages.ts`);
  assert.match(avatars, /glob<[^>]*>\(\s*'\.\/avatar\/\*\.\{png/, '头像走 glob 扫目录（目录空 ⇒ 集合空，不是构建失败）');
  assert.match(avatars, /if \(avatars\.length === 0\) \{\s*return null;/, '空池必须显式回 null（我们不分发头像就靠这一格兜住）');
  assert.match(avatars, /if \(avatarSource === 'cover' && coverUrl\) \{\s*return coverUrl;/, '缺省 cover 时读的是歌曲封面，不读池子');
  const body = read(`${FOLIA}/${dir}VisualizerCappella.tsx`);
  assert.match(body, /useAvatarGridCrop \|\| !avatarUrl/, '拿不到头像地址时画色块（不是破图）');
  assert.match(body, /import \{ useTranslation \} from '\.\.\/\.\.\/\.\.\/i18n\/config';/, 'i18next 改指本仓 shim（R52）');
  assert.doesNotMatch(body, /from ['"]react-i18next['"]/, '本仓零 i18next 依赖（基线）');
  const bare = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(bare, /from ['"](pixi\.js|three)['"]/, '这一档不许引入 pixi / three');
  assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, '渲染件里不许有网络调用');
  assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, '渲染件里不许写死第三方主机');
  // 画面上的文案必须全在 shim 表里，否则用户看见裸 key（R162 那条扫描的正身）
  const shim = read(`${FOLIA}/i18n/config.ts`);
  const have = new Set([...shim.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  const missing = [];
  for (const rel of files.filter((f) => f !== 'entry.tsx')) {
    const src = read(`${FOLIA}/${dir}${rel}`);
    for (const m of src.matchAll(/'([a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)'/g)) {
      if (!have.has(m[1])) missing.push(`${rel} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `这些文案会以裸 key 的形式出现在用户眼前：${missing.join(' | ')}`);
});
test('R177：档四 fume（浮名）——十六份逐字、面板那一格切除、满屏堆叠走 canvas2D 不引渲染引擎', () => {
  assert.deepEqual(localTuningCells('DEFAULT_FUME_TUNING', 'FumeTuning'),
    upstreamTuningCells('DEFAULT_FUME_TUNING'),
    '默认参数与上游不一致（八格决定"没调过设置时长什么样"，含最后一格 heroScale）');
  const dir = 'components/visualizer/fume/';
  const files = ['entry.tsx', 'VisualizerFume.tsx', 'fumeArticleLayout.ts', 'fumeBlockFrame.ts', 'fumeCamera.ts',
    'fumeCameraStep.ts', 'fumeCanvasText.ts', 'fumeLiveRaster.ts', 'fumeMath.ts', 'fumeReveal.ts', 'fumeStage.ts',
    'fumeTextMeasure.ts', 'fumeTextStyle.ts', 'fumeTypes.ts', 'useFumeCanvasStage.ts'];
  const all = [...files.map((f) => dir + f), 'components/visualizer/FumeBackground.ts'];
  const manifest = JSON.parse(read('scripts/folia-port-manifest.json')).entries;
  for (const rel of all) assert.ok(manifest.includes(rel), `${rel} 不在复制清单里（R53 的逐字校验就管不到它了）`);
  // 两份登记改写：entry 切面板、fumeCamera 剥注入三行；其余十四份必须逐字
  assert.equal(REWRITE_ALLOWLIST.has(`${dir}entry.tsx`), true, 'entry 切了面板那一格 ⇒ 必须在白名单里带理由');
  assert.equal(REWRITE_ALLOWLIST.has(`${dir}fumeCamera.ts`), true, 'fumeCamera 剥了三行注入注释（R0）');
  for (const rel of all.filter((r) => r !== `${dir}entry.tsx` && r !== `${dir}fumeCamera.ts`)) {
    assert.equal(REWRITE_ALLOWLIST.has(rel), false, `${rel} 不该出现在改写白名单里（这一档除那两份外零改写）`);
  }
  // 与档一/档三同理：面板没搬 ⇒ tuning.ts 也不进（通道另一头没人喂）
  assert.equal(manifest.includes(`${dir}tuning.ts`), false,
    'fume 的 tuning.ts 不进：面板按同一形状切除 ⇒ 今天没有人写这一格，塞一份永不执行的 adapter 是假装有通道');
  const entry = read(`${FOLIA}/${dir}entry.tsx`);
  assert.match(entry, /mode: 'fume'/);
  assert.match(entry, /order: 60/, '排序号照搬上游');
  assert.match(entry, /labelKey: 'ui\.visualizerFume'/, '上游 zh-CN 里这一档叫「浮名」');
  assert.match(entry, /tuningKind: 'fume'/, '这一档吃 tuning（字面量保留，切除的只有面板那一格）');
  assert.match(entry, /previewStartOffset: 18\.4/, '预览起点照搬（这一档的预览帧要落在有字的那一段）');
  const entryBare = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(entryBare, /renderSettingsPanel|resetSettings|FumeSettingsPanel|settingsPanels/,
    '面板那一格必须切干净（留着就会把共用面板 + 六份 diorama 设置件 + cameraPath 一起拖进包里）');
  assert.match(entry, /React\.lazy\(\(\) => import\('\.\/VisualizerFume'\)\)/, '本体必须懒加载（R54 那条）');
  // 共用面板与 diorama 那一片挡在门外
  for (const rel of ['components/visualizer/settingsPanels.tsx', 'components/visualizer/diorama/cameraPath.ts',
    'components/visualizer/diorama/dioramaMoteField.ts']) {
    assert.equal(existsSync(join(APP, FOLIA, rel)), false, `${rel} 不许进移植区（它是被切掉那一格的依赖）`);
  }
  // 这一档的真实形状：满屏文字层是 canvas2D 画的，但**不许**因此拖进渲染引擎
  const raster = read(`${FOLIA}/${dir}useFumeCanvasStage.ts`);
  assert.match(raster, /getContext\(['"]2d['"]\)/, '舞台走 canvas2D（这一档的真实形状）');
  for (const rel of all) {
    const bare = read(`${FOLIA}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(bare, /from ['"](pixi\.js|three)['"]/, `${rel} 不许引入 pixi / three`);
    assert.doesNotMatch(bare, /\bfetch\s*\(|XMLHttpRequest|new WebSocket/, `${rel} 里出现了网络调用`);
    assert.doesNotMatch(bare, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${rel} 里写死了第三方主机`);
  }
  // 画面上的文案必须全在 shim 表里（entry 的 labelKey 不上屏 ⇒ 与先例同一处置：不扫 entry）
  const shim = read(`${FOLIA}/i18n/config.ts`);
  const have = new Set([...shim.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  const missing = [];
  for (const rel of files.filter((f) => f !== 'entry.tsx')) {
    const src = read(`${FOLIA}/${dir}${rel}`);
    for (const m of src.matchAll(/'([a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)'/g)) {
      if (!have.has(m[1])) missing.push(`${rel} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `这些文案会以裸 key 的形式出现在用户眼前：${missing.join(' | ')}`);
});

test('R183：三档参数面板文案（lumiere/sonnet/tempera）—— 面板渲染出的文本里不许出现未解析的 options./OPTIONS.', () => {
  // 用户报"歌词调整模式也没有用中文说明"：模式**选择卡**是中文的（13 档全有说明），而**逐档参数面板**
  // 的中文化是"逐档补 shim 词表"的 —— R162/R166/R175 那几条扫描的清单里只有 monet / pendolo 两档的面板，
  // 这三档的面板从上线起点就是整片裸 key。这条判据把这三档钉住（口径取自用户要求：渲染出的文本里
  // 不许出现未解析的 `options.` / `OPTIONS.` 前缀 —— 大写也收，免得以后有人换个写法绕过去）。
  // 判据面 = **渲染出来的那一整棵子树**，不是"面板那一个文件"：
  // 真机抓到 tempera 的「画布图片」那一节渲染的是 `TemperaImageLayerControls.tsx`，
  // 而它不在我第一版的清单里（`options.temperaLayerImageHint` / `options.temperaAddLayerImage` 因此漏网）。
  const panels = {
    lumiere: ['components/visualizer/lumiere/LumiereSettingsPanel.tsx'],
    sonnet: ['components/visualizer/sonnet/SonnetSettingsPanel.tsx'],
    tempera: [
      'components/visualizer/tempera/TemperaSettingsPanel.tsx',
      'components/visualizer/tempera/TemperaImageLayerControls.tsx',
      'components/visualizer/tempera/TemperaImageLayerDialog.tsx',
      'components/visualizer/tempera/TemperaImageImportMenu.tsx',
      'components/visualizer/tempera/TemperaImagePlacementEditor.tsx',
    ],
  };
  const shim = read(`${FOLIA}/i18n/config.ts`);
  const have = new Set([...shim.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
  const missing = [];
  for (const [mode, rels] of Object.entries(panels)) {
    for (const rel of rels) {
      const src = read(`${FOLIA}/${rel}`);
      // 判据面 = 面板里出现的**每一个** options.* 字面量 —— 含 slider()/toggle() 的行标签，
      // 它们自己不直接调 t()（那一课见 R166：只认 `t('…')` 会漏掉三元与包装函数里的 key）。
      for (const m of src.matchAll(/['"]([oO][pP][tT][iI][oO][nN][sS]\.[A-Za-z0-9_]+)['"]/g)) {
        if (!have.has(m[1])) missing.push(`${mode} · ${rel.split('/').pop()} → ${m[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `这些文案会以裸 key 的形式出现在用户眼前：${missing.join(' | ')}`);
  // 反向：这三档真的补进来了 —— 免得"表里一条 options.lumiere* 都没有"也能绿（判据要两边都咬）。
  for (const prefix of ['options.lumiere', 'options.sonnet', 'options.tempera']) {
    assert.ok([...have].some((k) => k.startsWith(prefix)), `shim 里一条 ${prefix}* 都没有 ⇒ 面板还是裸 key`);
  }
  // 三档各自的开头那两句（面板标题 + 一句说明）逐字比上游 zh-CN —— 标题/说明是最先上屏的两格，
  // 抄错就是用户第一眼看到的错（基准 commit 同文件，与 R166/R175 同一口径）。
  const upstream = readFileSync(join(APP, '..', 'references', 'folia-major', 'src', 'i18n', 'locales', 'zh-CN.ts'), 'utf8');
  for (const [key, zh] of [
    ['lumiereSettings', '绘光参数'], ['lumiereSettingsDesc', '调整绘光的体积光、烟雾、光学线稿与歌词被照亮的方式。'],
    ['sonnetSettings', '商籁参数'], ['sonnetSettingsDesc', '调整商籁场景运动、纹理分辨率，以及绘制的图层。建议搭配空 / Sora 背景。'],
    ['temperaSettings', '凝彩参数'], ['temperaSettingsDesc', '调整凝彩的色块构图、镜头运动与渲染质量。建议搭配空 / Sora 背景。'],
  ]) {
    assert.ok(upstream.includes(`"${key}": "${zh}"`), `上游 zh-CN 里找不到 ${key} ⇒ 基准可能换了，别拿这份稿当归宿`);
    assert.ok(shim.includes(`"options.${key}": "${zh}"`), `shim 里 ${key} 与上游不一致`);
  }
});

test('R201：蛋彩「图片层参数」——空池如实告知（整组无效控件门控在 poolAvailable 后）+ 无效文案不许无条件渲染', () => {
  // 用户报"导入不了"：图片池服务层是 R44 的自撰空桩（读取恒空、prepare 恒 null、isSupported 恒 false），
  // 上游也没有"默认图片"可搬 ⇒ 现状是"空壳上挂着完整 UI"（按钮点了永远 0/16、不报错）。
  // 本产品拍板：不搬素材管理 ⇒ 隐藏整组无效控件 + 如实告知，两个**真有效**的参数（图层位置 / 出现频率）保留。
  const stub = read(`${FOLIA}/services/temperaLayerImages.ts`);
  assert.match(stub, /export const TEMPERA_LAYER_IMAGE_POOL_AVAILABLE = false;/,
    '空池这条事实必须由服务层（空桩）说明，且是 false —— 它不是渲染侧各自判断的第二个真相');

  const DIALOG = 'components/visualizer/tempera/TemperaImageLayerDialog.tsx';
  const CONTROLS = 'components/visualizer/tempera/TemperaImageLayerControls.tsx';
  const dialog = read(`${FOLIA}/${DIALOG}`);
  const controls = read(`${FOLIA}/${CONTROLS}`);
  for (const [name, src] of [[DIALOG, dialog], [CONTROLS, controls]]) {
    assert.match(src, /TEMPERA_LAYER_IMAGE_POOL_AVAILABLE/, `${name} 必须读那个单一出处`);
  }

  // ① 对话框：无效控件（添加 / 导出 / 清空 / 导入菜单 / 拖放提示）必须全部落在"池可用"的守卫之后。
  //    两条守卫形态都要认：`headerActions={poolAvailable ? (…) : undefined}` 与 `{poolAvailable && (…)}`。
  //    判据 = 每一个入口 key 的**第一次**出现都在**第一次**出现 `poolAvailable` 之后
  //    （R126 的课：判据要落在那句守卫上，别只查"变量存在"）。
  assert.match(dialog, /headerActions=\{poolAvailable \? \(/, 'R201：清空全部那颗按钮必须门控在 poolAvailable 上');
  assert.match(dialog, /\{poolAvailable && \(/, 'R201：底部那一整组（添加/导入/导出）必须门控在 poolAvailable 上');
  const firstGuard = dialog.indexOf('poolAvailable');
  for (const key of [
    'options.temperaAddLayerImage',
    'options.temperaExportImages',
    'options.temperaClearLayerImages',
  ]) {
    const at = dialog.indexOf(key);
    assert.ok(at > 0 && at > firstGuard,
      `R201：${key} 的取值点落在守卫之前 ⇒ 空池时这颗控件仍会渲染出来（用户点了永远 0/16）`);
  }
  // 导入菜单是独立组件（它自己那份 `options.temperaImportImages` 在别处），这里钉住它只在守卫内被挂载
  // —— 组件不挂载，它里面那颗「导入备份」就不可能渲染。
  assert.match(dialog, /poolAvailable && \([\s\S]*?<TemperaImageImportMenu/, '导入菜单必须在守卫内挂载');

  // ② 拖放提示与拖放处理器同一条守卫（空池时拖进去也没有去处）。
  assert.match(dialog, /poolAvailable && !full &&/, '拖放提示必须门控在 poolAvailable 之后');
  assert.match(dialog, /onDrop=\{poolAvailable \? handleDrop : undefined\}/, '空池时拖放处理器不许挂上去');

  // ③ 实话文案：两个渲染点（对话框正文 / 摘要行提示）都读同一句，且该句在 shim 里。
  const shim = read(`${FOLIA}/i18n/config.ts`);
  assert.match(shim, /"options\.temperaPoolUnavailable": "本产品未启用自定义图片池：此面板仅可调整图层位置与出现频率。"/,
    '实话文案必须在 shim 里逐字在案');
  for (const [name, src] of [[DIALOG, dialog], [CONTROLS, controls]]) {
    assert.match(src, /t\('options\.temperaPoolUnavailable'\)/, `${name} 必须渲染那句实话`);
  }
  // ③b 更强的判据：那句实话必须**出现在空池分支里**，且是"池不可用"那一侧的取值
  //    （只查"文件里有没有这个 key"会被绕过 —— 把空池那句换回旧文案、只留别处一处，文件里仍有这个 key，
  //     但用户看到的还是"还没有图片"。所以判据落在空池分支里的那三元选择上。）
  const emptyBranch = /images\.length === 0 \? \(([\s\S]*?)\) : \(/.exec(dialog)?.[1] ?? '';
  assert.ok(emptyBranch, 'R201：对话框里应有一段 `images.length === 0 ? (…) : (…)` 的空池分支');
  assert.match(emptyBranch, /\{poolAvailable\s*\?\s*\(t\('options\.temperaLayerImageEmpty'\)[\s\S]*?:\s*\(t\('options\.temperaPoolUnavailable'\)/,
    'R201：空池分支必须是"池可用才说旧的池提示、否则说那句实话"的三元选择');

  // ③c 对话框的描述行同一条守卫：空池时不许再说"每个分镜会从图片池里随机取一张"。
  assert.match(dialog, /description=\{poolAvailable\s*\n?\s*\?[\s\S]*?options\.temperaPoolUnavailable/,
    'R201：描述行必须门控在 poolAvailable 上，空池时说那句实话');

  // ③d 摘要行（TemperaImageLayerControls）的提示同样门控：读的是那个单一出处，两处出口各说各的实话。
  assert.match(controls, /\{TEMPERA_LAYER_IMAGE_POOL_AVAILABLE[\s\S]*?options\.temperaPoolUnavailable/,
    'R201：摘要行提示必须读那个单一出处，并给出那句实话');

  // ④ 入口定名：`options.temperaImageSection` 从「画布图片」改成「图片层参数」（定名理由见 shim 注释）。
  assert.match(shim, /"options\.temperaImageSection": "图片层参数"/, '入口文案要改成「图片层参数」');
  assert.doesNotMatch(shim, /"options\.temperaImageSection": "画布图片"/, '旧文案（让人以为能传图）不许留着');

  // ⑤ 两个**有效**参数照常保留（它们走宿主 tuning 层，与空池无关）——判据钉 key，不钉布局。
  assert.match(dialog, /options\.temperaLayerImageDepth/, '「图层位置」必须在案');
  assert.match(dialog, /options\.temperaLayerImageFrequency/, '「出现频率」必须在案');
  assert.match(dialog, /onDepthChange/, '图层位置必须是可调的（有回调，不是只读）');
  assert.match(dialog, /onFrequencyChange/, '出现频率必须是可调的');

  // ⑥ 计数 `0 / 16` 保留（它是真实的，不是无效控件）。
  assert.match(dialog, /t\('options\.temperaImagePoolCount',/, '「0 / 16」计数要保留');

  // ⑦ 白名单：这两份移植件的改写理由必须点名 R201（本批改了它们）。
  for (const rel of [DIALOG, CONTROLS]) {
    const reason = REWRITE_ALLOWLIST.get(rel) ?? '';
    assert.match(reason, /R201/, `${rel} 的改写理由必须登记 R201（空池如实告知）`);
  }
});
