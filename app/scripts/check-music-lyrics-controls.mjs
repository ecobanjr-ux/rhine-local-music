// 阶段 5.5 · Folia 沉浸视图外壳与控制条的源码形状断言。
// 沿用本仓库对 DOM/CSS 的既有做法：形状断言 + 真实浏览器数值回读（回读见 stage55 执行日志）。
// 本轮推翻上轮方案：不再是"压暗 .music-detail 到 0.16"，而是整体隐藏 + 封面模糊背景 + 顶栏活动浮现。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8')
const stage = await readFile(new URL('../src/lyric-stage.ts', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/lyric-stage.css', import.meta.url), 'utf8')
const chrome = await readFile(
  new URL('../src/lyric-folia-chrome.css', import.meta.url),
  'utf8',
)
const FOLIA = '#stage[data-display="folia"][data-mode="detail"]';
// 选择器里有 [ ] " 等正则元字符，拼进 RegExp 前必须转义，否则 [data-display="folia"]
// 会被当成字符类，断言永远匹配不到而静默失效。
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test('Folia 视图整体隐藏 Rhine 面板与底部控件，不再用压暗代替', () => {
  assert.doesNotMatch(css, /opacity:\s*0\.16/, '上轮的 0.16 压暗方案必须废弃')
  assert.doesNotMatch(css, /\.music-detail/, '外壳规则不该留在歌词样式表里')
  for (const sel of [
    '.music-detail',
    '.album-callout',
    '.music-counter',
    '.album-stepper',
    '.music-bottomline',
  ]) {
    assert.ok(chrome.includes(`${FOLIA} ${sel}`), `${sel} 要在 Folia 里隐藏`)
  }
  // 常驻进度行让位给悬浮控制条，但**只在控制条真在的时候让**（`controls` 在几条路径下会缺席）。
  // 旧规则只认 `[data-mode="detail"]`：browse（档案层）按 L 进歌词面时 mode 还是 `archive`，
  // 该让的没让 ⇒ 两条底部条叠在一起（截图 57 / F4）。
  assert.match(
    chrome,
    /#stage\[data-display="folia"\]:has\(#lyric-stage \.folia-controls\) \.music-progress \{\s*display: none/,
    '.music-progress 要在"歌词面且有悬浮控制条"时让位（判据按"控制条在不在"划，不按 mode 划）',
  )
  assert.ok(
    !chrome.includes(`${FOLIA} .music-progress`),
    '.music-progress 不许再退回"只认 detail"的那条选择器（browse 那条路就是被它漏掉的）',
  )
  assert.ok(
    !/#stage\[data-display="folia"\] \.music-progress/.test(chrome),
    '也不许写成无条件的"进了歌词面就让"：控制条缺席时它是唯一的底部进度，让掉等于把控件弄没了',
  )
  assert.match(
    chrome,
    new RegExp(`${esc(FOLIA)} \\.music-detail \\{[\\s\\S]*?display: none`),
    '面板 display:none',
  )
})

// 顶栏定案（用户 2026-10-03 拍板，修正此前"模式开关常驻"）：默认隐藏 + 活动浮现，
// 浮现态只留两组胶囊；品牌区与音乐库/搜索/设置/transport 一律不显示。
test('顶栏在 Folia 里默认隐藏，浮现态只留模式与主题两组胶囊', () => {
  assert.match(
    chrome,
    new RegExp(`${esc(FOLIA)} \\.music-header \\{[\\s\\S]*?opacity: 0`),
    '默认整条透明',
  )
  assert.match(
    chrome,
    new RegExp(`${esc(FOLIA)} \\.music-header \\{[\\s\\S]*?pointer-events: none`),
    '隐藏态不吃点击',
  )
  assert.match(
    chrome,
    new RegExp(`${esc(FOLIA)}\\[data-chrome="on"\\] \\.music-header \\{[\\s\\S]*?opacity: 1`),
    '活动态浮现',
  )
  assert.match(chrome, /transition:[^;]*opacity/, '只过渡透明度')
  for (const sel of [
    '.music-identity',
    '[data-action="library"]',
    '[data-action="search"]',
    '[data-action="settings"]',
    '.minimal-transport',
  ]) {
    assert.ok(
      chrome.includes(`${FOLIA} .music-header ${sel}`),
      `浮现态仍要隐藏 ${sel}`,
    )
  }
  assert.doesNotMatch(
    chrome,
    /\.music-header \.mode-switch[^{]*\{[^}]*display: none/,
    '模式胶囊必须留得住',
  )
  assert.doesNotMatch(
    chrome,
    /\.music-header \.theme-switch[^{]*\{[^}]*display: none/,
    '主题胶囊必须留得住',
  )
})

test('背景用当前专辑封面做模糊放大层，并有令牌派生回退', () => {
  assert.match(chrome, /\.lyric-backdrop \{/, '背景层存在')
  assert.match(chrome, /filter: blur\(\d+px\)/, '封面必须模糊')
  assert.match(chrome, /inset: -\d+%/, '必须外扩，否则 blur 边缘会透出黑边')
  assert.match(
    chrome,
    /\.lyric-backdrop\.no-cover \{[\s\S]*?linear-gradient/,
    '无封面回退到渐变底',
  )
  assert.match(
    chrome,
    /\.lyric-scrim \{[\s\S]*?color-mix\(in srgb, var\(--folia-back\)/,
    '暗场读取色底色别名',
  )
  // 派生色未写入时，别名必须落回 --page-bg，两套主题才仍然自动跟随。
  assert.match(
    chrome,
    /--folia-back: var\(--folia-ink, var\(--page-bg\)\)/,
    '暗场最终回退到令牌，两套主题自动跟随',
  )
  assert.match(
    stage,
    /root\.style\.setProperty\("--lyric-cover"/,
    '封面 url 由 TS 写进 CSS 变量',
  )
  assert.match(stage, /no-cover/, '取不到封面时打标记类')
})

test('回归：Folia 背景不再依赖三维最后一帧，换主题补丁删除', () => {
  assert.doesNotMatch(app, /parkOverrideUntil/, '定格重画补丁已成死代码，必须删净')
  assert.match(
    app,
    /const parkScene = foliaStage && presentation\.phase === "detail";/,
    '定格条件保持收窄在 detail 落定后',
  )
})

// —— T2 悬浮最小控制条 + 顶栏活动浮现 ——
const controls = await readFile(new URL('../src/lyric-controls.ts', import.meta.url), 'utf8')
const reveal = await readFile(new URL('../src/idle-reveal.ts', import.meta.url), 'utf8')
// 否定断言必须先剥掉注释：模块头里写着"这里绝不直接调 player.play()"、"不碰
// requestAnimationFrame"这类说明，直接 doesNotMatch 会自己抓到自己的注释。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
const controlsCode = stripComments(controls)
const revealCode = stripComments(reveal)

test('控制条复用既有 data-action，不新造一套播放逻辑', () => {
  for (const action of ['track-prev', 'play-pause', 'track-next', 'mode-rhine']) {
    assert.ok(controls.includes(`data-action="${action}"`), `缺按钮 ${action}`)
  }
  assert.doesNotMatch(controlsCode, /player\.(play|pause|next|previous|seek)\(/, '不得直接驱动播放器')
})

test('空闲计时器只有一个实例，顶栏与控制条由它同时驱动', () => {
  assert.match(reveal, /const idleMs = options\.idleMs \?\? 3000/, '默认 3 秒')
  assert.match(reveal, /addEventListener\("pointermove"/, '鼠标移动唤醒')
  assert.match(reveal, /addEventListener\("pointerdown"/, '点击/触屏唤醒')
  assert.match(reveal, /addEventListener\("keydown"/, '按键唤醒')
  assert.match(reveal, /clearTimeout/, '计时器可回收')
  assert.doesNotMatch(revealCode, /requestAnimationFrame/, '不碰逐帧路径')
  assert.doesNotMatch(controlsCode, /setTimeout|addEventListener/, '控制条不自建定时器与监听')
  assert.match(app, /createIdleReveal\(\{/, 'music-app 里只建一个')
  assert.match(app, /onReveal: \(\) => applyChrome\(true\)/, '一个计时器同时驱动顶栏与控制条')
  // R203 改写这条的**形状**（要求没放宽，反而多点名了一格 ⇒ 并入 Q84）：原文钉的是
  // `keepOpen: () => !!document.querySelector(".music-header:hover, .folia-controls:hover")`
  // 那一整行字面 ⇒ 只要把 keepOpen 折成多行、或给某一档补一颗"悬停时别收起"的元素，就被判成回归。
  // 现在钉不变式：那**唯一一处** keepOpen 必须逐条点名要保住的元素，一个都不许少。
  const keepOpen = /keepOpen:[\s\S]*?\}\);/.exec(app);
  assert.ok(keepOpen, '找不到 keepOpen 那一处（换了写法就要一起来改这条，别让它静默失效）');
  for (const hovered of ['.music-header:hover', '.folia-controls:hover', '.folia-surface-exit:hover'])
    assert.ok(keepOpen[0].includes(hovered), `keepOpen 少点名了 ${hovered}（指针在那上面时不许收起）`);
  assert.equal([...app.matchAll(/keepOpen:/g)].length, 1, '只许一处 keepOpen（两处就有两份"什么算悬停"）');
})

test('离开沉浸态必须停表并强制浮现，否则顶栏会永久不可见', () => {
  assert.match(app, /function syncChromeReveal\(\)/, '进出沉浸态的开关函数')
  // F4 把"沉浸态"的定义放宽了一档：除 detail+folia 外，"在播的是在线曲目"也算
  // （在线曲目没有"打开专辑"这一步，不放行就看不见词）。起表/停表这条不变的东西照旧守：
  // 判据为假必须停表并强制浮现，否则顶栏永久不可见。
  assert.match(app, /function lyricViewWanted\(\) \{[\s\S]*?displayMode !== "folia"[\s\S]*?mode === "detail" \|\| player\.state\.currentTrack\?\.sourceKind === "online"/, '沉浸态判据：folia 且（detail 或在播的是在线曲目）')
  assert.match(app, /if \(lyricViewWanted\(\)\) \{[\s\S]*?chromeReveal\.start\(\);/, '只在沉浸态起表')
  assert.match(app, /else chromeReveal\.stop\(\);/, '其余场合停表')
  // 控制条在起表这一刻才挂进 DOM，而 syncTransportControls 只在播放器离散变化时跑，
  // 不补一次回灌，标题与可用性会一直空到下次切歌。
  assert.match(app, /if \(playerState\) syncTransportControls\(playerState\);/, '进入时回灌一次播放状态')
  assert.match(reveal, /stop\(\) \{[\s\S]*?onReveal\(\);/, 'stop 里强制回到浮现态')
  const setModeHook = app.slice(app.indexOf('mode: (next) => {'), app.indexOf('prepareMenu:'))
  assert.match(setModeHook, /syncChromeReveal\(\)/, '视图切换时同步')
  const setDisplayBody = app.slice(app.indexOf('function setDisplayMode'), app.indexOf('stage.dataset.display = displayMode;'))
  assert.match(setDisplayBody, /syncChromeReveal\(\)/, '模式切换时同步')
})

test('两个进度条共用一条 seek 通路，且覆盖后来动态创建的悬浮条', () => {
  // 悬浮条是进 Folia 才创建的：初始化时 querySelectorAll('[data-seek]') 看不到它，必须用委托。
  assert.match(app, /document\.addEventListener\("input", \(e\) => \{/, 'input 走文档级委托')
  assert.match(app, /matches\?\.\("input\[data-seek\]"\)/, '按 [data-seek] 过滤')
  assert.match(app, /document\.addEventListener\("pointerdown", \(e\) => \{[\s\S]*?closest\?\.\("input\[data-seek\]"\)/, '拖动标记也走委托')
  assert.match(app, /id="progress-slider" data-seek/, '原底部胶囊纳入同一通路')
  assert.match(controls, /class="folia-seek" data-seek/, '悬浮条进度条带 data-seek')
  assert.match(controls, /if \(!snapshot\.dragging\) seek\.value =/, '拖动中不回写，否则指针被自己拽回去')
})

// 舞台换曲会 root.textContent = "" 清 DOM，挂载标志还是 true 但节点已脱离。
test('回归：控制条挂载按父子关系幂等，换曲清 DOM 后能补回来', () => {
  assert.match(controls, /if \(bar\.parentNode !== root\) root\.appendChild\(bar\)/, 'mount 看父子关系而非标志')
  assert.match(stage, /function ensureSurface\(\)/, '统一的补挂入口')
  assert.match(stage, /function ensureSurface\(\) \{\s*\n\s*mountBackdrop\(\);\s*\n\s*if \(!controls\) controls = createFoliaControls\(\{ root \}\);\s*\n\s*controls\.mount\(\);/,
    '背景与控制条一起补，且控制条缺席时要在这里**建**出来——清 DOM 的路径只调这一个入口，只挂不建就永远挂不回来')
  assert.match(stage, /ensureSurface\(\);\s*\n\s*(applyIntensity\(\);\s*\n\s*)?activeLine = -1;/, 'build 收尾必走 ensureSurface')
  assert.match(stage, /pulse\.mount\(\);[\s\S]{0,200}?ensureSurface\(\);/, '无歌词那条清 DOM 的路也要走 ensureSurface')
})

// 重新挂载不能强扭成"浮现"：idle-reveal 以为还藏着，控制条却自己跳出来，与顶栏不同步。
test('回归：换曲重新挂载时沿用当前浮现态，不自行跳出', () => {
  assert.match(controlsCode, /applyReveal\(revealed\);/, 'mount 复用当前状态')
  assert.doesNotMatch(controlsCode, /setRevealed\(true\);/, '不得硬写浮现')
  assert.match(controlsCode, /function applyReveal\(on: boolean\)/, '状态写入只有一处实现')
})

// 实测踩到：品牌区 display:none 之后，原来的 space-between 把仅剩的两组胶囊甩到左上角，
// 切一次模式胶囊就跳位置。Folia 下改成右对齐，让它在两种模式下待在同一处。
// 这里刻意用 indexOf 而不是拼 RegExp：模板字符串会把 [\s\S] 再解一次变成 [sS]，
// 那种断言会静默地几乎匹配不到任何东西。
test('回归：浮现态的两组胶囊保持右对齐，切模式不跳位置', () => {
  const at = chrome.indexOf(`${FOLIA} .music-header {\n  justify-content: flex-end;`)
  assert.ok(at > 0, 'Folia 下顶栏内容右对齐')
  // 右对齐这条必须排在"隐藏品牌区"之后，否则品牌区还在时它也会生效。
  assert.ok(
    chrome.indexOf(`${FOLIA} .music-header .music-identity`) < at,
    '顺序：先隐藏品牌区，再改对齐',
  )
})

// 实测踩到：没选曲时（track:null、歌词还没解析）setMode 只看 lines.length，
// 把"没选曲"当成"这首没有歌词"，弹出带 aria-label"这首曲目没有歌词"的音符动画。
// 对读屏用户这是一句假话。必须有 loaded 才允许放动画。
test('回归：没选曲 / 歌词未解析完时不放无歌词动画', () => {
  const setModeBody = stage.slice(stage.indexOf('function setMode('), stage.indexOf('function refresh()'))
  assert.match(setModeBody, /if \(loaded && !lines\.length && !showPlainText\(\)\)/, '放动画前先确认已解析')
  assert.ok(
    setModeBody.indexOf('if (loaded') > setModeBody.indexOf('if (mode !== "folia")'),
    '门控在切回演出分支之后',
  )
})

// ── R179（缺陷一）：岛的顶部安全区 = 宿主顶部导航带的下沿，运行时量、隐身时撤 ──────────────
const bodyOf = (src, name) => {
  const start = src.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} 这个函数找不到了（判据要跟着搬家，不许放宽）`);
  const end = src.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name} 的函数体收不上`);
  return src.slice(start, end + 2);
};

test('R179：岛内绘制的内容不许落在顶部导航带里（安全区由宿主量，不写死数字）', async () => {
  const { computeFoliaSafeTop, FOLIA_SAFE_TOP_VAR } = await import('../src/folia-host/safe-area.ts');
  // ① 纯函数：带下沿减岛上沿；**负数收成 0**（顶栏被隐藏时 rect 全 0，不夹就会得到负 inset）
  assert.equal(computeFoliaSafeTop(71, 0), 71, '带的下沿就是岛要避让的高度');
  assert.equal(computeFoliaSafeTop(71, 40), 31, '岛不在 y=0 时要按两者之差，不是按绝对值');
  assert.equal(computeFoliaSafeTop(0, 0), 0, '顶栏隐藏（rect 全 0）⇒ 0，不许出负值');
  assert.equal(computeFoliaSafeTop(20, 71), 0, '带在岛上方 ⇒ 收成 0，不许把内容往上推');
  assert.equal(computeFoliaSafeTop(71.6, 0), 72, '取整（半个像素会让每帧量到的值抖动）');
  // ② CSS：吃变量，不吃字面量。那条带在三个断点上 top 分别是 33/48/25px、高度还是内容撑的，
  //    写死任何一个数都会在别的断点上要么留缝、要么仍然压住。
  //    R180 搬家：安全区**不再收岛自己**（那会把岛的平色背景一起收进来 ⇒ 屏幕上一条硬接缝，用户报），
  //    改收岛的第一层内容节点；不变的是"避让量由宿主现量、不许写字面量"。
  const CONTENT_SEL = '#folia-island > :first-child';
  assert.ok(chrome.includes(CONTENT_SEL), `安全区要落在内容层那条规则上（${CONTENT_SEL}）`);
  assert.match(chrome, new RegExp(`${esc(CONTENT_SEL)}\\s*\\{[^}]*margin-top:\\s*var\\(--folia-safe-top, 0px\\)[^}]*\\}`),
    '内容层必须从顶部让出 var(--folia-safe-top)');
  assert.match(chrome, new RegExp(`${esc(CONTENT_SEL)}\\s*\\{[^}]*height:\\s*calc\\(100% - var\\(--folia-safe-top, 0px\\)\\)`),
    '让出之后内容高度要跟着减掉（不然底部会被挤出去）');
  // **岛自己的背景必须整窗**：这一格就是 R180 那道接缝的判据——背景一收，接缝就回来。
  assert.match(chrome, /\.folia-island\s*\{\s*position:\s*absolute;\s*inset:\s*0;/,
    '岛必须 inset:0（背景整窗），R180 的接缝就是这么来的');
  assert.doesNotMatch(chrome, /\.folia-island\s*\{[^}]*inset:\s*var\(--folia-safe-top/,
    '不许把安全区收在岛自己身上（那会连底色一起收 ⇒ 顶部一条硬接缝）');
  assert.doesNotMatch(chrome, /\.folia-island\s*\{[^}]*inset:\s*\d+px/, '岛的上沿不许写死成字面量像素');
  // 收 padding 那一版也不行：padding 管不到岛内 `absolute inset-0` 那类元素（R179 真机量到）。
  assert.doesNotMatch(chrome, /padding-top:\s*var\(--folia-safe-top/,
    '不许退回 padding-top 那一版（它管不到岛内的绝对定位元素）');
  // ③ 顶栏隐身时这一格必须撤掉，且**条件与隐藏顶栏那条规则同源**（两处条件不一致 = 有一处会错）
  const hideSel = `${FOLIA} .music-header`;
  assert.ok(chrome.includes(hideSel), '顶栏在歌词面详情里隐藏这条规则还在（撤安全区那格的前提）');
  const zeroSel = `${FOLIA}:not([data-chrome="on"]) ${CONTENT_SEL}`;
  assert.ok(chrome.includes(zeroSel), `隐身时撤安全区的规则要在，选择器应为 ${zeroSel}`);
  assert.match(chrome, new RegExp(`${esc(zeroSel)}\\s*\\{\\s*margin-top: 0`), '撤的方式是把内容层的位移归零');
  // ④ 宿主接线：变量只有一个写入处，且三个时机都会重算（挂载 / 窗口尺寸 / 顶栏自身高度变化）
  assert.equal([...app.matchAll(/stage\.style\.setProperty\(FOLIA_SAFE_TOP_VAR/g)].length, 1,
    `写入 ${FOLIA_SAFE_TOP_VAR} 的地方必须只有一个（两处 = 两份真相，R173 那一族）`);
  const sync = bodyOf(app, 'syncFoliaSafeTop');
  assert.match(sync, /querySelector<HTMLElement>\("\.music-header"\)/, '量的是那条带，不是别的顶栏元素');
  assert.match(sync, /computeFoliaSafeTop\(/, '算式走那个纯函数（不许在宿主里再写一遍减法）');
  const fit = bodyOf(app, 'fit');
  assert.ok(fit.includes('syncFoliaSafeTop()'), 'fit() 里要重算（断点一改，带的位置与高度都变）');
  assert.ok(fit.indexOf('syncFoliaSafeTop()') < fit.indexOf('if (mode === "detail")'),
    'fit() 里要在切详情之前先量（顺序反了会给一帧错的几何）');
  assert.match(bodyOf(app, 'watchFoliaSafeTop'), /new ResizeObserver\(syncFoliaSafeTop\)/,
    '顶栏高度会被内容/字体撑变 ⇒ 观察它自己，不能只挂 window resize');
  assert.match(app, /island\.hidden = false;[\s\S]{0,240}watchFoliaSafeTop\(\)/,
    '岛现身那一刻就量一次（晚一步就有一帧内容压在带下面）');
  // ⑤ 这条缺陷的本质是"某档的锚定方式撞了 chrome" ⇒ 避让规则**不许按档点名生效**
  //    （按档点名 = 加一档就要回来补一条，正是本批要防的"只修 cappella 漏下一档"）。
  //    R184：按档点名**放开**安全区是允许的（用户拍板的三档特例），但**按档点名启用避让**仍禁止
  //    ——这两个方向不对称：启用会让"漏一档"变成默认缺陷，放开只会让"多放一档"变成显式特例。
  assert.doesNotMatch(chrome, /\[data-folia-mode=[^\]]*\][^{]*\{[^}]*--folia-safe-top/,
    '安全区不许按具体模式点名启用（放开那三档是由 R184 的专用规则做，不经过这条变量）');
  // R184：三档放开安全区 = 内容层 margin-top 归零、高度回到整窗（用户拍板的特例，逐档点名、写死在这里）。
  const RELEASE_MODES = ['lumiere', 'tempera', 'still'];
  const releaseSels = RELEASE_MODES.map((m) => `${FOLIA}[data-folia-mode="${m}"] ${CONTENT_SEL}`);
  for (const sel of releaseSels) {
    assert.ok(chrome.includes(sel), `R184：要有一条"放开安全区"的规则（选择器 ${sel} 没找到）`);
  }
  // 三个选择器共用同一个声明块（逗号并列）⇒ 从最后一个选择器往后取到 `}`，核那个块里的两格。
  const releaseBlock = chrome.slice(chrome.indexOf(releaseSels[releaseSels.length - 1]));
  const releaseBody = releaseBlock.slice(releaseBlock.indexOf('{'), releaseBlock.indexOf('}') + 1);
  assert.match(releaseBody, /margin-top:\s*0/, 'R184：放开安全区要把内容层的位移归零');
  assert.match(releaseBody, /height:\s*100%/, 'R184：放开安全区后内容层高度回到整窗');
  // 放开的档必须真的会命中：宿主把当前档写到 data-folia-mode 上（写错属性名 = 规则静默失效、接缝照旧）。
  assert.match(app, /stage\.dataset\.foliaMode = next;/, 'R184：换档要落到 data-folia-mode 上（规则才命中）');
  assert.match(app, /stage\.dataset\.foliaMode = preferences\.foliaMode;/, 'R184：初始化也要落一次属性');
  // 放开的档名不许是"随手编的字符串"：必须是宿主 FOLIA_MODES 里的合法 id（与 R184 的规则名对得上）。
  for (const mode of RELEASE_MODES) {
    assert.ok(app.includes(`id: "${mode}"`), `R184：${mode} 必须是 FOLIA_MODES 里的合法档（否则规则永远命中不了）`);
  }
  // ── R193 · 顶部横带：**用户翻案，R189 那两条渐隐全部撤除** ──────────────────────────────
  // 用户原话「不接受有色带……要类似于刚开始那样」。R193 的判据从"盖住"改成"让场景真的铺满"：
  // 这里只钉得住"那一格没有被重新加回来"，观感面的判据在 run log（逐行相邻色差 > 2 即违例）。
  assert.doesNotMatch(chrome, /--folia-top-fade/, 'R193：R189 那条顶部渐隐的令牌必须撤除（不是调淡、不是改色）');
  assert.doesNotMatch(chrome, /--folia-pendolo-top-fade/, 'R193：时计那条渐隐的令牌一并撤除');
  assert.doesNotMatch(chrome, /#folia-island > :first-child::before/,
    'R193：岛内容层上不许再有任何遮罩伪元素（"盖住"本身就等于造一条带）');
  // 时计改成"内容层从 y=0 起排"（R189 给它留的 71px 安全区撤掉），
  // 且**弧顶行不许被裁** ⇒ 那一档的 overflow 要放开（岛内容层默认是 hidden）。
  const pendoloTop = /\[data-folia-mode="pendolo"\] #folia-island > :first-child \{([\s\S]*?)\n\}/.exec(chrome)?.[1] ?? '';
  assert.ok(pendoloTop, 'R193：时计要有一条"内容层从 y=0 起排"的规则');
  assert.match(pendoloTop, /margin-top:\s*0/, 'R193：时计的内容层不再让安全区');
  assert.match(pendoloTop, /height:\s*100%/, 'R193：时计的内容层高度回到整窗');
  assert.match(pendoloTop, /overflow:\s*visible/, 'R193：弧顶行不许被裁 ⇒ 那一档放开裁切');
  // 放开安全区那三档照旧（R184 的规则一个字没动）。
  const RELEASE_MODES_193 = ['lumiere', 'tempera', 'still'];
  for (const mode of RELEASE_MODES_193) {
    assert.ok(chrome.includes(`${FOLIA}[data-folia-mode="${mode}"] ${CONTENT_SEL}`), `R193：${mode} 放开安全区那条规则还在（R184 的成果不许回退）`);
  }
  // ── R195（Q72）· 歌词面里顶部 chrome **不自带底色**（用户拍板：菜单浮在歌词背景上）──────
  const ISLAND_CHROME = '#stage[data-display="folia"][data-folia-view="island"]';
  // ① 两处"chrome 自带的底"撤掉：演出/歌词那颗胶囊容器的 `--veil` + 那两条 veil 渐晕（导航行 + 底栏）
  assert.match(chrome, new RegExp(`${esc(ISLAND_CHROME)} \\.mode-switch \\{\\s*background: transparent;`),
    'R195：胶囊容器在歌词面里不带底（原先是 --veil，深夜是蓝黑，压在偏绿的深画上就成一条带）');
  assert.match(chrome, new RegExp(`${esc(ISLAND_CHROME)} \\.music-vignette \\{\\s*display: none;`),
    'R195：歌词面里那条 veil 渐晕必须撤（它就是导航行那条横带的底）');
  // ② 撤底之后字要自己站住：字色主题主色 + 不再调暗 + 描边取相反的一端 + 控件自带一层同族底
  assert.match(chrome, /music-topnav button:not\(\[aria-pressed="true"\]\)[\s\S]{0,80}?\{\s*color: var\(--ink\);\s*opacity: 1;/,
    'R195：未按下的导航项要用主题主色、且不许再调暗（原先 --muted×0.6 压在暗岛上实测只有 1.05:1）');
  assert.match(chrome, /music-topnav button \{\s*background: color-mix\(in srgb, var\(--page-bg\) 82%, transparent\)/,
    'R195：控件自带一层同族底 —— 底先定下来，对比度才算得出来（这是用户允许的"描边救不回来"那一档回退）');
  assert.match(chrome, /text-shadow:\s*0 0 2px var\(--page-bg\),\s*0 0 4px var\(--page-bg\)/,
    'R195：描边/阴影取与字色相反的那一端（--page-bg），压在亮画或暗画上都把笔画托住');
  // ③ **不许恢复整条带的底**：那两个 veil 令牌在歌词面里一个字都不许回来
  assert.doesNotMatch(chrome, new RegExp(`${esc(ISLAND_CHROME)}[^{]*\\{[^}]*var\\(--veil\\)`),
    'R195：歌词面里不许再用 --veil 当底（那才是色带的来源）');
  // ④ 按下态保留实底 + 描个边界（那是"当前在哪一档"的唯一标识）
  assert.match(chrome, /theme-switch button\[aria-pressed="true"\][\s\S]{0,120}?\{\s*box-shadow:/,
    'R195：按下态要留住实底（去底只去"容器"那一层）');
  // ── R196（Q72 终章）：垫层全部撤掉（用户终审）────────────────────────────────────
  // 岛容器与封面墙根节点都不带自己的底：画布/海报之下露出什么就让它露。
  assert.match(chrome, /\.folia-island \{[\s\S]{0,900}?background: transparent;/,
    'R196：岛容器背景必须透明（那条 `var(--page-bg)` 垫层就是"最上面一条格格不入的带"）');
  assert.match(chrome, /\.folia-island \.lattice-root \{\s*background: transparent;/,
    'R196：封面墙根节点也不许有自己的底（它是海报的容器，不是一块画布）');

  // ── R200（Q72 真终章）：岛视图下内容层恒铺满 —— "导航行下那道色相交界带"的根因 ──────────────
  // 一手复现（r200 探针）：dataset.mode 置 archive（歌词面可以直接出现在档案态 —— F4 的在线曲目路径、
  // `L` 键只切 displayMode 不碰 data-mode），内容层被 `margin-top: var(--folia-safe-top)` 推下
  // （archive 实测 83px）⇒ y<83 露出岛下之物（3D 场景/页面底，night 实测 0,3,13 蓝黑）与 y≥83 的
  // 画面（绘光，暖调）在导航行底缘接成一条异相带。R184（按档三组）与 R196（按布局）的放开规则
  // 都挂在 `[data-mode="detail"]` 上 ⇒ archive 下全部失效、避让照旧（这两组被本条涵盖，保留作历史登记）。
  const islandFill = /#stage\[data-display="folia"\]\[data-folia-view="island"\] #folia-island > :first-child \{([\s\S]*?)\n\}/.exec(chrome)?.[1] ?? '';
  assert.ok(islandFill, 'R200：要有一条"岛视图下内容层恒铺满"的规则（选择器必须按 data-folia-view，不再按档/按布局/按 data-mode）');
  assert.match(islandFill, /margin-top:\s*0/, 'R200：岛视图下内容层位移恒为 0（导航行下那条带就是位移露出来的）');
  assert.match(islandFill, /height:\s*100%/, 'R200：岛视图下内容层高度恒为整窗');
  // 归属条件的三个反例都要钉死：不许再写回 data-mode 限定（R117 为同一件事踩过一次）、
  // 不许用 not(...) 把某档又排除出去、也不许"岛视图"之外另加档名单（枚举必然漏路径）。
  assert.doesNotMatch(islandFill, /data-mode|:not\(|lumiere|tempera|still|lattice/,
    'R200：铺满规则不许回到"按 data-mode / 按档 / 按布局"的枚举形态（archive 态就是这么漏掉的）');
});
