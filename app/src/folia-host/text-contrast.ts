/**
 * 文字对比度钳制（自撰，非移植）—— 缺陷二拍板 B 的那条不变量：**呈现出来的字要能读**。
 *
 * 为什么单独一个文件、且**零 import**：自检要能真的调用这些算式（不是"读源码里有没有那个名字"），
 * 而 Node 的 strip-only 模式带不动含 `enum` 的 `src/folia/types.ts`，扩展名省略的运行时 import 也解不开
 * （R175 的 `tuning-merge.ts` 是同一个理由）。
 *
 * 判据只认**当前这块底是亮是暗**（量出来的相对亮度），不认主题名 ——
 * 按主题名分支会在"深色主题 + 亮封面"那一格反向再挖一次同一个坑。
 */

export type Rgb = readonly [number, number, number];

const LINEAR = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.1 相对亮度。 */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * LINEAR(rgb[0]) + 0.7152 * LINEAR(rgb[1]) + 0.0722 * LINEAR(rgb[2]);
}

/** WCAG 对比度（1..21）。 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 亮底判据：相对亮度 > 0.35。
 * 这个数不是拍的 —— 与 theme-bridge 的 isDaylight 同一条（R51 起就在用），两处必须同一个出处，
 * 否则"宿主认为该给深字"和"宿主认为这是亮色主题"会分叉。
 */
export const LIGHT_GROUND_LUMINANCE = 0.35;

export function groundIsLight(back: Rgb): boolean {
  return relativeLuminance(back) > LIGHT_GROUND_LUMINANCE;
}

/** `#rrggbb` / `rgb(r g b)` / `rgb(r, g, b)` / `rgba(r, g, b, a)` → 三元组；读不出颜色回 null。 */
export function parseColor(input: string): Rgb | null {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const body = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
  }
  const fn = text.match(/^rgba?\(([^)]+)\)$/);
  if (!fn) return null;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  return [Math.round(parts[0]), Math.round(parts[1]), Math.round(parts[2])];
}

/** 色值里的 alpha（`rgba(...)` 的第四项；没有就当 1）。 */
export function parseAlpha(input: string): number {
  const fn = String(input ?? '').trim().toLowerCase().match(/^rgba\(([^)]+)\)$/);
  if (!fn) return 1;
  const parts = fn[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 4 || !Number.isFinite(parts[3])) return 1;
  return Math.max(0, Math.min(1, parts[3]));
}

const mix = (ink: Rgb, back: Rgb, t: number): Rgb => [
  Math.round(ink[0] + (back[0] - ink[0]) * t),
  Math.round(ink[1] + (back[1] - ink[1]) * t),
  Math.round(ink[2] + (back[2] - ink[2]) * t),
];

/** 半透明色画在不透明底上的**实际颜色**（WCAG 要按这个算，不是按色值算）。 */
export function composite(ink: Rgb, alpha: number, back: Rgb): Rgb {
  return mix(ink, back, 1 - alpha);
}

/**
 * 一层层叠出来的**真实底色**：`layers` 自下而上（第一层最靠近不透明的根），每层给自己的 alpha。
 * 只挑"第一个不透明的祖先"是错的 —— 半透明气泡会被跳过，拿到的底就错一层，
 * 钳制会因此把本来能读的字改成不能读（真机量到过，见 run log 第五段）。
 */
export function stackGround(
  layers: ReadonlyArray<{ readonly color: Rgb; readonly alpha: number }>,
  base: Rgb,
): Rgb {
  let acc = base;
  for (const layer of layers) acc = composite(layer.color, Math.max(0, Math.min(1, layer.alpha)), acc);
  return acc;
}

/**
 * 把 ink 往**远离底色**的方向推，直到对比度 ≥ floor；本来就达标就原样回（幂等）。
 * 推的方式是"朝底色的反方向加距离"而不是"换成纯黑/纯白"：保住色相，字才还是这一档的字。
 * 极端情况（底色本身就是中灰，怎么推都不到 floor）回**能拿到的最大对比度**那一档，
 * 调用方据返回值是否仍不达标来决定要不要报。
 */
export function clampInkToFloor(ink: Rgb, back: Rgb, floor: number): Rgb {
  if (contrastRatio(ink, back) >= floor) return ink;
  const light = relativeLuminance(back) > LIGHT_GROUND_LUMINANCE;
  // 二分：t 是"把 ink 朝该方向的极值拉多远"，0 = 原色，1 = 极值（亮底拉向近黑，暗底拉向近白）。
  const toward = (t: number): Rgb => mix(ink, light ? [8, 8, 12] : [252, 252, 252], t);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(toward(mid), back) >= floor) hi = mid;
    else lo = mid;
  }
  return toward(hi);
}

/**
 * 元素级淡出（`style.opacity`）那一档的钳制：**要钳的是画出来的那一份**。
 * 同一个声明色在 alpha 0.7 的元素上落到屏幕上就更浅，按声明色钳到 4.5 实际只有 3.4（真机量到）。
 * 所以这里二分的是**声明色**，判据用**合成之后**的颜色 —— 而 alpha=1 时与 `clampInkToFloor` 等价。
 */
export function clampInkToFloorShown(ink: Rgb, alpha: number, back: Rgb, floor: number): Rgb {
  const a = Math.max(0, Math.min(1, alpha));
  const shown = (c: Rgb): Rgb => (a >= 0.999 ? c : composite(c, a, back));
  if (contrastRatio(shown(ink), back) >= floor) return ink;
  const light = relativeLuminance(back) > LIGHT_GROUND_LUMINANCE;
  const toward = (t: number): Rgb => mix(ink, light ? [8, 8, 12] : [252, 252, 252], t);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(shown(toward(mid)), back) >= floor) hi = mid;
    else lo = mid;
  }
  return toward(hi);
}

/**
 * 光晕 / 描边那一档：它要的是"与底分离"，不是"能读成字"，所以阈值低得多（1.45）。
 * 方向跟着底色走：亮底给浅晕、暗底给深晕 —— 这正是拍板里"亮底 ⇒ 深字 + 浅阴影"的后半句，
 * 而它同样只看量出来的亮度，不看主题名。
 */
export const INK_FLOOR_HALO = 1.45;

export function decideHaloColor(ground: string): string | null {
  const back = parseColor(ground);
  if (!back) return null;
  const light = relativeLuminance(back) > LIGHT_GROUND_LUMINANCE;
  const halo = clampInkToFloor(light ? [255, 255, 255] : [0, 0, 0], back, INK_FLOOR_HALO);
  return `rgb(${halo[0]} ${halo[1]} ${halo[2]})`;
}

/** 正文 / 次要两档阈值（拍板 B 写的两个数）。 */
export const INK_FLOOR_BODY = 4.5;
export const INK_FLOOR_SOFT = 3;

/**
 * 渐变裁切文字（`background-clip: text` + 渐变背景）—— **画出来的是背景，不是 `color`**。
 * monet 的活动行就是这样：computed `color` 是 rgb(85,85,103)（算出来 4.93 合格），
 * 而真正画在屏幕上的是一段 rgb(255,255,255) 的渐变（亮底上 1.26）。
 * 只读 `color` 的判据在这一档上完全失明 ⇒ 必须从渐变的色标里取出**最读不出来的那一档**当墨色。
 * 这条不是猜的：一手探针在 monet/day 的活动行上量到 `clip=text`、`fill=rgba(0,0,0,0)`、
 * `img=linear-gradient(90deg, rgb(255,255,255) 0%, ...)`。
 */
export function gradientInkStops(backgroundImage: string): string[] {
  const found = String(backgroundImage ?? "").match(/(?:rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})/g);
  return found ? found.map((s) => s.trim()) : [];
}

/** 渐变里**最差**的那一档色标（按"合成到底上之后"的对比度算），没有可读色标回 null。 */
export function worstGradientInk(
  backgroundImage: string,
  ground: string,
): { ink: string; contrast: number } | null {
  const back = parseColor(ground);
  if (!back) return null;
  let worst: { ink: string; contrast: number } | null = null;
  for (const stop of gradientInkStops(backgroundImage)) {
    const c = parseColor(stop);
    if (!c) continue;
    const ratio = contrastRatio(composite(c, parseAlpha(stop), back), back);
    if (!worst || ratio < worst.contrast) worst = { ink: stop, contrast: ratio };
  }
  return worst;
}

export interface PaintedInkInput {
  /** computed `color`。 */
  readonly color: string;
  /** computed `-webkit-text-fill-color`（没写过时等于 `color`，写过 `transparent` 时是 alpha 0）。 */
  readonly fill: string;
  /** computed `background-clip` / `-webkit-background-clip`。 */
  readonly backgroundClip: string;
  /** computed `background-image`。 */
  readonly backgroundImage: string;
  readonly ground: string;
}

export interface PaintedInk {
  /** 真正画出来的那一份墨色（保留它自己的 alpha，交给 decideTextColor 合成）。 */
  readonly ink: string;
  /**
   * 这一笔墨**自己带的** alpha（不是元素 opacity）。
   * 它和元素级有效不透明度是上游同一套"淡出"的两种写法：monet 的行距淡出写成元素 `opacity`、
   * 而卡拉OK 的未唱档写成颜色 alpha（0.34 / 0.36 / 0.46）—— 两处都在画同一件事。
   * 所以"这一笔到底有多不透明" = 元素有效不透明度 × 这个数，判据只认这个乘积（守卫与仪器同一条）。
   */
  readonly alpha: number;
  /** 靠渐变裁切画的 ⇒ 只改 `color` 没用，得连背景一起中和。 */
  readonly viaGradient: boolean;
  readonly gradientContrast: number | null;
}

/**
 * 「这一片字到底用什么颜色画出来的」—— 优先看渐变裁切，其次看显式 `-webkit-text-fill-color`，
 * 最后才是 `color`。判定次序不能反：一旦 `background-clip:text` + 渐变在，`color` 与 `fill` 都不参与绘制。
 */
export function resolvePaintedInk(input: PaintedInkInput): PaintedInk | null {
  const back = parseColor(input.ground);
  if (!back) return null;
  const image = String(input.backgroundImage ?? "");
  if (/text/i.test(String(input.backgroundClip ?? "")) && image && image !== "none") {
    const worst = worstGradientInk(image, input.ground);
    if (worst) return { ink: worst.ink, alpha: parseAlpha(worst.ink), viaGradient: true, gradientContrast: worst.contrast };
  }
  const fillColor = parseColor(input.fill);
  const inlineColor = parseColor(input.color);
  // "两边是同一个色" 要连 **alpha** 一起比：卡拉OK 的未唱档正是 `color` 不透明 + fill 带 0.34 这种形状，
  // 只比 RGB 就会把它当成"没写过 fill"而退回 `color` ⇒ 淡出那一档又放空了（R185 的用例抓到的）。
  const sameAsColor = !!inlineColor
    && fillColor !== null
    && fillColor.join() === inlineColor.join()
    && parseAlpha(input.fill) === parseAlpha(input.color);
  if (fillColor && parseAlpha(input.fill) > 0 && !sameAsColor) {
    return { ink: input.fill, alpha: parseAlpha(input.fill), viaGradient: false, gradientContrast: null };
  }
  if (!inlineColor) return null;
  return { ink: input.color, alpha: parseAlpha(input.color), viaGradient: false, gradientContrast: null };
}

/** 与岛外量测脚本 `t18-mc2.cjs` 同一条分档：≥24px 算正文，其余算次要。 */
export const BODY_FONT_PX = 24;

/** 字号 → 该用哪一档阈值。**唯一出处**：守卫与自检都走这一条，两边不会分叉。 */
export function floorForSize(px: number): number {
  return px >= BODY_FONT_PX ? INK_FLOOR_BODY : INK_FLOOR_SOFT;
}

export type InkDecision =
  | { readonly changed: false }
  | { readonly changed: true; readonly color: string; readonly from: number; readonly to: number };

/**
 * 界面层的一次判定：这个字色画在这块底上读不读得出来？
 * 读不出来就给一个"钳在阈值上"的同族色；`alpha` 是色值自带的透明度（先按实际色算）。
 * `extraAlpha` 是**元素级**的有效不透明度（自己 × 祖先）：它同样把字冲淡，所以判据要按合成后算。
 * 返回 null（changed:false）= 不动它 —— 达标的不许被顺手改，否则每次重画都会漂色。
 */
export function decideTextColor(
  color: string,
  ground: string,
  floor: number = INK_FLOOR_BODY,
  extraAlpha: number = 1,
): InkDecision {
  const raw = parseColor(color);
  const back = parseColor(ground);
  if (!raw || !back) return { changed: false };
  const alpha = parseAlpha(color) * Math.max(0, Math.min(1, extraAlpha));
  const ink = alpha >= 0.999 ? raw : composite(raw, alpha, back);
  const from = contrastRatio(ink, back);
  if (from >= floor) return { changed: false };
  const clamped = clampInkToFloorShown(raw, alpha, back, floor);
  const shown = alpha >= 0.999 ? clamped : composite(clamped, alpha, back);
  const to = contrastRatio(shown, back);
  if (to < floor) return { changed: false };
  return { changed: true, color: `rgb(${clamped[0]} ${clamped[1]} ${clamped[2]})`, from, to };
}
