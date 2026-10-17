import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveDisplayMode } from '../src/lyric-stage.ts'

const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/lyric-stage.css', import.meta.url), 'utf8')

test('displayMode 只接受 rhine / folia，其余回落演出模式', () => {
  assert.equal(resolveDisplayMode('folia'), 'folia')
  assert.equal(resolveDisplayMode('rhine'), 'rhine')
  for (const bad of [undefined, null, '', 'DUSK', 'night', 42, {}])
    assert.equal(resolveDisplayMode(bad), 'rhine', `fallback for ${String(bad)}`)
})

test('偏好里注册了 displayMode 与 lyricPulse 并带合法性校验', () => {
  assert.match(app, /displayMode: "rhine" as DisplayMode/, 'default in preferences')
  assert.match(app, /lyricPulse: "basic" as LyricPulseTier/, 'pulse default is basic')
  assert.match(app, /\["rhine", "folia"\]\.includes\(preferences\.displayMode\)/, 'mode validation')
  // R133 之后四档的合法集是一张具名表（面板选项 / 读取校验 / 写入校验共用它），
  // 判据跟着改指那张表——**判据本身没放宽**：仍然是"不在合法集里就回落 basic"。
  assert.match(app, /const LYRIC_PULSE_TIERS: readonly LyricPulseTier\[\] = \["off", "basic", "audio", "spectrum"\]/, 'pulse tier set is one named table')
  assert.match(app, /LYRIC_PULSE_TIERS\.includes\(preferences\.lyricPulse\)/, 'pulse validation')
})

test('歌词舞台是专辑详情的兄弟节点，不会被 renderDetail 重写', () => {
  const article = app.indexOf('<article id="album-detail-content"')
  const stage = app.indexOf('<section id="lyric-stage"')
  assert.ok(article > 0 && stage > article, 'stage markup must come after the article')
  const between = app.slice(article, stage)
  assert.match(between, /<\/article>/, 'article closed before the stage')
  assert.match(between, /<\/section>/, 'detail section closed before the stage')
})

test('歌词舞台层级低于顶栏与面板，避免遮挡控件', () => {
  const block = css.slice(css.indexOf('.lyric-stage {'), css.indexOf('.lyric-lines'))
  const z = Number(/z-index:\s*(\d+)/.exec(block)?.[1])
  assert.ok(z >= 4 && z <= 5, `z-index should sit in 4..5, got ${z}`)
  assert.match(block, /pointer-events:\s*none/, 'stage must not swallow canvas gestures')
})

test('L 键在输入态守卫之后注册，不会吃掉打字', () => {
  const guard = app.indexOf('"input, textarea, select, [contenteditable=true]"')
  const key = app.indexOf('e.key === "l" || e.key === "L"')
  assert.ok(guard > 0 && key > guard, 'the input guard must precede the L handler')
})

test('Folia 视图暂停三维渲染，歌词时钟取自播放元素', () => {
  assert.match(app, /const foliaStage = lyricViewWanted\(\);/)
  assert.match(app, /const parkScene = foliaStage && presentation\.phase === "detail";/)
  assert.match(app, /if \(!viewer\?\.isOpen && !parkScene\) scene\.update\(/, 'render loop gated')
  assert.match(app, /if \(foliaStage\) lyricStage\.applyTime\(player\.clockTime\(\)\)/, 'frame-accurate clock source')
  assert.doesNotMatch(app, /addEventListener\(\s*["']timeupdate["']/, 'the app must not poll timeupdate')
})

// 回归：定格必须等演出状态机落到 detail。状态机在 presentation.update() 里轮询只有
// scene.update() 才会推进的场景标志，若在 opening/switching 期间就定格三维，
// browse→detail 转场会永久卡死（实测：phase 停在 opening、菜单永不出现）。
test('回归：转场期间不得定格三维，歌词高亮则全程持续跟随', () => {
  const loop = app.slice(app.indexOf('function frame(ms: number)'), app.indexOf('requestAnimationFrame(frame)'))
  assert.ok(loop.includes('presentation.phase === "detail"'), 'parking must require the settled phase')
  assert.ok(
    loop.indexOf('const parkScene') < loop.indexOf('!parkScene) scene.update('),
    'the gate must be computed before the render call',
  )
  assert.ok(
    loop.indexOf('if (foliaStage) lyricStage.applyTime') < loop.indexOf('viewer?.update('),
    'lyric highlighting keeps running while the scene transitions',
  )
})

// F4 改了这条的边界：在线曲目没有"打开专辑"这一步，若 browse 一律不接管画面，
// 在线曲目的词就取到了却永远不上屏。所以判据从"是否在 browse"换成 lyricViewWanted()
// ——browse + 没有在线曲在播 ⇒ 只记偏好并提示（原行为）；browse + 在线曲在播 ⇒ 歌词面接管。
test('browse 按 L：没有在线曲在播时只记偏好并提示，有在线曲在播时歌词面接管（F4）', () => {
  const branch = app.slice(app.indexOf('function setDisplayMode'), app.indexOf('stage.dataset.display = displayMode;'))
  assert.match(branch, /if \(mode === "detail"\) \{/, 'detail applies the mode directly')
  assert.match(branch, /applyLyricView\(\);/, 'browse 走同一个判据，不再无条件把画面留在 Rhine')
  assert.match(branch, /if \(resolved === "folia" && !lyricViewWanted\(\)\) notify\("歌词模式将在打开专辑后生效"\)/, '提示只在"真的没生效"时才给')
  const predicate = /function lyricViewWanted\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? ''
  assert.match(predicate, /if \(displayMode !== "folia"\) return false;/, '演出模式一律不进歌词面')
  assert.match(predicate, /mode === "detail" \|\| player\.state\.currentTrack\?\.sourceKind === "online"/, 'detail 或在播的是在线曲目 ⇒ 进')
  assert.match(app, /lyricStage\.setMode\(wanted \? "folia" : "rhine"\);/, '退出歌词面要把舞台藏回去（在线曲播完不能留一张静止的字幕）')
  assert.match(app, /const foliaStage = lyricViewWanted\(\);\s*\n[^\n]*\n\s*applyLyricView\(\);/, '帧循环每帧对账一次')
})

const stage = await readFile(new URL('../src/lyric-stage.ts', import.meta.url), 'utf8')

// 应用内"减弱动效"是 JS 状态，媒体查询看不到它，必须由舞台自己同步到样式上。
test('减弱动效：应用内开关与系统媒体查询都要生效', () => {
  // 只断言 reduced 在这份解构里，不锁整串字面量：阶段 6 加 theme 取值器时，
  // 锁全串的版本会因为一个无关的追加而误报，而那并不是本条要守的东西。
  assert.match(stage, /const \{[^}]*\breduced\b[^}]*\} = options/, 'reduced must be read')
  assert.ok(stage.includes(`behavior: reduced?.() ? "auto" : "smooth"`), 'scroll must drop smooth')
  assert.ok(stage.includes(`root.classList.toggle("is-reduced", !!reduced?.())`), 'root class mirrors the switch')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'system query still honoured')
  assert.match(css, /\.lyric-stage\.is-reduced \.lyric-line,/, 'in-app switch drives the same rules')
  // 阶段 5.5 起动效改用 translate/scale/filter/text-shadow/animation，降级块必须逐条归零，
  // 只留 opacity 与 color —— 旧的 transform: none 写法已经不覆盖任何新动效。
  const reducedBlock = css.slice(css.indexOf('.lyric-stage.is-reduced .lyric-line,'))
  for (const prop of ['translate: none', 'scale: none', 'filter: none', 'text-shadow: none', 'animation: none', 'transition-delay: 0ms'])
    assert.ok(reducedBlock.includes(prop), `降级块缺 ${prop}`)
  assert.match(reducedBlock, /transition-property: opacity, color/, '降级后只保留淡入淡出')
  // 特异度：媒体查询若只写 .lyric-line（0,1,0），会输给 .lyric-line.is-active（0,2,0），
  // 系统级"减少动效"下入场与呼吸照跑不误。三级链压过所有双类规则。
  const query = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
  assert.match(query, /\.lyric-stage \.lyric-lines \.lyric-line,/, '系统媒体查询要用够特异度的选择器')
  assert.match(query, /\.lyric-stage \.lyric-lines \.lyric-word \{/, '逐字同理')
})

// 实测踩到：当前行居中用 scrollIntoView，它会连带滚动链上每个可滚动祖先。
// #stage 是 overflow:hidden —— 隐藏裁切并不妨碍被程序滚动，于是整层界面被顶上去
// （回读 .music-app.scrollTop=75、scrollHeight 1010 > clientHeight 935），
// 底部露出一条 75px 背景带，三维场景与歌词列一起偏移，且偏移量随换行变化。
// 这也是 browse→detail y 轴瞬态的同源机制，按验收要求升级为必须修复。
test('回归：当前行居中只在歌词列内部滚动，外壳不可被程序滚动', async () => {
  // 带点的调用形式才算命中：解释这段回归的注释里必然提到 scrollIntoView。
  assert.doesNotMatch(stage, /\.scrollIntoView\(/, '不得再用 scrollIntoView')
  assert.match(stage, /list\.scrollTo\(\{ top: target/, '只滚 .lyric-lines 自身')
  assert.match(stage, /row\.offsetTop \+ row\.offsetHeight/, '用 offsetTop 定位，避开入场动画污染 rect')
  assert.match(stage, /if \(!list\?\.isConnected\) return/, '列表被重建或摘除后不得继续滚')
  const linesBlock = css.slice(css.indexOf('.lyric-lines {'), css.indexOf('}', css.indexOf('.lyric-lines {')))
  assert.match(linesBlock, /position: relative/, 'offsetTop 必须以歌词列为参照，否则居中偏出十几像素')
  assert.match(linesBlock, /overflow: hidden/, '歌词列本身要可滚')
  const musicCss = await readFile(new URL('../src/music.css', import.meta.url), 'utf8')
  const shell = musicCss.slice(musicCss.indexOf('#stage.music-app {'))
  assert.match(shell, /overflow: clip/, '外壳用 clip：只裁切、不可被程序滚动')
  assert.doesNotMatch(shell.slice(0, shell.indexOf('}')), /overflow: hidden/, 'hidden 仍是滚动容器，不算修好')
})

// 实测踩到：换行时只清了 is-word-passed，旧行末尾那个 is-word-active 的字永久顶着
// 强调色（截图里上一行的"析"字在歌词换到下一行后仍是橙色）。
test('回归：换行时上一行的当前字强调色一并清除', () => {
  const apply = stage.slice(stage.indexOf('function applyTime('), stage.indexOf('function setMode('))
  const change = apply.slice(apply.indexOf('if (lineIndex !== activeLine)'), apply.indexOf('const line = lines[activeLine]'))
  assert.ok(change.length > 20, '换行分支必须能定位到')
  assert.match(change, /classList\.remove\("is-word-passed", "is-word-active"\)/, '两个标记一起清')
  assert.match(change, /wordNodes\[activeLine\]/, '清的是换行前那一行')
  assert.ok(
    change.indexOf('is-word-active') < change.indexOf('activeLine = lineIndex'),
    '必须在改写 activeLine 之前清理，否则清到了新行、旧行残留',
  )
})

// 上轮为"换主题重画定格背景"加的 parkOverrideUntil 补丁，在背景改为封面模糊底后失去作用对象：
// Folia 里三维根本不可见。留着它是死代码，删。
test('回归：Folia 背景不再依赖三维最后一帧（定格重画补丁已删）', () => {
  assert.doesNotMatch(app, /parkOverrideUntil/, '死代码必须删净，不留兼容壳')
  assert.doesNotMatch(css, /opacity:\s*0\.16/, '压暗方案已废弃')
})

// 实测踩到：内嵌非同步歌词（ID3 USLT）没有任何时间轴，解析出 0 行后被当成"没有歌词"，
// 画面只剩音符动画，而来源徽标却写着"内嵌标签 · 纯文本"——自相矛盾。
// 纯文本必须按段落静态显示出来，且不触发无歌词动画。
test('非同步内嵌歌词按段落静态显示，不被误判为没有歌词', async () => {
  const client = await readFile(new URL('../src/lyrics-client.ts', import.meta.url), 'utf8')
  assert.match(client, /text\?: string/, 'LoadedLyrics 要带上原始文本')
  assert.match(client, /^\s+text,$/m, '解析成功时把文本随记录返回')
  assert.match(stage, /function showPlainText\(\)/, '舞台要有纯文本分支')
  assert.match(stage, /if \(lines\.length\) hidePulse\(\);\s*\n\s*else if \(!showPlainText\(\)\) showPulse\(\);/, '有原文就不放动画')
  assert.match(stage, /loaded\?\.format !== "lyrics"/, '只对非同步歌词走这条分支，坏掉的 .lrc 不该把标记原样贴出来')
  assert.match(css, /\.lyric-plain \{/, '纯文本块有独立样式')
})

// F1 复核（2026-10-06 用户报告"升级命中后宿主段落未退场，与岛内逐字两层叠加"）。
// 三条路径真机复现**均未复现**（冷启动竞态用 CDP 把网络延迟拉到 3 秒撑开窗口、末态出图、
// 以及切视图触发 refresh()——升级结果不进客户端缓存那条路），段落退场是原子的：
// t+2.0s plain=true:36 / has-plain / 岛内 0 个歌词行 → t+5.0s plain=false / host=62 / 岛内逐字。
// 既然报上来的现象不在当前代码里，就把"为什么它不可能发生"钉成断言，而不是照着描述改代码。
test('F1 复核：在线升级命中走 build() 这条清场路径，宿主段落层不可能留在屏上', async () => {
  const upgrade = /if \(result\.upgrade\) \{[\s\S]*?\n      \}\n    \}/.exec(stage)?.[0] ?? '';
  assert.ok(upgrade.length > 120, '没抓到升级分支');
  assert.match(upgrade, /build\(upgraded\.data\)/, '升级命中必须整体重建（不是打补丁），才会走 build() 的清场');
  assert.equal(/showPlainText\(\)/.test(upgrade), false, '升级分支里不许自己再摆段落层');
  const build = /function build\(data: LyricData\) \{[\s\S]*?\n  \}/.exec(stage)?.[0] ?? '';
  assert.match(build, /^\s*function build\(data: LyricData\) \{\s*\n\s*markPlainBlock\(false\);/, 'build() 第一件就是把 has-plain 摘掉');
  assert.match(build, /root\.textContent = "";/, 'build() 要清空宿主 DOM，段落节点随之消失');
  const order = build.indexOf('markPlainBlock(false)');
  const plain = build.indexOf('showPlainText()');
  assert.ok(order >= 0 && plain > order, '段落层只可能在清场之后按"无时间轴行"这一档重新出现');
})

// F1（台账 R63，2026-10-04）：岛路径把自研歌词面整体隐藏时，连带藏掉了"非同步歌词段落"和
// "歌词来源徽标"。一手实测（Lovers 进岛）：.lyric-plain 存在且有 36 个段落、文本正确，但 display:none、
// rect 0×0 —— 屏幕上就是一片空白；徽标同样看不见，而"在线结果必须标明来源"要落在徽标上。
// 第二版又由截图抓出两处：① 岛自己的"等待音乐"占位层满幅居中压在段落正中；② 封面墙里放行会压住海报。
test('F1/R63：classic 系放行段落与徽标、岛内空态让位，封面墙不放行', async () => {
  const chrome = await readFile(new URL('../src/lyric-folia-chrome.css', import.meta.url), 'utf8')
  assert.match(chrome, /#stage\[data-folia-view="island"\] #lyric-stage > :not\(\.folia-controls\) \{\s*display: none/, 'R20 的岛隐藏规则必须还在（整条删掉会让自研逐字面与岛内 DOM 叠成两套字）')
  assert.match(chrome, /#stage\[data-folia-view="island"\]\[data-folia-layout="classic"\] #lyric-stage > \.lyric-plain \{\s*display: flex/, 'classic 系要放行非同步歌词段落')
  assert.match(chrome, /#stage\[data-folia-view="island"\]\[data-folia-layout="classic"\] #lyric-stage > \.lyric-source \{[\s\S]{0,220}?bottom: 112px/, '徽标在岛内可见且要让开悬浮控制条（实测数值，不是审美调整）')
  // R64：岛内当前行与上游字幕都在底部居中，居中的徽标会压住它们（截图实测）⇒ 岛里改挂左侧。
  assert.match(chrome, /#stage\[data-folia-view="island"\]\[data-folia-layout="classic"\] #lyric-stage > \.lyric-source \{[\s\S]{0,400}?left: 24px;[\s\S]{0,40}?transform: none/, '岛内徽标必须让开底部居中的歌词基线')
  assert.match(chrome, /\[data-folia-layout="classic"\]:has\(#lyric-stage\.has-plain\) \.folia-island \[data-lyric-empty\]/, '宿主有段落时岛内空态占位必须让位')
  // 封面墙不放行：墙内歌词画在展开卡的画布上，浮一层满幅文字会压海报（截图实测）
  assert.equal(/data-folia-layout="lattice"[^{]*\.lyric-plain/.test(chrome), false, '不得给封面墙放行段落块')
  assert.match(stage, /classList\.toggle\("has-plain", on\)/, '宿主段落存在时要留一个可判定的标记')
  for (const file of [
    '../src/folia/components/visualizer/classic/Visualizer.tsx',
    '../src/folia/components/visualizer/lumiere/VisualizerLumiere.tsx',
    '../src/folia/components/visualizer/sonnet/VisualizerSonnet.tsx',
    '../src/folia/components/visualizer/tempera/VisualizerTempera.tsx',
  ]) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.match(text, /data-lyric-empty="1"/, `${file} 的空态占位缺显式钩子（用工具类选择器会随上游改类名静默失效）`)
  }
  // DOM 属性这个钩子本身是契约（CSS 靠它区分 classic 与封面墙），但**值从哪来**不是：
  // 看板 c980fa6 嫌疑③之后，它改读"岛实际布局"那个入口，不再直接读偏好（三处判据同源）。
  assert.match(app, /stage\.dataset\.foliaLayout = currentFoliaLayout\(\)/, '布局要落到 DOM 属性，CSS 才能区分 classic 与封面墙')
  assert.doesNotMatch(app, /stage\.dataset\.foliaLayout = preferences\.foliaView/, 'DOM 属性不许退回"直接读偏好"（那是双真相的那一份）')
  // R63 的全部新增规则必须限定在 island 域内：legacy 降级面（岛加载失败时走自研歌词行）
  // 被这些规则波及，等于把唯一还在工作的路径也改坏了。剥掉注释后逐条选择器核对。
  const bare = chrome.replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = bare.split('{').map((chunk) => chunk.slice(chunk.lastIndexOf('}') + 1).trim()).filter(Boolean)
  const touched = selectors.filter((sel) => /\.lyric-plain|\.lyric-source|\[data-lyric-empty\]/.test(sel))
  assert.ok(touched.length >= 3, `R63 相关的选择器数量异常：${touched.length}`)
  for (const sel of touched) {
    assert.ok(sel.includes('[data-folia-view="island"]'), `R63 规则越出 island 域：${sel}`)
    assert.ok(!sel.includes('[data-folia-view="legacy"]'), `R63 规则不该碰 legacy 降级面：${sel}`)
  }
  assert.ok(touched.every((sel) => !sel.includes('lattice') || sel.includes('!')), '封面墙不得出现在放行选择器里')
})

test('R60：在线升级在舞台里被接手——同一条换曲守卫、重建后立刻按当前位置点亮', async () => {
  const client = await readFile(new URL('../src/lyrics-client.ts', import.meta.url), 'utf8')
  assert.match(stage, /if \(result\.upgrade\) \{/, '舞台必须承接 client 交来的 upgrade promise')
  // 守卫必须与首次加载同一条：token 变了（换曲）就不能再写 DOM，否则旧歌会被贴上新歌的词。
  const upgradeBlock = stage.slice(stage.indexOf('if (result.upgrade)'), stage.indexOf('/** Apply the media clock'))
  assert.match(upgradeBlock, /request !== token \|\| trackId !== track\.id/, 'upgrade 走的是同一条换曲守卫')
  assert.match(upgradeBlock, /build\(upgraded\.data\)/, '匹配到词后要重建行，而不是只改徽标')
  assert.match(upgradeBlock, /renderSourceBadge\(\)/, '重建后来源徽标要跟着换成"在线匹配"')
  assert.match(upgradeBlock, /applyTime\(lastTime\)/, '重建后按当前播放位置立刻点亮，不等下一帧')
  assert.match(upgradeBlock, /upgraded\.empty \|\| !\(upgraded\.data\.lines\?\.length\)/, '未命中不许动画面：无词曲目停在无词，USLT 曲目停在段落')
  assert.match(upgradeBlock, /\.catch\(/, 'promise 侧留一道保险，绝不产生未处理 rejection')
  // 6.6：能建 upgrade 的路径从一条变成两条（完全无词 / 只有无时间轴内嵌纯文本），有带时间轴的词仍绝不建。
  assert.equal((client.match(/upgrade: runOnlineUpgrade\(/g) ?? []).length, 2, 'upgrade 只有"无词"与"有词无轴"两个入口')
  assert.match(client, /if \(!reference\) \{[\s\S]{0,200}options\.online/, '本地完全无词是第一个入口')
  assert.match(client, /if \(reference\.format === "lyrics" && options\.online\) \{[\s\S]{0,260}upgrade: runOnlineUpgrade\(track, reference\)/, '内嵌纯文本是第二个入口，且段落结果先放行')
  assert.match(client, /async function runOnlineUpgrade[\s\S]{0,1600}return noneResult\(track, /, '一切失败都兑现成无词 + 可读原因（舞台的空结果守卫让显示停在原样）')
  const upgradeFn = client.slice(client.indexOf('async function runOnlineUpgrade'), client.indexOf('async function load'))
  assert.doesNotMatch(upgradeFn, /Promise\.reject|throw /, '升级函数里不许出现抛出：失败一律兑现成无词结果')
  // 岛内字幕的"逐字"判定要认 qrc，否则在线逐字词被标成"纯文本"。
  assert.match(stage, /loaded\.format === "ttml" \|\| loaded\.format === "qrc"/, 'qrc 归入逐字')
  // R144 把这一格从"逐字钉模板排版"改成钉四件不变式（旧判据换个排版就红，而红得没有信息量：
  // 它当时能挡住的是"来源名从三元退回硬编码"，那件事下面第 3、4 条判得更准）。
  const badgeTemplate = /const origin =([\s\S]*?);\n/.exec(stage)?.[1] ?? '';
  assert.ok(badgeTemplate.length > 60, `没抓到徽标那行模板：${badgeTemplate.length}`);
  assert.match(badgeTemplate, /在线匹配/, '机器配上的那条要说"在线匹配"');
  assert.match(badgeTemplate, /手动认领/, 'R144：人挑的那一条不许冒充机器配的（两种来源混说 = 界面在替人冒认）');
  assert.match(badgeTemplate, /\$\{ONLINE_PROVIDER_LABELS\[loaded\.provider \?\? "qq"\]/,
    '徽标必须标明在线来源与服务商（第五期四源之后，名字取自那张共享表，不再各写三元）');
  assert.equal((badgeTemplate.match(/ONLINE_PROVIDER_LABELS/g) ?? []).length, 1,
    '只一条模板、一次取表：两态各写一条迟早有一处忘了带来源');
  assert.match(client, /export const ONLINE_PROVIDER_LABELS: Record<OnlineProvider, string>/, 'provider 标签表是徽标与设置面板共用的单一真源')
  assert.match(client, /netease: "网易云"[\s\S]{0,40}kugou: "酷狗"/, '四源的名字都要在表里')
  // 6.6：替换态换了措辞，但"必须标明来源"这条硬约束（第四期定案）不能因此松动——两态都带"在线匹配"与 provider。
  // 第五期四源之后 provider 名从 lyric-stage 的三元表达式挪进了共享表，所以这里查的是"表里名字齐不齐"
  // （上面三条断言），badge 侧只钉"前缀必须还在"——名字丢没丢由那张表负责，一处定义一处断言。
  const badgeBlock = stage.slice(stage.indexOf('const origin ='), stage.indexOf('// 被安全预检挡下时'))
  assert.match(badgeBlock, /在线匹配/, '两条在线分支共用的前缀里必须含"在线匹配"');
  assert.match(badgeBlock, /ONLINE_PROVIDER_LABELS/, '徽标必须经那张共享表拿服务商名，不许退回硬编码');
  // 注入点：默认关闭时零请求，且开关即时生效（不重建 client）。
  assert.match(app, /if \(!library\.onlineLyrics\?\.enabled\) return null/, '关闭时直接回 null，连请求都不发')
  assert.match(app, /createLyricsClient\(\{\s*online: \{/, 'client 通过 options.online 拿到在线来源')
  assert.match(app, /"\/api\/online\/lyrics\/match"/, '前端只打这一条本地路由，出网由服务端负责')
  assert.match(app, /localLyrics === "present"/, '服务端说本地有词时前端照单收下，不重试')
})
