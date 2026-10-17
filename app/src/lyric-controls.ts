export interface FoliaControlsSnapshot {
  playing: boolean;
  title: string;
  single: boolean;
  currentTime: number;
  duration: number;
  dragging: boolean;
  intensityLabel: string;
  /** 第二期：封面墙切换键。文案是"点下去会变成什么"，pressed 表示当前已在封面墙。 */
  layoutLabel: string;
  layoutActive: boolean;
  /** 岛没挂上（降级自研歌词面）时不能进封面墙。 */
  layoutAvailable: boolean;
}

export interface FoliaControlsOptions {
  root: HTMLElement;
}

/**
 * Folia 视图里的悬浮精简控制条：上一首 / 播放暂停 / 下一首 / 细进度条 / 返回演出。
 *
 * 两个刻意的设计约束：
 *  ① 按钮只写 data-action，播放动作由 music-app 里 document 级点击委托统一处理，
 *     这里绝不直接调 player.play()/next()，否则同一个动作会有两套入口各自漂移；
 *  ② 不持有定时器、不起 rAF。浮现/淡出由外部唯一的 idle-reveal 喂进来（setRevealed），
 *     进度与可用性由 sync() 从播放状态推进来。本模块只做 DOM 与类名。
 */
export function createFoliaControls(options: FoliaControlsOptions) {
  const { root } = options;
  const bar = document.createElement("div");
  bar.className = "folia-controls";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "播放控制");
  bar.innerHTML = `
    <button type="button" data-action="track-prev" class="folia-btn" aria-label="上一首">⏮</button>
    <button type="button" data-action="play-pause" class="folia-btn folia-btn-primary" aria-label="播放或暂停" aria-pressed="false">▶</button>
    <button type="button" data-action="track-next" class="folia-btn" aria-label="下一首">⏭</button>
    <input type="range" class="folia-seek" data-seek min="0" max="0" step="0.5" value="0" aria-label="拖动调整播放进度" disabled>
    <span class="folia-title"></span>
    <button type="button" data-action="lyric-intensity" class="folia-btn folia-btn-intensity" aria-label="动效强度">标准</button>
    <button type="button" data-action="folia-layout" class="folia-btn folia-btn-layout" aria-label="封面墙" aria-pressed="false">封面墙</button>
    <button type="button" data-action="mode-rhine" class="folia-btn folia-btn-exit" aria-label="返回演出模式">演出</button>`;
  const seek = bar.querySelector<HTMLInputElement>(".folia-seek")!;
  const title = bar.querySelector<HTMLElement>(".folia-title")!;
  const intensityButton = bar.querySelector<HTMLButtonElement>('[data-action="lyric-intensity"]')!;
  const layoutButton = bar.querySelector<HTMLButtonElement>('[data-action="folia-layout"]')!;
  const playButton = bar.querySelector<HTMLButtonElement>('[data-action="play-pause"]')!;
  const prevButton = bar.querySelector<HTMLButtonElement>('[data-action="track-prev"]')!;
  const nextButton = bar.querySelector<HTMLButtonElement>('[data-action="track-next"]')!;

  let revealed = true;

  /** 淡出同时交还指针，避免"看不见但还能点"。 */
  function applyReveal(on: boolean) {
    revealed = on;
    bar.classList.toggle("is-hidden", !on);
  }

  return {
    get element() {
      return bar;
    },
    get seekInput() {
      return seek;
    },
    mount() {
      // 幂等按"当前是不是 root 的子节点"判断，而不是按已挂载标志：
      // 舞台换行/换曲时会 root.textContent = "" 清一次 DOM，标志还是 true 但节点已脱离。
      if (bar.parentNode !== root) root.appendChild(bar);
      // 重新挂载时沿用当前的浮现态，不能强扭成"浮现"：否则 idle-reveal 以为还藏着，
      // 控制条却自己跳出来，和顶栏不同步。
      applyReveal(revealed);
    },
    dispose() {
      bar.remove();
    },
    /** 由唯一的 idle-reveal 计时器驱动。 */
    setRevealed(on: boolean) {
      applyReveal(on);
    },
    sync(snapshot: FoliaControlsSnapshot) {
      playButton.textContent = snapshot.playing ? "⏸" : "▶";
      playButton.setAttribute("aria-pressed", String(snapshot.playing));
      title.textContent = snapshot.title;
      intensityButton.textContent = snapshot.intensityLabel;
      layoutButton.textContent = snapshot.layoutLabel;
      layoutButton.setAttribute("aria-pressed", String(snapshot.layoutActive));
      layoutButton.setAttribute("aria-label", snapshot.layoutLabel);
      layoutButton.disabled = !snapshot.layoutAvailable;
      prevButton.disabled = snapshot.single;
      nextButton.disabled = snapshot.single;
      const usable = snapshot.duration > 0;
      seek.disabled = !usable;
      if (!usable) return;
      seek.max = String(snapshot.duration);
      // 拖动中不回写，否则指针会被自己的值拽回去。
      if (!snapshot.dragging) seek.value = String(Math.min(snapshot.currentTime, snapshot.duration));
    },
    get mounted() {
      return bar.parentNode !== null;
    },
    get visible() {
      return bar.parentNode !== null && revealed;
    },
  };
}

export type FoliaControls = ReturnType<typeof createFoliaControls>;
