/**
 * R179（缺陷一）：岛内内容不许压在顶部导航带上——顶部安全区由**宿主运行时量**，不写死数字。
 *
 * 为什么不写死：顶部那条带是宿主的 `header.music-header`（`position:absolute; z-index:6`），
 * 它的 `top` 在三个断点上分别是 33 / 48 / 25px（music.css:115-125、:1634-1638、:1727），
 * 高度又是内容撑出来的（1440 宽实测 33..71）⇒ 任何"安全区 = 71px"这种字面量都会在别的断点上
 * 要么留一条缝、要么仍然压住。量一次写成一个 CSS 变量，断点与内容变化都自动跟上。
 *
 * 为什么是宿主的职责：上游那一档视觉区本来就长在它自家 chrome **之下**，
 * 而本仓的岛是 `inset:0` 全幅铺满（第一期定的容器关系）⇒ 差的是宿主这一层的容器关系，不是移植件画错。
 * cappella（群唱）只是第一个"顶锚定"（`justify-start`）的档，所以第一个撞出来。
 */

/** 岛（或其父层）上那个变量的名字。CSS 侧与宿主侧共用这一个出处。 */
export const FOLIA_SAFE_TOP_VAR = "--folia-safe-top";

/**
 * 安全区高度 = 顶部带的下沿减去岛的上沿，**负数一律收成 0**。
 * 收成 0 这一格不是防御性代码：顶部带被隐藏时 `getBoundingClientRect()` 回全 0，
 * 不夹就会得到一个负 padding（把内容往屏幕外推）。
 */
export function computeFoliaSafeTop(headerBottom: number, islandTop: number): number {
  const inset = headerBottom - islandTop;
  return inset > 0 ? Math.round(inset) : 0;
}
