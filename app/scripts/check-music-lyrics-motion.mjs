// 阶段 5.5 · T3 歌词动效清单逐项断言，对照 memory/folia-learnings.md 第 6 节。
// 类名是逐帧同步的判定依据（漂移采样器读 .is-active / .is-word-active），
// 所以这里既锁"动效有"，也锁"类名没被改坏"。
//
// 与方案的一处有意偏差：方案 Task 3 先写死倍率、Task 4 再换成强度变量，那会让同一批
// 断言在两个任务里各改一次。这里直接从变量起步（默认值等于 normal 档），
// Task 4 只需补变量表与按钮，不必回头重写样式与断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const css = await readFile(new URL('../src/lyric-stage.css', import.meta.url), 'utf8')
const stage = await readFile(new URL('../src/lyric-stage.ts', import.meta.url), 'utf8')

const blockOf = (selector) => {
  const at = css.indexOf(selector)
  assert.ok(at >= 0, `找不到样式块 ${selector}`)
  const end = css.indexOf('\n}', at)
  assert.ok(end > at, `${selector} 块没有闭合`)
  return css.slice(at, end)
}

test('字号是沉浸级大字，当前行更大且用独立 scale 实现（不触发重排）', () => {
  const line = blockOf('.lyric-line {')
  const size = /font-size: clamp\((\d+)px/.exec(line)
  assert.ok(size, '基线字号必须是 clamp')
  assert.ok(Number(size[1]) >= 28, `基线字号下限应 ≥28px，实际 ${size[1]}px`)
  const active = blockOf('.lyric-line.is-active {')
  assert.match(active, /scale: 1/, '当前行用独立 scale 属性放大')
  assert.doesNotMatch(active, /font-size/, '不用 font-size 做大小变化（会重排整列）')
})

test('行入场 = scale + 纵向位移 + blur(10px)→0 + 颜色插值，曲线带 spring 过冲', () => {
  const enter = blockOf('@keyframes lyric-enter {')
  assert.match(enter, /opacity: 0;[\s\S]*?filter: blur\(10px\)/, '入场起点 blur(10px)')
  assert.match(enter, /translate: 0 calc\(var\(--i-enter-y/, '入场起点有纵向位移')
  assert.match(enter, /to \{[\s\S]*?filter: blur\(0\)/, '入场终点 blur 归零')
  assert.match(enter, /to \{[\s\S]*?translate: 0 0/, '入场终点位移归零')
  assert.match(enter, /to \{[\s\S]*?opacity: 1/, '入场终点淡入到位')
  // scale 走过渡而不是关键帧：入场瞬态与"当前行比邻居大"是同一件事，一处定义。
  const line = blockOf('.lyric-line {')
  assert.match(line, /scale: calc\(1 - var\(--i-enter-scale/, '邻居行按强度档缩小一档')
  assert.match(line, /scale 620ms cubic-bezier\([^)]*1\.[2-9]/, 'scale 过渡用带过冲的 spring 曲线')
  const active = blockOf('.lyric-line.is-active {')
  assert.match(
    active,
    /animation:[\s\S]*?lyric-enter 620ms cubic-bezier\([^)]*1\.[2-9]/,
    '入场挂在 is-active 上，spring 曲线带过冲',
  )
  assert.match(active, /color: var\(--folia-primary/, '颜色插值由令牌承担')
})

// 实测踩到：把 blur(10px) 写成 .lyric-line 的静止态，入场过渡确实成立，
// 代价是除当前行以外整列歌词永久糊成一团（回读 d=1/2/3 分别 blur 5/7/9px），
// 直接违背"歌词可读性优先"。模糊只能是入场那一瞬，邻居分层只准用透明度。
test('回归：模糊只属于入场瞬态，静止态与距离阶梯一律清晰', () => {
  const line = blockOf('.lyric-line {')
  assert.doesNotMatch(line, /filter/, '静止态不得带 blur')
  assert.doesNotMatch(line, /translate/, '静止态不得带位移')
  for (const d of [1, 2, 3]) {
    const rung = new RegExp(`lyric-line\\[data-distance="${d}"\\] \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    assert.doesNotMatch(rung, /filter|blur/, `距离 ${d} 阶梯不得叠加 blur`)
  }
})

test('行尾按距离淡出：data-distance 阶梯，且只更新有限窗口', () => {
  for (const d of [1, 2, 3])
    assert.match(css, new RegExp(`lyric-line\\[data-distance="${d}"\\][\\s\\S]*?opacity`), `缺距离 ${d}`)
  // 阶梯必须单调变暗，否则"远处更亮"会抢走当前行的焦点。
  const op = (d) => Number(new RegExp(`lyric-line\\[data-distance="${d}"\\] \\{[^}]*opacity: ([\\d.]+)`).exec(css)?.[1])
  const active = Number(/\.lyric-line\.is-active \{[\s\S]*?opacity: ([\d.]+)/.exec(css)?.[1])
  assert.ok(active > op(1) && op(1) > op(2) && op(2) > op(3), `淡出阶梯不单调: ${active}/${op(1)}/${op(2)}/${op(3)}`)

  const apply = stage.slice(stage.indexOf('function applyTime('), stage.indexOf('function setMode('))
  assert.match(apply, /dataset\.distance = String\(distance\)/, '距离在换行时写入')
  assert.match(apply, /delete node\.dataset\.distance/, '窗口外的行要清掉距离，否则残留旧阶梯')
  assert.match(apply, /for \(let offset = -3; offset <= 3/, '只遍历 ±3 窗口，不整表扫')
})

test('当前行双层发光 + 轻微呼吸浮动，呼吸用独立 translate 不覆盖入场位移', () => {
  const active = blockOf('.lyric-line.is-active {')
  assert.match(active, /text-shadow:[\s\S]*?color-mix\(in srgb, var\(--folia-accent, var\(--accent\)\)/, '第一层 accent 光')
  assert.match(active, /text-shadow:[\s\S]*?color-mix\(in srgb, var\(--folia-primary, var\(--ink\)\)/, '第二层主体光（双层）')
  // 入场与呼吸都动 translate，靠 delay 错开而不是靠特异度压制：
  // 呼吸必须等入场跑完再起，否则两条动画同属性打架，入场位移会被呼吸吃掉。
  assert.match(active, /lyric-enter (\d+)ms/, '入场时长')
  const enter = Number(/lyric-enter (\d+)ms/.exec(active)?.[1])
  const breathe = Number(/lyric-breathe [\d.]+s ease-in-out (\d+)ms/.exec(active)?.[1])
  assert.ok(breathe >= enter, `呼吸延迟 ${breathe}ms 不得早于入场 ${enter}ms`)
  const breatheBlock = blockOf('@keyframes lyric-breathe {')
  assert.match(breatheBlock, /translate: 0 calc\(var\(--i-breathe/, '呼吸幅度由强度变量驱动')
  assert.doesNotMatch(breatheBlock, /transform/, '呼吸不得用 transform，会覆盖入场位移')
})

test('逐字高亮走 --accent + 轻微 scale，入场允许 stagger 且必须有上限', () => {
  const active = blockOf('.lyric-word.is-word-active {')
  assert.match(active, /color: var\(--folia-accent, var\(--accent\)\)/, '当前字走强调色（带令牌回退）')
  assert.match(active, /scale: 1\./, '当前字轻微放大')
  const word = blockOf('.lyric-word {')
  assert.match(word, /transition-delay: calc\(var\(--i, 0\) \* var\(--i-stagger/, '按字序 stagger')
  assert.match(stage, /setProperty\("--i", String\(wordIndex % \d+\)\)/, '字序取模封顶')
  // 46px 大字一行可能 20+ 字，不封顶的话行尾会比音频慢半秒。
  const mod = Number(/setProperty\("--i", String\(wordIndex % (\d+)\)\)/.exec(stage)?.[1])
  assert.ok(mod >= 6 && mod <= 16, `stagger 档位上限不合理: ${mod}`)
})

test('同步判定所依赖的类名保持不变', () => {
  assert.match(stage, /classList\.add\("is-active"\)/)
  assert.match(stage, /classList\.add\("is-word-active"\)/)
  assert.match(stage, /classList\.add\("is-word-passed"\)/)
})

test('颜色一律走令牌，样式表不出现硬编码色值', () => {
  // 逐行剔除 mask-image：linear-gradient(..., #000 ...) 是透明度遮罩的惯用写法，
  // 那里的 #000 表达"完全不遮挡"，不是主题色，不该被这条规则管。
  const code = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/mask-image|mask:/.test(line))
    .join("\n");
  assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, "硬编码色值要换成令牌或 color-mix");
});
