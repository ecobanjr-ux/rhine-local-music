// R205（壁纸 v1 · 形态 A）· 解锁热点：穿透态下**唯一点得中**的那一小块。
//
// 为什么必须有它：穿透态下窗口收不到任何点击（Task 0 实测：`WindowFromPoint` 四个点全部落到底下的窗口），
// 所以"点一下热点把交互还回来"这件事**不能靠页面 hover** —— 实测 `forward:true` 在本机不把 mousemove 送进页面
// （页面里 mousemove 计数 1→1）。上游主进程本来也不是靠 hover：它**轮询光标**
// （`main.cjs:4649-4658` 的判定 + `MAIN_WINDOW_CLICK_THROUGH_UNLOCK_HOVER_INTERVAL_MS = 150`），本件沿这一套。
//
// 四个常量沿上游那两份（`main.cjs:1796-1801` 与 `src/utils/clickThroughUnlockHotspot.ts:13-18`，
// 上游注释明写"the two constants must stay identical"）。我们只有一块画面 ⇒ **壳里只留一处定义**（判据 ㉕）。

export const CLICK_THROUGH_UNLOCK_HOTSPOT = {
  width: 84,
  height: 40,
  rightInset: 176,
  topInset: 4,
};

/** 轮询节奏沿上游那一格（150 ms）。 */
export const HOTSPOT_POLL_MS = 150;

/**
 * R206 ① · 解锁的**宽限**：光标离开热点之后，交互再多还给窗口一会儿。
 *
 * 为什么必须有这一格（真机量出来的，不是猜的）：确认文案与提示都指着"点画面右下角那颗退出按钮"，
 * 可那颗按钮离热点有几百像素 —— 光标一离开热点，下一拍（150 ms 内）就把穿透收回去，
 * 于是那一指移动过去就重新穿过去了，**点击永远落不到按钮上**（实测：命中测试回的是底下的窗口）。
 * 给一个短宽限，"移到右上角解锁 → 移到按钮上点一下"这条路才真的走得通；
 * 宽限只买"这一次移动"，不买常驻（过点时间照样收回穿透，壁纸该穿的还是穿）。
 */
export const HOTSPOT_UNLOCK_LINGER_MS = 2500;

/**
 * 光标在不在这块热点里。坐标一律 **DIP**、且按**窗口内容原点**算（副屏原点非 0，四步粘滞会落到别的屏）。
 * 算法逐字沿上游 `main.cjs:4649-4658`。
 */
export function isCursorInUnlockHotspot(cursor, contentBounds, hotspot = CLICK_THROUGH_UNLOCK_HOTSPOT) {
  const hotspotRight = contentBounds.x + contentBounds.width - hotspot.rightInset;
  const hotspotLeft = hotspotRight - hotspot.width;
  const hotspotTop = contentBounds.y + hotspot.topInset;
  const hotspotBottom = hotspotTop + hotspot.height;
  return cursor.x >= hotspotLeft
    && cursor.x <= hotspotRight
    && cursor.y >= hotspotTop
    && cursor.y <= hotspotBottom;
}

/**
 * 热点看守：只负责"在/不在"的跳变上报，**不碰任何窗口 API**（层级那一跳的唯一出处在
 * `wallpaper-window.mjs`，判据 ㉗）。`pinned`（用户点了一下把交互钉住）由调用方持有并读回来。
 *
 * `onInside`（R206 ①）：光标**停在**热点里的每一拍都上报一次。为什么需要它：Windows 的前台锁规定
 * "只有收到过最后一次输入的那个进程才允许把窗口带到前台"，而 `onEnter` 那一拍是在光标**还没**进到
 * 我们窗口之前触发的（穿透还开着 ⇒ 那一次移动根本没送进本窗口）⇒ 单靠 `onEnter` 里那一次 `focus()`
 * 真机量到的是"样式位里的 WS_EX_TRANSPARENT 摘掉了、但前台还是别人的"。后续的光标抖动会送进本窗口，
 * 所以每拍重试一次、拿到焦点就停（调用方自己按 `isFocused()` 门住，不许无脑刷）。
 */
export function createHotspotWatcher({ getCursor, getContentBounds, onEnter, onLeave, onInside, isPinned = () => false, pollMs = HOTSPOT_POLL_MS, lingerMs = HOTSPOT_UNLOCK_LINGER_MS, nowMs = () => Date.now(), setInterval = (fn, ms) => setIntervalImpl(fn, ms), clearInterval = (id) => clearIntervalImpl(id) }) {
  let inside = false;   // 光标此刻在不在热点里
  let engaged = false;  // 交互有没有还给窗口（= 在里面，或还在宽限里）—— 上层只关心这一格
  let until = 0;
  let timer = null;
  const tick = () => {
    const cursor = getCursor();
    const bounds = getContentBounds();
    if (!cursor || !bounds) return;
    inside = isPinned() ? false : isCursorInUnlockHotspot(cursor, bounds);
    if (inside) until = nowMs() + lingerMs;
    const want = inside || nowMs() < until;
    if (want !== engaged) {
      engaged = want;
      if (engaged) onEnter?.(); else onLeave?.();
    } else if (engaged) {
      onInside?.();
    }
  };
  return {
    start() { if (timer) return false; timer = setInterval(tick, pollMs); tick(); return true; },
    stop() { if (timer) clearInterval(timer); timer = null; inside = false; engaged = false; until = 0; },
    running() { return timer !== null; },
    inside() { return inside; },
    engaged() { return engaged; },
  };
}

// setInterval / clearInterval 的默认实现单独取一层：让上面的签名参数不被同名局部变量吃掉（自检注入假时钟用）。
function setIntervalImpl(fn, ms) { return globalThis.setInterval(fn, ms); }
function clearIntervalImpl(id) { return globalThis.clearInterval(id); }
