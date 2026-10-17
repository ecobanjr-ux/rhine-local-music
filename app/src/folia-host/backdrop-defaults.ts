/**
 * R202：歌词面与封面墙的"背景模糊层"参数（本文件零 import —— 与 R175 的 tuning-merge.ts、
 * R181 的 text-contrast.ts、R200 的 page-hue.ts 同一条纪律：自检要能**真的调用**它）。
 *
 * 效果（用户原话）：打开歌词界面或封面墙时，背后的画面被模糊掉（相当于垫一张可调模糊程度的透明图）；
 * 并支持把"当前播放曲目的封面"作为这层模糊图的来源（封面 → 放大 → 高斯模糊 → 低透明度）。
 *
 * 三个参数、两条来源：
 *   · source：`off` 关 / `underlay` 下层画面（CSS backdrop-filter，模糊的是层后面的东西）/ `cover` 当前曲封面；
 *   · blur：模糊半径（px），0 等效于关；
 *   · opacity：封面档专用（下层画面档没有"不透明度"可言）。
 *
 * **三主题各自缺省**（day 浅、night 深，dusk 居中）—— 缺省是"垫着看着舒服"的起点（真机定，不是算式推出）。
 * 磁盘只存"用户改过的格"（改一格存一格），缺省永远由这里现算 ⇒ 换主题时没改过的格跟着主题走。
 */

export type BackdropSource = "off" | "underlay" | "cover";

export interface BackdropParams {
  source: BackdropSource;
  /** 模糊半径 px（0 = 关）。封面上限高于下层画面：封面放大后需要更大半径才"化开"。 */
  blur: number;
  /** 封面档的不透明度（0~1）。 */
  opacity: number;
}

export interface BackdropOverride {
  source?: BackdropSource;
  blur?: number;
  opacity?: number;
}

/** 亮 / 暗两种底各一套缺省（dusk 与 night 同取"深"那套：两者都是暗底主题）。 */
const DEFAULTS_LIGHT: BackdropParams = { source: "cover", blur: 24, opacity: 0.30 };
const DEFAULTS_DARK: BackdropParams = { source: "cover", blur: 36, opacity: 0.22 };

/** 三主题档 → 缺省读数。`isDaylight` 是宿主唯一的亮暗判据（theme-bridge 算的）。 */
export function backdropDefaults(isDaylight: boolean): BackdropParams {
  return isDaylight ? { ...DEFAULTS_LIGHT } : { ...DEFAULTS_DARK };
}

const SOURCES: readonly BackdropSource[] = ["off", "underlay", "cover"];
const isSource = (v: unknown): v is BackdropSource => typeof v === "string" && (SOURCES as readonly string[]).includes(v);

/** 像素半径钳到 0~80；认不出的值回落到缺省（不是 0 —— 0 是"用户明确要关"的意思，不许被脏值顶掉）。 */
const clampBlur = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(80, Math.max(0, Math.round(n)));
};

/** 不透明度钳到 0~1。 */
const clampOpacity = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
};

/**
 * 合成完整读数：缺省 → 用户改过的格。逐格独立（改一格不影响另两格跟着主题漂）。
 * `stored` 可以是磁盘上那份补丁，也可以是 undefined（一次都没改过）。
 */
export function resolveBackdrop(isDaylight: boolean, stored: BackdropOverride | undefined): BackdropParams {
  const d = backdropDefaults(isDaylight);
  const s = stored ?? {};
  return {
    source: isSource(s.source) ? s.source : d.source,
    blur: clampBlur(s.blur, d.blur),
    opacity: clampOpacity(s.opacity, d.opacity),
  };
}

/**
 * 这一档要不要画模糊层。判据收口在这里（渲染侧不许各自判断）：
 * `off` 关；`blur` 为 0 也等效于关（用户把滑杆拖到 0 = 不要模糊）。
 */
export function backdropActive(p: BackdropParams): boolean {
  return p.source !== "off" && p.blur > 0;
}
