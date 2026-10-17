/**
 * 壁纸 surface（M0，台账 R203）· 退出这三路。自撰（AGPL-3.0-only），零 import、零出网。
 *
 * 为什么必须三路齐全：这一档将来要**长期挂在墙上**（无人值守），退不出去就是把人关在里面
 * （方案 §四.5 把"退出通道"写成安全要求而不是体验细节；M0 在浏览器里先把这三路落地）。
 * 浏览器里"退出" = 回到普通页面（本件不涉及沉底与穿透，那是 M2/M3），
 * 所以三路都收敛到**同一个 `exit()`**：先按需退全屏，再换到"去掉 `wallpaper` 那一格"的同一张页。
 * 三路各写一份导航 = 三份迟早漂（与 R131 那条"命令表是唯一出处"同一个道理）。
 *
 * 三条口径写死在这里：
 *  · **判定不在本模块**：`isWallpaperSurface` 只在 `folia/utils/appSurface.ts` 那一处（Task 1 判据①）。
 *    这里只做一件事——把那个参数从地址里**删掉**，不参与"现在在哪一档"的判断（第二处判定=第二个真相）。
 *  · **宿主一行 URL 读取都不必出现**：地址从 `host.ownerDocument.defaultView.location` 拿，
 *    自检注一份假的即可（于是 `music-app.ts` 里既没有 `location.search`，也没有第二个 surface 判定）。
 *  · **界面不许说「壁纸模式」**（Q53 执行侧意见）：这一档不沉底、不穿透，叫"壁纸"就是撒谎。
 *    文案只有下面那一条，并被断言钉住。
 */

/** 界面文案：**不叫「壁纸模式」**（Q53）。它同时是热点按钮的字与 aria-label。 */
export const SURFACE_EXIT_LABEL = '退出沉浸（浏览器内）';

/** 这个 surface 的 URL 参数名。判读它在 `appSurface.ts`，删除在这一格，不许出现第二个名字。 */
export const SURFACE_PARAM = 'wallpaper';

/** 只用到这三个字段：真机是 `window.location`，自检注一份对象即可。 */
export interface SurfaceExitLocation {
  search: string;
  pathname: string;
  hash?: string;
}

export interface SurfaceExitOptions {
  /** 热点按钮的字（缺省 = `SURFACE_EXIT_LABEL`）。 */
  label?: string;
  /** 地址来源（缺省 = `host` 所在文档的 `location`）。 */
  location?: SurfaceExitLocation;
  /**
   * 按键/点击让给谁：命令面板开着时那颗 Esc 已经有主人（R134 一手量到过——capture 里
   * `preventDefault` 拦不住同一条事件的其它监听器，Esc 关面板顺带执行了宿主动作，岛一起被卸装）。
   * 返回 true 就一律不动作。
   */
  blocked?: () => boolean;
  /** 注入点：自检里换成记账的假函数；真机就是 `location.replace`。 */
  navigate?: (url: string) => void;
  /** 注入点：全屏那一条（真机 = `document.exitFullscreen`）。 */
  exitFullscreen?: () => unknown;
}

export interface SurfaceExitHandle {
  /** 退出落点（构造时算好；真机取证与断言都读这一格，不许各处再算一遍）。 */
  readonly target: string;
  /** 挂三路 + 放那颗角落热点（幂等：重复调用不重复挂、不重复放）。 */
  activate(): void;
  /** 摘三路 + 收掉热点。 */
  dispose(): void;
  /** 三路共用的那一次退出（自检按三路各点一次，也直接按这一格）。 */
  exit(): void;
  /** 那颗热点元素（真机取证要量它的位置与命中）。 */
  hotspot(): Element | null;
}

/**
 * 退出目标地址：**同一张页、去掉 `wallpaper` 那一格，其余参数与 hash 原样保留**。
 * 三条讲究：
 *  · `?wallpaper=1&lighting=baseline` → `/?lighting=baseline`（不许把人家别的参数一起丢了）；
 *  · `?wallpaper=1` → 空查询串写成空，不留一个孤零零的 `?`；
 *  · 返回值一定是**同源相对地址**：`pathname` 不以 `/` 开头就退回 `/`
 *    （这一格不是防御性代码——它挡的是"把外部字符串当地址用"那一类，本仓红线）。
 */
export function surfaceExitTarget(location: SurfaceExitLocation): string {
  const params = new URLSearchParams(location.search);
  params.delete(SURFACE_PARAM);
  const query = params.toString();
  // 站内绝对路径才收：`//host/x` 是**协议相对地址**（浏览器会当成另一个主机），
  // 不以 `/` 开头的更不是路径。这一格是被自己那条断言（⑫）拦下来补的，不是先想好的。
  const raw = location.pathname ?? '';
  const path = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  const hash = location.hash ?? '';
  return `${path}${query ? `?${query}` : ''}${hash}`;
}

/**
 * 这次点击/双击算不算"退出"：**交互元件上的动作不归退出**（那颗按钮、悬浮控制条、面板自己管自己）。
 * 判据落在 `closest()` 而不是标签名上——岛里的海报是 `div[role=button]`（一手读
 * `lattice/LatticePoster.tsx:229-231`：`onClick` + `role={expanded ? 'group' : 'button'}`），
 * 只认 `<button>` 会把"双击海报"当成退出口（R121 那一族："这次点击还有没有主人"）。
 */
const INTERACTIVE =
  'button, a, input, textarea, select, [contenteditable=true], [role=button], [role=tab], .folia-controls, #command-palette, [data-surface-exit]';

export function isSurfaceExitGesture(target: unknown): boolean {
  const element = target as { closest?: (selector: string) => Element | null } | null;
  if (!element || typeof element.closest !== 'function') return false;
  return element.closest(INTERACTIVE) === null;
}

export function createSurfaceExit(
  host: HTMLElement,
  options: SurfaceExitOptions = {},
): SurfaceExitHandle {
  const doc = host.ownerDocument;
  const label = options.label ?? SURFACE_EXIT_LABEL;
  const location = options.location ?? doc.defaultView?.location;
  const target = surfaceExitTarget({
    search: location?.search ?? '',
    pathname: location?.pathname ?? '/',
    hash: location?.hash ?? '',
  });
  let hotspot: HTMLButtonElement | null = null;
  let armed = false;

  const exit = (): void => {
    if (options.blocked?.()) return;
    // 全屏是"挂在墙上的那块屏"的最后一层：先把它按下来，再换地址。
    // 没有全屏可退、或浏览器不给退，都不拦这一步（拦了就退不出去，正是这一节要避免的事）。
    try {
      options.exitFullscreen?.();
    } catch {
      /* 退不了全屏不是失败：导航照走 */
    }
    options.navigate?.(target);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    exit();
  };
  const onDoubleClick = (event: MouseEvent): void => {
    if (!isSurfaceExitGesture(event.target)) return;
    exit();
  };
  const onHotspotClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    exit();
  };

  return {
    target,
    activate() {
      if (armed) return;
      armed = true;
      if (!hotspot) {
        hotspot = doc.createElement('button');
        hotspot.type = 'button';
        hotspot.className = 'folia-surface-exit';
        hotspot.dataset.surfaceExit = '1';
        hotspot.setAttribute('aria-label', label);
        hotspot.textContent = label;
        hotspot.addEventListener('click', onHotspotClick);
        host.appendChild(hotspot);
      }
      doc.addEventListener('keydown', onKeyDown);
      host.addEventListener('dblclick', onDoubleClick);
    },
    dispose() {
      if (!armed) return;
      armed = false;
      doc.removeEventListener('keydown', onKeyDown);
      host.removeEventListener('dblclick', onDoubleClick);
      hotspot?.removeEventListener('click', onHotspotClick);
      hotspot?.remove();
      hotspot = null;
    },
    exit,
    hotspot: () => hotspot,
  };
}
