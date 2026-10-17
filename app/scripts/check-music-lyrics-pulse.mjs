// 阶段 5 T6 —— 无歌词曲目的音符跳动动画。
// 与 check-music-lyrics-stage.mjs 同一套做法：DOM/音频相关的形状用源码断言锁住，
// 纯函数与偏好校验用真实调用验证。Web Audio 两条硬约束（同一元素只能建一次
// MediaElementSource、必须连回 destination）是这一档最大的静音风险，逐条锁死。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const pulse = await readFile(new URL('../src/lyric-pulse.ts', import.meta.url), 'utf8')
const stage = await readFile(new URL('../src/lyric-stage.ts', import.meta.url), 'utf8')
const app = await readFile(new URL('../src/music-app.ts', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/lyric-stage.css', import.meta.url), 'utf8')

test('无歌词曲目不再显示文字占位，改为挂载音符动画', () => {
  assert.doesNotMatch(stage, /renderPlaceholder/, '文字占位实现必须移除')
  assert.doesNotMatch(stage, /lyric-placeholder/, '不再渲染占位文本节点')
  assert.match(stage, /else if \(!showPlainText\(\)\) showPulse\(\);/, '解析为空且无原文才挂载动画')
  assert.match(stage, /pulse\?\.tick\(\)/, '动画由同一个 rAF 循环驱动')
  assert.doesNotMatch(pulse, /requestAnimationFrame\(/, '模块自身不得另起第二条循环')
})

test('屏幕阅读器仍能知道这是"没有歌词"', () => {
  assert.match(pulse, /setAttribute\(\s*"aria-label",\s*"这首曲目没有歌词"/)
  assert.match(pulse, /className = "visually-hidden"/)
  assert.match(pulse, /host\.setAttribute\(\s*"role",\s*"img"\s*\)/)
})

// 同一个 <audio> 元素第二次 createMediaElementSource 会直接抛 InvalidStateError。
test('Web Audio 硬约束①：每个音频元素只建一次 MediaElementSource', () => {
  assert.match(pulse, /new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>/)
  // 区域边界跟着改名：`readLevel` 已被 `readBands` 取代（六段各读一次）。
  // 顺带补一条守卫：`slice(a, indexOf(x))` 在 indexOf 落空时返回 -1，区域会悄悄变成"到文件末尾为止"，
  // 断言照样绿——本仓已经为此返工过几次，所以凡是"抠一段再断言"都要先确认抠到了。
  const guardEnd = pulse.indexOf('function readBands')
  assert.ok(guardEnd > 0, '没找到 readBands 这个边界（区域提取失败不许静默通过）')
  const guard = pulse.slice(pulse.indexOf('function ensureGraph'), guardEnd)
  assert.match(guard, /sources\.get\(element\)/, '先查缓存')
  assert.match(guard, /if \(!source\) \{\s*source = context\.createMediaElementSource\(element\)/, '缺失才创建')
  assert.match(guard, /sources\.set\(element, source\)/, '建完立即登记')
  assert.match(guard, /activeSource\.disconnect\(\)/, '换曲目要断开旧节点')
})

// 一旦接进图谱，声音只走图谱；不连 destination 就整首静音。
test('Web Audio 硬约束②：分析节点必须连回 destination', () => {
  assert.match(pulse, /analyser\.connect\(context\.destination\)/)
  assert.match(pulse, /source\.connect\(analyser!\)/, '媒体元素接进分析节点')
})

test('进阶档不可用时自动降回基础档并记下原因', () => {
  assert.match(pulse, /浏览器不支持 Web Audio/)
  assert.match(pulse, /音频图谱建立失败/, 'createMediaElementSource 抛错要接住')
  assert.match(pulse, /AudioContext 被自动播放策略挂起/)
  assert.match(pulse, /连续 120 帧读不到电平，已降回基础动画/)
  assert.match(pulse, /effective = "basic"/, '降级后走 CSS 动画')
  assert.match(pulse, /host\.dataset\.fallback = /, '降级原因写进 DOM 供实测回读')
})

test('减弱动效下不跑跟随音频的动画（两个吃电平的档一视同仁）', () => {
  // R133 之后"跟随音频"有两档（音符 / 频谱条），判据必须走那一组而不是写死一档：
  // 只挡 audio 的话，开减弱动效的用户选到 spectrum 就还是满屏跟着跳。
  assert.match(pulse, /reduced\(\) && audioDriven\(wanted\) \? "basic" : wanted/)
  assert.match(pulse, /export const AUDIO_DRIVEN_TIERS: readonly LyricPulseTier\[\] = \["audio", "spectrum"\]/,
    '两档合用一张表，不在三处各写一遍 === "audio"')
  assert.match(pulse, /function audioDriven\(value: LyricPulseTier\): boolean \{[\s\S]{0,120}AUDIO_DRIVEN_TIERS\.includes\(value\)/)
  // 挂载那道门也必须走同一组判据：写成 `requested !== "audio"` 的话，选频谱档会直接走"不需要电平"那条分支，
  // 画面静止而界面还显示着"频谱条"——这一刀是变异 P1 逼出来的（它第一轮没咬）。
  const mountFn = /function mount\(\) \{[\s\S]*?\n  \}/.exec(pulse)
  assert.ok(mountFn, '没抓到 mount')
  assert.match(mountFn[0], /if \(!audioDriven\(requested\)\) \{/, '挂载按"这一档要不要电平"分岔，不是按档名写死一档')
  assert.doesNotMatch(mountFn[0], /requested !== "audio"/, '不许留下只认 audio 那一份判据')
  assert.match(mountFn[0], /effective = requested;/, '两档各自把生效档写成自己（不是统一写成 audio）')
  // 每帧写 DOM 的那一步：两档各写各的一套字形，缺一条就是"选了档但画面永远不动"
  const applyFn = /function apply\(value: number, bands: readonly number\[\]\) \{[\s\S]*?\n  \}/.exec(pulse)
  assert.ok(applyFn, '没抓到 apply')
  assert.match(applyFn[0], /if \(effective === "spectrum"\) \{[\s\S]*?for \(const \[index, bar\] of bars\.entries\(\)\) bar\.style\.setProperty\("--l"/,
    '频谱档写的是那 16 根条')
  assert.match(applyFn[0], /for \(const \[index, note\] of notes\.entries\(\)\) note\.style\.setProperty\("--l"/,
    '音符档仍然写那六颗（重构不许把老档写丢）')

  assert.match(css, /\.lyric-stage\.is-reduced \.note-pulse__note \{[\s\S]*?animation: none/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.note-pulse__note/, '系统级开关同样生效')
  // 规则本身对两档一视同仁还不够——它是在 mount 时读的，所以**改减弱动效必须重挂一次舞台**。
  // 真机量到：先选频谱档、再打开减弱动效，effective 仍是 spectrum（要等下一次换曲才改）。
  const reducedHandler = /if \(el\.id === "reduced-motion"\) \{([\s\S]*?)\n  \}/.exec(app)
  assert.ok(reducedHandler, '没抓到减弱动效那个变更分支')
  assert.match(reducedHandler[1], /lyricStage\.refresh\(\);/, '改减弱动效要立刻重挂舞台，否则档位停留在挂载那一刻')
  assert.match(reducedHandler[1], /lyricStage\.sync\(player\.state\);/, '重挂之后还要按当前曲目重新走一遍判定')
})

test('四档样式齐备：静止 / 循环 / 音符吃电平 / 频谱条', () => {
  assert.match(css, /\.note-pulse\[data-tier="off"\][\s\S]*?animation: none/)
  assert.match(css, /\.note-pulse\[data-tier="basic"\][\s\S]*?animation: note-bounce/)
  assert.match(css, /\.note-pulse\[data-tier="audio"\][\s\S]*?var\(--pulse-level/)
  assert.match(css, /@keyframes note-bounce/)
  assert.match(pulse, /root\.style\.setProperty\("--pulse-level"/, '电平由每帧写一个自定义属性驱动')
  // R133 频谱条：与音符同一层 DOM，靠 data-tier 换显示的那一套（切换不重建 DOM ⇒ 不可能两套各自记电平）
  assert.match(css, /\.note-pulse__bar \{\s*display: none;/, '默认不画条')
  assert.match(css, /\.note-pulse\[data-tier="spectrum"\] \.note-pulse__note \{\s*display: none;/, '频谱档不画音符')
  assert.match(css, /\.note-pulse\[data-tier="spectrum"\] \.note-pulse__bar \{[\s\S]*?display: block/)
  assert.match(css, /\.note-pulse\[data-tier="spectrum"\] \.note-pulse__bar \{[\s\S]*?transform: scaleY\(/,
    '条高走 scaleY（合成层）而不是 height（每帧触发布局）')
  const barRule = /\.note-pulse\[data-tier="spectrum"\] \.note-pulse__bar \{[\s\S]*?\}/.exec(css)
  assert.ok(barRule && !/height:.*var\(--l/.test(barRule[0]), '不许用 --l 直接算 height')
})

test('偏好 lyricPulse 接到舞台，档位合法集只有一张表', () => {
  assert.match(app, /pulseTier: \(\) => preferences\.lyricPulse/, '档位以 getter 传入，改设置即时生效')
  assert.match(app, /id="lyric-pulse-setting"/, '设置面板里有控件')
  // R133：四档。合法集 / 下拉选项 / 写入前校验三处共用一张表——各写一份字符串数组的话，
  // 加一档必然漏一处，漏的那处会把用户存的合法值当成非法值重置掉。
  assert.match(app, /const LYRIC_PULSE_TIERS: readonly LyricPulseTier\[\] = \["off", "basic", "audio", "spectrum"\]/)
  assert.match(app, /preferences\.lyricPulse = LYRIC_PULSE_TIERS\.includes\(next\) \? next : "basic"/, '写入前再校验一次')
  assert.match(app, /if \(!LYRIC_PULSE_TIERS\.includes\(preferences\.lyricPulse\)\)/, '读取时校验')
  assert.match(app, /\$\{LYRIC_PULSE_TIERS\.map\(\(value\) =>/, '下拉的选项由同一张表生成')
  assert.doesNotMatch(app, /\["off", "basic", "audio"\]/, '不许留下第三份写死的三档清单（那正是加一档会漏掉的地方）')
  assert.match(app, /spectrum: "频谱条/, '新档要有自己的中文标签')
  assert.match(app, /想要整幅画面跟着声音呼吸[\s\S]{0,160}lumiere/, '设置里那句现状说明在案（沉浸式反应画面 = 视觉模式 lumiere）')
})

test('被安全预检拒下的歌词不能标成"行级/逐字"', () => {
  assert.match(stage, /loaded\.rejected === "entity-declaration"/)
  assert.match(stage, /已拒绝（含实体声明）/)
})

// 字形数组曾经写成两个空串，一排音符里凭空少了两颗，肉眼很难发现。
test('音符字形全部非空，六颗一排', () => {
  const literal = /const NOTE_GLYPHS = \[([^\]]*)\]/.exec(pulse)
  assert.ok(literal, 'NOTE_GLYPHS 数组必须存在')
  const glyphs = literal[1].split(',').map((entry) => entry.trim().replace(/^"|"$/g, ''))
  assert.equal(glyphs.length, 6, '一排六颗')
  for (const glyph of glyphs) {
    const isEscape = glyph.startsWith("\\u")
    const char = isEscape ? String.fromCharCode(parseInt(glyph.slice(2), 16)) : glyph
    const code = char.charCodeAt(0)
    assert.ok(
      char.length === 1 && code >= 0x2669 && code <= 0x266f,
      `字形缺失或不在音乐符号区段：${JSON.stringify(glyph)}`,
    )
  }
})

// 实测踩到：暂停播放后电平恒为 0，连续 120 帧的静音保护把进阶档永久降级，
// 用户一按暂停就再也回不到跟随音频的动画。暂停必须不算故障。
test('回归：暂停播放不得被当成图谱故障，恢复播放要自动回到进阶档', () => {
  const tick = pulse.slice(pulse.indexOf('function tick()'), pulse.indexOf('function dispose()'))
  assert.match(tick, /const playing = !!element && !element\.paused && !element\.ended/, 'paused must be detected before counting silence')
  assert.match(tick, /silentFrames = 0/, 'silence while paused must not accumulate')
  assert.match(tick, /recoverAudio\(\)/, 'resuming must recover')
  // 恢复必须重建图谱：软降级可能一次都没建过 AudioContext，只翻标志位会永远读不到电平。
  assert.match(pulse.slice(pulse.indexOf('function recoverAudio')), /mount\(\);/, 'recovery rebuilds the graph via mount')
  assert.match(tick, /if \(!analyser\) \{/, 'missing analyser must trigger a rebuild, not a bogus degrade')
  assert.match(pulse, /播放元素尚未就绪/, '尚未就绪属于可恢复而非硬失败')
})

test('暂停时装饰动画定格，不在静音中继续跳动', () => {
  assert.match(pulse, /host\.classList\.add\("is-idle"\)/)
  assert.match(pulse, /host\.classList\.remove\("is-idle"\)/)
  assert.match(css, /\.note-pulse\.is-idle \.note-pulse__note \{[\s\S]*?animation-play-state: paused/)
})

// 实测踩到：项目里没有全局 .visually-hidden 工具类，无障碍说明文字因此被当成
// 大字显示出来——正是"无歌词时不要显示文字占位"这条要求要避免的画面。
test('回归：屏幕阅读器说明文字必须有就地定义的隐藏规则', () => {
  assert.match(pulse, /className = "visually-hidden"/)
  assert.match(
    css,
    /\.note-pulse \.visually-hidden \{[\s\S]*?clip-path: inset\(50%\)/,
    '必须在 lyric-stage.css 里就地定义，不能依赖不存在的全局工具类',
  )
})

// 实测踩到：从"无歌词"曲目切到"有歌词"曲目后，pulsing 仍为 true、--pulse-level 仍挂在
// 根节点上，动画虽然不可见却还在每帧被驱动。有歌词时必须显式停掉。
test('回归：切到有歌词曲目要显式停止动画状态', () => {
  assert.match(stage, /if \(lines\.length\) hidePulse\(\);/, 'build 里两条分支都要走')
  assert.match(stage, /root\.style\.removeProperty\("--pulse-level"\)/, '电平自定义属性要一并清掉')
})

// 实测踩到：tick 里的软降级重建会重新 append 音符容器。纯文本歌词也是"解析出 0 行"，
// 于是三行正文上又叠了一排音符。驱动动画必须先确认当前确实在放动画。
test('回归：纯文本歌词不得被 tick 的自愈重建叠上音符', () => {
  assert.match(stage, /if \(pulsing\) pulse\?\.tick\(\);/, 'tick 受 pulsing 开关约束')
  assert.match(stage, /root\.querySelector\(\"\.note-pulse\"\)\?\.remove\(\)/, '停用时把容器从 DOM 摘掉')
})

// 看板 6378d44 第 3 条（夜间批 三）：用户报"在线纯音乐没有无词态可视化"。
// 一手实测的结论与报的相反：**本地与在线都走到了 `showPulse()`**（pulsing 为真、容器在 DOM 里），
// 看不到的是岛挂载时 R20 那条"只放行控制条"把整棵子树藏了。所以缺的不是判据，是显示通道。
const chrome = await readFile(new URL('../src/lyric-folia-chrome.css', import.meta.url), 'utf8')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const CLASSIC_ISLAND = '#stage[data-folia-view="island"][data-folia-layout="classic"]'

test('无词态的音符动画在岛挂载时要放行（复用既有实现，不新造第二套）', () => {
  assert.match(
    chrome,
    new RegExp(`${esc(CLASSIC_ISLAND)} #lyric-stage > \\.note-pulse \\{\\s*display: flex`),
    'classic 系里放行 .note-pulse（display 值与 lyric-stage.css 那份基础样式一致）',
  )
  // 放行规则必须限定在 island 域内：legacy 降级面本来就能看见音符，波及它等于改坏唯一还在工作的路径。
  const pulseRules = chrome.split('{').map((chunk) => chunk.slice(chunk.lastIndexOf('}') + 1).trim()).filter((sel) => sel.includes('.note-pulse'))
  assert.ok(pulseRules.length >= 1, '没抓到那条放行规则')
  for (const sel of pulseRules) assert.ok(sel.includes('[data-folia-view="island"]'), `放行规则越出 island 域：${sel}`)
})

test('音符在跳时，岛自己那句"等待音乐"要让位（R63 为段落做过同一件事）', () => {
  assert.match(
    chrome,
    new RegExp(`${esc(CLASSIC_ISLAND)}:has\\(#lyric-stage \\.note-pulse\\) \\.folia-island \\[data-lyric-empty\\] \\{\\s*display: none`),
    '同一块画面里不许两样东西叠着',
  )
})

test('封面墙不放行宿主音符动画（墙的词与空态都画在自己的展开卡里）', () => {
  for (const sel of chrome.split('{').map((chunk) => chunk.slice(chunk.lastIndexOf('}') + 1).trim()).filter((s) => s.includes('.note-pulse'))) {
    assert.ok(sel.includes('[data-folia-layout="classic"]'), `音符放行规则要限定 classic 系：${sel}`)
  }
})

test('判据不许按本地/在线分叉，可视化也只许有这一个出处', () => {
  // 这一条守的是"绝不允许造第二个"：无词态的显示通道只能接在既有 showPulse 上。
  assert.equal([...stage.matchAll(/function showPulse\(/g)].length, 1, 'showPulse 只许有一个定义')
  assert.equal([...stage.matchAll(/showPulse\(\);/g)].length, 2, '调用点仍是既有那两处（build 与切回歌词面）')
  assert.doesNotMatch(stage, /sourceKind/, '歌词舞台不按曲目来源分叉显示（本地与在线同一条判据）')
  assert.doesNotMatch(chrome, /@keyframes[^{]*pulse/, '不许在岛的外壳里再起一套音符动画')
})

// 看板 571dfa2（夜间批 一）：无歌词动画调强。
// 从前的三处"太弱"是一起的：全频段平均 ÷160 没有自适应（fftSize=512 时两百多格近乎零的高频
// 把平均数拖没，典型流行乐只剩 0.05~0.15）、位移只有 -0.5em（乘上那个电平＝2~3 像素）、
// 六颗音符共用同一个总电平（永远同步起伏，看着像一张纸在抖）。
// 看板给的处方是"自适应增益 + 噪声底 + 开方"，真机量下来只有前两条成立：
// 按段自适应会把动态除掉（见 调强② 的 doesNotMatch），而信号换成 dB 之后开方是多余的压缩。
// 于是保留意图、改道实现：dB 信号源 + 固定频谱补偿 + 噪声底 + 每段各自慢跟的基准 + 按实测跨度给的窗口宽度。
// 真机结果（同一首 601 帧）：六颗行程各 0~68 像素、逐帧平均变化 0.02~0.06、顶格率 2.5%~6%。
test('调强①：六颗音符各绑一条频段，不再共用一个全频段平均', () => {
  // 捕获到 `];` 为止：写 `\]\n` 之前那个 `]` 会先被区间本身匹配掉（第一版就栽在这里，抓到空串）
  const bands = /const NOTE_BAND_HZ: readonly \[number, number\]\[\] = \[([\s\S]*?)\];/.exec(pulse)
  assert.ok(bands, '没抓到 NOTE_BAND_HZ')
  const edges = [...bands[1].matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])])
  assert.equal(edges.length, 6, '六颗音符 = 六条频段')
  for (let i = 1; i < edges.length; i += 1) {
    assert.equal(edges[i][0], edges[i - 1][1], `频段必须首尾相接：第 ${i + 1} 颗从 ${edges[i][0]} 起，上一颗到 ${edges[i - 1][1]} 止`)
  }
  for (const [low, high] of edges) assert.ok(high > low, `频段区间反了：${low}-${high}`)
  // 按 Hz 切再换算成 bin：写死 bin 序号的话换 fftSize 或采样率会整体错位
  assert.match(pulse, /context\.sampleRate \/ analyser\.fftSize/, 'bin 宽度由采样率与 fftSize 现算')
  assert.doesNotMatch(pulse, /sum \/ bins\.length \/ 160/, '全频段平均 ÷160 那一条必须消失（它就是"看不见动"的根因）')
  // 逐颗绑定要按下标绑：只看"有没有 setProperty(\"--l\"" 会被"六颗都写同一个总电平"蒙过去（M9 第一轮就没咬）
  const applyFn = /function apply\(value: number, bands: readonly number\[\]\) \{([\s\S]*?)\n  \}/.exec(pulse)
  assert.ok(applyFn, '没抓到 apply 这个函数体')
  assert.match(applyFn[1], /for \(const \[index, note\] of notes\.entries\(\)\)/, '要带着下标逐颗走')
  assert.match(applyFn[1], /setProperty\("--l", \(bands\[index\]/, '每颗吃自己那条频段的电平')
  assert.doesNotMatch(applyFn[1], /setProperty\("--l", value/, '总电平只许管整排透明度；喂给每颗就退回"一张纸在抖"')
  assert.match(css, /translateY\(calc\(var\(--l, 0\) \* -1\.6em\)\)/, 'audio 档的位移读每颗自己的 --l')
});

test('调强②：电平链是 固定补偿 → 噪声底 → 慢基准 → 各自窗口宽度（缺一都算回退）', () => {
  // R133 之后这条链住在 createBandReader 的 read() 里（音符与频谱条共用同一台机器），
  // 而"每帧读一次谱"住在 readBands 里 —— 两段分开读，任何一段整段丢了都要红。
  const reader = pulse.slice(pulse.indexOf('function createBandReader'), pulse.indexOf('export interface NotePulseOptions'))
  const frame = pulse.slice(pulse.indexOf('function readBands('), pulse.indexOf('function topOf('))
  assert.ok(reader.length > 800 && !reader.includes('undefined'), `没整段读到 createBandReader，实测 ${reader.length}`)
  assert.ok(frame.length > 300, `没整段读到 readBands，实测 ${frame.length}`)
  // 信号源：跳动读 float(dB)，byte 数组每帧仍要填（Folia 岛信号层 R19 吃的是它）
  assert.match(frame, /analyser\.getFloatFrequencyData\(/, '读 dB：byte 数组按 −100~−30dB 截断，低段常年顶格 255')
  assert.match(frame, /analyser\.getByteFrequencyData\(/, 'byte 数组不许因为改读 float 就饿掉（岛信号层在读）')
  assert.match(reader, /spec\.trim\[index\]/, '固定补偿：频谱向低音倾斜，不补偿则五颗永远贴地')
  assert.match(reader, /<= FLOOR_DB/, '噪声底：低于门槛按静音处理，不显示也不许把基准拖下去')
  assert.match(reader, /seeded\[index\]/, '第一条真实读数直接落定基准（从 0dB 爬要平好几分钟）')
  assert.match(reader, /CENTER_TRACKING/, '自适应：每条频段各自慢跟自己的基准，换录音不必改常数表')
  assert.match(reader, /spec\.span\[index\]/, '各自窗口宽度：六段跨度实测 11~45dB，共用一个宽度会变成两颗狂跳四颗发抖')
  // 本案的教训：按段各算一份"瞬时涨、慢慢落"的峰值增益，等于把每条频段自己的动态一起除掉
  assert.doesNotMatch(pulse, /bandPeak/, '按段峰值归一化那一版必须消失（真机实测位移中位数与最大值只差 0.6 像素）')
  assert.doesNotMatch(reader, /Math\.sqrt\(/, 'dB 已是对数量，再开方是把压缩做两遍（看板处方里的这一条按实测改道）')
  const tracking = Number(/const CENTER_TRACKING = ([\d.]+)/.exec(pulse)?.[1] ?? 1)
  assert.ok(tracking > 0 && tracking <= 0.02, `CENTER_TRACKING=${tracking}：跟得太快就把拍子一起抹平了（约 1.9 秒走完一半）`)
  assert.match(pulse, /const FLOOR_DB = -70/, '噪声底在案，不是散在表达式里的裸数')
  // 频谱档的成立条件：**同一台机器**接两张表，而不是抄第二份链
  assert.equal([...pulse.matchAll(/createBandReader\(/g)].length, 3,
    '一处定义 + 两处实例（音符六条、频谱 16 条）；出现第四处就是有人另起了一套映射')
  assert.equal([...pulse.matchAll(/<= FLOOR_DB/g)].length, 1, '噪声底这一格全仓只许有一处实现')
  assert.match(pulse, /const NOTE_BANDS: BandSpec = \{ hz: NOTE_BAND_HZ, trim: BAND_TRIM_DB, span: BAND_SPAN_DB \}/,
    '六颗吃的就是验收过的那两张表')
  assert.match(pulse, /const SPECTRUM_BANDS: BandSpec = \{ hz: SPECTRUM_BAND_HZ, trim: SPECTRUM_TRIM_DB, span: SPECTRUM_SPAN_DB \}/)
  assert.match(pulse, /read\(dbBins, binHz, bins\.length\)/, '两档共用同一次 dB 读数（不各读一次谱）')
});

test('调强②b：三条常数表都恰好六条，与频段同序，补偿随频率单调加大', () => {
  // 少一条不会报错，只会让那颗音符吃到 undefined 补偿/宽度而永远贴地 —— 所以按长度钉死
  const table = (name) => {
    const hit = new RegExp(`const ${name}: readonly number\\[\\] = \\[([\\d.,\\s-]*)\\]`).exec(pulse)
    assert.ok(hit, `没抓到 ${name}`)
    const values = hit[1].split(',').map((s) => s.trim()).filter(Boolean)
    assert.equal(values.length, 6, `${name} 要六条（六颗音符各一条），实测 ${values.length}：${values.join(',')}`)
    for (const v of values) assert.ok(Number.isFinite(Number(v)), `${name} 里有非数字项：${v}`)
    return values.map(Number);
  };
  const trim = table('BAND_TRIM_DB');
  table('BAND_SPAN_DB');
  // 整条抹平成 0 也是六条，长度拦不住（M14 第一轮就没咬）：频谱倾斜是单向的，补偿必须逐级加大
  for (let i = 1; i < trim.length; i += 1) {
    assert.ok(trim[i] > trim[i - 1], `BAND_TRIM_DB 第 ${i + 1} 条(${trim[i]}) 必须大于第 ${i} 条(${trim[i - 1]})：越高段的倾斜越大`)
  }
  assert.ok(trim[5] - trim[0] >= 40, `补偿总落差 ${trim[5] - trim[0]}dB：实测倾斜是 70dB，落差小于一半就等于没补`)
  assert.match(pulse, /const BAND_SPAN_DB: readonly number\[\] = \[17, 11, 21, 29, 45, 36\]/,
    '窗口宽度按真机实测各段 p10~p90 跨度定，改数值要重新量')
});

test('调强③：位移与缩放的肉眼幅度不低于旧值的两倍', () => {
  const rule = /\.note-pulse\[data-tier="audio"\][\s\S]*?\}/.exec(css)
  assert.ok(rule, '没抓到 audio 档那条规则')
  const shift = Number(/var\(--l, 0\) \* -([\d.]+)em\)/.exec(rule[0])?.[1] ?? 0)
  const scaleBase = Number(/var\(--l, 0\) \* \(0\.(\d+)/.exec(rule[0])?.[1] ?? 0)
  assert.ok(shift >= 1.2, `位移系数 -${shift}em：旧值 -0.5em 乘上典型电平只有两三像素，这一格不许调回去`)
  assert.ok(scaleBase >= 30, `缩放基系数 0.${scaleBase}：旧值 0.18 太小，肉眼看不出鼓起来`)
});

test('边界：basic 档与降级/暂停路径一个字没动（调强不许把保底那条路一起改坏）', () => {
  assert.match(css, /\.note-pulse\[data-tier="basic"\][\s\S]*?animation: note-bounce 1\.15s ease-in-out infinite/, 'basic 档仍是 CSS 循环')
  assert.match(css, /\.note-pulse\[data-tier="off"\][\s\S]*?animation: none/, 'off 档仍静止')
  assert.match(css, /\.lyric-stage\.is-reduced \.note-pulse__note \{[\s\S]*?animation: none/, '减弱动效仍关掉')
  // 静音/降级/暂停三种场合都要归零（R133 起归零是一个具名函数）：只清总电平会留下"定格在半空"的字形
  assert.equal([...pulse.matchAll(/clearVisual\(\);/g)].length, 3,
    '三处归零：mount 的非电平档、降级、暂停')
  const clear = /function clearVisual\(\) \{[\s\S]*?\n  \}/.exec(pulse)
  assert.ok(clear, '没抓到 clearVisual')
  assert.match(clear[0], /for \(const note of notes\)[\s\S]*?setProperty\("--l", "0\.000"\)/, '音符那一套要归零')
  assert.match(clear[0], /for \(const bar of bars\)[\s\S]*?setProperty\("--l", "0\.000"\)/,
    '频谱那一套也要归零：只清当前档的话，暂停时换档会看到另一套停在半空')
  assert.match(pulse, /连续 120 帧读不到电平，已降回基础动画/, '静音保护的话术与档位不变')
  assert.match(pulse, /topOf\(bands\)/, '静音保护读的是各段最大值（全零才是真没信号）')
  // 降级只有一条路径：两档都降回 basic，不许 spectrum 另起一条"降回音符"的路
  assert.equal([...pulse.matchAll(/degradeToBasic\(/g)].length, 2, '一处定义 + 一处调用')
  assert.match(pulse, /effective = "basic";\s*\n\s*host\.dataset\.tier = effective;\s*\n\s*host\.dataset\.fallback = reason;/,
    '降级就是把生效档改成 basic 并记下原因（沿用既有那条路径，不新造）')
});

// ── R133 频谱条档（第四档）───────────────────────────────────────────────────

test('R133 频谱条：16 根半倍频程、区间首尾相接、补偿随频率单调加大', () => {
  assert.match(pulse, /const SPECTRUM_BAND_HZ: readonly \[number, number\]\[\] = Array\.from\(\{ length: 16 \}/,
    '16 根条的区间表由公式生成（改成手写字面量也要同步改这条判据）')
  // 公式的两个端点也要钉住：判据只"自己重算一遍性质"是不够的，源码里换了起点它照样绿。
  assert.match(pulse, /Math\.round\(60 \* Math\.SQRT2 \*\* index\)/, '起点 60Hz、公比 √2（半倍频程）')
  assert.match(pulse, /index === 15 \? 22050 : Math\.round\(60 \* Math\.SQRT2 \*\* \(index \+ 1\)\)/,
    '最后一根收到奈奎斯特，不把高频读数丢掉')
  // 表是算出来的，所以判"性质"而不是抄一份数字复算：半倍频程与首尾相接这两条性质比 16 行数字更该被钉住
  const bands = Array.from({ length: 16 }, (unused, index) => [
    Math.round(60 * Math.SQRT2 ** index),
    index === 15 ? 22050 : Math.round(60 * Math.SQRT2 ** (index + 1)),
  ]);
  assert.equal(bands.length, 16, '16 根条（用户定的区间是 12~24，取 2^4 让每根正好半个倍频程）')
  assert.equal(bands[0][0], 60, '最低一根从 60Hz 起：fftSize=512 @44.1kHz 一格约 86Hz，再低就没有格子可分')
  assert.equal(bands[15][1], 22050, '最后一根收到奈奎斯特，不把高频读数丢掉')
  for (let i = 1; i < 16; i += 1) {
    assert.equal(bands[i][0], bands[i - 1][1], `第 ${i + 1} 根的起点必须等于上一根的终点（中间留缝 = 有条永远读不到内容）`)
    const octaves = Math.log2(bands[i][1] / bands[i][0])
    assert.ok(octaves > 0.4 && octaves < 1.6, `第 ${i + 1} 根宽 ${octaves.toFixed(2)} 个倍频程：既不该挤成一坨也不该一根占掉大半个频谱`)
  }
  const literal = (name) => {
    const hit = new RegExp(`const ${name}: readonly number\\[\\] = \\[([\\d.,\\s-]*)\\]`).exec(pulse)
    assert.ok(hit, `没抓到 ${name}（频谱档的两张表必须是**字面量**：它们是一手实测的产物，不该由公式生成）`)
    const values = hit[1].split(',').map((text) => text.trim()).filter(Boolean).map(Number)
    assert.equal(values.length, 16, `${name} 要 16 条（16 根条各一条），实测 ${values.length}`)
    for (const value of values) assert.ok(Number.isFinite(value), `${name} 里有非数字项：${value}`)
    return values
  };
  const trim = literal('SPECTRUM_TRIM_DB');
  const span = literal('SPECTRUM_SPAN_DB');
  // 频谱向低音倾斜是单向的 ⇒ 总落差必须在（实测 24→54 = 30dB 这一档），
  // 但**不要求逐格单调**：真实录音在人声基频/泛音区有起伏，实测里第 5 根就比第 4 根低 2dB。
  assert.ok(trim[14] - trim[0] >= 20, `补偿总落差 ${trim[14] - trim[0]}dB：实测倾斜约 30dB，落差太小等于没补`)
  assert.ok(Math.max(...span) <= 45 && Math.min(...span) >= 11,
    `窗口宽度跨度 ${Math.min(...span)}~${Math.max(...span)}dB：窄于 11 会把一格量化抖动放大成整根在闪，宽于 45 就永远贴地`)
  // 最高那根（10.8k 以上）在普通录音里就是数字近静音：补偿**故意停在噪声底之下**，
  // 平时贴地、真有镲片/空气感才跳。把它"对齐到 −31"等于把 FFT 数值噪声放大成画面。
  assert.ok(trim[15] <= trim[14] + 2, `最后一根补偿 ${trim[15]} 不该高于前一根 ${trim[14]}：那是在放大数值噪声`)
  assert.match(pulse, /数字近静音|数值噪声/, "这一格的道理必须写在代码里，不然下一个改的人一定会'顺手把它对齐'")
  assert.doesNotMatch(pulse, /sampleMeasured\(MEASURED_CENTER_HZ/, '不许留一份"从六条插值到 16 条"的第二真相（实测过：低四根偏 24~31dB）')
  assert.doesNotMatch(pulse, /const SPECTRUM_TRIM_DB[^=]*= Array\.from/, '补偿表不许由区间表算出来（算出来的那版实测不对）')
});

test('R133 同一帧只读一次谱：两档共用 analyser 与 dB 数组，各读各的频段', () => {
  assert.equal([...pulse.matchAll(/getFloatFrequencyData\(/g)].length, 1,
    '每帧一次 dB 读数：两档各读一次会拿到不一致的瞬时值，"复用同一机制"就名存实亡')
  assert.equal([...pulse.matchAll(/getByteFrequencyData\(/g)].length, 1, 'byte 数组也一次（岛信号层在读）')
  assert.match(pulse, /readBands\(effective === "spectrum" \? "bars" : "notes"\)/, '这一帧算哪一套由生效档位决定（不在两处各写一遍）')
  assert.match(pulse, /const reader = want === "bars" \? barReader : noteReader;/)
});

test('R133 状态回读带 bars 与 rawBars：16 根条的行程与窗口装不装得下，实测才量得到', () => {
  assert.match(pulse, /bars: \[\.\.\.lastBars\]/, '每条 0~1 的电平')
  assert.match(pulse, /rawBars: barReader\.raw\.map\(/, '每条原始 dB 读数（判断窗口宽度够不够用）')
  assert.match(pulse, /rawBands: noteReader\.raw\.map\(/, '音符那六条仍然在（R124 的实测口径不许因为重构而断）')
  // 名字不许撞：本模块里 spectrum 这个词已经是"给岛的那份 byte 数组"，一词不装两义
  assert.doesNotMatch(pulse, /spectrum: \[\.\.\./, '状态里那 16 条要叫 bars')
  assert.match(pulse, /spectrum\(\): Uint8Array \| null \{/, '给岛的 byte 数组出口不变')
});
