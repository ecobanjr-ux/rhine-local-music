import type { LyricData } from "./lyrics/types";
import type { ParsedLyricLine } from "./lyrics/index.ts";
import { ONLINE_PROVIDER_LABELS, type LoadedLyrics, type LyricsClient } from "./lyrics-client.ts";
import type { MusicPlayer, MusicPlayerState } from "./music-player";
import type { MusicTrack } from "./music-types";
import { createNotePulse, type LyricPulseTier } from "./lyric-pulse.ts";
import { createFoliaControls, type FoliaControlsSnapshot } from "./lyric-controls.ts";
import { derivePalette, loadCoverStats, tierForTheme, type CoverStats, type PaletteTheme, type Rgb } from "./cover-palette.ts";

export type DisplayMode = "rhine" | "folia";

/** Only the two known modes are honoured; anything else falls back to the 3D show. */
export function resolveDisplayMode(value: unknown): DisplayMode {
  return value === "folia" ? "folia" : "rhine";
}

export type LyricIntensity = "calm" | "normal" | "chaotic";

/** 非法值一律回落 normal：偏好可能来自旧版本或手工编辑过的 localStorage。 */
export function resolveLyricIntensity(value: unknown): LyricIntensity {
  return value === "calm" || value === "chaotic" ? value : "normal";
}

/**
 * 三档的全部驱动量。刻意只用 CSS 变量表达：改档不重建 DOM、不让逐帧路径出现代码分叉，
 * 也让 reduced-motion 只需把动效属性归零就能整条退化（不靠调小变量）。
 * 单位各不相同（px / em / 倍率 / ms），所以表里存无单位数字，样式侧补单位。
 */
export const INTENSITY_VARS: Record<LyricIntensity, Record<string, number>> = {
  calm:    { "--i-breathe": 2,  "--i-enter-y": 0.22, "--i-enter-scale": 0.06, "--i-stagger": 14 },
  normal:  { "--i-breathe": 5,  "--i-enter-y": 0.42, "--i-enter-scale": 0.14, "--i-stagger": 26 },
  chaotic: { "--i-breathe": 11, "--i-enter-y": 0.72, "--i-enter-scale": 0.26, "--i-stagger": 46 },
};

/** 派生色变量名。失败回退时要逐个摘掉，所以列成表而不是散在七处 setProperty。 */
const FOLIA_VARS = [
  "--folia-ink",
  "--folia-tinted",
  "--folia-dusk",
  "--folia-rich",
  "--folia-primary",
  "--folia-secondary",
  "--folia-accent",
] as const;

export interface LyricStageOptions {
  root: HTMLElement;
  client: LyricsClient;
  player: MusicPlayer;
  reduced?: () => boolean;
  /** 无歌词曲目的音符动画档位；缺省按 basic（纯 CSS，不碰 Web Audio）。 */
  pulseTier?: () => LyricPulseTier;
  /** 当前专辑封面 URL，Folia 视图拿它做模糊背景；取不到则回退到令牌渐变底。 */
  cover?: () => string | undefined;
  /** 当前主题：决定 Folia 用哪一档底色（主题定明暗、封面定色相）。缺省则按封面亮度归档。 */
  theme?: () => PaletteTheme;
  /** 动效强度档位；缺省 normal。 */
  intensity?: () => LyricIntensity;
}

/**
 * The Folia-mode lyric surface. It owns DOM only: the caller drives it with
 * `applyTime()` from a single animation frame loop so timing stays frame-accurate.
 */
export function createLyricStage(options: LyricStageOptions) {
  const { root, client, player, reduced, pulseTier, cover, intensity, theme } = options;
  let lines: ParsedLyricLine[] = [];
  let lineNodes: HTMLElement[] = [];
  let wordNodes: HTMLElement[][] = [];
  let activeLine = -1;
  let activeWord = -1;
  let loaded: LoadedLyrics | null = null;
  let lastTime = 0;
  let listEl: HTMLElement | null = null;
  let trackId: string | null = null;
  let token = 0;
  let pulse: ReturnType<typeof createNotePulse> | null = null;
  let pulsing = false;
  let controls: ReturnType<typeof createFoliaControls> | null = null;

  function build(data: LyricData) {
    markPlainBlock(false);
    lines = (data.lines ?? []) as ParsedLyricLine[];
    lineNodes = [];
    wordNodes = [];
    root.textContent = "";
    const list = document.createElement("div");
    list.className = "lyric-lines";
    lines.forEach((line, index) => {
      const row = document.createElement("p");
      row.className = "lyric-line";
      row.dataset.index = String(index);
      row.dataset.start = String(line.startTime);
      if (line.isInterlude) row.classList.add("is-interlude");
      const perWord: HTMLElement[] = [];
      (line.words ?? []).forEach((word, wordIndex) => {
        const span = document.createElement("span");
        span.className = "lyric-word";
        span.dataset.index = String(wordIndex);
        span.dataset.start = String(word.startTime);
        // 逐字 stagger 的档位。% 12 是刻意封顶：46px 大字一行可能 20+ 字，
        // 全量累加会让行尾比音频慢半秒，同步实测会直接劣化。
        span.style.setProperty("--i", String(wordIndex % 12));
        span.textContent = word.text;
        row.appendChild(span);
        perWord.push(span);
      });
      if (!perWord.length) row.textContent = line.fullText ?? "";
      wordNodes.push(perWord);
      lineNodes.push(row);
      list.appendChild(row);
    });
    root.appendChild(list);
    listEl = list;
    if (lines.length) hidePulse();
    else if (!showPlainText()) showPulse();
    ensureSurface();
    applyIntensity();
    activeLine = -1;
    activeWord = -1;
  }

  /**
   * build() / showPulse() / showPlainText() 都会先 root.textContent = "" 清一次 DOM，
   * 背景层与悬浮控制条是常驻外壳，必须在这些路径之后统一补回来。
   *
   * **控制条要在这里"建"，不能只在这里"挂"**：`controls` 被 `setMode("rhine")` 置空之后
   * （那时它已经把节点 dispose 掉了），清 DOM 的路径只调这一个函数补回来 ⇒ 只 mount 不 create，
   * 就再也没人把它建回来（表现为"进了歌词面却没有底部控制条"）。
   * 与"清 DOM 时把在挂的那条清掉"是两件事：那种情况 `controls` 还在，`mount()` 能挂回去。
   */
  function ensureSurface() {
    mountBackdrop();
    if (!controls) controls = createFoliaControls({ root });
    controls.mount();
  }

  /** 改档只写四个变量：不清 DOM、不动逐帧路径，降级路径也因此只需把动效属性归零。 */
  function applyIntensity() {
    const name = intensity ? resolveLyricIntensity(intensity()) : "normal";
    const table = INTENSITY_VARS[name];
    for (const [key, value] of Object.entries(table)) root.style.setProperty(key, String(value));
    root.dataset.intensity = name;
  }

  /**
   * 当前行居中——只滚歌词列自己，绝不用 scrollIntoView。
   * scrollIntoView 会连带滚动链上每一个可滚动祖先，而 #stage 是 overflow:hidden：
   * 隐藏裁切并不妨碍被程序滚动，于是整层界面被顶上去，底部露出一条背景带
   * （实测 .music-app.scrollTop=75，且这个偏移随换行变化，正是 y 轴瞬态的同源问题）。
   * 用 offsetTop 而不是 getBoundingClientRect：入场动画的 translate/scale 会污染 rect，
   * 让居中位置随行号抖动十几像素。
   */
  function centerActiveLine(row: HTMLElement) {
    const list = listEl;
    if (!list?.isConnected) return;
    const target = row.offsetTop + row.offsetHeight / 2 - list.clientHeight / 2;
    list.scrollTo({ top: target, behavior: reduced?.() ? "auto" : "smooth" });
  }

  /**
   * 封面取色只在 Folia 视图里生效：成功写七个 --folia-* 变量 + data-tier，
   * 失败必须把变量摘干净，让样式里的 var(--folia-x, var(--令牌)) 落回全局令牌，
   * 并把原因留在 data-palette-fallback 上——静默回退等于把 bug 藏进配色里。
   *
   * 色相与饱和度来自封面，明暗档来自主题（tierForTheme），所以这里缓存的是**封面统计**
   * 而不是成品色板：换主题只重推一遍，不再解码封面。
   *
   * 刻意不做 @property 注册：注册过的自定义属性永远有值（initial-value），
   * var(--folia-primary, var(--ink)) 的回退分支就再也走不到，失败态会拿到一个
   * 写死的初始色而不是当前主题的令牌色。渐变因此改由消费端过渡
   * （color / background-color 本身就是可插值属性）。
   */
  let paletteToken = 0;
  let paletteFor: string | undefined;
  let coverStats: CoverStats | null = null;

  function clearPalette() {
    for (const name of FOLIA_VARS) root.style.removeProperty(name);
    delete root.dataset.tier;
    coverStats = null;
  }

  /** 把缓存的封面统计按当前主题的档位重新推导一遍并写进样式。 */
  function applyPalette() {
    if (!coverStats) return;
    const stats = coverStats;
    const p = derivePalette(stats, theme ? tierForTheme(theme()) : stats.coverTier);
    const paint = (c: Rgb) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
    root.style.setProperty("--folia-ink", paint(p.ink));
    root.style.setProperty("--folia-tinted", paint(p.tinted));
    root.style.setProperty("--folia-dusk", paint(p.dusk));
    root.style.setProperty("--folia-rich", paint(p.rich));
    root.style.setProperty("--folia-primary", paint(p.primary));
    root.style.setProperty("--folia-secondary", paint(p.secondary));
    root.style.setProperty("--folia-accent", paint(p.accent));
    root.dataset.tier = p.tier;
    delete root.dataset.paletteFallback;
  }

  async function refreshPalette() {
    const url = cover?.();
    const token = ++paletteToken;
    paletteFor = url;
    if (!url) {
      clearPalette();
      root.dataset.paletteFallback = "no-cover";
      return;
    }
    const result = await loadCoverStats(url);
    // 换歌快时旧结果不得覆盖新结果：只认最后一次派发的令牌。
    if (token !== paletteToken) return;
    if ("error" in result) {
      clearPalette();
      root.dataset.paletteFallback = result.error;
      return;
    }
    coverStats = result.stats;
    applyPalette();
  }

  /**
   * Folia 是独立沉浸视图，背景必须是亮度可控的封面模糊底，而不是定格的三维最后一帧——
   * detail 构图的主体就是那张满幅高饱和的封面卡，直接压大字歌词对比度不可控。
   * 幂等：先摘掉旧的再插，所以 build / setMode 两条路径都能安全重复调用。
   */
  function mountBackdrop() {
    root.querySelector(".lyric-backdrop")?.remove();
    root.querySelector(".lyric-scrim")?.remove();
    const url = cover?.();
    root.style.setProperty("--lyric-cover", url ? `url("${url}")` : "none");
    const backdrop = document.createElement("div");
    backdrop.className = url ? "lyric-backdrop" : "lyric-backdrop no-cover";
    const scrim = document.createElement("div");
    scrim.className = "lyric-scrim";
    root.prepend(scrim, backdrop);
    // 封面变了就重新取色；同一张封面重复挂载（切模式来回）不重复解码。
    if (url !== paletteFor) void refreshPalette();
  }

  /**
   * 非同步歌词（ID3 USLT）没有时间轴，解析不出逐行时间，但它**不是**"没有歌词"。
   * 这里把原文按行静态显示：不做逐行点亮，也不放音符动画。返回 false 表示没有原文可显示。
   */
  /** R63：岛内的"等待音乐"占位层要在宿主有段落可显示时让位（CSS 靠这个类判定）。 */
  function markPlainBlock(on: boolean): void {
    root.classList.toggle("has-plain", on);
  }

  function showPlainText(): boolean {
    if (loaded?.format !== "lyrics") {
      markPlainBlock(false);
      return false;
    }
    const text = (loaded.text ?? "").trim();
    if (!text) {
      markPlainBlock(false);
      return false;
    }
    root.textContent = "";
    const block = document.createElement("div");
    block.className = "lyric-plain";
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = document.createElement("p");
      row.textContent = line.trim();
      block.appendChild(row);
    }
    if (!block.childNodes.length) {
      markPlainBlock(false);
      return false;
    }
    root.appendChild(block);
    markPlainBlock(true);
    // 这条路也清过 DOM（`root.textContent = ""`），同样要把常驻外壳补回来：
    // 三条清 DOM 的路径里只有 `build()` 原本走了 `ensureSurface`，这一条与 `showPulse` 都漏了。
    ensureSurface();
    return true;
  }

  /**
   * 无歌词曲目不显示"无歌词"文字占位，改为一排跳动的音符（屏幕阅读器仍读到文字说明）。
   * 动画由同一个 rAF 循环里的 applyTime 驱动，不自建第二条循环。
   */
  function showPulse() {
    markPlainBlock(false);
    root.textContent = "";
    pulsing = true;
    if (!pulse) {
      pulse = createNotePulse({
        root,
        player,
        reduced: () => !!reduced?.(),
        tier: pulseTier ?? (() => "basic"),
      });
    }
    pulse.mount();
    // 这条路也清过 DOM，同样把常驻外壳补回来（控制条的建与挂都收在 ensureSurface 一处，
    // 不在这里各写一遍——两处各写一套迟早漂）。
    ensureSurface();
  }

  function hidePulse() {
    pulsing = false;
    root.style.removeProperty("--pulse-level");
    root.querySelector(".note-pulse")?.remove();
  }

  /** Show the source of the current lyric text (sidecar file name or embedded tag). */
  function renderSourceBadge() {
    root.querySelector(".lyric-source")?.remove();
    root.querySelector(".lyric-match-entry")?.remove();
    // R144：先画入口，再画徽标——入口在"没有歌词"时**更要看得见**（它就是为那种时候准备的），
    // 所以它不能跟着徽标那条 `source === "none"` 的早退一起被跳过。
    if (trackId) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "text-button lyric-match-entry";
      entry.dataset.action = "open-lyric-match";
      entry.textContent = loaded?.claimed ? "歌词匹配（已认领）…"
        : !loaded || loaded.source === "none" ? "匹配歌词…"
          : "换一首歌词…";
      root.appendChild(entry);
    }
    if (!loaded || loaded.source === "none") return;
    const badge = document.createElement("small");
    badge.className = "lyric-source";
    // 来源徽标必须与设置面板那份声明同源（第四期定案"UI 标明来源"）：
    // 四源各自的中文名只在这里定义一次，面板与徽标都读它，免得文案说三家、徽标冒出第四家。
    const origin =
      loaded.source === "sidecar" ? "同目录文件"
        // R144：手动认领的那一条不叫"在线匹配"——机器没有配过它，是人挑的。两种来源不许混说。
        : loaded.source === "online" ? `${loaded.claimed ? "手动认领" : "在线匹配"}${loaded.replacedLocalUntimedLyric ? "（替换内嵌纯文本）" : ""} · ${ONLINE_PROVIDER_LABELS[loaded.provider ?? "qq"] ?? "在线"}`
        : "内嵌标签";
    // 被安全预检挡下时不能还标"行级/逐字"——那会让人以为只是没对上时间轴。
    badge.textContent =
      loaded.rejected === "entity-declaration"
        ? `${origin} · 已拒绝（含实体声明）`
        : `${origin} · ${loaded.format === "lrc" ? "行级" : loaded.format === "ttml" || loaded.format === "qrc" ? "逐字" : "纯文本"}`;
    root.appendChild(badge);
  }

  async function sync(state: MusicPlayerState) {
    const track: MusicTrack | null | undefined = state.currentTrack;
    const id = track?.id ?? null;
    if (id !== trackId) {
      trackId = id;
      loaded = null;
      lines = [];
      lineNodes = [];
      wordNodes = [];
      activeLine = -1;
      activeWord = -1;
      const request = ++token;
      if (!track) {
        hidePulse();
        root.textContent = "";
        root.style.removeProperty("--lyric-cover");
        return;
      }
      const result = await client.load(track);
      if (request !== token || trackId !== track.id) return;
      loaded = result;
      build(result.data);
      renderSourceBadge();
      // R60：本地无词的曲目先在播的是"无词态"，在线匹配后到时再原地换成逐字词。
      // 守卫与上面同一条：换过曲（token 变）就丢弃，不给旧歌贴上新的歌词。
      if (result.upgrade) {
        void result.upgrade.then((upgraded) => {
          if (request !== token || trackId !== track.id) return;
          if (upgraded.empty || !(upgraded.data.lines?.length)) return;
          loaded = upgraded;
          build(upgraded.data);
          renderSourceBadge();
          // 立刻按当前播放位置点亮，不等下一帧：匹配通常几百毫秒就到，晚一帧也要肉眼可见。
          applyTime(lastTime);
        }).catch(() => {
          /* runOnlineUpgrade 已经把一切失败兑现成结果；这里只是最后一道保险，绝不让它变成未处理的 rejection。 */
        });
      }
    }
  }

  /** Apply the media clock: only touches the DOM when the highlighted index changes. */
  function applyTime(seconds: number) {
    lastTime = seconds;
    root.classList.toggle("is-reduced", !!reduced?.());
    if (!lines.length) {
      // 只有确实在放动画时才驱动 tick：tick 里的软降级重建会重新 append 音符容器，
      // 纯文本歌词同样解析出 0 行，不守住这个开关音符会盖在正文上面。
      if (pulsing) pulse?.tick();
      return;
    }
    let lineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      const end = line.renderHints?.renderEndTime ?? line.endTime ?? line.startTime;
      if (line.startTime <= seconds && seconds < end) {
        lineIndex = i;
        break;
      }
      if (line.startTime <= seconds) {
        lineIndex = i;
        break;
      }
    }
    if (lineIndex !== activeLine) {
      const previous = activeLine;
      lineNodes[activeLine]?.classList.remove("is-active");
      // 换行时清掉上一行的"已唱"与"当前字"标记：往回拖动进度条会重新进入同一行，
      // 残留会让未唱的字先亮着；而 is-word-active 不清的话，旧行末尾那个字会永久
      // 顶着强调色（实测：下一行已经唱到中间，上一行的"析"字还是橙色）。
      for (const word of wordNodes[activeLine] ?? [])
        word.classList.remove("is-word-passed", "is-word-active");
      activeLine = lineIndex;
      activeWord = -1;
      const row = lineNodes[activeLine];
      row?.classList.add("is-active");
      if (row) centerActiveLine(row);
      // 距离阶梯只更新新旧当前行的 ±3 窗口：整表遍历会让每次换行变成 O(n) 的 DOM 写入。
      const touched = new Set<number>();
      for (let offset = -3; offset <= 3; offset += 1) {
        if (lineIndex + offset >= 0) touched.add(lineIndex + offset);
        if (previous + offset >= 0) touched.add(previous + offset);
      }
      for (const index of touched) {
        const node = lineNodes[index];
        if (!node) continue;
        const distance = Math.abs(index - lineIndex);
        if (distance <= 3) node.dataset.distance = String(distance);
        else delete node.dataset.distance;
      }
    }
    const line = lines[activeLine];
    const words = wordNodes[activeLine] ?? [];
    if (line && words.length) {
      let wordIndex = -1;
      const entries = line.words ?? [];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].startTime <= seconds) {
          wordIndex = i;
          break;
        }
      }
      if (wordIndex !== activeWord) {
        words[activeWord]?.classList.remove("is-word-active");
        words[activeWord]?.classList.remove("is-word-passed");
        for (let i = 0; i < wordIndex; i += 1) words[i].classList.add("is-word-passed");
        activeWord = wordIndex;
        words[activeWord]?.classList.add("is-word-active");
      }
    }
  }

  function setMode(mode: DisplayMode) {
    root.hidden = mode !== "folia";
    root.setAttribute("aria-hidden", String(mode !== "folia"));
    // 切回演出视图后不再逐帧驱动动画；节点留着，再切回来时不必重建音频图谱。
    if (mode !== "folia") {
      hidePulse();
      controls?.dispose();
      controls = null;
    } else {
      // loaded 为空表示还没选曲或歌词还没解析完 —— 这两种场合什么都不显示。
      // 只看 lines.length 会把"没选曲"误判成"这首没有歌词"，弹出带 aria-label
      // "这首曲目没有歌词"的音符动画，对读屏用户是一句假话。
      if (loaded && !lines.length && !showPlainText()) {
        showPulse();
        renderSourceBadge();
      }
      mountBackdrop();
      applyIntensity();
      if (!controls) controls = createFoliaControls({ root });
      ensureSurface();
    }
  }

  /** Force a reload of the current track's lyrics (after a rescan or cache reset). */
  function refresh() {
    trackId = null;
    token += 1;
  }

  return {
    sync,
    applyTime,
    setMode,
    refresh,
    /** 外部改档后立刻生效（不重建 DOM）。 */
    refreshIntensity: applyIntensity,
    /** 换主题后按新档位重新推导派生色（复用缓存的封面统计，不重新解码）。 */
    refreshTheme: applyPalette,
    /** R19：把无歌词动画既有 analyser 的频谱交给 Folia 岛信号层（不新建 source）。 */
    pulseSpectrum() {
      return pulse?.spectrum() ?? null;
    },
    /** 岛适配层喂词用：当前已加载的歌词数据（未加载完为 null）。 */
    lyricData() {
      return loaded?.data ?? null;
    },
    /** 播放状态推给悬浮控制条；本模块不读播放器内部状态。 */
    syncControls(snapshot: FoliaControlsSnapshot) {
      controls?.sync(snapshot);
    },
    /** 顶栏与控制条由同一个 idle-reveal 驱动，一起浮现、一起淡出。 */
    setRevealed(on: boolean) {
      controls?.setRevealed(on);
    },
    get controlsMounted() {
      return controls?.mounted ?? false;
    },
    get state() {
      return {
        lines: lines.length,
        activeLine,
        activeWord,
        clock: lastTime,
        source: loaded?.source ?? "none",
        empty: loaded?.empty ?? true,
        rejected: loaded?.rejected,
        error: loaded?.error,
        pulsing,
        controlsVisible: controls?.visible ?? false,
        plain: !!root.querySelector(".lyric-plain"),
        pulse: pulse?.state,
        // [start, end) per line in seconds; lets an in-page sampler verify the
        // displayed index against the media clock frame by frame.
        timeline: lines.map((line) => [
          line.startTime,
          line.renderHints?.renderEndTime ?? line.endTime ?? line.startTime,
        ]),
      };
    },
  };
}

export type LyricStage = ReturnType<typeof createLyricStage>;
