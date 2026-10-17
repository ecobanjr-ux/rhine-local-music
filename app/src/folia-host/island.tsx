/**
 * Folia 岛挂载点（自撰，非移植）：懒加载 React 根，仅在 Folia 播放视图存在。
 * 第一期只挂 classic 歌词面；第二期按宿主偏好渲染 classic 或 lattice（封面墙）。
 * chrome（顶栏胶囊/悬浮控制条）仍由宿主提供，岛不持有传输控件权威。
 *
 * R23（移植台账）：适配层实例**必须在本模块（岛 chunk）内创建**。曾把它放在 music-app
 * 静态导入链里，导致 motionSignals 被 rollup 拆成主 chunk 与岛 chunk 两个模块实例：
 * 适配层写的是主 chunk 那份，岛内组件订阅的是岛 chunk 那份，时钟驱动动画全部冻结
 * （入场动画由组件自驱故仍能跑，极具迷惑性）。handle 模式让信号写入与订阅同实例。
 *
 * R36（第二期）：Lattice 走 React.lazy，pixi 只进 Lattice chunk——岛本身（classic 路径）
 * 不下载 pixi，封面墙第一次打开才下载。
 */
import React, { Suspense, lazy, useContext, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "zustand";
import "../folia-tailwind.css";
// R24：歌词衬线自托管（上游经 CDN hotlink 同一字体的 @fontsource 包）；只引简中子集两档字重。
import "@fontsource/noto-serif-sc/chinese-simplified-400.css";
import "@fontsource/noto-serif-sc/chinese-simplified-500.css";
import VisualizerRenderer from "../folia/components/visualizer/VisualizerRenderer";
import type { VisualizerTuningBundle } from "../folia/components/visualizer/tuningRegistry";
import { audioBands, audioPower, currentTime, lyricCurrentTime } from "../folia/stores/motionSignals";
import {
  selectDisplayCoverUrl,
  selectDisplayDuration,
  selectDisplayPlayerState,
  selectDisplaySong,
  usePlaybackStore,
} from "../folia/stores/usePlaybackStore";
import { useAppViewStore } from "../folia/stores/useAppViewStore";
import { PlayerState, type ArtistGridFeed, type Line, type LyricData, type SongResult } from "../folia/types";
import { useHostThemeStore } from "./theme-bridge";
import { createFoliaTextGuard, type FoliaTextGuard } from "./text-guard";
import { SUBTITLE_OVERLAY_BACKGROUND, SUBTITLE_UPCOMING_LYRICS_BLUR } from "./subtitle-glow";
import {
  createFoliaAdapter,
  type FoliaAdapter,
  type FoliaAdapterOptions,
} from "./adapter";

const Lattice = lazy(() => import("../folia/components/app/lattice/Lattice"));
// R162（任务九）：移植件本体逐字照搬上游，宿主喂料替代它自己的三条取数支路（见台账 R162）。
// 和 Lattice 同一档处理：只在第一次打开网格时才下载这块代码，classic/lattice 路径不为它多带字节。
const ArtistGrid = lazy(() => import("../folia/components/ArtistGridView"));

const EMPTY_LINES: Line[] = [];

export type IslandLayout = "classic" | "lattice" | "artistGrid";
/** R47（第三期）：岛内歌词渲染的视觉模式；lattice 布局不受它影响（墙有自己的歌词画布）。 */
export type FoliaMode = "cadenza" | "cappella" | "claddagh" | "classic" | "fume" | "lumiere" | "monet" | "partita" | "pendolo" | "sonnet" | "still" | "tempera" | "tilt";

interface IslandUiState {
  layout: IslandLayout;
  mode: FoliaMode;
  queue: SongResult[];
  /** R130：宿主那份收藏态的镜像（岛不持有数据，只有一份用来重渲染的读数）。 */
  songLiked: boolean;
  /** R162：宿主喂给音乐人网格的那一份描述符（null = 还没喂到，网格画它自己的载入态）。 */
  artistFeed: ArtistGridFeed | null;
  /**
   * R203（壁纸 surface M0）：宿主那份"播放器外壳在不在场"的读数，喂给移植件既有的
   * `isPlayerChromeHidden` 这一格（**不新造 prop、不新造算式**：上游同族 surface 传的正是 `true`，
   * 见 `references/folia-major/src/components/obs/ObsBrowserSourceApp.tsx:216`）。
   * 缺省 false ⇒ 主窗口里表现与今天逐字节一致；只有 `?wallpaper=1` 那档会由宿主推 true。
   */
  chromeHidden: boolean;
  /**
   * R173（Q51）：宿主那份"每档可调参数"的镜像。岛不持有设置、不写盘，只拿一份用来重渲染的读数，
   * 键就是模式 id（`lumiere` / `monet` / …）——与 `tuningRegistry` 里那份 bundle 同一个形状，
   * 由 `applyVisualizerTuning` 在渲染器边界注入到 props 上。上游那条通道本来就是这样，
   * 缺的只是"宿主有没有喂它"（R128/R131/R165 那一族：接口的存在不等于接口被用）。
   */
  tunings: VisualizerTuningBundle;
}

/** 岛内的视图态（布局 + 视觉模式 + 队列 + 收藏读数 + 网格喂料）。队列不进 folia store：上游 store 本来也不管队列。 */
const useIslandUi = create<IslandUiState>(() => ({
  layout: "classic",
  mode: "classic",
  queue: [],
  songLiked: false,
  artistFeed: null,
  chromeHidden: false,
  tunings: {},
}));

const AdapterContext = React.createContext<FoliaAdapter | null>(null);

/**
 * 封面墙样式表读上游主题变量名（--bg-color / --text-*）；宿主权威令牌叫 --page-bg / --ink 等，
 * 派生色叫 --folia-*（挂在 #lyric-stage 上，岛容器取不到）。这里把已算好的主题写回岛容器，
 * 不改移植的 CSS，也不污染全局样式表。
 *
 * R51（第三期）：同时把岛容器底色改成主题的歌词底色（`--folia-back`）。原先 CSS 里写死
 * `var(--page-bg)`，而 classic 自己会画一层背景所以看不出来；sonnet 这类**透明背景**的模式
 * 一进来，白字就压在宿主的浅色页面底上（dusk 实测 islandBg rgb(203 214 223) vs 主题底 rgb(54 54 89)）。
 */
function useIslandThemeVars(host: HTMLElement | null) {
  const theme = useHostThemeStore((s) => s.theme);
  useEffect(() => {
    if (!host) return;
    host.style.setProperty("--bg-color", theme.backgroundColor);
    host.style.setProperty("--text-primary", theme.primaryColor);
    host.style.setProperty("--text-secondary", theme.secondaryColor);
    host.style.setProperty("--text-accent", theme.accentColor);
    // R196（Q72 终章）：**不再写岛容器自己的底色**。R51 当年写它是为了让 sonnet 这类"透明背景模式"
    // 不把白字压在宿主的浅色页面底上；用户终审翻掉了那一层——"画面整个铺满屏幕、控件浮在画面上、
    // 不想看到任何分隔带"。所以这一行撤掉，岛底交给 CSS 的 `background: transparent`（`lyric-folia-chrome.css`）。
    // 上面那四个**令牌**照旧写（封面墙的海报配色读的就是 `--bg-color`，它不是"垫层"）。
  }, [host, theme]);
}

function FoliaView() {
  const mode = useIslandUi((s) => s.mode);
  const chromeHidden = useIslandUi((s) => s.chromeHidden);
  const lines = usePlaybackStore((s) => s.lyrics?.lines ?? EMPTY_LINES);
  const currentLineIndex = usePlaybackStore((s) => s.currentLineIndex);
  const song = usePlaybackStore(selectDisplaySong);
  const coverUrl = usePlaybackStore(selectDisplayCoverUrl);
  const theme = useHostThemeStore((s) => s.theme);
  const isDaylight = useHostThemeStore((s) => s.isDaylight);
  const tunings = useIslandUi((s) => s.tunings);
  return (
    <Suspense fallback={null}>
      <VisualizerRenderer
        mode={mode}
        visualizerTunings={tunings}
        // R203：宿主既有的那一格外壳读数（缺省 false = 与今天逐字节一致）。
        isPlayerChromeHidden={chromeHidden}
        // R206 ⑥：「下一句歌词」那一行的发光关掉（只关发光，出现时机/位置/字号/明暗关系一律不动）。
        // 这两格本来就是移植件的形参 ⇒ 宿主传值即可，**没改移植件、没新增白名单条目**；
        // 常量住在 folia-host/subtitle-glow.ts（唯一出处，自检按它跑变异）。
        subtitleUpcomingLyricsBlur={SUBTITLE_UPCOMING_LYRICS_BLUR}
        subtitleOverlayBackground={SUBTITLE_OVERLAY_BACKGROUND}
        currentTime={currentTime}
        currentLineIndex={currentLineIndex}
        lines={lines}
        theme={theme}
        isDaylight={isDaylight}
        audioPower={audioPower}
        audioBands={audioBands}
        songTitle={song?.name ?? null}
        songArtist={song?.artists?.map((a) => a.name).join(" / ") ?? null}
        songAlbum={song?.album?.name ?? null}
        coverUrl={coverUrl ?? null}
      />
    </Suspense>
  );
}

function LatticeView() {
  const adapter = useContext(AdapterContext);
  const lyrics = usePlaybackStore((s) => s.lyrics ?? null);
  const lines = usePlaybackStore((s) => s.lyrics?.lines ?? EMPTY_LINES);
  const currentLineIndex = usePlaybackStore((s) => s.currentLineIndex);
  const playerState = usePlaybackStore(selectDisplayPlayerState);
  const song = usePlaybackStore(selectDisplaySong);
  const duration = usePlaybackStore(selectDisplayDuration);
  const theme = useHostThemeStore((s) => s.theme);
  const isDaylight = useHostThemeStore((s) => s.isDaylight);
  const queue = useIslandUi((s) => s.queue);
  const songLiked = useIslandUi((s) => s.songLiked);
  if (!adapter) return null;
  // R130：`playback.isSongLiked` 要在收藏之后重算 —— 上游 provider 的 memo 依赖 `controls` 这个对象身份，
  // 所以这里换一份新对象。外层用 getter 委托，**不能展开 `latticeControls`**：
  // 展开会把 `loopMode` 那个 getter 摊成一个静态值，岛里的循环指示就再也不动了（R109 刚把它改成 getter）。
  const controls = {
    playback: { ...adapter.latticeControls.playback, isSongLiked: songLiked },
    get loopMode() {
      return adapter.latticeControls.loopMode;
    },
    invokeCommandById: (id: string) => adapter.latticeControls.invokeCommandById(id),
    canInvokeCommandById: (id: string) => adapter.latticeControls.canInvokeCommandById(id),
  };
  return (
    <Suspense fallback={null}>
      <Lattice
        controls={controls}
        lyrics={lyrics}
        lyricSource={{ currentTime, currentLineIndex, lines, theme, paused: playerState === PlayerState.PAUSED }}
        lyricKeywordColoringEnabled={false}
        currentSong={song}
        playerState={playerState}
        currentTime={currentTime}
        playbackDuration={duration}
        canTogglePlayback={Boolean(song)}
        queue={queue}
        isDaylight={isDaylight}
        onBack={() => adapter.requestLayout("classic")}
        onOpenPlayer={() => adapter.requestLayout("classic")}
        onPlaySong={(next) => adapter.playSong(next)}
        onTogglePlayback={() => void adapter.togglePlayback()}
        onSeek={(time) => adapter.seek(time)}
      />
    </Suspense>
  );
}

function ArtistGridHost() {
  const adapter = useContext(AdapterContext);
  const feed = useIslandUi((s) => s.artistFeed);
  const theme = useHostThemeStore((s) => s.theme);
  const isDaylight = useHostThemeStore((s) => s.isDaylight);
  if (!adapter) return null;
  return (
    <Suspense fallback={null}>
      <ArtistGrid
        // 上游这个 prop 是"从首页网格带进来的那张卡"；本产品只有音乐人这一种，
        // id 由宿主描述符给（导航恢复的 sessionStorage 键就落在这格上）。
        collection={{ id: feed?.id ?? "artist", source: "host", name: feed?.name ?? "" }}
        artistFeed={feed}
        theme={theme}
        isDaylight={isDaylight}
        onBack={() => adapter.requestLayout("classic")}
        // 三个动作都只往上送 id：曲库/队列/取数的权威在宿主那一侧（R162）。
        onSelectTrack={(song) => adapter.playArtistGridTrack(String(song.id))}
        // 卡片上那颗「加入播放队列」必须有人接：真机第一遍点它什么也没发生
        // （R121 那一族："这次点击还有没有主人"）。
        onAddTrackToQueue={(song) => adapter.addArtistGridTrackToQueue(String(song.id))}
        onSelectAlbum={(albumId) => adapter.playArtistGridAlbum(String(albumId))}
        onAddAllToQueue={(songs) => {
          adapter.addArtistGridToQueue(songs.map((song) => String(song.id)));
          return songs.length;
        }}
      />
    </Suspense>
  );
}

function IslandRoot() {
  const layout = useIslandUi((s) => s.layout);
  const adapter = useContext(AdapterContext);
  // 主题变量与岛底色对三种布局（classic / 视觉模式 / 封面墙 / 音乐人网格）都要生效，故挂在根上。
  useIslandThemeVars(adapter?.hostElement ?? null);
  if (layout === "lattice") return <LatticeView />;
  if (layout === "artistGrid") return <ArtistGridHost />;
  return <FoliaView />;
}

export interface IslandHandle {
  tick(clock: number): void;
  feedSong(song: SongResult | null, coverUrl: string | null, duration: number): void;
  feedLyrics(data: LyricData | null): void;
  feedTransport(playing: boolean, paused: boolean): void;
  feedQueue(queue: SongResult[]): void;
  /** R162：音乐人网格的数据由宿主喂（岛不取数、不出网、不碰曲库）。 */
  feedArtist(feed: ArtistGridFeed | null): void;
  setLayout(layout: IslandLayout): void;
  /**
   * 岛**当前真的在渲染**哪个布局。看板 c980fa6 嫌疑③（"点了没反应"）的修法和这条有关：
   * 按钮文案原先读宿主偏好、渲染读这份岛存储、点击又按偏好算 next —— 三份里任何两份脱钩，
   * 观感就是"文字变了画面没变"。宿主现在统一只问这里，偏好退回它该待的位置（持久化）。
   */
  getLayout(): IslandLayout;
  setMode(mode: FoliaMode): void;
  /** R130：宿主收藏态变了（切换收藏 / 换歌之后问完服务端）就推一次读数，岛内的按钮据此重渲染。 */
  setSongLiked(liked: boolean): void;
  /**
   * R203（壁纸 surface M0）：宿主推一次"播放器外壳在不在场"的读数（公式只在宿主那一处，见
   * `music-app.ts` 的 `islandChromeHidden`）。这一格喂的是移植件既有的 `isPlayerChromeHidden`，
   * 岛自己**不判断**任何外壳状态。
   */
  setPlayerChromeHidden(hidden: boolean): void;
  /** R173（Q51）：宿主改了某一档的可调参数 ⇒ 推一份新的 bundle 进来（岛不存设置、不落盘）。 */
  setTunings(tunings: VisualizerTuningBundle): void;
  unmount(): void;
}

export interface MountFoliaIslandOptions extends FoliaAdapterOptions {
  /** 岛内（封面墙的返回键等）改布局时回灌宿主，用于持久化偏好与同步按钮态。 */
  onLayoutChange?: (layout: IslandLayout) => void;
  /**
   * R131：岛内「打开命令面板」那颗按钮的落地。上游那块面板没移植（台账 R6/R7），
   * 而写请求的那颗按钮是移植件——它只往 `useAppViewStore.commandPaletteRequest` 里加序号，
   * 全仓没有读者，于是点击静默无果（与 R121「这次点击还有没有主人」同族）。
   * 宿主的面板做出来之后，下面那条订阅就是它唯一的读者。
   * @param commandId 上游按按钮预置的命令 id（队列那颗传 `'queue'`）；本产品表里没有同名命令，
   *                  所以只用来透传，不猜"最接近的那条"。
   */
  onCommandPaletteRequest?: (commandId: string | null) => void;
}

let root: Root | null = null;
let handle: IslandHandle | null = null;
// 缺陷二（拍板 B）：岛内文字的可读性守卫跟着岛一起装卸（R181）。
let textGuard: FoliaTextGuard | null = null;

export function mountFoliaIsland(
  host: HTMLElement,
  options: MountFoliaIslandOptions,
): IslandHandle | null {
  if (handle) return handle;
  const adapter = createFoliaAdapter({
    ...options,
    hostElement: host,
    requestLayout: (layout) => {
      useIslandUi.setState({ layout });
      options.onLayoutChange?.(layout);
    },
  });
  // 请求 store 是模块级的，卸装之后序号还在涨 ⇒ 起点取当前值，重挂不会被一次旧请求误触发。
  let lastSeq = useAppViewStore.getState().commandPaletteRequest.seq;
  const unsubscribePalette = useAppViewStore.subscribe((state) => {
    const request = state.commandPaletteRequest;
    if (request.seq === lastSeq) return;
    lastSeq = request.seq;
    options.onCommandPaletteRequest?.(request.kind === "command" ? request.commandId : null);
  });
  root = createRoot(host);
  root.render(
    <AdapterContext.Provider value={adapter}>
      <IslandRoot />
    </AdapterContext.Provider>,
  );
  // 守卫在岛挂上之后起（它扫的是岛里的 DOM）。**兜底底色的来源**：R196 起岛容器自己透明了
  // （垫层撤掉），所以兜底要读**岛下面那一层**——`#stage` 的页面底（它跟着主题走）。
  // 不这么改的话，`getComputedStyle(host).backgroundColor` 会拿到 `rgba(0,0,0,0)`，
  // 守卫会把"透明"当成黑底来算，同一片字的钳制结论会跟着漂。
  textGuard = createFoliaTextGuard({
    root: host,
    ground: () => {
      const stage = document.querySelector<HTMLElement>("#stage");
      return (stage && getComputedStyle(stage).backgroundColor) || getComputedStyle(host).backgroundColor;
    },
  });
  handle = {
    tick: (clock) => adapter.tick(clock),
    feedSong: (song, coverUrl, duration) => adapter.feedSong(song, coverUrl, duration),
    feedLyrics: (data) => adapter.feedLyrics(data),
    feedTransport: (playing, paused) => adapter.feedTransport(playing, paused),
    feedQueue: (queue) => useIslandUi.setState({ queue }),
    // R162：宿主算好一份描述符再喂（对象身份即"重算一次"的信号，见 ArtistGridFeed 的注释）。
    feedArtist: (artistFeed) => useIslandUi.setState({ artistFeed }),
    setLayout: (layout) => {
      useIslandUi.setState({ layout });
      options.onLayoutChange?.(layout);
    },
    getLayout: () => useIslandUi.getState().layout,
    setMode: (mode) => useIslandUi.setState({ mode }),
    setSongLiked: (songLiked) => useIslandUi.setState({ songLiked }),
    setPlayerChromeHidden: (chromeHidden) => useIslandUi.setState({ chromeHidden }),
    setTunings: (tunings) => useIslandUi.setState({ tunings }),
    unmount: () => {
      unsubscribePalette();
      textGuard?.stop();
      textGuard = null;
      root?.unmount();
      root = null;
      handle = null;
      useIslandUi.setState({ layout: "classic", mode: "classic", queue: [], songLiked: false, artistFeed: null, chromeHidden: false, tunings: {} });
      adapter.reset();
    },
  };
  return handle;
}

export function unmountFoliaIsland(): void {
  handle?.unmount();
}
