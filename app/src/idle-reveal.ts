export interface IdleRevealOptions {
  /** 空闲多少毫秒后收起。 */
  idleMs?: number;
  onReveal: () => void;
  onHide: () => void;
  /** 指针停在受保护区域（顶栏胶囊 / 控制条）上时不收起，否则会"看不见但还能点"。 */
  keepOpen: () => boolean;
}

/**
 * 活动浮现 / 空闲淡出的唯一计时器。
 *
 * 顶栏与悬浮控制条共用同一个实例：各起一个定时器一定会漂，出现"顶栏还在、控制条已经消失"
 * 这种割裂态。这里只用 setTimeout，不碰 requestAnimationFrame —— 它不参与逐帧音画同步。
 */
export function createIdleReveal(options: IdleRevealOptions) {
  const { onReveal, onHide, keepOpen } = options;
  const idleMs = options.idleMs ?? 3000;
  let timer: number | undefined;
  let armed = false;
  let revealed = true;

  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (keepOpen()) {
        arm();
        return;
      }
      if (revealed) {
        revealed = false;
        onHide();
      }
    }, idleMs);
  };

  const onActivity = () => {
    if (!armed) return;
    if (!revealed) {
      revealed = true;
      onReveal();
    }
    arm();
  };

  return {
    /** 进入 Folia 播放视图时挂监听并立即浮现一次。 */
    start() {
      if (armed) return;
      armed = true;
      revealed = true;
      onReveal();
      window.addEventListener("pointermove", onActivity, { passive: true });
      window.addEventListener("pointerdown", onActivity, { passive: true });
      window.addEventListener("keydown", onActivity);
      arm();
    },
    /** 离开时摘监听并强制回到"浮现"态，避免顶栏停在隐藏状态而当前视图没人负责显示它。 */
    stop() {
      if (!armed) return;
      armed = false;
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      revealed = true;
      onReveal();
    },
    wake: onActivity,
    get isRevealed() {
      return revealed;
    },
  };
}
