// 阶段 5.5 · T4 动效强度三档（原版 animationIntensity 第一期）。
// 强度必须全部走 CSS 变量：JS 分支会让"改档"变成重建 DOM，
// 也会让逐帧路径出现与档位相关的代码分叉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { INTENSITY_VARS, resolveLyricIntensity } from '../src/lyric-stage.ts'

const stage = readFileSync(new URL('../src/lyric-stage.ts', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/lyric-stage.css', import.meta.url), 'utf8')
const controls = readFileSync(new URL('../src/lyric-controls.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8')

test('三档取值合法，非法值回落 normal', () => {
  assert.equal(resolveLyricIntensity('calm'), 'calm')
  assert.equal(resolveLyricIntensity('chaotic'), 'chaotic')
  assert.equal(resolveLyricIntensity('normal'), 'normal')
  for (const bad of [undefined, null, '', 'NORMAL', 'wild', 42, {}])
    assert.equal(resolveLyricIntensity(bad), 'normal', `fallback for ${String(bad)}`)
})

// 单位各不相同（px / em / 倍率 / ms），所以只要求同名列内单调递增。
test('每档四个驱动量齐全且 calm < normal < chaotic', () => {
  const names = ['--i-breathe', '--i-enter-y', '--i-enter-scale', '--i-stagger']
  for (const key of names) {
    const calm = Number(INTENSITY_VARS.calm[key])
    const normal = Number(INTENSITY_VARS.normal[key])
    const chaotic = Number(INTENSITY_VARS.chaotic[key])
    for (const [label, v] of [['calm', calm], ['normal', normal], ['chaotic', chaotic]])
      assert.ok(Number.isFinite(v), `${key}/${label} 不是数字`)
    assert.ok(calm < normal && normal < chaotic, `${key} 不单调: ${calm}/${normal}/${chaotic}`)
    assert.ok(calm >= 0, `${key} 不能为负`)
  }
})

test('动效样式读变量而不是硬编码倍率', () => {
  for (const key of ['--i-breathe', '--i-enter-y', '--i-enter-scale', '--i-stagger'])
    assert.ok(css.includes(`var(${key}`), `样式缺 ${key} 消费点`)
  assert.match(css, /translate: 0 calc\(var\(--i-enter-y/, '入场位移由变量驱动')
  assert.match(css, /scale: calc\(1 - var\(--i-enter-scale/, '入场缩放由变量驱动')
  assert.match(css, /transition-delay: calc\(var\(--i, 0\) \* var\(--i-stagger/, 'stagger 由变量驱动')
  assert.match(css, /@keyframes lyric-breathe \{[\s\S]*?var\(--i-breathe/, '呼吸幅度由变量驱动')
})

test('档位由控制条三态按钮循环切换，写入只动变量不清 DOM', () => {
  assert.match(controls, /data-action="lyric-intensity"/, '控制条里有三态按钮')
  assert.match(app, /case "lyric-intensity"/, '动作走统一委托')
  const apply = stage.slice(
    stage.indexOf('function applyIntensity'),
    stage.indexOf('function applyIntensity') + 700,
  )
  assert.ok(apply.length > 40, 'applyIntensity 必须存在')
  assert.match(apply, /for \(const \[key, value\] of Object\.entries\(table\)\)/, '遍历写变量')
  assert.match(apply, /root\.dataset\.intensity = /, '档位写进 data 属性供回读与断言')
  assert.doesNotMatch(apply, /textContent = ""|build\(|showPulse\(/, '改档不得清 DOM')
})

test('偏好注册 lyricIntensity 且读写两侧都校验', () => {
  assert.match(app, /lyricIntensity: "normal" as LyricIntensity/, '默认 normal')
  assert.match(app, /resolveLyricIntensity\(preferences\.lyricIntensity\)/, '读取侧校验')
  assert.match(app, /intensity: \(\) => preferences\.lyricIntensity/, '接到舞台')
})

// 三档在减弱动效下必须完全失效，否则"退化为淡入淡出"只覆盖了 normal 档。
test('回归：减弱动效降级块把强度变量一并归零', () => {
  const reduced = css.slice(css.indexOf('.lyric-stage.is-reduced .lyric-line,'))
  assert.match(reduced, /transition-delay: 0ms/, 'stagger 归零')
  assert.match(reduced, /translate: none/, '入场位移归零')
  assert.match(reduced, /scale: none/, '入场缩放归零')
  assert.match(reduced, /animation: none/, '呼吸归零')
  // 呼吸关键帧本身读变量，animation:none 已经不再播放；这里锁的是"不靠变量取值来降级"。
  assert.doesNotMatch(reduced, /--i-breathe/, '降级不得依赖把强度变量改小')
})
