// 阶段 6 · T1 主题入口断言。
// 三套主题必须在「类型 / UI 清单 / CSS 令牌 / 3D 令牌」四层同时存在，
// 且 UI 只从单一清单派生——防止再出现 ["day","night"] 这类二值硬编码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCENE_THEMES } from '../src/music-scene-theme.ts';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../src/music-app.ts');
const switchCss = read('../src/music-theme-switch.css');
const musicCss = read('../src/music.css');

const THEMES = ['day', 'dusk', 'night'];
const TOKENS = ['--ink', '--muted', '--line', '--accent', '--surface', '--panel', '--page-bg', '--veil'];

const block = (selector) =>
  musicCss.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
const pageBg = (theme) =>
  (theme === 'day' ? block('.music-app') : block(`.music-app[data-theme="${theme}"]`))
    .match(/--page-bg: (#[0-9a-f]{6})/i)?.[1];

test('Theme 由单一清单派生，二值硬编码清干净', () => {
  assert.match(app, /const THEMES = \["day", "dusk", "night"\] as const;/);
  assert.match(app, /type Theme = \(typeof THEMES\)\[number\];/);
  assert.doesNotMatch(app, /\["day", "night"\]/, '还留着二值清单');
  assert.doesNotMatch(app, /theme !== "day" && theme !== "night"/, '还留着旧白名单');
  assert.doesNotMatch(app, /! \["day", "night"\]\.includes/, '偏好校验还在用二值清单');
  assert.equal(app.match(/THEMES\.map\(/g)?.length, 2, '顶栏胶囊与设置卡片两处都要从清单派生');
  const names = app.match(/const themeNames: Record<Theme, string> = \{([^}]*)\}/)?.[1] ?? '';
  assert.equal(names.match(/:\s*"/g)?.length, 3, 'themeNames 要三套名称');
});

test('每套主题在 CSS 令牌与 3D 令牌两层同名同步', () => {
  for (const theme of THEMES) {
    assert.ok(Object.hasOwn(SCENE_THEMES, theme), `3D 令牌缺 ${theme}`);
    if (theme === 'day') continue; // day 是 .music-app 基态
    const css = block(`.music-app[data-theme="${theme}"]`);
    assert.ok(css, `CSS 令牌缺 ${theme}`);
    for (const token of TOKENS) assert.ok(css.includes(`${token}:`), `${theme} 的 CSS 覆盖块缺 ${token}`);
  }
  const base = block('.music-app');
  for (const token of TOKENS) assert.ok(base.includes(`${token}:`), `基态缺 ${token}`);
});

test('meta theme-color 走三值表，day/dusk 与 --page-bg 同值', () => {
  assert.match(app, /const themeColors: Record<Theme, string> = \{/);
  assert.doesNotMatch(app, /theme === "night" \? "#/, '还留着二值三元表达式');
  assert.equal(pageBg('day'), '#e8e5e1');
  assert.equal(pageBg('dusk'), '#cbd6df');
  for (const theme of ['day', 'dusk'])
    assert.ok(app.includes(`${theme}: "${pageBg(theme)}"`), `themeColors 里 ${theme} 应与 --page-bg 同值`);
  // night 沿用底座既有值，与 --page-bg(#08121f) 有意不同，本轮不改
  assert.ok(app.includes('night: "#0a1220"'), 'night 保持底座既有值');
  // 取证发现的缺陷：启动路径只写 dataset.theme，不动 meta，于是持久化主题刷新后
  // 浏览器界面色仍是 index.html 里的 day 默认值（night 也一样，不是 dusk 新引入）。
  const boot = app.slice(app.indexOf('stage.dataset.theme = preferences.theme;'));
  assert.match(boot.slice(0, 400), /setMetaThemeColor\(preferences\.theme\)/, '启动时要按持久化主题写 meta');
  assert.equal(app.match(/setMetaThemeColor\(/g)?.length, 2, '启动与 setTheme 两处都要调用');
});

test('设置面板三张卡片，dusk 有自己的预览与圆点', () => {
  assert.match(musicCss, /\.theme-cards \{\s*display: grid;\s*grid-template-columns: repeat\(3, 1fr\)/);
  assert.match(musicCss, /\.theme-cards \.dusk i \{/, 'dusk 卡片预览渐变');
  assert.match(musicCss, /\.theme-dot\.dusk \{/, 'dusk 胶囊圆点');
  assert.match(app, /const themeHints: Record<Theme, string> = \{/, '卡片文案要走三值表');
  assert.doesNotMatch(app, /t === "day" \? "暖白玻璃与日光"/, '卡片文案还留着三元表达式');
});

test('主题滑块三档：宽度三等分，位移按 DOM 序递进', () => {
  // 100% = 胶囊 padding box；3 个按钮 + 2 个 4px 间距 + 左右各 3px 内边距
  assert.match(switchCss, /width: calc\(\(100% - 14px\) \/ 3\);/, '滑块宽度要三等分');
  assert.match(switchCss, /\.music-app\[data-theme="dusk"\] \.theme-switch::before \{\s*transform: translateX\(calc\(100% \+ 4px\)\);/);
  assert.match(switchCss, /\.music-app\[data-theme="night"\] \.theme-switch::before \{\s*transform: translateX\(calc\(200% \+ 8px\)\);/);
  assert.doesNotMatch(switchCss, /between the two theme labels/, '文件头注释还写着两档');
});

test('portrait 下三个带文字的按钮放得下，网格列宽与胶囊同宽', () => {
  const width = Number(switchCss.match(/data-layout="portrait"\] \.theme-switch \{\s*display: flex;\s*width: (\d+)px;/)?.[1]);
  assert.ok(width >= 143, `portrait 胶囊宽度 ${width}px 放不下三个带文字的按钮（实测约需 143px）`);
  const column = Number(switchCss.match(/grid-template-columns: 28px 28px (\d+)px 28px minmax\(0, 1fr\);/)?.[1]);
  assert.equal(column, width, '网格列宽必须等于胶囊宽度，否则胶囊被挤压或换行');
});

// —— Task 3：Folia 内的档位跟随主题（分层优先规则第 2、4 条）——
const stageTs = read('../src/lyric-stage.ts');
const chromeCss = read('../src/lyric-folia-chrome.css');

test('Folia：主题决定档位，换主题不重新解码封面', () => {
  assert.match(stageTs, /theme\?: \(\) => PaletteTheme;/, '舞台要能读当前主题');
  assert.match(stageTs, /tierForTheme\(theme\(\)\)/, '档位由主题映射，不在舞台里写死');
  assert.match(stageTs, /loadCoverStats\(/, '封面统计要能缓存复用');
  assert.match(stageTs, /refreshTheme: applyPalette/, '对外暴露 refreshTheme，且它就是重新推导那一步');
  assert.match(stageTs, /let coverStats: CoverStats \| null = null;/, '要缓存封面统计');
  assert.match(app, /theme: \(\) => preferences\.theme,/, 'music-app 必须把主题喂给舞台');
  assert.match(app, /lyricStage\.refreshTheme\(\);/, 'setTheme 必须通知舞台');
  // setTheme 是唯一入口，且通知发生在 data-theme 落地之后
  const body = app.match(/function setTheme\(theme: Theme\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(body.indexOf('stage.dataset.theme = theme;') < body.indexOf('lyricStage.refreshTheme();'),
    '要先写 data-theme 再通知舞台，否则舞台读到的是旧主题');
});

test('四档底色都有 --folia-back 分支，且始终回退令牌', () => {
  assert.match(chromeCss, /--folia-back: var\(--folia-ink, var\(--page-bg\)\);/, 'ink 是无 data-tier 时的基态');
  for (const tier of ['tinted', 'dusk', 'rich']) {
    assert.match(
      chromeCss,
      new RegExp(`\\.lyric-stage\\[data-tier="${tier}"\\] \\{\\s*--folia-back: var\\(--folia-${tier}, var\\(--page-bg\\)\\);`),
      `${tier} 档缺 --folia-back 分支`,
    );
  }
  // 七个派生变量都要在失败时被摘掉，也都要真的被消费（否则写了没人读）
  for (const name of ['--folia-ink', '--folia-tinted', '--folia-dusk', '--folia-rich',
    '--folia-primary', '--folia-secondary', '--folia-accent']) {
    assert.ok(stageTs.includes(`"${name}",`), `FOLIA_VARS 缺 ${name}，失败时会残留`);
    assert.ok(
      chromeCss.includes(`var(${name},`) || read('../src/lyric-stage.css').includes(`var(${name},`),
      `${name} 没有被消费`,
    );
  }
  assert.doesNotMatch(chromeCss, /@property --folia-/, '注册 @property 会吃掉令牌回退分支');
});

// ── 第四期 Task 9 + 2026-10-04 定案「联网默认打开」：设置面板「在线能力」分区 ──
test('在线能力分区默认已勾选，且不复用 onlineEnabled（那是 MusicBrainz 的补全开关，R61）', () => {
  const types = read('../src/music-types.ts');
  assert.match(types, /onlineLyrics\?: \{ enabled: boolean \}/, '快照类型里 onlineLyrics 仍是可选的（旧快照没这一项时由前端落回默认）');
  assert.match(types, /缺省即开启/, '类型注释要说清新的默认方向，别留下"缺省即关闭"的过期说明');
  assert.match(app, /onlineLyrics: \{ enabled: true \}/, '首轮快照之前内存里的默认值必须是开启（与服务端 ONLINE_DEFAULTS 同向）');
  assert.match(app, /onlineEnabled: true,\n\s*onlineLyrics/, 'MusicBrainz 那一项的占位默认同样开启');
  assert.doesNotMatch(app, /onlineLyrics: \{ enabled: false \}/, '前端不得再留"默认关闭"的字面量');

  // 子开关表（R77 的界面兑现，第五期 Task 7 补三张、M3-c 补第四张 `covers`）：
  // 勾选框由 ONLINE_SWITCHES_UI 生成，所以这里判"表里的 key 集合与服务端 ONLINE_SWITCHES 逐字相等"。
  // 双向都要成立：服务端多一项而界面没有 ⇒ 那句"可在设置里重新勾选"是假指引；
  // 界面多一项而服务端没有 ⇒ 是一个管不了任何东西的空勾选框（M3-c 之前 covers 就属于这一档，故当时明令不许加）。
  const switchTable = /const ONLINE_SWITCHES_UI = \[([\s\S]*?)\] as const;/.exec(app)?.[1] ?? '';
  assert.ok(switchTable.length > 100, '没抓到在线开关表');
  const uiKeys = [...switchTable.matchAll(/key: "(\w+)"/g)].map((match) => match[1]);
  const serverKeys = /ONLINE_SWITCHES = \[([^\]]*)\]/.exec(read('../scripts/music-library.mjs'))?.[1]
    .split(',').map((entry) => entry.trim().replaceAll("'", '')) ?? [];
  assert.deepEqual(uiKeys, serverKeys, `界面开关表与服务端开关表不齐：界面 ${uiKeys.join('/')} vs 服务端 ${serverKeys.join('/')}`);
  for (const key of ['lyrics', 'search', 'streaming', 'covers']) {
    assert.match(switchTable, new RegExp(`key: "${key}"`), `开关表缺 ${key}（服务端有这张子开关，界面就必须管得着它）`);
  }
  const toggle = /id="online-\$\{entry\.key\}-enabled"/.exec(app)?.[0] ?? '';
  assert.ok(toggle, '勾选框要按开关表生成 id');
  assert.match(app, /library\.online\?\.\[entry\.key\] !== false \? "checked" : ""/, '勾选态来自那四张子开关，且缺省即开启');
  assert.doesNotMatch(app, /online-lyrics-enabled" \$\{config\.onlineLyrics/, '这个框不再由旧的 onlineLyrics 镜像驱动');
  // 两个开关必须在 DOM 与提交体里都各走各的，否则一个勾会改两件不同的事。
  assert.match(app, /id="online-enabled"/, '资料库补全开关保持原样');
  assert.match(app, /onlineEnabled: \$<HTMLInputElement>\("#online-enabled"\)\.checked/, '资料库保存只提交 onlineEnabled');
  assert.match(app, /onlineLyrics: \{ enabled: wanted \}/, '在线歌词的旧通路仍只提交自己那一项');
});

test('默认开启后面板文案：标题与两处副说明都写"默认已开启，可在此关闭"，出网声明改为常驻段落', () => {
  const section = /onlineLyricsSection\.innerHTML = `([\s\S]*?)`;/.exec(app)?.[1] ?? '';
  assert.ok(section.length > 200, `没抓到在线能力分区的 HTML：${section.length}`);
  assert.match(section, /在线能力（默认已开启，可在此关闭）/, '小标题要说清默认方向与可关闭性');
  // 副说明从"写死在 HTML 里"搬进了开关表（三项各有一句），所以判表里的默认方向措辞。
  assert.match(app, /hint: "只为本地没有带时间轴歌词的曲目查询；关闭后这一类请求归零"/, '歌词那一项的副说明要说清范围与关闭后果');
  assert.match(app, /hint: "经本机中转的流式试听：音频字节不落盘、不缓存/, '试听那一项必须当面写明"不落盘"（这是它的红线）');
  assert.doesNotMatch(section, /默认关闭/, '不得再出现"默认关闭"字样');
  assert.doesNotMatch(section, /开启前会再确认/, '二次确认取消后，这句是假说明');
  assert.match(section, /\$\{esc\(ONLINE_LYRICS_DISCLOSURE\)\}/, '出网范围声明必须常驻面板（它原先只在确认框里）');
  assert.match(section, /data-role="online-lyrics-state"/, '当前状态行仍在');

  // MusicBrainz 那一项同步改文案（它现在也是默认开启）
  const configHtml = /configSection\.innerHTML = `([\s\S]*?)`;\n/.exec(app)?.[1] ?? '';
  assert.match(configHtml, /扫描后自动补充新专辑资料<small>默认已开启，可在此关闭/, '资料补全的副说明同步');
  assert.match(configHtml, /整轮跳过/, '没配联系方式时要说明"开关是开的但这轮跳过"，否则用户只看到没反应');

  // 状态行两个方向都要说清后果
  const status = /const onlineLyricsStatus = \(enabled: boolean\)[\s\S]*?;\n/.exec(app)?.[0] ?? '';
  assert.match(status, /已开启（默认）/, '开启态要点明这是默认');
  assert.match(status, /已关闭 —— 不发起任何在线请求/, '关闭态仍要给出"零请求"的说明（定案：关闭方向提示保留）');
});

test('在线能力的出网声明把来源、范围与"不下载"说全，且来源名与 provider 表同源', () => {
  const disclosure = /const ONLINE_LYRICS_DISCLOSURE =([\s\S]*?);\n/.exec(app)?.[1] ?? '';
  assert.ok(disclosure.length > 80, `说明文案太短：${disclosure.length}`);
  for (const phrase of ['本机', '不下载', '不改写音频标签', '不保存歌词到磁盘', '带时间轴', '127.0.0.1',
    'lyric-claims.json', '不含歌词正文', '不含任何账号凭据']) {
    assert.ok(disclosure.includes(phrase), `说明文案缺"${phrase}"`);
  }
  // R149（Q21）：新加的那句与"不保存歌词到磁盘"必须**并存且互相解释得通**。
  // 顺序也是判据：先说"不保存歌词到磁盘"，再说那份只记身份的认领记录 —— 反过来说就成了自相矛盾。
  const noSaveAt = disclosure.indexOf('不保存歌词到磁盘');
  const claimsAt = disclosure.indexOf('lyric-claims.json');
  assert.ok(noSaveAt >= 0 && claimsAt > noSaveAt, '认领记录那句必须排在"不保存歌词到磁盘"之后，两句一起才自洽');
  assert.match(disclosure, /只记“哪一家的哪一首被认下来了”/, '要说清那份文件记的是身份不是内容');
  assert.match(disclosure, /取消认领|删掉那个文件/, '还要说清怎么撤（可撤销的东西不该让人猜）');
  assert.match(disclosure, /联网状态/, '默认开启后第一句就该说这是联网行为，不用等确认框提示');
  // 来源名与 provider 表**逐字同源**：表里有的名字，文案里必须都有；文案里写了表里没有的名字也算漂移。
  // （第四期这条只钉了"QQ/AMLL"两个字面量，扩到四源后就地换成按表核对。）
  const client = read('../src/lyrics-client.ts');
  const labels = [...client.matchAll(/^\s+(?:qq|netease|amll|kugou):\s*"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(labels, ['QQ', '网易云', 'AMLL', '酷狗'], 'provider 标签表本身要还是这四家、这个顺序');
  for (const label of labels) assert.ok(disclosure.includes(label), `说明文案缺来源名"${label}"`);
  const score = read('../scripts/online-match-score.mjs');
  assert.match(score, /LYRIC_SOURCES = \['qq', 'netease', 'amll', 'kugou'\]/, '服务端源集合已变，文案要同步');
  assert.match(read('../src/lyric-stage.ts'), /ONLINE_PROVIDER_LABELS\[loaded\.provider \?\? "qq"\]/,
    '徽标读的是那张共享表，不再各写一份三元表达式');
});

test('开启方向不再有二次确认；保存失败回弹到改动前那一档（含内存快照一起）', () => {
  const handler = /async function applyOnlineLyricsSwitch[\s\S]*?\n}\n/.exec(app)?.[0] ?? '';
  assert.ok(handler.length > 200, '没抓到开关的处理函数');
  assert.doesNotMatch(handler, /window\.confirm/, '联网默认打开 ⇒ 取消"勾选前确认"（为一个已生效的行为再点一次头没有意义）');
  assert.match(handler, /const before = library\.onlineLyrics\?\.enabled === true/, '先记下改动前那一档');
  assert.match(handler, /toggle\.checked = before/, '回弹回 before，而不是硬写 false —— 默认开启后硬写 false 会把用户刚做的关闭悄悄做实');
  assert.match(handler, /library = \{ \.\.\.library, onlineLyrics: \{ enabled: before \} \}/, '回弹时内存快照一起改回，否则注入点还会去请求');
  assert.match(handler, /回弹为\$\{before \? "开启" : "关闭"\}/, 'notify 要说清回弹到了哪一档');
  // 开关即时生效：注入点每次匹配前读的就是这份内存快照。
  assert.match(app, /if \(!library\.onlineLyrics\?\.enabled\) return null/, '关闭时在线注入点直接回 null');
});

// ── 阶段 6.6 Task 2：F2 岛内底色跟随当前主题 ──────────────────────────────
test('F2：主题过渡收敛后必须再刷一次岛内主题桥（同步读计算样式会读到过渡起点的值）', () => {
  const setTheme = (/function setTheme\(theme: Theme\) \{[\s\S]*?\n\}/.exec(app) ?? [''])[0];
  assert.ok(setTheme.length > 200, '没抓到 setTheme 本体');
  assert.match(setTheme, /refreshHostTheme\(\);/, '即时刷新要保留：派生色未注册 @property，有封面路径当场就正确');
  assert.match(setTheme, /refreshHostThemeAfterTransition\(\);/, '还要补一次过渡收敛后的刷新');
  const helper = (/function refreshHostThemeAfterTransition\(\)[\s\S]*?\n\}/.exec(app) ?? [''])[0];
  assert.ok(helper.length > 200, '没抓到收敛刷新的实现');
  assert.match(helper, /propertyName !== ['"]--page-bg['"]/, '只认主题令牌自身的过渡结束，别被 background-color 之类提前触发');
  assert.match(helper, /\}, 900\)/, '必须有兜底定时器：过渡被跳过或事件不派发时也要收敛');
  assert.match(helper, /hostThemeSettleToken/, '要有序号守卫，快速连点时旧排程不得覆盖新档');
});

test('6.6：专辑架分组是独立控件，chrome 文案跟分组轴走（不与排序互相赋值）', () => {
  assert.match(app, /id="music-shelf-layout"/, '缺少分组下拉');
  assert.match(app, /id="music-sort"/, '排序下拉保持原样');
  assert.match(app, /const shelfLabels: Record<MusicShelfLayout/, 'chrome 文案要有分组标签表');
  assert.match(app, /const shelfLabel = shelfLabels\[shelfLayoutPreference\];/, 'chrome 读的是分组轴，不再读排序轴');
  assert.match(app, /const resolved = stored && SHELF_LAYOUTS\.includes\(stored\) \? stored : preferences\.sortMode;/, '缺省/非法一律由排序轴推导（老偏好升级零观感变化）');
  // 两个控件各自只写自己的偏好
  const sortHandler = /if \(el\.id === "music-sort"[\s\S]{0,300}?\n  \}/.exec(app)?.[0] ?? '';
  assert.ok(sortHandler, '没找到排序 change 分支');
  assert.doesNotMatch(sortHandler, /shelfLayout/, '排序控件不得写分组偏好');
  const shelfHandler = /if \(el\.id === "music-shelf-layout"[\s\S]{0,320}?\n  \}/.exec(app)?.[0] ?? '';
  assert.ok(shelfHandler, '没找到分组 change 分支');
  assert.match(shelfHandler, /preferences\.shelfLayout = el\.value as MusicShelfLayout;/, '分组 change 要写 shelfLayout');
  assert.match(shelfHandler, /location\.reload\(\);/, '沿用排序既定的"切换后刷新页面"（本期不热切换）');
  assert.doesNotMatch(shelfHandler, /preferences\.sortMode/, '分组控件不得反向写排序偏好');
  // 计划里那句"每 12 张一列"的说明已经与实现不符，留着就是假文案
  assert.doesNotMatch(app, /每 12 张一列/, '面板说明不得再写"每 12 张一列"');
  // chrome 三处（步进按钮 aria、列计数前缀、快捷键说明）与无障碍说明都必须读 shelfLabel
  const chrome = app.slice(app.indexOf('<div class="genre-stepper">'), app.indexOf('<div class="music-keyhint">') + 200);
  assert.match(chrome, /上一个\$\{shelfLabel\.column\}/, '步进按钮 aria 跟分组轴');
  assert.match(chrome, /\$\{shelfLabel\.code\} <span id="genre-index"/, '列计数前缀跟分组轴');
  assert.match(chrome, /↑ ↓ \$\{shelfLabel\.rows\}/, '快捷键说明里"一行是什么"跟分组轴（专辑档=曲目）');
  assert.match(app, /左右切\$\{shelfLabel\.column\}，上下切\$\{shelfLabel\.rows\}/, '无障碍说明同样改读分组轴');
});

// ── R189（任务三）："当前模式的参数"面板美化 ──────────────────────────────────────────────
// 面板本体是移植件（`*SettingsPanel.tsx`），观感统一收在宿主侧：CSS 在 music.css，
// 滑杆的填充比例由 `mode-settings.tsx` 每次提交后补写（原生 range 自己不带这个信息）。
// 两条硬约束：① 颜色只走宿主令牌（写死十六进制 = R181"亮底翻车"那一族的根）；
//            ② 不往宿主全局样式表里定义上游主题令牌名（R36 那条判据扫的就是这个）。
test('R189：面板美化的三条都落在宿主侧，颜色全走令牌', async () => {
  const { rangeFillPercent } = await import('../src/folia-host/range-fill.ts');
  const css = musicCss;
  const glue = await read('../src/folia-host/mode-settings.tsx');
  const rootBlock = /#folia-mode-settings \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.ok(rootBlock, '#folia-mode-settings 这条规则还在');
  // ① 不许定义上游令牌名（R36）。字色靠"继承到我们自己的容器色"来做，不靠塞变量。
  assert.doesNotMatch(rootBlock, /--(?:bg-color|text-primary|text-secondary|text-accent)\s*:/,
    'R36：宿主样式表不许定义上游主题令牌名（面板里那几处 var(--text-*) 未定义就让它继承）');
  assert.doesNotMatch(css, /--(?:bg-color|text-primary|text-secondary|text-accent)\s*:/,
    'R36：整个 music.css 都不许出现这些令牌的定义');
  const bodyBlock = /#folia-mode-settings \.folia-mode-settings-body \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.match(bodyBlock, /color:\s*var\(--ink\)/, 'R189：面板正文色定在容器上（未定义的次色会继承到它）');
  // ② 滑杆行：数值从"两端顶满"改成"行内右侧"。判据必须带 `:has(> input.folia-tuning-range)`，
  //    否则 tempera 的"添加图片"那一行（同样用 justify-between，但**要**两端分开）会被一起改坏。
  const rowBlock = /#folia-mode-settings \.space-y-2:has\(> input\.folia-tuning-range\) > \.justify-between \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.ok(rowBlock, 'R189：滑杆行那条规则在（`:has` 是"只命中滑杆行"的判据）');
  assert.match(rowBlock, /justify-content:\s*flex-start/, 'R189：数值改行内右侧（不再两端顶满）');
  assert.match(css, /#folia-mode-settings section \{[^}]*border-top-color:\s*color-mix\(in srgb, var\(--ink\)/,
    'R189：节的分隔线换成令牌色（`border-white/10` 在亮底上等于没有）');
  assert.match(css, /#folia-mode-settings section > h3 \{[^}]*opacity:\s*1/,
    'R189：节标题不许靠 opacity 变淡（那是"亮底上读不出来"的老路）');
  // 预设组那几排按钮的字色来自**岛的主题变量**（对着岛底算的下限），而面板的底是浅的
  // ⇒ 黄昏档实测"近白的字压在浅底上 1.06:1"。判据：面板里按钮的字色也必须拉平到宿主令牌。
  assert.match(css, /#folia-mode-settings button \{\s*color:\s*var\(--ink\) !important;/,
    'R189：面板里按钮的字色要拉平到宿主令牌（岛那边算的下限在浅底上不成立）');
  assert.match(css, /#folia-mode-settings button\[disabled\] \{\s*opacity:\s*0?\.\d+ !important;/,
    'R189：禁用态要抬头不透明度（0.38 在浅底上读不出来）');
  // ③ 滑杆：轨道弱色 + 填充段主题色 + thumb 细描边
  const trackBlock = /\.folia-tuning-range::-webkit-slider-runnable-track \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const thumbBlock = /\.folia-tuning-range::-webkit-slider-thumb \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.ok(trackBlock && thumbBlock, 'R189：轨道与 thumb 两条都要在（不写就退回浏览器默认外观）');
  assert.match(css, /\.folia-tuning-range \{[^}]*appearance:\s*none/, 'R189：要自定义外观就必须关掉原生外观');
  assert.match(css, /\.folia-tuning-range \{[^}]*--tuning-range-fill:\s*0%/, 'R189：填充比例要有一个默认值');
  assert.match(trackBlock, /var\(--accent\) 0 var\(--tuning-range-fill\)/, 'R189：填充段是主题强调色');
  assert.match(trackBlock, /color-mix\(in srgb, var\(--ink\) 16%, transparent\)/, 'R189：轨道弱色也走令牌');
  assert.match(thumbBlock, /border:\s*2px solid var\(--accent\)/, 'R189：thumb 是细描边（不是一块实心橙）');
  assert.match(thumbBlock, /background:\s*var\(--panel\)/, 'R189：thumb 的填充也走令牌');
  for (const [name, block] of [['#folia-mode-settings', rootBlock], ['滑杆行', rowBlock], ['轨道', trackBlock], ['thumb', thumbBlock]])
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, `R189：${name} 这条里不许有写死的色值`);
  // ④ 接线：容器 + 每次提交后补写填充比例，且百分比来自那个纯函数
  assert.match(glue, /ref=\{bodyRef\}/, 'R189：要有我们自己的容器（滑杆填充靠它一次算完）');
  assert.match(glue, /React\.useEffect\(\(\) => \{ syncRangeFills\(bodyRef\.current\); \}\);/,
    'R189：每次提交后都要重算（不带依赖数组 ⇒ 每次渲染都跑）');
  assert.match(glue, /input\.style\.setProperty\("--tuning-range-fill", `\$\{rangeFillPercent\(value, min, max\)\}%`\)/,
    'R189：填充比例只有一个写入处，且走纯函数');
  assert.match(glue, /import \{ rangeFillPercent \} from "\.\/range-fill"/, 'R189：算式在那个零 import 的纯函数文件里');
  // ⑤ 纯函数本身的边界（0 / 中值 / 满 / 越界 / 非法）
  assert.equal(rangeFillPercent(0, 0, 2), 0);
  assert.equal(rangeFillPercent(1, 0, 2), 50);
  assert.equal(rangeFillPercent(2, 0, 2), 100);
  assert.equal(rangeFillPercent(3, 0, 2), 100, '超出上沿要夹住');
  assert.equal(rangeFillPercent(-1, 0, 2), 0, '低于下沿要夹住');
  assert.equal(rangeFillPercent(5, 2, 6), 75, '非 0 下沿也要对');
  assert.equal(rangeFillPercent(Number.NaN, 0, 2), 0, '非法值收成 0，不许出 NaN');
  assert.equal(rangeFillPercent(1, 2, 2), 0, '上下沿相等不许除零');
});

