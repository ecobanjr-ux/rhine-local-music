/**
 * R202：歌词面与封面墙的"背景模糊层"（自撰，非移植）。
 *
 * 效果（用户原话）：打开歌词界面或封面墙时，背后的画面被模糊掉（相当于垫一张可调模糊程度的透明图）；
 * 并支持把"当前播放曲目的封面"作为这层模糊图的来源（封面 → 放大 → 高斯模糊 → 低透明度）。
 *
 * 这一层是宿主侧的、**画面之下**的一层（DOM 顺序：`#three-scene` → `#folia-backdrop` → 岛）：
 *   · `underlay` 来源：CSS `backdrop-filter: blur(N)` —— 它模糊的是**层后面已经画好的东西**
 *     （三维档案场景 / 页面底），零 canvas 成本；
 *   · `cover` 来源：一个 `<img>` 放大铺满 + CSS `filter: blur(Npx)` + `opacity`，切歌时交叉淡入淡出。
 *
 * 三条红线：
 *   ① 封面地址只可能是**同源**（本地 `/api/artwork/<id>`、在线 `/api/online/artwork/<token>`）；
 *      `applyBackdrop` 对非同源地址直接不取（第三方 URL 不许进 DOM —— R116/R135 那条）。
 *   ② 封面**预缩**到 ≤256px：模糊后视觉等同，但合成成本大降（一张 3000×3000 的图每帧 blur 会很贵）。
 *   ③ **一帧一更、变了才更**：`update()` 由每帧的 `feedFoliaIsland()` 调用，但只在"来源/半径/不透明度/封面"
 *      任何一格变了时才写 DOM；且封面解码/预缩是一次性的（不进逐帧路径）。
 *
 * 参数与缺省在 `backdrop-defaults.ts`（纯函数、自检可直调）；这里只做 DOM。
 */

import { backdropActive, type BackdropParams } from "./backdrop-defaults.ts";

/** 预缩的目标边长（模糊后视觉等同；上限是"再大也看不出差别"的实测起点）。 */
export const BACKDROP_COVER_MAX_PX = 256;

/**
 * R202-F4（用户实报："背景的文字也模糊"，指的是右侧那一整块专辑信息）：把**这一格半径**同时写到
 * `#stage` 上的自定义属性 `--folia-backdrop-blur-px`，由 CSS 让档案信息块（`.album-callout`）吃同一个模糊。
 * 关 / 半径为 0 / 卸装 ⇒ 属性**移除**（不是写 0）⇒ `var()` 回退到 `0px`，档案架与"关"档一个字都不变。
 */
export const BACKDROP_BLUR_VAR = "--folia-backdrop-blur-px";

/** 同源判据：以 `/` 开头的站内地址，或 `location.origin` 开头的绝对地址。其余一律不取（红线 ①）。 */
export function isSameOriginArtworkUrl(url: string | null | undefined, origin?: string): boolean {
  if (!url) return false;
  if (url.startsWith("/")) return !url.startsWith("//");
  const base = origin ?? (typeof location !== "undefined" ? location.origin : "");
  return Boolean(base) && url.startsWith(`${base}/`);
}

export interface FoliaBackdropHandle {
  /** 每帧调用（由 feedFoliaIsland）：只在任一格变了时才写 DOM。 */
  update(params: BackdropParams, coverUrl: string | null): void;
  /** 卸装：把层收干净（清 src、去掉样式），下次挂载从零开始。 */
  reset(): void;
}

interface AppliedState {
  source: string;
  blur: number;
  opacity: number;
  coverUrl: string | null;
}

/** 把封面预缩到 ≤ max px，返回一个 data URL（同源图先经 Image 解码，再画到离屏 canvas 缩小）。 */
async function shrinkCover(url: string, max: number): Promise<string | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const img = new Image();
  // 同源图不需要 crossOrigin；也不设它（设错反而会让同源请求带 CORS 模式失败）。
  img.decoding = "async";
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
  });
  img.src = url;
  if (!(await loaded)) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, cw, ch);
  try {
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

/**
 * 造一台模糊层。`doc` 可注入（自检用）；默认 `document`。
 * 元素由本模块创建并插到 `#stage` 里（`#three-scene` 之后、岛之前）——不进 `stage.innerHTML` 那个模板，
 * 免得每次重建舞台都要记得把它拼回去。
 */
export function createFoliaBackdrop(doc: Document = document): FoliaBackdropHandle {
  let el: HTMLElement | null = null;
  let img: HTMLImageElement | null = null;
  let applied: AppliedState = { source: "__init", blur: -1, opacity: -1, coverUrl: "__init" };
  // 单飞：同一次来源切换只解码一次；解码期间来了新地址，等它回来再决定要不要覆盖（按当时的 target 比）。
  let pendingCoverUrl: string | null = null;
  let shrinkToken = 0;

  /** R202-F4：把当前半径转达给 CSS（`.album-callout` 吃同一个值）。`null` = 移除属性 ⇒ `var()` 回退 0px。 */
  const publishBlur = (px: number | null): void => {
    const stage = doc.querySelector<HTMLElement>("#stage");
    if (!stage) return;
    if (px === null) stage.style.removeProperty(BACKDROP_BLUR_VAR);
    else stage.style.setProperty(BACKDROP_BLUR_VAR, `${px}px`);
  };

  const ensure = (): HTMLElement | null => {
    if (el && el.isConnected) return el;
    const stage = doc.querySelector<HTMLElement>("#stage");
    if (!stage) return null;
    const node = doc.createElement("div");
    node.id = "folia-backdrop";
    node.setAttribute("aria-hidden", "true");
    const image = doc.createElement("img");
    image.alt = "";
    image.decoding = "async";
    // 红线 ②：预缩后再模糊，图不进逐帧路径。
    image.loading = "eager";
    node.appendChild(image);
    // 插在 `#three-scene` 之后（同层里它在三维之上、岛之下，z-index 见 CSS）。
    const three = stage.querySelector("#three-scene");
    if (three && three.parentElement === stage) three.after(node);
    else stage.insertBefore(node, stage.firstChild);
    el = node;
    img = image;
    return node;
  };

  const applyImage = (node: HTMLElement, image: HTMLImageElement, url: string | null): void => {
    if (!url) {
      image.removeAttribute("src");
      image.style.opacity = "0";
      return;
    }
    const token = ++shrinkToken;
    pendingCoverUrl = url;
    void shrinkCover(url, BACKDROP_COVER_MAX_PX).then((dataUrl) => {
      // 回来时若这一份已经不是当前要的那一张（又切歌了），丢弃。
      if (token !== shrinkToken || pendingCoverUrl !== url) return;
      if (!node.isConnected) return;
      if (!dataUrl) {
        image.removeAttribute("src");
        image.style.opacity = "0";
        return;
      }
      image.src = dataUrl;
      image.style.opacity = "1";
    });
  };

  return {
    update(params: BackdropParams, coverUrl: string | null) {
      const active = backdropActive(params);
      const same = applied.source === params.source
        && applied.blur === params.blur
        && applied.opacity === params.opacity
        && applied.coverUrl === coverUrl;
      if (same) return;
      applied = { source: params.source, blur: params.blur, opacity: params.opacity, coverUrl };

      const node = ensure();
      if (!node || !img) return;
      if (!active) {
        node.dataset.backdropSource = "off";
        node.style.removeProperty("backdrop-filter");
        node.style.removeProperty("-webkit-backdrop-filter");
        node.style.removeProperty("opacity");
        applyImage(node, img, null);
        publishBlur(null);   // R202-F4：关了就撤属性 ⇒ 档案信息块回到原样
        return;
      }
      node.dataset.backdropSource = params.source;
      publishBlur(params.blur);   // R202-F4：同一格半径转达给 CSS（信息块吃同一个值）
      // 红线 ③：封面档的 blur 与 opacity 走同一层；下层画面档只用 backdrop-filter。
      if (params.source === "underlay") {
        node.style.setProperty("backdrop-filter", `blur(${params.blur}px)`);
        node.style.setProperty("-webkit-backdrop-filter", `blur(${params.blur}px)`);
        node.style.setProperty("opacity", "1");
        applyImage(node, img, null);
        return;
      }
      // cover
      node.style.removeProperty("backdrop-filter");
      node.style.removeProperty("-webkit-backdrop-filter");
      node.style.setProperty("opacity", "1");
      img.style.filter = `blur(${params.blur}px)`;
      img.style.opacity = "0";
      // 红线 ①：非同行地址不取（第三方 URL 不许进 DOM）。
      applyImage(node, img, isSameOriginArtworkUrl(coverUrl) ? coverUrl : null);
    },
    reset() {
      shrinkToken += 1;
      pendingCoverUrl = null;
      if (img) {
        img.removeAttribute("src");
        img.style.removeProperty("filter");
        img.style.removeProperty("opacity");
      }
      if (el && el.parentElement) el.parentElement.removeChild(el);
      el = null;
      img = null;
      applied = { source: "__init", blur: -1, opacity: -1, coverUrl: "__init" };
      publishBlur(null);   // R202-F4：卸装也撤属性（离开岛视图时信息块跟着回到原样）
    },
  };
}
