/**
 * R206 ④ · 窄窗口时顶栏收敛（按**窗口宽度**分级，不是屏幕宽度）。
 *
 * 这一格只回答两个问题："现在算哪一档"与"那一档收起哪几项"。收起这个动作本身住在
 * `music.css` 里（与 R203 那条"隐藏只在 CSS 里做"同一条纪律），宿主只把档位写进
 * `stage.dataset.topbar` 那一个属性上 ⇒ 阈值与清单只有这一个出处，CSS 只问这一格。
 *
 * 三条讲究：
 *  1. **宽档 = 什么都不收**（`hidden: []`）。今天的样子就是宽档的样子：
 *     判据要钉"宽档那一条选择器根本不存在"，而不是"宽档收起的清单为空"—— 后者会被
 *     一条 `[data-topbar="wide"] xxx {display:none}` 的新规则绕过。
 *  2. **被收掉的每一项都必须有键盘出路**（`TOPBAR_HIDDEN_COMMANDS`）。命令面板（`Ctrl+P`）
 *     本来就是所有入口的第二条路，这一格把它从"顺便有"变成"必须有"：清单里出现一个
 *     没有对应命令的项，自检当场红。
 *  3. 档位按**窗口**宽度算，所以全屏、分屏、拖窄都跟着走；阈值写在常量里，
 *     不在 CSS 里再写一遍 `@media`（两处数字迟早漂）。
 */

export type TopbarTier = "wide" | "medium" | "narrow";

/** 宽档下界：>= 这个宽度什么都不收（今天的样子）。 */
export const TOPBAR_WIDE_MIN_WIDTH = 1240;
/** 中档下界：再窄就把「显示模式」那一组收掉。低于它就进窄档。 */
export const TOPBAR_MEDIUM_MIN_WIDTH = 1024;

/**
 * 每一档收起的清单。名字用的是**顶栏里那颗元素的标识**（class 或 `data-action` 的值），
 * CSS 与自检都读这一份；改清单只改这里。
 */
export const TOPBAR_HIDDEN: Record<Exclude<TopbarTier, "wide">, readonly string[]> = {
  medium: ["mode-switch"],
  narrow: ["mode-switch", "playlists", "favorites"],
};

/** 被收起的项 → 命令面板里那条能办同一件事的命令（判据②：无路可走就不许收）。 */
export const TOPBAR_HIDDEN_COMMANDS: Record<string, readonly string[]> = {
  "mode-switch": ["view-folia", "view-rhine"],
  playlists: ["open-playlists"],
  favorites: ["open-favorites"],
};

/** 档位判定（纯函数）。宽度量不到时按宽档（不许因为读不到就乱收）。 */
export function topbarTier(width: number): TopbarTier {
  if (!Number.isFinite(width) || width <= 0) return "wide";
  if (width >= TOPBAR_WIDE_MIN_WIDTH) return "wide";
  if (width >= TOPBAR_MEDIUM_MIN_WIDTH) return "medium";
  return "narrow";
}

/** 这一档收起哪几项（宽档恒为空数组）。 */
export function topbarHiddenEntries(tier: TopbarTier): readonly string[] {
  return tier === "wide" ? [] : TOPBAR_HIDDEN[tier];
}
