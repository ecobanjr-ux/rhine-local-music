/**
 * Cover-derived palette for the Folia lyric view.
 *
 * Everything here is a pure colour computation except `loadCoverStats`, which
 * reads the (same-origin) artwork through a canvas so no CORS surface is touched.
 * Failure is always expressed as `{ error }` and never thrown: a cover we cannot
 * read must degrade to the token scrim, not break the lyrics.
 */

export type Rgb = [number, number, number];
export type PaletteTier = "ink" | "tinted" | "dusk" | "rich";
/** 决定档位的主题；与 music-app 的 Theme 同形，取色层不反向依赖 UI。 */
export type PaletteTheme = "day" | "dusk" | "night";

export interface CoverPalette {
  ink: Rgb;
  tinted: Rgb;
  dusk: Rgb;
  rich: Rgb;
  primary: Rgb;
  secondary: Rgb;
  accent: Rgb;
  tier: PaletteTier;
  /** 取色失败的原因；成功时为 undefined，调用方据此回退到令牌暗场。 */
  error?: string;
}

/** 封面的色彩统计：换主题时用它重新推导，不必再解码一次封面。 */
export interface CoverStats {
  hue: number;
  saturation: number;
  accentSource: Rgb;
  /** 封面自身亮度归出的档位；只在调用方不指定档位时当默认值用。 */
  coverTier: PaletteTier;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [(((h * 60) + 360) % 360), s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const hueOf = (c: Rgb) => rgbToHsl(c)[0];

/** 色相间隔走最短弧：200° 与 10° 相差 30°，不是 190°。 */
function hueGap(a: Rgb, b: Rgb) {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360;
  return Math.min(d, 360 - d);
}

const linearize = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance(c: Rgb): number {
  return 0.2126 * linearize(c[0]) + 0.7152 * linearize(c[1]) + 0.0722 * linearize(c[2]);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 沿亮度轴把前景色推到目标对比度，达到即停。
 *
 * 为什么可以二分：固定 h/s 时亮度随 L 单调，而 contrastRatio 在 L 轴上是 V 形
 * ——朝背景亮度的交点靠近时单调下降、越过之后单调上升。所以从原 L 出发的任一
 * 侧，"达标"区间都是从端点向内收敛的一段，谓词形如 false…false,true…true。
 */
export function pushContrast(fore: Rgb, back: Rgb, target: number): Rgb {
  if (contrastRatio(fore, back) >= target - 1e-6) return [fore[0], fore[1], fore[2]];
  const [h, s, l] = rgbToHsl(fore);
  const edge = (to: number): number | null => {
    if (contrastRatio(hslToRgb(h, s, to), back) < target - 1e-6) return null;
    let lo = l;
    let hi = to;
    for (let i = 0; i < 24; i += 1) {
      const mid = (lo + hi) / 2;
      if (contrastRatio(hslToRgb(h, s, mid), back) >= target - 1e-6) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const up = edge(1);
  const down = edge(0);
  const sides = [up, down].filter((v): v is number => v !== null);
  // 两头都推不到目标（背景本身亮度居中且前景饱和太低）时，取更远的那一头保底可读。
  const chosen = sides.length
    ? sides.reduce((a, b) => (Math.abs(a - l) <= Math.abs(b - l) ? a : b))
    : l > 0.5 ? 1 : 0;
  let out = hslToRgb(h, s, chosen);
  // 量化到 8bit 可能刚好差一丝，微调补齐；最多 40 步，不会贴到纯黑纯白。
  let guard = 0;
  const step = chosen > l ? 0.004 : -0.004;
  let l2 = chosen;
  while (contrastRatio(out, back) < target - 1e-6 && guard < 40) {
    l2 = clamp01(l2 + step);
    out = hslToRgb(h, s, l2);
    guard += 1;
  }
  return out;
}

/** 撞色时沿最短弧旋到刚好达标；本来不撞色则原样返回。 */
export function rotateHueAway(accent: Rgb, other: Rgb, minGapDeg: number): Rgb {
  const gap = hueGap(accent, other);
  if (gap >= minGapDeg - 1e-6) return [accent[0], accent[1], accent[2]];
  const [h, s, l] = rgbToHsl(accent);
  const clockwise = ((hueOf(other) - h) % 360 + 360) % 360;
  // other 落在顺时针侧就往逆时针退，反之亦然——两个方向都能达标时这是最短的一条。
  const dir = clockwise <= 180 ? -1 : 1;
  const next = (((h + dir * (minGapDeg - gap)) % 360) + 360) % 360;
  return hslToRgb(next, s, l);
}

interface Cluster {
  color: Rgb;
  weight: number;
}

function splitBox(pixels: Rgb[]): Rgb[][] {
  let axis = 0;
  let best = -1;
  for (let a = 0; a < 3; a += 1) {
    let lo = 255;
    let hi = 0;
    for (const p of pixels) {
      if (p[a] < lo) lo = p[a];
      if (p[a] > hi) hi = p[a];
    }
    if (hi - lo > best) {
      best = hi - lo;
      axis = a;
    }
  }
  if (best <= 0) return [];
  const sorted = [...pixels].sort((x, y) => x[axis] - y[axis]);
  const mid = Math.floor(sorted.length / 2);
  if (mid === 0 || mid >= sorted.length) return [];
  return [sorted.slice(0, mid), sorted.slice(mid)];
}

function average(pixels: Rgb[]): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    r += p[0];
    g += p[1];
    b += p[2];
  }
  const n = pixels.length || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** median-cut：按最长轴中位数递归切到 maxBoxes 个色簇。 */
function medianCut(pixels: Rgb[], maxBoxes: number): Cluster[] {
  if (!pixels.length) return [];
  let boxes: Rgb[][] = [pixels];
  while (boxes.length < maxBoxes) {
    const widest = boxes.reduce((acc, box, index) => {
      let range = 0;
      for (let a = 0; a < 3; a += 1) {
        let lo = 255;
        let hi = 0;
        for (const p of box) {
          if (p[a] < lo) lo = p[a];
          if (p[a] > hi) hi = p[a];
        }
        range = Math.max(range, hi - lo);
      }
      return range > acc.range ? { index, range, size: box.length } : acc;
    }, { index: -1, range: 0, size: 0 });
    if (widest.index < 0 || widest.range <= 8 || widest.size < 2) break;
    const parts = splitBox(boxes[widest.index]);
    if (parts.length !== 2) break;
    boxes = [...boxes.slice(0, widest.index), ...parts, ...boxes.slice(widest.index + 1)];
  }
  return boxes.map((box) => ({ color: average(box), weight: box.length }));
}

const FLAT_SATURATION = 0.12;

/**
 * 每档底色的亮度、饱和度上限与 primary 对比度下限。
 *
 * primaryFloor 之所以按档查询：底色越亮，白字能达到的对比度上限越低——
 * 完全中性灰时 L≈0.285 就是 9:1 的天花板，带色相更低（黄绿高饱和把上限压到 L≈0.20）。
 * 所以中间亮度的 dusk 档继续要求 9 是数学上不成立的，pushContrast 会推到纯白仍不达标。
 * 7:1 是 WCAG AAA 正文级，而 46px 当前行按 WCAG 属大字（AAA 大字只要 4.5:1）。
 * 全枚举依据（13 色相 × 7 饱和度的最坏值）见阶段 6 方案附录 A。
 */
const TIER_SPECS: Record<
  PaletteTier,
  { lightness: number; saturation: (coverSaturation: number) => number; primaryFloor: number }
> = {
  ink: { lightness: 0.075, saturation: (s) => Math.min(s, 0.34), primaryFloor: 9 },
  tinted: { lightness: 0.2, saturation: (s) => Math.min(s, 0.42), primaryFloor: 9 },
  dusk: { lightness: 0.28, saturation: (s) => Math.min(s, 0.25), primaryFloor: 7 },
  rich: { lightness: 0.86, saturation: (s) => Math.max(0.18, Math.min(s + 0.18, 0.62)), primaryFloor: 9 },
};

/** 主题定明暗档，封面定色相（用户 2026-10-03 拍板）。 */
const THEME_TIER: Record<PaletteTheme, PaletteTier> = {
  day: "rich",
  dusk: "dusk",
  night: "ink",
};

export function tierForTheme(theme: PaletteTheme): PaletteTier {
  return THEME_TIER[theme];
}

export function primaryFloorFor(tier: PaletteTier): number {
  return TIER_SPECS[tier].primaryFloor;
}

/** 取色失败时的占位色板；调用方见到 error 就会摘净变量回退令牌，这些值不会被消费。 */
const NEUTRAL: CoverPalette = {
  ink: [12, 14, 20],
  tinted: [30, 34, 46],
  dusk: [40, 46, 58],
  rich: [236, 238, 242],
  primary: [240, 240, 240],
  secondary: [180, 184, 192],
  accent: [200, 150, 90],
  tier: "ink",
};

export function extractCover(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): CoverStats | { error: string } {
  const samples: Rgb[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 8) {
    if (pixels[i + 3] < 128) continue;
    samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
  }
  const clusters = medianCut(samples, 5);
  const total = samples.length;
  if (!clusters.length) return { error: "封面没有可读取的像素" };

  // 失败信号落在彩度而不是色簇数：灰阶封面派生不出强调色，硬凑只会得到一个灰色 accent。
  // （纯色但带彩度的封面仍然有效——三档底色本来就是按亮度归类的。）
  const maxSaturation = Math.max(...clusters.map((c) => rgbToHsl(c.color)[1]));
  if (maxSaturation < FLAT_SATURATION) return { error: "封面色彩过于单一（无彩度）" };

  const byWeight = [...clusters].sort((a, b) => b.weight - a.weight);
  const dominant = byWeight[0].color;
  // accent 取"权重 × 彩度"最大的簇：满屏低彩度里那一小块高彩度封面色最值得当强调色。
  const accentSource = [...clusters]
    .sort((a, b) => b.weight * rgbToHsl(b.color)[1] - a.weight * rgbToHsl(a.color)[1])[0]
    .color;
  const weightedLightness = clusters.reduce((sum, c) => sum + rgbToHsl(c.color)[2] * c.weight, 0) / (total || 1);
  const [hue, saturation] = rgbToHsl(dominant);
  const coverTier: PaletteTier = weightedLightness < 0.32 ? "ink" : weightedLightness > 0.72 ? "rich" : "tinted";
  return { hue, saturation, accentSource, coverTier };
}

export function derivePalette(stats: CoverStats, tier: PaletteTier): CoverPalette {
  const { hue, saturation, accentSource } = stats;
  const backOf = (name: PaletteTier): Rgb => {
    const spec = TIER_SPECS[name];
    return hslToRgb(hue, spec.saturation(saturation), spec.lightness);
  };
  const back = backOf(tier);
  const spec = TIER_SPECS[tier];
  const primary = pushContrast(hslToRgb(hue, 0.12, 0.92), back, spec.primaryFloor);
  const secondary = pushContrast(hslToRgb(hue, 0.1, 0.72), back, 4.5);
  // 先旋转再推对比度：旋转保 L/S 但换色相会改变亮度（同 L 下蓝比绿暗），
  // 反过来先推后转就可能跌破 accent 的下限。
  const accent = pushContrast(rotateHueAway(accentSource, secondary, 40), back, 3.2);
  return {
    ink: backOf("ink"),
    tinted: backOf("tinted"),
    dusk: backOf("dusk"),
    rich: backOf("rich"),
    primary,
    secondary,
    accent,
    tier,
  };
}

export function extractPalette(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  tier?: PaletteTier,
): CoverPalette {
  const stats = extractCover(pixels, width, height);
  if ("error" in stats) return { ...NEUTRAL, error: stats.error };
  return derivePalette(stats, tier ?? stats.coverTier);
}

const SAMPLE = 64;

export async function loadCoverStats(url: string): Promise<{ stats: CoverStats } | { error: string }> {
  try {
    if (!url) return { error: "没有封面地址" };
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("封面加载失败"));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) return { error: "封面尺寸为空" };
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { error: "画布不可用" };
    ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    // /api/artwork 与页面同源，画布不会被污染，getImageData 可直接读。
    const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
    const stats = extractCover(data, SAMPLE, SAMPLE);
    if ("error" in stats) return { error: stats.error };
    return { stats };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "取色失败" };
  }
}

export async function loadCoverPalette(
  url: string,
  tier?: PaletteTier,
): Promise<{ palette: CoverPalette } | { error: string }> {
  const result = await loadCoverStats(url);
  if ("error" in result) return result;
  return { palette: derivePalette(result.stats, tier ?? result.stats.coverTier) };
}
