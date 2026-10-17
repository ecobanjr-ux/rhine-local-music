/**
 * R206 ③ · 歌词面右下角那颗「沉浸全屏」（自撰，AGPL-3.0-only，零 import）。
 *
 * 它做的两件事：**页内全屏**（Fullscreen API）+ 把播放器外壳让位，只留底部中间那条控制条。
 * 与第三期那个真壁纸不是一回事（那一档沉不底、穿不穿透都不做，窗口还在、任务栏还在），
 * 所以按 Q53 的口径叫「沉浸全屏」，文案里明写"窗口内"，不许蹭"壁纸模式"那个名字。
 *
 * 三条形状纪律：
 *  · **不新造第二套隐藏逻辑**（R203 判据④ 钉过"第二套=0"）：隐藏仍然全部住在
 *    `lyric-folia-chrome.css` 第 9 段那一组 `#stage[data-surface="…"]` 规则里，本模块只把
 *    "现在该挂哪一档"这一格交回宿主（`onSurfaceChange`），宿主仍然只写 `stage.dataset.surface`
 *    那一个出处。壁纸态与沉浸全屏是同一个属性的两个**值**，不是两套机制。
 *  · **全屏拿不到也要能进**：`requestFullscreen()` 被拒（浏览器策略、非用户手势、根本没有这个 API）
 *    都不拦"隐藏外壳"这一步 —— 那一格失败最坏只是没全屏，不该把整颗按钮变成死的。
 *  · **Esc 天然可用**：这一档窗口有焦点（不穿透），浏览器按 Esc 会自己退出全屏，
 *    `fullscreenchange` 回来时我们跟着把外壳还原 ⇒ 不另起按键监听、不与命令面板抢 Esc。
 */

/** 界面文案（Q53：叫「沉浸全屏」，并明写是窗口内，不叫壁纸模式）。 */
export const IMMERSIVE_ENTER_LABEL = '沉浸全屏（窗口内）';
export const IMMERSIVE_EXIT_LABEL = '退出沉浸全屏';

/** 这一档挂到 `data-surface` 上的值 —— 与壁纸那档同一个属性、不同的值。 */
export const IMMERSIVE_SURFACE_VALUE = 'immersive';

export interface ImmersiveFullscreenLike {
  /** 请求全屏；拿不到、被拒、抛错都算"没有全屏"，不拦沉浸本身。 */
  request(): unknown;
  /** 退出全屏（我们自己那颗按钮退出时调用）。 */
  release(): unknown;
  /** 现在到底全屏了没有（`fullscreenchange` 之后读的就是这一格）。 */
  active(): boolean;
  /** 订阅全屏变化；返回解除订阅。没有这一格（非浏览器环境）就不订。 */
  subscribe?(handler: () => void): () => void;
}

export interface ImmersiveOptions {
  fullscreen?: ImmersiveFullscreenLike;
  /** 该挂哪一档交回宿主（宿主只写 `stage.dataset.surface` 那一个出处）。 */
  onSurfaceChange?(on: boolean): void;
  /** 状态变化给宿主同步用（取证与命令表读这一格，不在别处另记一份）。 */
  onChange?(on: boolean): void;
}

export interface ImmersiveHandle {
  isOn(): boolean;
  /** 那颗按钮（真机取证要量它的位置与命中）。 */
  button(): HTMLButtonElement | null;
  /** 挂按钮（幂等）。 */
  activate(): void;
  /** 摘按钮并解除订阅。 */
  dispose(): void;
  /** 两条路都走这一个：进入 / 退出。 */
  toggle(): boolean;
}

export function createImmersiveToggle(host: HTMLElement, options: ImmersiveOptions = {}): ImmersiveHandle {
  const doc = host.ownerDocument;
  let button: HTMLButtonElement | null = null;
  let on = false;
  let armed = false;
  let unsubscribe: (() => void) | null = null;

  const apply = (next: boolean): void => {
    if (on === next) return;
    on = next;
    options.onSurfaceChange?.(on);
    if (button) {
      button.textContent = on ? IMMERSIVE_EXIT_LABEL : IMMERSIVE_ENTER_LABEL;
      button.setAttribute('aria-label', on ? IMMERSIVE_EXIT_LABEL : IMMERSIVE_ENTER_LABEL);
      button.dataset.immersiveOn = on ? '1' : '0';
    }
    options.onChange?.(on);
  };

  const toggle = (): boolean => {
    if (on) {
      // 退出：先把全屏按下来再还原外壳；全屏按不下来不是失败（可能本来就没拿到）
      try {
        options.fullscreen?.release();
      } catch {
        /* 没有全屏可退也要把外壳还回来 */
      }
      apply(false);
    } else {
      // 进入：全屏那一格失败也照样沉浸（判据④）
      try {
        const pending = options.fullscreen?.request() as Promise<unknown> | undefined;
        if (pending && typeof pending.catch === 'function') pending.catch(() => undefined);
      } catch {
        /* 上面注释：拿不到全屏不拦这一步 */
      }
      apply(true);
    }
    return on;
  };

  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    toggle();
  };

  return {
    isOn: () => on,
    button: () => button,
    activate() {
      if (armed) return;
      armed = true;
      if (!button) {
        button = doc.createElement('button');
        button.type = 'button';
        button.className = 'folia-immersive-toggle';
        button.dataset.immersiveToggle = '1';
        button.dataset.immersiveOn = '0';
        button.textContent = IMMERSIVE_ENTER_LABEL;
        button.setAttribute('aria-label', IMMERSIVE_ENTER_LABEL);
        button.addEventListener('click', onClick);
        host.appendChild(button);
      }
      // 浏览器自己退出的那一趟（按 Esc 退出全屏）跟着还原外壳
      unsubscribe = options.fullscreen?.subscribe?.(() => {
        if (on && !options.fullscreen!.active()) apply(false);
      }) ?? null;
    },
    dispose() {
      if (!armed) return;
      armed = false;
      unsubscribe?.();
      unsubscribe = null;
      button?.removeEventListener('click', onClick);
      button?.remove();
      button = null;
      apply(false);
    },
    toggle,
  };
}

/**
 * 真机上给宿主用的那份全屏适配器（单独一格：自检注假的进来，才能不依赖浏览器真跑状态机）。
 * `document.fullscreenElement` 与 `requestFullscreen` 的可用性都按"可能没有"写。
 */
export function documentFullscreenAdapter(doc: Document | null | undefined): ImmersiveFullscreenLike {
  return {
    request() {
      const element = doc?.documentElement as (HTMLElement & { requestFullscreen?: () => Promise<void> }) | undefined;
      if (!element || typeof element.requestFullscreen !== 'function') return undefined;
      return element.requestFullscreen();
    },
    release() {
      if (typeof doc?.exitFullscreen !== 'function') return undefined;
      if (!doc.fullscreenElement) return undefined;
      return doc.exitFullscreen();
    },
    active() {
      return Boolean(doc?.fullscreenElement);
    },
    subscribe(handler) {
      if (typeof doc?.addEventListener !== 'function') return () => undefined;
      doc.addEventListener('fullscreenchange', handler);
      return () => doc.removeEventListener('fullscreenchange', handler);
    },
  };
}
