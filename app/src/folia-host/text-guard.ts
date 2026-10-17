/**
 * 岛内文字可读性守卫（自撰，非移植）—— 缺陷二拍板 B 的执行侧。
 *
 * 一句话：**只看画出来的结果**。每过一遍，把岛里每一片文字叶子拿它"真正压在的那块底"算一次
 * WCAG 对比度，跌破阈值就把字色朝远离底的方向钳到阈值上；达标的一律不动（幂等，防每次重画漂色）。
 *
 * 为什么不是纯 CSS：量到的两类"颜色本身不达标"的字，一类用的是**背景色当字色**（群唱对方气泡），
 * 一类是**写死的白**（monet 的标题/歌手行）—— 两者都不读宿主令牌，CSS 覆盖只能逐档点名类名，
 * 而"逐档点名"按分工是第二段的事。这一层要的是**通用机制**：不认识任何一档的名字。
 *
 * 判据读的是**画出来的那一笔**，不是 `color` 这个属性（R185 补的第二处判据面缺口）：
 * 渐变裁切那一档（`background-clip: text` + 透明填充，monet 的活动卡拉OK 字）真正画出来的是
 * `background-image` 里的渐变，而 computed `color` 是深灰 —— 只读 `color` 的钳法对这一类**必然放空**
 * （那一格读数 4.93 达标、画出来 1.26）。这一档的处置见 `CLIP_ATTR` 那段。
 *
 * 不接管的那一类也写死在这里：**有效不透明度低于 `FADED_OUT`** 的格 —— 那是移植件逐帧动画
 * **正在画的过程中**（上游的淡出设计），宿主去改就是和动画对打。判据与仪器那条分界是**同一个数**，
 * 这类记"接受类"（不假装修掉，也不计入待修）。
 */
import {
  decideHaloColor,
  decideTextColor,
  floorForSize,
  parseColor,
  resolvePaintedInk,
  stackGround,
} from "./text-contrast";

/**
 * 淡出动画的归属判据：元素级有效不透明度低于这个数就**不接管**。
 *
 * 这个数与量测仪器那一侧"淡出/亮格"的分界**是同一个数**（仪器按 `opacity >= 0.6` 算"画得出来"）。
 * 第一版写成 0.99：仪器把 0.6~0.99 那一批算作"画出来了、该达标"，而守卫全跳过 ⇒ 27 格掉在两套阈值的缝里
 * （R181 验收侧原话"27 格两套阈值夹缝"）。两套口径必须是同一条，否则永远有一条缝。
 * 低于 0.6 的那一批（真机 89 格）是上游逐帧淡出**正在画的过程中**，宿主去改就是和动画对打 —— 记"接受类"。
 */
export const FADED_OUT = 0.6;

/** 慢兜底节奏：换行时节点常被复用（只改文本与 class，不增删），只挂观察器会漏。 */
export const GUARD_SWEEP_MS = 2000;

const INK_ATTR = "foliaInkFrom";
const INK_STYLE_ATTR = "foliaInkStyle";
const SHADOW_ATTR = "foliaShadowFrom";
const CLIP_ATTR = "foliaInkClipFix";
const CLIP_STYLE_ID = "folia-ink-clip-fix";

/**
 * 渐变裁切那一档的处置：把这一格的**绘制通道**从 `background-image` 退回普通着色。
 *
 * 为什么不是逐帧去改 React 写的内联渐变：那是它的动画所有者，改一处下一帧就写回来（和 R181 那条
 * `style.opacity` 同一个理由）。这里挂一张 `!important` 规则，React 的内联值赢不了它；
 * 掩膜扫光的动画仍在（它动的是 mask，不是 background-image），字改用 `currentColor`
 * （= 我们钳过的 `color`），于是画出来的那一笔就是能读的那一笔。
 */
function ensureClipFixStyle(): void {
  if (document.getElementById(CLIP_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CLIP_STYLE_ID;
  style.textContent =
    `[data-${CLIP_ATTR.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}] {` +
    " background-image: none !important; -webkit-text-fill-color: currentColor !important;" +
    " -webkit-background-clip: border-box !important; background-clip: border-box !important; }";
  document.head.appendChild(style);
}

export interface FoliaTextGuardStats {
  checked: number;
  fixed: number;
  fadedSkipped: number;
}

export interface FoliaTextGuard {
  /** 走一遍。返回这一遍的账，取证与自检都读这个数。 */
  run(): FoliaTextGuardStats;
  stop(): void;
}

function alphaOf(color: string): number {
  const parts = String(color ?? "")
    .toLowerCase()
    .match(/^rgba\(([^)]+)\)$/);
  if (!parts) return 1;
  const nums = parts[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  return nums.length >= 4 && Number.isFinite(nums[3]) ? nums[3] : 1;
}

/**
 * 这片字**实际压在**的那块底 = 从岛根往下，把每一层祖先的 background-color **按各自的 alpha 叠出来**。
 *
 * 为什么不能"往上找第一个不透明的祖先"就完事（第一版就是这么写的，真机把 cappella/dusk 从 10 红改成 19 红）：
 * 气泡那一层是**半透明白**，按 "alpha>0.999 才算" 就把它跳过了，拿到的是岛的深色底 ⇒
 * 判成"深底上的深字不达标"，于是把本来正好能读的字钳成了白字，压在浅气泡上反而变 1.9。
 * 判据错一层，钳制就帮倒忙 —— 这一格是全批最贵的一条：它只有跑**全矩阵**才暴露，
 * 只看 cappella/day（那一档确实从 18 红降到 13 红）会当成修好了。
 *
 * 还有第二层同类错（R185 第二段真机抓到）：**祖先的 `opacity` 也会稀释它自己的底色**。
 * 气泡那层写的是不透明的 `rgb(255,255,255)`，但同一元素上挂着 `opacity: 0.82`
 * ⇒ 真底是 0.82×白 + 0.18×岛底，而只读 `background-color` 的 alpha 会当它是纯白 ⇒ 又把达标的字钳过头。
 * 所以每一层的有效 alpha = 它自己 `background-color` 的 alpha × 从岛根到它这一路 `opacity` 的累乘。
 *
 * 第三层（R186）：**元素自己的底色也算一层**。带自己底的元素（角标 / chip / 气泡）读的是"字 vs 它自己的底"，
 * 原先从 `el.parentElement` 起走祖先链会跳过它自己的底 ⇒ 封面墙角标那 4 格被拿背后封面像素当底判。
 * 起点改成 `el` 本身（透明的仍跳过，读数不变）。
 */
export function paintGroundOf(el: HTMLElement, root: HTMLElement, fallback: string): string {
  const layers: Array<{ color: readonly [number, number, number]; alpha: number }> = [];
  let base: readonly [number, number, number] | null = null;
  // 祖先链（**自己 → 岛根**），每层自己的 `opacity` 也要摊到它的底色上：
  // cappella 的气泡是 `background: rgb(255,255,255)` + `opacity: 0.82`，真底 = 0.82×白 + 0.18×岛底
  // （dusk 219 / night 211），而只读 `background-color` 的 alpha 会拿到不透明的纯白 255
  // ⇒ 把本来达标的字钳过头（R185 第二段真机那一批 9 格）。所以从岛根往里走、逐层累乘 opacity。
  // 起点含 `el`：带自己底的元素（R186 的角标）要先算它自己的底，读的才是"字 vs 它自己的底"。
  const chain: HTMLElement[] = [];
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    chain.push(n);
    if (n === root) break;
  }
  let cum = 1;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const n = chain[i];
    cum *= Number(getComputedStyle(n).opacity) || 1;
    const bg = getComputedStyle(n).backgroundColor;
    if (bg && bg !== "transparent" && alphaOf(bg) > 0) {
      const c = parseColor(bg);
      if (c) layers.push({ color: c, alpha: Math.min(1, alphaOf(bg) * cum) });
    }
  }
  if (layers.length) {
    const bottom = layers.shift() as { color: readonly [number, number, number]; alpha: number };
    base = bottom.color;
    if (bottom.alpha < 1) {
      const fb = parseColor(fallback);
      base = fb ? stackGround([bottom], fb) : bottom.color;
    }
  }
  if (!base) base = parseColor(fallback);
  if (!base) return fallback;
  const acc = stackGround(layers, base);
  return `rgb(${acc[0]} ${acc[1]} ${acc[2]})`;
}

/** 元素级的有效不透明度（自己 × 各层祖先，到岛根为止）；低于 FADED_OUT = 淡出中，不接管。 */
export function effectiveAlphaOf(el: HTMLElement, stopAt: HTMLElement): number {
  let n: HTMLElement | null = el;
  let a = 1;
  while (n) {
    a *= Number(getComputedStyle(n).opacity);
    if (n === stopAt) break;
    n = n.parentElement;
  }
  return a;
}

export interface FoliaTextGuardOptions {
  root: HTMLElement;
  /** 兜底底色（岛自己的 background）。 */
  ground: () => string;
}

export function createFoliaTextGuard(options: FoliaTextGuardOptions): FoliaTextGuard {
  const { root, ground } = options;
  let observer: MutationObserver | null = null;
  let timer: number | undefined;
  let queued = false;
  /** 我们钳过的那一格，以及钳进去的那个值 —— 换歌时 React 会把内联色写回它自己那一份，
   *  等下一次慢扫（2 秒）才补上会看得见闪；所以只盯**已钳的这几格**的 style 变化。 */
  const written = new Map<HTMLElement, string>();

  const judge = (el: HTMLElement, back: string, stats: FoliaTextGuardStats): void => {
    if (el.children.length) return;
    if (!(el.textContent ?? "").trim()) return;
    // 只撤**自己上一轮写的**那一格（按 data 标记认，不看 style 有没有值 ——
    // 档自己也会写内联色，误撤就等于把它的字删掉，React 下次重画又写回来，两边对打）。
    if (el.dataset[INK_ATTR] || el.dataset[CLIP_ATTR]) {
      el.style.color = el.dataset[INK_STYLE_ATTR] ?? "";
      delete el.dataset[INK_ATTR];
      delete el.dataset[INK_STYLE_ATTR];
      delete el.dataset[CLIP_ATTR];
      written.delete(el);
    }
    if (el.dataset[SHADOW_ATTR]) {
      el.style.textShadow = el.dataset[SHADOW_ATTR];
      delete el.dataset[SHADOW_ATTR];
    }
    const cs = getComputedStyle(el);
    const size = Number.parseFloat(cs.fontSize) || 0;
    if (size < 8) return;
    if (cs.visibility === "hidden" || cs.display === "none") return;
    // 元素级淡出（有效不透明度低）不接管：那是移植件的逐帧动画，改它就是对打 —— 记"接受类"。
    if (effectiveAlphaOf(el, root) < FADED_OUT) {
      stats.fadedSkipped += 1;
      return;
    }
    // 判据要按"画出来的色"算：元素级透明度会把写下去的颜色稀释，只按声明色钳会钳不够。
    const effA = effectiveAlphaOf(el, root);
    const floor = floorForSize(size);
    const groundHere = paintGroundOf(el, root, back);
    const painted = resolvePaintedInk({
      color: cs.color,
      fill: cs.getPropertyValue("-webkit-text-fill-color") || cs.color,
      backgroundClip: cs.getPropertyValue("-webkit-background-clip") || cs.getPropertyValue("background-clip"),
      backgroundImage: cs.backgroundImage,
      ground: groundHere,
    });
    if (!painted) return;
    // 上游把同一套"淡出"写了两处：元素 `opacity`（monet 的行距淡出）与**色值自带的 alpha**
    // （卡拉OK 未唱档 0.34/0.36/0.46）。两者都在稀释这一笔 ⇒ "这一笔到底有多不透明"
    // = 两者的乘积；低于 FADED_OUT 的同样是接受类（与仪器、与上面那条元素级判据同一个算式）。
    if (effA * painted.alpha < FADED_OUT) {
      stats.fadedSkipped += 1;
      return;
    }
    stats.checked += 1;
    // 有元素级透明度的格要按"画出来的色"判：写下去的颜色会被那层透明度稀释，直接按声明色钳会钳不够。
    const decision = decideTextColor(painted.ink, groundHere, floor, effA);
    if (!decision.changed) return;
    if (painted.viaGradient) {
      ensureClipFixStyle();
      el.dataset[CLIP_ATTR] = "1";
    }
    el.dataset[INK_STYLE_ATTR] = el.style.color;
    el.style.color = decision.color;
    // 存**读回来的那一份**，不是我以为我写进去的那一份：CSS 会把 `rgb(40 40 52)` 规范成
    // `rgb(40, 40, 52)`，拿空格版去比"这次是不是我自己写的"永远不相等 ⇒ 自己的写入
    // 把自己再触发一遍，judge→记录→judge 无限循环，页面直接卡死（真机抓到的就是这一格）。
    written.set(el, el.style.color);
    // 对同一节点重复 observe 是"换一份选项"，不会叠加登记
    styleObserver.observe(el, { attributes: true, attributeFilter: ["style"] });
    el.dataset[INK_ATTR] = `${decision.from.toFixed(2)}→${decision.to.toFixed(2)}`;
    stats.fixed += 1;
    // 阴影/描边跟着翻（亮底给浅晕、暗底给深晕）：只改**本来就有** text-shadow 的元素，不给没有的凭空加。
    if (cs.textShadow && cs.textShadow !== "none") {
      const halo = parseColor(decideHaloColor(groundHere) ?? "");
      if (halo) {
        el.dataset[SHADOW_ATTR] = cs.textShadow;
        el.style.textShadow = `0 0 0.35em rgb(${halo[0]} ${halo[1]} ${halo[2]} / 0.9)`;
      }
    }
  };

  const run = (): FoliaTextGuardStats => {
    const stats: FoliaTextGuardStats = { checked: 0, fixed: 0, fadedSkipped: 0 };
    const back = ground();
    for (const el of root.querySelectorAll<HTMLElement>("*")) judge(el, back, stats);
    return stats;
  };

  // 第二道：只盯已钳的那几格。别人（React）把内联色改回去了就立刻重判这一格；
  // 自己写的那一次按"值相等"跳过 —— 不然就是自己触发自己，无限循环。
  const styleObserver = new MutationObserver((records) => {
    const back = ground();
    const stats: FoliaTextGuardStats = { checked: 0, fixed: 0, fadedSkipped: 0 };
    for (const rec of records) {
      const el = rec.target as HTMLElement;
      const mine = written.get(el);
      if (mine === undefined || el.style.color === mine) continue;
      judge(el, back, stats);
    }
  });

  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      run();
    });
  };

  observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });
  timer = window.setInterval(schedule, GUARD_SWEEP_MS);
  schedule();

  return {
    run,
    stop() {
      observer?.disconnect();
      observer = null;
      styleObserver.disconnect();
      written.clear();
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    },
  };
}
