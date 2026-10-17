// 阶段 5.5 · T5 封面取色主题断言。
// 取色算法是纯函数，所以这里直接喂像素断言数值（对比度下限、三档归类、撞色旋转都算得出来），
// 而不是锁源码形状。样式接线放在最后两条。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  contrastRatio, derivePalette, extractCover, extractPalette, primaryFloorFor,
  pushContrast, relativeLuminance, rotateHueAway, tierForTheme,
} from '../src/cover-palette.ts'

const solid = (rgb, size = 64) => {
  const px = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i += 1) {
    px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = 255
  }
  return px
}

// 两色对半，用来构造"有色彩可派生"的封面（median-cut 至少要有两个簇）。
const twoTone = (a, b, size = 64) => {
  const px = solid(a, size)
  for (let y = 0; y < size / 2; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      px[i] = b[0]; px[i + 1] = b[1]; px[i + 2] = b[2]; px[i + 3] = 255
    }
  }
  return px
}

const hueOf = ([r, g, b]) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (!d) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return ((h * 60) + 360) % 360
}
const hueGap = (a, b) => {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360
  return Math.min(d, 360 - d)
}

// 与 cover-palette 同式，只用来造测试封面与核对既有档位取值（模块没导出 hslToRgb）
const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l)
  const f = (n) => {
    const k = (n + h / 30) % 12
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))
  }
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}
// 13 色相 × 6 饱和度。饱和度下限取 0.15 而不是附录 A 探针用的 0.1：
// 造测试封面要经过 8bit 取整，再被 rgbToHsl 反算，0.12 附近的值可能掉到
// FLAT_SATURATION(0.12) 以下被误判成"无彩度封面"。低饱和不是最坏格
// （最坏格一律在饱和度上限处、色相 70 附近），所以砍掉低端不改变结论。
const HUES = [30, 45, 55, 70, 90, 120, 160, 200, 210, 250, 280, 320, 350]
const SATS = [0.15, 0.25, 0.35, 0.5, 0.7, 1.0]

test('相对亮度与对比度符合 WCAG 定义', () => {
  assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-6)
  assert.equal(relativeLuminance([0, 0, 0]), 0)
  assert.ok(Math.abs(contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 1e-6)
  assert.ok(Math.abs(contrastRatio([120, 40, 200], [120, 40, 200]) - 1) < 1e-6, '同色对比度为 1')
  assert.equal(
    contrastRatio([0, 0, 0], [255, 255, 255]),
    contrastRatio([255, 255, 255], [0, 0, 0]),
    '对比度必须对称',
  )
})

test('pushContrast 沿亮度轴推到目标对比度，不贴死黑白', () => {
  const back = [46, 52, 74]
  const out = pushContrast([150, 150, 170], back, 9)
  assert.ok(contrastRatio(out, back) >= 9 - 1e-6, `实际 ${contrastRatio(out, back).toFixed(2)}`)
  // 已经够对比时不该继续推，否则任何封面都会得到纯白正文。
  const already = pushContrast([250, 250, 250], back, 9)
  assert.ok(contrastRatio(already, back) >= 9)
  assert.deepEqual(already, [250, 250, 250], '达标就不动')
  // 只动亮度：色相与饱和必须原样保留，否则取色主题会越推越灰。
  const chroma = pushContrast([200, 60, 40], [250, 248, 245], 4.5)
  assert.ok(hueGap(chroma, [200, 60, 40]) < 1.5, `色相被改：${hueGap(chroma, [200, 60, 40]).toFixed(1)}°`)
})

test('三档底色按封面亮度归类', () => {
  assert.equal(extractPalette(solid([18, 22, 34]), 64, 64).tier, 'ink')
  assert.equal(extractPalette(solid([128, 96, 64]), 64, 64).tier, 'tinted')
  assert.equal(extractPalette(solid([232, 238, 244]), 64, 64).tier, 'rich')
})

test('主题定明暗档：day→rich、dusk→dusk、night→ink', () => {
  assert.equal(tierForTheme('day'), 'rich')
  assert.equal(tierForTheme('dusk'), 'dusk')
  assert.equal(tierForTheme('night'), 'ink')
})

// 用户 2026-10-03 拍板：primary 下限做成"按档查询"的表——dusk 档 7，其余三档维持 9。
// 依据是 L=0.28 时纯白字的对比度天花板只有 7.37，继续要求 9 数学上不成立（附录 A）。
test('按档对比度下限双断言：dusk 档最坏 ≥7，其余档最坏 ≥9（13 色相 × 6 饱和度全枚举）', () => {
  for (const tier of ['ink', 'tinted', 'dusk', 'rich']) {
    const floor = primaryFloorFor(tier)
    assert.equal(floor, tier === 'dusk' ? 7 : 9, `${tier} 档的 primary 下限被改动了`)
    let worst = Infinity
    let worstCase = ''
    for (const h of HUES) {
      for (const s of SATS) {
        // 喂纯色封面：median-cut 得到一个簇，hue/saturation 就是喂进去的值
        const p = extractPalette(solid(hsl(h, s, 0.5)), 64, 64, tier)
        assert.equal(p.error, undefined, `不该判失败：h=${h} s=${s} -> ${p.error}`)
        assert.equal(p.tier, tier, '指定档位必须原样落地')
        const back = p[tier]
        const cp = contrastRatio(p.primary, back)
        if (cp < worst) { worst = cp; worstCase = `h=${h} s=${s}` }
        assert.ok(contrastRatio(p.secondary, back) >= 4.5 - 1e-6,
          `secondary 不足：${tier} h=${h} s=${s} -> ${contrastRatio(p.secondary, back).toFixed(2)}`)
        assert.ok(contrastRatio(p.accent, back) >= 3.2 - 1e-6,
          `accent 不足：${tier} h=${h} s=${s} -> ${contrastRatio(p.accent, back).toFixed(2)}`)
      }
    }
    assert.ok(worst >= floor - 1e-6,
      `${tier} 档 primary 最坏 ${worst.toFixed(2)} < ${floor}（${worstCase}）`)
    console.log(`  ${tier} 档 primary 最坏 ${worst.toFixed(2)}（下限 ${floor}，${worstCase}）`)
  }
})

test('既有三档底色取值逐位不变，dusk 档按 L=0.28 / 饱和度上限 0.25 推导', () => {
  const stats = extractCover(solid(hsl(210, 0.6, 0.5)), 64, 64)
  assert.equal('error' in stats, false)
  const { hue, saturation } = stats
  const p = derivePalette(stats, 'dusk')
  assert.deepEqual(p.ink, hsl(hue, Math.min(saturation, 0.34), 0.075))
  assert.deepEqual(p.tinted, hsl(hue, Math.min(saturation, 0.42), 0.2))
  assert.deepEqual(p.rich, hsl(hue, Math.max(0.18, Math.min(saturation + 0.18, 0.62)), 0.86))
  assert.deepEqual(p.dusk, hsl(hue, Math.min(saturation, 0.25), 0.28))
  // 四档底色互不相同，否则"三套主题在 Folia 内有可见区别"就是空话
  const keys = ['ink', 'tinted', 'dusk', 'rich'].map((k) => p[k].join(','))
  assert.equal(new Set(keys).size, 4, '四档底色出现重复值')
})

test('档位取值来自按档查询表，不是手挑颜色', () => {
  const src = readFileSync(new URL('../src/cover-palette.ts', import.meta.url), 'utf8')
  assert.match(src, /const TIER_SPECS: Record<\s*PaletteTier/, '要有按档查询表')
  assert.equal(src.match(/primaryFloor: 9/g)?.length, 3, '只有 dusk 档放宽到 7，其余三档必须仍是 9')
  assert.match(src, /primaryFloor: 7/, 'dusk 档下限 7')
  assert.match(src, /lightness: 0\.28/, 'dusk 档亮度 0.28')
  assert.match(src, /Math\.min\(s, 0\.25\)/, 'dusk 档饱和度上限 0.25')
  assert.doesNotMatch(src, /@property/, '取色层不碰 CSS 注册')
})

test('文字三色对所选底色满足对比度下限', () => {
  for (const src of [[18, 22, 34], [232, 238, 244], [128, 96, 64], [12, 140, 90]]) {
    const p = extractPalette(solid(src), 64, 64)
    assert.equal(p.error, undefined, `不该判失败：${src} -> ${p.error}`)
    const back = p[p.tier]
    assert.ok(contrastRatio(p.primary, back) >= 9 - 1e-6, `primary 不足: ${src} -> ${contrastRatio(p.primary, back).toFixed(2)}`)
    assert.ok(contrastRatio(p.secondary, back) >= 4.5 - 1e-6, `secondary 不足: ${src}`)
    assert.ok(contrastRatio(p.accent, back) >= 3.2 - 1e-6, `accent 不足: ${src}`)
  }
})

test('accent 与 secondary 撞色时按最短弧旋转 hue，不撞色时不动', () => {
  const other = [201, 91, 41]
  const rotated = rotateHueAway([200, 90, 40], other, 40)
  assert.ok(hueGap(rotated, other) >= 40 - 1e-6, `旋转后间隔不足: ${hueGap(rotated, other).toFixed(1)}`)
  // 最短弧：只转到刚好达标，不多转。
  assert.ok(hueGap(rotated, other) < 46, `转过了：${hueGap(rotated, other).toFixed(1)}°`)
  const distinct = [40, 90, 200]
  assert.deepEqual(rotateHueAway([200, 90, 40], distinct, 40), [200, 90, 40], '本来不撞色就不该改')
})

// 灰阶封面派生不出强调色。方案原文写的是"色簇数或明度跨度低于阈值"，
// 但纯色判失败会和"三档按亮度归类"那组断言直接冲突（那组喂的就是纯色），
// 所以失败信号定在彩度上：没有彩度就没有可派生的 accent，硬凑只会得到灰色强调色。
test('灰阶封面判定为取色失败，交回调用方走令牌回退', () => {
  const flat = extractPalette(solid([90, 90, 90]), 64, 64)
  assert.equal(typeof flat.error, 'string', '纯色必须给出可读的失败原因')
  assert.ok(flat.error.includes('单一') || flat.error.includes('彩度'), `原因要能落到日志上：${flat.error}`)
  const grayRamp = extractPalette(twoTone([40, 40, 40], [210, 210, 210]), 64, 64)
  assert.equal(typeof grayRamp.error, 'string', '明度跨度大但无彩度，同样算失败')
  const colorful = extractPalette(twoTone([22, 40, 120], [220, 150, 40]), 64, 64)
  assert.equal(colorful.error, undefined, '有彩度的双色封面不得误判')
})

test('空像素与全透明像素不得抛异常，按失败处理', () => {
  const empty = extractPalette(new Uint8ClampedArray(64 * 64 * 4), 64, 64)
  assert.equal(typeof empty.error, 'string')
})

// 派生色只能影响 Folia 视图：全局令牌与 Rhine 视图必须原样。
const chrome = readFileSync(new URL('../src/lyric-folia-chrome.css', import.meta.url), 'utf8')
const stageCss = readFileSync(new URL('../src/lyric-stage.css', import.meta.url), 'utf8')
const stageTs = readFileSync(new URL('../src/lyric-stage.ts', import.meta.url), 'utf8')

test('派生色只作用于 Folia，全局令牌不受影响', () => {
  assert.ok(chrome.includes('var(--folia-'), '暗场/控制条读派生色')
  // 分层优先规则第 1 条（用户 2026-10-03 拍板）：全局四份样式表永不得引用派生色。
  for (const file of ['../src/music.css', '../src/music-theme.css', '../src/music-theme-switch.css', '../src/style.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(css, /--folia-/, `${file} 不得引用派生色`)
  }
  // 派生色只写在 #lyric-stage 上，不得写到 :root 或 documentElement
  assert.doesNotMatch(stageTs, /documentElement\.style\.setProperty\("--folia-/, '派生色不得写到 :root')
  assert.match(
    chrome,
    /var\(--folia-[a-z]+,\s*var\(--[a-z-]+\)\)/,
    '每个派生色都要有令牌回退',
  )
})

// 方案 Step 5 原写"六个变量各注册 @property 以获得过渡"。实测（Edge 154，CDP 现场验证）
// 这条路和验收硬要求的"失败回退到令牌"互斥：注册过的自定义属性永远有值，
// var(--folia-primary, var(--ink)) 的回退分支再也走不到，失败态会拿到写死的初始色。
// 所以过渡改放在消费端属性上（color / background-color 本身就是可插值属性）。
test('派生色渐变靠消费端过渡，不靠 @property 注册', () => {
  assert.doesNotMatch(stageCss, /@property --folia-/, '注册会吃掉 var() 的令牌回退分支')
  assert.match(stageCss, /\.lyric-stage \{[\s\S]*?transition:[\s\S]*?color 600ms/, '舞台根的文字色要有派生过渡')
  assert.match(chrome, /transition:[\s\S]*?background-color 600ms/, '暗场底色换封面时渐变而非跳变')
  // 底色用单层 background-color：三段渐变作为 image 只能整条离散替换，插不了值。
  assert.match(chrome, /\.lyric-scrim \{[\s\S]*?background-color: color-mix/, '暗场走可插值的 background-color')
  assert.match(chrome, /--folia-back: var\(--folia-ink, var\(--page-bg\)\)/, '三档底色折成一个别名，始终回退令牌')
  assert.match(chrome, /\[data-tier="tinted"\]/, '档位由 data-tier 选择，JS 不拼字符串')
})

test('取色失败要留下可回读的原因，不得静默', () => {
  assert.match(stageTs, /dataset\.paletteFallback\s*=\s*/, '失败原因写进 data 属性')
  assert.match(stageTs, /delete root\.dataset\.paletteFallback/, '成功时要清掉失败标记')
  // 换歌快时旧结果不得覆盖新结果：令牌号守卫。
  assert.match(stageTs, /paletteToken/, '取色必须有 in-flight 守卫')
})
