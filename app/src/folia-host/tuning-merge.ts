/**
 * R175：把"这一档的缺省参数"与"用户改过的那几格"合成一份**完整**读数的纯函数（本文件零 import）。
 *
 * 为什么单独一份：数值表在 `tuning-defaults.ts`，而那个文件必须运行时 import 移植件的 `types.ts`
 * （无扩展名 specifier，Vite 认、Node 的 ESM 解析器不认）。合成逻辑放这里，自检就能**真的调用**它，
 * 而不是只对着源码文本打补丁式断言。
 */
export type TuningTable = Record<string, Record<string, unknown>>;

/**
 * R178（拍板 ③）：本产品给不了的取值 ⇒ 在合成那一刻回落，不等画面出问题再兜。
 * 现在只有一条：cappella 的 `avatarSource` 里 `builtin` / `custom` 两档本仓不随包发行
 * （内置头像 16 张没搬；自定义头像包要上游那套 IndexedDB，属我们的边界桩，也没搬）⇒ 回落 `cover`。
 * 今天界面上切不到这两个值（这一档的面板按 R1/R168/R171/R174/R176/R177 的形状没搬），
 * 会落到这两个值的只有两种情形：磁盘上留下的旧偏好、以及日后批准搬共享面板之后的用户选择 ⇒
 * 两种都不许出现"选了没图"（配套的实话写在设置面板那一格里，见 `mode-settings.tsx` 的 `note`）。
 */
export interface UnavailableTuningValue {
  /** 哪一格（如 `avatarSource`）。 */
  field: string;
  /** 这一格里本产品服务不了的值。 */
  values: readonly unknown[];
  /** 回落成什么。 */
  fallback: unknown;
}

export type UnavailableTuningMap = Record<string, readonly UnavailableTuningValue[]>;

export interface FoliaTuningResolver {
  /** 合成完整读数；表里没有的档（不吃 tuning 的 still）返回 `undefined`。 */
  resolve(mode: string, stored: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
}

/**
 * R196（Q72 终审 · B1）：**宿主改掉的缺省值**。与"回落"（`unavailable`）不是一回事 ——
 * 回落是"这个值本产品服务不了"，这里是"这个值我们决定缺省不要"（用户在面板里改回来照样生效）。
 * 优先级写在合成次序里：`缺省 → 宿主改掉的缺省 → 用户改过的格`（用户永远最大）。
 * 为什么需要这一层：移植件把某些默认写在它自己的 `types.ts` 里（`DEFAULT_*_TUNING`），
 * 而那一份是**逐字对照上游**的（R53 的纪律），不能改；改缺省只能在我们自己这一层做。
 */
export type TuningOverrideTable = Record<string, Record<string, unknown>>;

export function createTuningResolver(
  defaults: TuningTable,
  unavailable?: UnavailableTuningMap,
  overrides?: TuningOverrideTable,
): FoliaTuningResolver {
  return {
    resolve(mode, stored) {
      const base = defaults[mode];
      // 表里没有 ⇒ 不给（`undefined` 让移植件走它自己的整对象回退），也不凭空造一份
      if (!base) return undefined;
      const merged = { ...base, ...(overrides?.[mode] ?? {}), ...(stored ?? {}) };
      for (const rule of unavailable?.[mode] ?? []) {
        if (rule.values.includes(merged[rule.field])) merged[rule.field] = rule.fallback;
      }
      return merged;
    },
  };
}

/**
 * R189 · 辉光/雾的亮底打折表（每档列出"这一档里算辉光/雾"的那几格）。
 *
 * 起因是用户报的"辉光雾蒙蒙"：帧率 62fps 正常 ⇒ 不是性能，是**浅底 + 大面积辉光**的观感
 * （辉光在暗底是光、在亮底是雾）。所以这一档**只在亮底（day）生效**，暗底一档不改。
 * 表里没有的档 = 它没有"辉光/雾"这类数值格（`still`/`monet`/`partita`/`claddagh`/`cappella`/`tilt`/`classic`），
 * 或只有开关（`pendolo` 的 `enableLineGlow` 缺省本就是 false）⇒ 规则对它们是 no-op，写出来是为了"表是否完整"可核。
 */
export type GlowDiscountTable = Record<string, readonly string[]>;

export const DAY_GLOW_SCALE = 0.6;

/**
 * 把亮底下的**缺省**辉光/雾乘一个系数。三条规矩，缺一条都会做错：
 *  ① **用户自己调过的那一格一律不动**（"可在面板调回"——落盘过就在 `stored` 里，这里跳过）；
 *  ② 只认数值格（开关与枚举原样放行）；
 *  ③ 没改动过就把**原对象原样回**（调用方按引用比较，凭空造一份新对象 = 每次主题刷新都触发一轮重渲染）。
 */
export function applyDayGlowDiscount(
  mode: string,
  resolved: Record<string, unknown> | undefined,
  stored: Record<string, unknown> | undefined,
  table: GlowDiscountTable,
  scale: number = DAY_GLOW_SCALE,
): Record<string, unknown> | undefined {
  const fields = table[mode];
  if (!resolved || !fields || fields.length === 0) return resolved;
  let next: Record<string, unknown> | undefined;
  for (const field of fields) {
    if (stored && Object.prototype.hasOwnProperty.call(stored, field)) continue;
    const value = resolved[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (!next) next = { ...resolved };
    next[field] = Math.round(value * scale * 1000) / 1000;
  }
  return next ?? resolved;
}
