/**
 * R175：把"这一档的缺省参数"与"用户改过的那几格"合成一份**完整**读数。
 *
 * 为什么需要这一层（pendolo 取证抓到，控制台两处 `Cannot read properties of undefined (reading 'toFixed')`）：
 * 上游那 10 档吃 tuning 的模式里，面板与渲染器用的都是"**整对象回退**"的形状 ——
 * `pendoloTuning = DEFAULT_PENDOLO_TUNING`（缺省参数只在 prop 为 `undefined` 时生效）、
 * `const resolvedTuning = pendoloTuning ?? DEFAULT_PENDOLO_TUNING`。
 * 而 R173 那份通道喂的是用户改过的**局部**补丁（第一格都没动过时是 `{}`）：
 * `{}` 是 truthy ⇒ 整对象回退不触发 ⇒ 除被拖过的那一格之外全是 `undefined`，
 * 表现为滑杆 NaN、`.toFixed()` 抛、画面按 NaN 几何布局（**拖一次设置就把整档画坏**，而不是只改那一格）。
 * 上游不会有这一格，是因为它的 store 里每一份 tuning 从初始化起就是完整的默认对象。
 *
 * 规矩：合成只在这一个出处做，两个读数（面板 `getTuning` / 喂岛 `feedFoliaTunings`）都走这里；
 * 磁盘上那份 `preferences.foliaTunings` 继续只存"用户真正改过的格"（改一格存一格，不给没改过的格落盘）。
 */
import {
  DEFAULT_CADENZA_TUNING,
  DEFAULT_CAPPELLA_TUNING,
  DEFAULT_CLADDAGH_TUNING,
  DEFAULT_CLASSIC_TUNING,
  DEFAULT_FUME_TUNING,
  DEFAULT_LUMIERE_TUNING,
  DEFAULT_MONET_TUNING,
  DEFAULT_PARTITA_TUNING,
  DEFAULT_PENDOLO_TUNING,
  DEFAULT_SONNET_TUNING,
  DEFAULT_TEMPERA_TUNING,
  DEFAULT_TILT_TUNING,
} from "../folia/types";
import { applyDayGlowDiscount, createTuningResolver, DAY_GLOW_SCALE, type GlowDiscountTable, type TuningOverrideTable, type UnavailableTuningMap } from "./tuning-merge";

/**
 * 把移植件那份 tuning 对象摊成"键 → 值"的读数：它们声明的是**接口**（没有索引签名），
 * TS 不让接口隐式宽化成 `Record<string, unknown>`，所以在这一个出处做一次展开。运行时零差别。
 */
const asCells = (base: object): Record<string, unknown> => ({ ...base });

/** 吃 tuning 的那些档的缺省读数（照搬移植件自己的 `DEFAULT_*_TUNING`，不在这里重抄数值）。 */
export const FOLIA_TUNING_DEFAULTS: Record<string, Record<string, unknown>> = {
  cadenza: asCells(DEFAULT_CADENZA_TUNING),
  cappella: asCells(DEFAULT_CAPPELLA_TUNING),
  claddagh: asCells(DEFAULT_CLADDAGH_TUNING),
  classic: asCells(DEFAULT_CLASSIC_TUNING),
  fume: asCells(DEFAULT_FUME_TUNING),
  lumiere: asCells(DEFAULT_LUMIERE_TUNING),
  monet: asCells(DEFAULT_MONET_TUNING),
  partita: asCells(DEFAULT_PARTITA_TUNING),
  pendolo: asCells(DEFAULT_PENDOLO_TUNING),
  sonnet: asCells(DEFAULT_SONNET_TUNING),
  tempera: asCells(DEFAULT_TEMPERA_TUNING),
  tilt: asCells(DEFAULT_TILT_TUNING),
};

/**
 * R178（拍板 ③）：本产品服务不了的取值 ⇒ 合成时回落。撤法：删掉这一格与 `createTuningResolver`
 * 的第二个实参，同时把 `mode-settings.tsx` 里那句实话一起撤掉（两者必须同进退，别留"回落了但界面不说"）。
 */
export const FOLIA_TUNING_UNAVAILABLE: UnavailableTuningMap = {
  cappella: [
    {
      // `builtin` = 本仓不随包发行的那 16 张头像；`custom` = 上游 IndexedDB 头像包（未移植）。
      field: "avatarSource",
      values: ["builtin", "custom"],
      fallback: "cover",
    },
  ],
};


/**
 * R196（Q72 终审 · B1）：**宿主改掉的缺省值**（用户在面板里改回来照样生效，用户的格永远最大）。
 * 两条，都是"垫层撤掉"的直接后果：
 *  · `overlayFrame: false` —— 移植件缺省是 `true`，而那条画框顶边在整窗画面里正好落在 y≈76
 *    （实测：关掉画框那一格 11.59→0.88）⇒ 用户"不接受任何格格不入的线"（Q71 终审走 B1）。
 *  · `darkField: 1` —— 移植件缺省 0.75（"共享背景原样透出"是它当初的设计，因为那时岛的底色是不透明的）。
 *    R196 把岛底撤成透明之后，"透出来"的东西变成了**岛下面的 3D 归档场景**（截图上能看到海报的鬼影）。
 *    暗场调到 1 = 完全不透明 ⇒ 画面自己盖满、鬼影消失，观感回到"刚开始那样"（那时岛底不透明，等效于满不透明）。
 * **不动移植件的 `types.ts`**（那一份逐字对照上游，R53 的纪律）：改缺省只在我们这一层做。
 * 撤法：删掉对应的那一格（画框回到缺省开、暗场回到 0.75）。
 */
export const FOLIA_TUNING_DEFAULT_OVERRIDES: TuningOverrideTable = {
  lumiere: { overlayFrame: false, darkField: 1 },
};
/** 合成完整读数（逻辑在 tuning-merge.ts：那一份零 import，自检可以直接调用）。 */
export const resolveFoliaTuning = createTuningResolver(FOLIA_TUNING_DEFAULTS, FOLIA_TUNING_UNAVAILABLE, FOLIA_TUNING_DEFAULT_OVERRIDES).resolve;

/**
 * R189 · 亮底（day）下要打折的"辉光/雾"缺省格。逐档的依据（都是这一档面板上真实存在的滑杆）：
 *  · lumiere  烟雾浓度 / 图形辉光 / 文字辉光 —— 用户报"雾蒙蒙"的那一档就是它；
 *  · tempera / sonnet  胶片颗粒（雾感）/ 暗角 —— 这两档共用同一套后处理字段；
 *  · cadenza / fume  辉光强度。
 * 不在表里的档：`still` / `monet` / `partita` / `claddagh` / `cappella` / `tilt` / `classic` 没有这类数值格，
 * `pendolo` 只有开关（`enableLineGlow` 缺省 false，且它在三档之外另有 R189③ 的顶部渐入）⇒ 规则对它们 no-op。
 * 系数 0.6 是"看着不雾"的起点（真机对照见 run log），不是对比度算式推出的数。
 */
export const FOLIA_DAY_GLOW_FIELDS: GlowDiscountTable = {
  lumiere: ["fogDensity", "bloom", "textBloom"],
  tempera: ["postProcessGrain", "postProcessVignette"],
  sonnet: ["postProcessGrain", "postProcessVignette"],
  cadenza: ["glowIntensity"],
  fume: ["glowIntensity"],
};

/**
 * 合成完整读数 + 亮底打折。**这是宿主唯一的合成出口**（面板 `getTuning` 与喂岛 `feedFoliaTunings`
 * 都走这里，不许有第二条路 —— 两条路就会出现"面板显示 1.00、画面按 0.60 画"）。
 * 暗底（dusk / night）原样返回 `resolveFoliaTuning` 的结果，一个字不改。
 */
export function resolveFoliaTuningForTheme(
  mode: string,
  stored: Record<string, unknown> | undefined,
  isDaylight: boolean,
): Record<string, unknown> | undefined {
  const resolved = resolveFoliaTuning(mode, stored);
  if (!isDaylight) return resolved;
  return applyDayGlowDiscount(mode, resolved, stored, FOLIA_DAY_GLOW_FIELDS, DAY_GLOW_SCALE);
}

