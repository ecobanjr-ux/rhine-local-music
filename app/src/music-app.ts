import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import "./document-decryption.css";
import "./decryption.css";
import "./music.css";
import "./music-navigation-motion.css";
import "./music-navigation-ruler.css";
import "./music-transport-title.css";
import "./music-theme.css";
import "./music-theme-switch.css";
import "./lyric-stage.css";
import "./lyric-folia-chrome.css";
import { DocumentDecryption } from "./document-decryption";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import { ArchiveScene } from "./scene";
import {
  records,
  archiveColumns,
  archiveColumnKeys,
  columnFiles,
  fileLocation,
  setMusicAlbums,
  orderMusicAlbums,
  PLAYLIST_GROUP_ID,
  playlistAlbumId,
  playlistSlugOf,
  ONLINE_ARTIST_GROUP_ID,
  artistAlbumId,
  artistSlugOf,
  shelfClearance,
  type MusicShelfLayout,
  type MusicSortMode,
} from "./data";
import { wrap, type ArchiveNavigation } from "./archive-loop";
import {
  normalizeQuality,
  qualityPresets,
  type QualityPreset,
  type RenderQuality,
} from "./render-quality";
import { MusicPlayer, PLAYBACK_MODES, type MusicPlaybackMode, type MusicPlayerState } from "./music-player";
import { setupMediaSession } from "./media-session";
// R212：登录面板的"刷新窗口"（低频心跳）—— 纯逻辑模块，只读本地自省快照；见下面 authHeartbeat 的注释。
import { createAuthHeartbeat } from "./auth-heartbeat";
// R217：「已登录」徽标的三档判定（本地有凭据 ≠ 上游认账）—— 纯逻辑模块，判据与文案都在那里，见文件头。
import {
  applyAuthAccountState,
  classifyAuthAccount,
  showsRescan,
  type AuthAccountCacheEntry,
} from "./auth-badge";
// R203（壁纸 surface M0）：surface 判定只有这一个出处（`utils/appSurface.ts` 里"读同一份答案、
// 不重解析 URL"那条上游规矩）。宿主再写一次 `location.search` 就是第二个真相，Task 1 判据①会红。
import { isWallpaperSurface } from "./folia/utils/appSurface";
// R203（Task 3）：三路退出（`Esc` / 双击 / 角落热点）共用这一块的同一个 `exit()`；
// 退出落点也在那里算，所以宿主一行 URL 读取都不必出现。
import { createSurfaceExit } from "./folia-host/surface-exit";
import { createImmersiveToggle, documentFullscreenAdapter, IMMERSIVE_SURFACE_VALUE } from "./folia-host/immersive";
import { createLyricStage, resolveDisplayMode, resolveLyricIntensity, type DisplayMode, type LyricIntensity } from "./lyric-stage";
import type { LyricPulseTier } from "./lyric-pulse.ts";
import type { FoliaMode, IslandHandle, IslandLayout } from "./folia-host/island";
// R173（Q51）：岛内模式的参数面板由这块挂进宿主设置面板；岛不存设置，值与落盘都在这边。
// 它里面是 React 组件 + 移植件，所以**必须动态 import**（静态会把整棵 React 树拉进主入口 chunk，
// 那条"岛懒加载"的判据就是拦这个的）。类型走 import type（编译期擦除，不留运行时边）。
import type { ModeSettingsOptions } from "./folia-host/mode-settings";
type ModeSettingsModule = typeof import("./folia-host/mode-settings");
let modeSettingsModule: Promise<ModeSettingsModule> | null = null;
const loadModeSettings = (): Promise<ModeSettingsModule> =>
  (modeSettingsModule ??= import("./folia-host/mode-settings"));
import { installHostThemeBridge, useHostThemeStore } from "./folia-host/theme-bridge";
import { createFoliaFeedGate } from "./folia-host/feed-gate";
// R202：歌词面 / 封面墙的"背景模糊层"（宿主侧，画面之下的一层）。参数与缺省在 backdrop-defaults（纯函数）。
import { createFoliaBackdrop, type FoliaBackdropHandle } from "./folia-host/backdrop";
import { resolveBackdrop, type BackdropOverride, type BackdropSource } from "./folia-host/backdrop-defaults";
// R175：`preferences.foliaTunings` 存的是"用户真正改过的格"（补丁），喂给面板与岛之前要合成完整读数。
// 这份表只 import 移植件 types.ts 里那些 `DEFAULT_*_TUNING` 常量（那边全是 type-only import，零运行时边）。
import { FOLIA_TUNING_DEFAULTS, resolveFoliaTuningForTheme } from "./folia-host/tuning-defaults";
// R179（缺陷一）：岛的顶部安全区 = 宿主顶部导航带的下沿，运行时量出来写成一个 CSS 变量。
import { FOLIA_SAFE_TOP_VAR, computeFoliaSafeTop } from "./folia-host/safe-area";
import { createCommandPalette, type Command } from "./command-palette";
import type { LyricData, SongResult } from "./folia/types";
import { createIdleReveal } from "./idle-reveal.ts";
import { createLyricsClient, ONLINE_PROVIDER_LABELS, type OnlineMatchOutcome, type OnlineNearCandidate } from "./lyrics-client";
import { lyricMatchMarkup } from "./lyric-match-ui";
// R162（任务九）：音乐人网格的数据层（自撰薄层，与移植件 ArtistGridView 对接）。
import { buildArtistGridModel, type ArtistGridModel } from "./artist-grid";
import type { ArtistGridFeed } from "./folia/types";
import {
  accountPlaylistMarkup,
  ACCOUNT_PLAYLIST_PROVIDERS,
  addToPlaylistMarkup,
  artistMarkup,
  detailMarkup,
  exportFileName,
  listMarkup,
  pickBannerMarkup,
  pickRowMarkup,
  type AccountPlaylistAddable,
  type AccountPlaylistRow,
  type PlaylistDetail,
  type PlaylistImportResult,
  type PlaylistPickTarget,
  type PlaylistSummary,
} from "./playlists-ui.ts";
import {
  favoritesMarkup,
  type FavoriteRow,
  type FavoritesView,
} from "./favorites-ui.ts";
import {
  ONLINE_PROVIDER_NAMES,
  formatDuration,
  perSourceSummary,
  playOnlineTrack,
  playlistQueue,
  requestOnlineSearch,
  toMusicTrack,
  type OnlineSearchItem,
  type OnlineSearchResponse,
} from "./online-search.ts";
import { ModelViewer } from "./model-viewer";
import { TerminalAudio } from "./audio";
import type {
  MusicAlbum,
  MusicGenre,
  MusicLibrary,
  MusicOnlineArtistDetail,
  MusicOnlineArtistShelfRow,
  MusicPlaylistShelf,
  MusicPlaylistShelfRow,
  MusicTrack,
  GenreRules,
} from "./music-types";
import { demoAlbums, demoGenres } from "./demo-library";
import { coverImage, escapeHtml as esc } from "./html";
import { albumTitleMarkup, setupMusicTitleLayout } from "./music-title";
import { setupMusicTextMotion } from "./music-text-motion";
import { setupTransportTitle } from "./music-transport-title";
import { setupMusicTicks } from "./music-ticks";
import { setupMusicRuler } from "./music-ruler";
import { MusicPresentation, type AlbumSelection } from "./music-presentation";
import { MusicTrackFocus } from "./music-track-focus";
import { MusicBoot } from "./music-boot";
import { viewportLayout } from "./viewport-layout";
import { topbarTier } from "./topbar-tiers";
// R162：本地音乐人分组必须与架子 `artist` 档用同一个规范化键（第二个真相迟早和架子对不上账）。
import { musicArtistKey } from "./music-order";

const THEMES = ["day", "dusk", "night"] as const;
type Theme = (typeof THEMES)[number];
type Panel = "library" | "search" | "settings" | "playlists" | "playlist" | "artist" | "favorites" | "lyrics" | null;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  play: svg('<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>'),
  pause: svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
  search: svg(
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  ),
  settings: svg(
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="var(--surface)"/><circle cx="15" cy="17" r="2.5" fill="var(--surface)"/>',
  ),
  folder: svg('<path d="M3 7V5h6l2 2h10v13H3Z"/>'),
  prev: svg(
    '<path d="M17 6v12L8.5 12Z" fill="currentColor" stroke="none"/><path d="M6.5 6v12"/>',
  ),
  next: svg(
    '<path d="M7 6v12l8.5-6Z" fill="currentColor" stroke="none"/><path d="M17.5 6v12"/>',
  ),
  // R130 收藏：描线心（未收藏）与实心（已收藏）共用这一个形状，靠 `data-liked` 决定填不填。
  heart: svg(
    '<path d="M12 20.2S4.6 15.6 4.6 10.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.4 3c0 5-7.4 9.6-7.4 9.6Z"/>',
  ),
};
const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
const preferences = {
  ...{
    theme: "day" as Theme,
    sortMode: "genre" as MusicSortMode,
    // 6.6：分组轴。刻意不给字面默认值——老偏好里没有这一项时要由 sortMode 推导，
    // 保证"升级当天铺列方式一模一样"（给 "genre" 会让原本按歌手铺列的用户当场换列布局）。
    shelfLayout: undefined as MusicShelfLayout | undefined,
    quality: "original" as QualityPreset,
    reduced: false,
    volume: 0.65,
    songFade: true,
    bgm: true,
    bgmVolume: 0.18,
    sound: true,
    soundVolume: 0.22,
    displayMode: "rhine" as DisplayMode,
    lyricPulse: "basic" as LyricPulseTier,
    lyricIntensity: "normal" as LyricIntensity,
    // R109：播放模式。缺省 sequential = 今天的行为（队列播完就停），升级当天零观感变化。
    playbackMode: "sequential" as MusicPlaybackMode,
    // R160（任务七）：音频输出设备。**空串 = 跟随系统默认**（缺省 = 行为逐字不变）。
    // 这里只存 id 不存名字：名字是浏览器给的、随时会变（换耳机、拔插），名字由列表当场现算。
    outputDevice: "",
    foliaView: "classic" as IslandLayout,
    foliaMode: "classic" as FoliaMode,
    renderQuality: undefined as RenderQuality | undefined,
    /** R173（Q51）：每档可视化的可调参数，键 = 模式 id。缺省空对象 = 全吃上游默认值。 */
    foliaTunings: {} as Record<string, Record<string, unknown>>,
    /** R202：歌词面 / 封面墙的背景模糊层。缺省空对象 = 全吃主题缺省（day 浅、night 深）。 */
    backdrop: {} as BackdropOverride,
  },
  ...read<
    Partial<{
      theme: Theme;
      sortMode: MusicSortMode;
      shelfLayout: MusicShelfLayout;
      quality: QualityPreset;
      reduced: boolean;
      volume: number;
      songFade: boolean;
      bgm: boolean;
      bgmVolume: number;
      sound: boolean;
      soundVolume: number;
      displayMode: DisplayMode;
      lyricPulse: LyricPulseTier;
      lyricIntensity: LyricIntensity;
      playbackMode: MusicPlaybackMode;
      foliaView: IslandLayout;
      foliaMode: FoliaMode;
      renderQuality: RenderQuality;
      foliaTunings: Record<string, Record<string, unknown>>;
      backdrop: BackdropOverride;
    }>
  >("rhine-music-preferences", {}),
};
let renderQuality = normalizeQuality(
  preferences.renderQuality || qualityPresets[preferences.quality],
);
if (!THEMES.includes(preferences.theme)) {
  preferences.theme = "day";
  save("rhine-music-preferences", preferences);
}
if (!Object.hasOwn(qualityPresets, preferences.quality))
  preferences.quality = "original";
if (!["genre", "artist", "album"].includes(preferences.sortMode))
  preferences.sortMode = "genre";
// 6.6：分组轴缺省或非法 ⇒ 由排序轴推导（= 拆分前的行为），所以老偏好升级零观感变化。
// 归一化写成函数并返回非可选值：偏好对象里那一项的类型是 `MusicShelfLayout | undefined`
// （"没存过"与"存了 genre"必须可区分），而下面所有取标签的地方都需要确定值。
const SHELF_LAYOUTS: MusicShelfLayout[] = ["genre", "artist", "album"];
function normalizeShelfLayout(): MusicShelfLayout {
  const stored = preferences.shelfLayout;
  const resolved = stored && SHELF_LAYOUTS.includes(stored) ? stored : preferences.sortMode;
  preferences.shelfLayout = resolved;
  return resolved;
}
const shelfLayoutPreference = normalizeShelfLayout();
if (!["rhine", "folia"].includes(preferences.displayMode))
  preferences.displayMode = "rhine";
/**
 * 「无歌词动画」的四档（R133）：这一张表是设置面板的选项、偏好的合法集、变更时的判据**共用的唯一出处**
 * ——三处各写一份字符串数组的话，加一档一定会漏掉一处（漏掉的那处会把用户存的合法值当成非法值重置掉）。
 */
const LYRIC_PULSE_TIERS: readonly LyricPulseTier[] = ["off", "basic", "audio", "spectrum"];
if (!LYRIC_PULSE_TIERS.includes(preferences.lyricPulse))
  preferences.lyricPulse = "basic";
preferences.lyricIntensity = resolveLyricIntensity(preferences.lyricIntensity);
// R109：播放模式的非法值回落"顺序播放"——磁盘上写着没人认识的模式时，不该把用户停在随机里出不来。
// 按钮的**循环顺序**用内核那份 `PLAYBACK_MODES`（传输区与岛内是同一个动作的两个入口，顺序表不许有两份）。
const PLAYBACK_MODE_NAMES: Record<MusicPlaybackMode, { name: string; short: string }> = {
  sequential: { name: "顺序播放", short: "顺序" },
  "repeat-all": { name: "列表循环", short: "循环" },
  "repeat-one": { name: "单曲循环", short: "单曲" },
  shuffle: { name: "随机播放", short: "随机" },
};
if (!PLAYBACK_MODES.includes(preferences.playbackMode))
  preferences.playbackMode = "sequential";
// Folia 内的布局偏好（歌词面 / 封面墙）：非法值一律回落歌词面。
if (!["classic", "lattice"].includes(preferences.foliaView))
  preferences.foliaView = "classic";
// R47（第三期）：视觉模式偏好，非法值回落 classic（未注册的模式由 registry 兜底再回落一次）。
if (!["cadenza", "cappella", "claddagh", "classic", "fume", "lumiere", "monet", "partita", "pendolo", "sonnet", "still", "tempera", "tilt"].includes(preferences.foliaMode))
  preferences.foliaMode = "classic";
// displayMode only ever affects the playback (detail) view; browse stays Rhine.
// R203（壁纸 surface M0）：这一档的画面就是岛 ⇒ `data-display` 必须是 folia（R200"岛视图内容层恒铺满"、
// R117 进度行让位、R195 顶部去底、R202 模糊层显形那一整组规则都挂在这个属性上，见 run log §0.4）。
// **只改前端这一格的初值、不碰 preferences**：surface 不写用户设置，主窗口选的档下次进 surface 仍算数。
let displayMode: DisplayMode = isWallpaperSurface
  ? "folia"
  : resolveDisplayMode(preferences.displayMode);
const modeNames: Record<DisplayMode, string> = { rhine: "演出", folia: "歌词" };
/** R47（第三期）：岛内歌词的视觉模式；sonnet/tempera 在 T3/T4 注册后才可选，先只放已注册的。 */
const FOLIA_MODES: { id: FoliaMode; name: string; hint: string }[] = [
  { id: "cadenza", name: "心象", hint: "整行预先分段并镜像到 DOM 与画布，带光束与辉光的重排布" },
  { id: "cappella", name: "群唱", hint: "歌词化成聊天气泡左右往返，配头像与表情，像一场对唱" },
  { id: "claddagh", name: "回环", hint: "歌词沿倾斜圆环轨道循环推进，大小对比拉开纵深" },
  { id: "classic", name: "经典", hint: "逐词淡入排布（第一期移植的默认视图）" },
  { id: "fume", name: "浮名", hint: "满屏歌词层层堆叠，镜头追着当前句推移，虚实之间浮沉" },
  { id: "lumiere", name: "绘光", hint: "光场、烟雾与线稿的 3D 光效歌词" },
  { id: "monet", name: "莫奈", hint: "海报式版面：左侧歌词轨、右侧肖像、底部频谱" },
  { id: "partita", name: "云阶", hint: "逐词按语义块排布、交错入场（stagger），可画参考线" },
  { id: "pendolo", name: "时计", hint: "封面嵌进钟表盘，歌词沿弧线随擒纵一格格推过" },
  { id: "sonnet", name: "十四行", hint: "多层印刷式分镜与转场的 pixi 歌词" },
  { id: "still", name: "静止", hint: "歌词停在画面中央，不做动画也不画背景，最省资源" },
  { id: "tempera", name: "蛋彩", hint: "色块构图与镜头切换的 pixi 歌词" },
  { id: "tilt", name: "倾诉", hint: "长句自动断行、随机斜体强调，像有人凑近低声说话" },
];
const intensityNames: Record<LyricIntensity, string> = {
  calm: "克制", normal: "标准", chaotic: "外放",
};
const lyricPulseLabels: Record<LyricPulseTier, string> = {
  off: "关闭（静止音符）",
  basic: "基础（循环跳动）",
  audio: "跟随音频（音符吃电平）",
  spectrum: "频谱条（16 根半倍频程）",
};
/**
 * 每一档一句实话。最后那句是**现状说明**：本产品的"沉浸式音频反应画面"确实存在，
 * 但不在这一档里——它是歌词面的视觉模式 `lumiere`（本来就吃音频功率与频段），
 * 频谱条这一档补的是"没有歌词时画面也别是死的"，不是要重做一遍 lumiere。
 */
const lyricPulseHints: Record<LyricPulseTier, string> = {
  off: "纯音乐曲目在歌词视图里只显示一排静止的音符。",
  basic: "音符按固定节拍循环跳动，不读取音频，兼容性最好。",
  audio: "音符由播放元素的真实电平驱动；读不到电平或被浏览器策略挡下时自动降回基础档。",
  spectrum: "16 根条各跟一条半倍频程频段，与音符档共用同一张 analyser 与同一套 dB 映射；"
    + "读不到电平或被浏览器策略挡下时同样降回基础档。"
    + "想要整幅画面跟着声音呼吸（而不只是底下一排条），把歌词面的视觉模式切到 lumiere——它本来就吃音频，这一档不动它。",
};
const sortLabels: Record<MusicSortMode, { name: string; column: string; code: string }> = {
  genre: { name: "按流派", column: "流派", code: "GENRE" },
  artist: { name: "按歌手名字", column: "歌手", code: "ARTIST" },
  album: { name: "按专辑名字", column: "分组", code: "ALBUMS" },
};
/**
 * 6.6 两轴拆分：chrome 里"列"的名词、列计数前缀与快捷键说明都跟着**分组轴**走
 * （拆分前它们读的是 sortMode，于是"按标题排序 + 按歌手分组"会显示成"左右切分组"）。
 * rows = 列内一行是什么；album 分组下一行是一首曲目，这是本期唯一一处按键语义随分组变化。
 */
const shelfLabels: Record<MusicShelfLayout, { name: string; column: string; rows: string; code: string; hint: string }> = {
  genre: { name: "按流派", column: "流派", rows: "专辑", code: "GENRE", hint: "每列一个流派，列内是该流派的专辑。" },
  artist: { name: "按音乐人", column: "歌手", rows: "专辑", code: "ARTIST", hint: "每列一位歌手，列内是她／他们的专辑。" },
  album: {
    name: "按专辑",
    column: "专辑",
    rows: "曲目",
    code: "ALBUMS",
    hint: "每列一张专辑，列内是它的曲目：上下键在专辑内走曲目，左右键走下一张专辑。",
  },
};
const shelfLabel = shelfLabels[shelfLayoutPreference];
let libraryReceived = false,
  scanSubmitting = false;
let scanRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let library: MusicLibrary = {
  version: 1,
  albums: [],
  genres: [],
  roots: [],
  scan: { running: false },
  onlineEnabled: true,
  onlineLyrics: { enabled: true },
};
let albums: MusicAlbum[] = [],
  genres: MusicGenre[] = [],
  demo = false,
  selected = 0;
let mode: "archive" | "detail" = "archive",
  activeTab: "tracks" | "about" = "tracks",
  panel: Panel = null;
let scene: ArchiveScene | undefined,
  ready = false,
  apiAvailable = true,
  refreshing = false;
let introductionsStarting = false,
  libraryStateVersion = 0,
  introductionRequestError = "";
let viewer: ModelViewer | undefined;
let boot: MusicBoot | undefined;
const effects = new TerminalAudio();
effects.configure({
  sound: preferences.sound,
  music: false,
  soundVolume: preferences.soundVolume,
  musicVolume: 0,
});
document.addEventListener("pointerdown", () => void effects.unlock(), {
  once: true,
});
document.addEventListener("keydown", () => void effects.unlock(), {
  once: true,
});
let toastTimer: ReturnType<typeof setTimeout>,
  pollTimer: ReturnType<typeof setTimeout> | undefined;
let columnMemory = new Map<string, string>();
let playerState: MusicPlayerState;
const player = new MusicPlayer({
  volume: preferences.volume,
  songFadeEnabled: preferences.songFade,
  bgmEnabled: preferences.bgm,
  bgmVolume: preferences.bgmVolume,
  playbackMode: preferences.playbackMode,
});
setupMediaSession(player, (albumId) => {
  const album = albums.find((entry) => entry.id === albumId);
  return album ? { title: album.title, coverUrl: album.coverUrl } : undefined;
});
const themeNames: Record<Theme, string> = {
  day: "暖昼",
  dusk: "黄昏",
  night: "深夜",
};
/** meta theme-color：day/dusk 取各自 --page-bg，night 沿用底座既有值（与 --page-bg 有意不同）。 */
const themeColors: Record<Theme, string> = {
  day: "#e8e5e1",
  dusk: "#cbd6df",
  night: "#0a1220",
};
const themeHints: Record<Theme, string> = {
  day: "暖白玻璃与日光",
  dusk: "薄暮冷灰与暖调聚光",
  night: "极简星空与透光白卡",
};
const stage = $("#stage");
const setMetaThemeColor = (theme: Theme) =>
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColors[theme]);
stage.className = "music-app";
stage.dataset.mode = "archive";
// R203（壁纸 surface M0）：判定落到 DOM 属性上，与 `data-mode` / `data-display` / `data-folia-view`
// 同一处置（R63 / R184 的理由：只有落到属性上，规则才不是"读某处变量"的第二份真相 ⇒ CSS 只问这一格）。
// **只在 true 时写**：不带参数时这个属性缺席，默认态的 DOM 结构与今天逐字节一致（Task 2 判据②）。
if (isWallpaperSurface) stage.dataset.surface = "wallpaper";
// R184：当前视觉模式落到 DOM 属性上，CSS 才能按档做"放开安全区"这一类特例
//（与 data-folia-layout 同一处置：只有落到属性上，规则才不是"读某处变量"的第二份真相）。
stage.dataset.foliaMode = preferences.foliaMode;
stage.dataset.theme = preferences.theme;
setMetaThemeColor(preferences.theme);
stage.innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="music-vignette" aria-hidden="true"></div>
  <header class="music-header">
    <div class="music-identity"><a class="music-brand" href="/" aria-label="Rhine Music 音乐库"><strong>RHINE LAB</strong><span>MUSIC ARCHIVE <i>／</i> 私人音乐终端</span></a></div>
    <nav class="music-topnav" aria-label="音乐终端导航">
      <button data-action="library" aria-label="音乐库">${icons.folder}<span>音乐库</span></button>
      <button data-action="search" aria-label="搜索">${icons.search}<span>搜索</span></button>
      <button data-action="playlists" aria-label="歌单">${icons.folder}<span>歌单</span></button>
      <button data-action="favorites" aria-label="收藏">${icons.heart}<span>收藏</span></button>
      <div class="theme-switch" aria-label="主题">${THEMES.map((t) => `<button data-theme="${t}" aria-label="${themeNames[t]}主题" aria-pressed="${preferences.theme === t}"><i class="theme-dot ${t}"></i><span>${themeNames[t]}</span></button>`).join("")}</div>
      <div class="mode-switch" aria-label="播放视图模式">${(["rhine", "folia"] as DisplayMode[]).map((entry) => `<button data-action="mode-${entry}" aria-label="${modeNames[entry]}模式" aria-pressed="${displayMode === entry}"><span>${modeNames[entry]}</span></button>`).join("")}</div>
      <button data-action="settings" class="icon-button" aria-label="播放与画质设置">${icons.settings}</button>
      <div class="minimal-transport" role="group" aria-label="音乐播放"><button type="button" data-action="locate-playing" id="transport-track" class="transport-track" aria-label="定位当前歌曲" aria-hidden="true" disabled><span id="transport-track-label"></span></button><button data-action="track-prev" id="track-prev" class="icon-button" aria-label="上一首" disabled>${icons.prev}</button><button data-action="play-pause" id="play-pause" aria-label="播放" aria-pressed="false"><span class="transport-glyph transport-play" aria-hidden="true">${icons.play}</span><span class="transport-glyph transport-pause" aria-hidden="true">${icons.pause}</span></button><button data-action="track-next" id="track-next" class="icon-button" aria-label="下一首" disabled>${icons.next}</button><button data-action="stop" id="stop-playback" aria-label="停止">${icons.stop}</button><button type="button" data-action="favorite-toggle" id="favorite-toggle" class="icon-button transport-favorite" aria-label="收藏" aria-pressed="false" disabled>${icons.heart}</button><button type="button" data-action="playback-mode" id="playback-mode" class="transport-mode" aria-label="播放模式">${PLAYBACK_MODE_NAMES[preferences.playbackMode].short}</button><span class="playback-scope" data-role="playback-scope" hidden></span></div>
    </nav>
  </header>
  <div id="library-status" class="library-status"><i></i><span>正在读取本地音乐索引</span></div>
  <section id="music-browse" class="music-browse" aria-label="专辑浏览">
    <div class="music-browse-veil" aria-hidden="true"></div>
    <div class="album-callout"><p class="music-eyebrow">MUSIC ARCHIVE <span>／</span> <span id="selection-genre"></span></p>
      <div class="selection-rule"><span id="selection-code">ALBUM <span id="selection-code-number">001</span></span><span id="selection-format"></span></div>
      <h1 id="selection-title"></h1><p id="selection-artist" class="selection-artist"></p>
      <div class="selection-meta" id="selection-meta"></div>
      <button class="open-album" data-action="open">打开专辑 <span>↗</span></button>
    </div>
    <div class="music-navigation">
      <div class="music-counter"><span class="music-eyebrow">ALBUM / SELECT</span><div><b id="selection-number">01</b><span>/ <i id="selection-total">00</i></span></div></div>
      <div class="album-stepper"><button data-action="prev" aria-label="上一个专辑">↑</button><div id="album-ticks"></div><button data-action="next" aria-label="下一个专辑">↓</button></div>
      <div class="genre-stepper"><button data-action="genre-prev" aria-label="上一个${shelfLabel.column}">←</button><div><small id="genre-position">${shelfLabel.code} <span id="genre-index">01</span> / <span id="genre-total">00</span></small><button data-action="genres" id="genre-name"></button></div><button data-action="genre-next" aria-label="下一个${shelfLabel.column}">→</button></div>
    </div>
    <div class="music-keyhint">← → ${shelfLabel.column} <span>／</span> ↑ ↓ ${shelfLabel.rows} <span>／</span> ENTER 打开专辑</div>
  </section>
  <section id="music-detail" class="music-detail" aria-label="专辑详情" hidden>
    <button class="music-back" data-action="back">← 返回专辑架 <kbd>ESC</kbd></button>
    <div class="card-caption"><span id="detail-card-id"></span><small>拖动卡片，查看完整封面</small></div>
    <article id="album-detail-content" tabindex="-1"></article>
  </section>
  <section id="lyric-stage" class="lyric-stage" aria-label="歌词" hidden></section>
  <section id="folia-island" class="folia-island" hidden></section>
  <div id="music-empty" class="music-empty" hidden><small>YOUR PRIVATE COLLECTION</small><h1>让音乐进入这座档案馆。</h1><p>选择本地音乐文件夹，专辑封面会出现在每一张卡片上。</p><button data-action="library">设置音乐文件夹 ↗</button><button data-action="demo" class="subtle">先查看演示封面</button></div>
  <div class="music-progress" role="group" aria-label="播放进度"><span id="progress-current">0:00</span><input id="progress-slider" data-seek type="range" min="0" max="0" step="0.5" value="0" aria-label="拖动调整播放进度" disabled><span id="progress-total">0:00</span></div>
  <div class="music-bottomline"><span>LOCAL COLLECTION <i>·</i> <span id="library-count">0 ALBUMS</span></span><span id="runtime-info">THREE.JS / LOCAL</span></div>
  <div id="music-panel-root"></div><div id="music-toast" role="status" aria-live="polite"></div>
  <div id="music-loading"><span class="loading-orbit"></span><strong>OPENING THE ARCHIVE</strong><small>正在载入三维专辑架</small></div>
`;
const titleMotion = setupMusicTitleLayout(stage);
const textMotion = setupMusicTextMotion(stage);
// Keep the previous navigation available while the ruler version is on trial.
const tickMotion = new URLSearchParams(location.search).get("nav") === "previous"
  ? setupMusicTicks($("#album-ticks"))
  : setupMusicRuler($("#album-ticks"));
let selectionInitialized = false;
const selectionMotionEnabled = () =>
  ready &&
  !boot?.active &&
  mode === "archive" &&
  !$("#music-browse").hidden &&
  !preferences.reduced;
function syncSelectionMotion() {
  // Build static reels during the hidden camera movement, before the text fades in.
  const enabled = selectionMotionEnabled() ||
    (mode === "archive" && !!albums.length && !preferences.reduced);
  textMotion.setEnabled(enabled);
  if (!enabled) titleMotion.finish();
  else {
    const album = currentAlbum();
    if (album) titleMotion.update(album.title, true);
  }
}

function notify(message: string) {
  $("#music-toast").textContent = message;
  $("#music-toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => $("#music-toast").classList.remove("visible"),
    5500,
  );
}
function time(value: number) {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function genreName(id: string) {
  return genres.find((g) => g.id === id)?.name || "未分类";
}
function currentAlbum() {
  const record = records[selected];
  if (!record) return undefined;
  // 6.6「按专辑」：一行是一首曲目，record.id 形如 `专辑id#曲目id`，直接拿它比专辑 id 永远找不到 ——
  // 于是整个文字层（标题/艺术家/格式/详情卡号）停止更新，而三维还在动，只看画面很容易以为一切正常。
  // 仍以 albums 里的活对象为准（元数据刷新要能反映出来），行内引用只作兜底。
  if (record.album) {
    const albumId = record.album.id;
    return albums.find((a) => a.id === albumId) ?? record.album;
  }
  return albums.find((a) => a.id === record.id);
}
function formatList(a: MusicAlbum) {
  return (
    [
      ...new Set(
        a.tracks.map((t) => (t.codec ? `${t.format} / ${t.codec}` : t.format)),
      ),
    ].join(" · ") || (demo ? "封面演示" : "未提供")
  );
}
function albumDuration(a: MusicAlbum) {
  return a.tracks.reduce((sum, t) => sum + t.duration, 0);
}
function valueRange(
  values: (number | undefined)[],
  format: (n: number) => string,
) {
  const n = [
    ...new Set(values.filter((v): v is number => !!v && Number.isFinite(v))),
  ].sort((a, b) => a - b);
  return n.length
    ? n.length === 1
      ? format(n[0])
      : `${format(n[0])}–${format(n[n.length - 1])}`
    : "未提供";
}
function cover(a: MusicAlbum, className = "") {
  // 判据只有一处：有同源地址就画，没有就画占位。在线曲目的封面走同一个助手（看板 ⑨ 追加）。
  return coverImage(a.coverUrl ?? "", `${a.title}专辑封面`, className);
}
const documentDecryption = new DocumentDecryption(
  "h1, .detail-artist, .album-facts span, .track-name strong, .album-about p",
  0.35,
);
const tabTransition = new ContentTransition();
const detailTransition = new SurfaceTransition(
  $("#music-detail"),
  $("#album-detail-content"),
  360,
  240,
  "right",
);
const browseTransition = new SurfaceTransition(
  $("#music-browse"),
  undefined,
  // Keep the existing reveal timing, but fade each overlay in its own layer.
  // Fading the parent traps its text below the night vignette until opacity=1.
  720,
  140,
  "up",
  "cubic-bezier(0.45, 0, 0.25, 1)",
  [$(".music-browse-veil"), $(".album-callout"), $(".music-navigation"), $(".music-keyhint")],
);
let detailIdentity = "",
  pendingDetailFocus = false;
const trackFocus = new MusicTrackFocus();
let pendingTrackReveal: { albumId: string; trackId: string } | undefined;
/**
 * 6.6「按专辑」：打开详情时要揭示哪一首。这里只放一个"武装"标记，真正的 pendingTrackReveal
 * 等 `#music-detail[data-transition=open]` 之后再登记 —— 因为 presentation.open() 内部会走一次
 * select()，而 select 对"非 archive 路由"一律 cancelTrackReveal()，先登记的 reveal 会被当场抹掉
 * （实测：先登记时详情打开后没有任何一行被点亮）。
 */
let detailRevealArmed = false;
function cancelTrackReveal() {
  pendingTrackReveal = undefined;
  trackFocus.cancel();
}
// The pane is interactive while its entrance is finishing. Cancel a queued
// reveal too, so a click/scroll in that interval is never pulled back later.
for (const event of ["wheel", "pointerdown", "touchstart", "keydown"] as const) {
  $("#album-detail-content").addEventListener(event, () => {
    if (pendingTrackReveal) cancelTrackReveal();
  }, { passive: true });
}
let libraryRebuilding = false;
type LibraryIntent = AlbumSelection & { openAfter: boolean } |
  { mode: "archive" | "detail" };
let libraryIntent: LibraryIntent | undefined;
const presentation = new MusicPresentation({
  presentationReady: () => scene?.musicPresentationReady ?? false,
  archiveReady: () => scene?.musicArchiveReady ?? false,
  archiveInteractive: () => scene?.musicArchiveInteractive ?? false,
  enterCamera: () => {
    scene?.setMode("detail");
    effects.setScene("detail");
    effects.play("open");
  },
  returnCamera: () => {
    scene?.setMode("archive");
    effects.setScene("archive");
    effects.play("back");
  },
  select: ({ index, navigation }) => commitSelection(index, navigation),
  switchDetail: ({ index, navigation }) => commitSelection(index, navigation, true),
  mode: (next) => {
    mode = next;
    stage.dataset.mode = next;
    syncSelectionMotion();
    lyricStage.setMode(next === "detail" ? displayMode : "rhine");
    syncChromeReveal();
  },
  prepareMenu: () => {
    activeTab = "tracks";
    detailTransition.hide(true);
    renderDetail();
    const content = $("#album-detail-content");
    content.style.removeProperty("opacity");
    content.style.removeProperty("transform");
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
  },
  showMenu: () => {
    const detail = $("#music-detail"), content = $("#album-detail-content");
    detailTransition.show(preferences.reduced);
    detail.inert = !!panel;
    detail.setAttribute("aria-hidden", "false");
    content.inert = false;
    content.scrollTop = 0;
    documentDecryption.reset(content, preferences.reduced);
    pendingDetailFocus = true;
  },
  hideMenu: (done) => {
    trackFocus.cancel();
    pendingDetailFocus = false;
    tabTransition.cancel();
    $("#music-detail").inert = true;
    $("#music-detail").setAttribute("aria-hidden", "true");
    detailTransition.hide(preferences.reduced, done);
  },
  hideBrowse: (done) => {
    $("#music-browse").inert = true;
    $("#music-browse").setAttribute("aria-hidden", "true");
    browseTransition.hide(preferences.reduced, done);
  },
  showBrowse: showBrowseSurface,
});
boot = new MusicBoot(stage, {
  reduced: () => preferences.reduced,
  onStart: () => {
    cancelTrackReveal();
    presentation.reset();
    detailTransition.hide(true);
    browseTransition.hide(true);
    scene?.setMode("hidden");
    syncSelectionMotion();
  },
  onComplete: (reason) => {
    const now = performance.now() / 1000;
    if (reason === "skip") scene?.showMusicArchiveImmediately(now);
    else scene?.finishMusicIntro(now);
    effects.setScene("archive");
    showBrowseSurface();
  },
});
function showBrowseSurface() {
  if (!albums.length || boot?.active) return;
  browseTransition.show(preferences.reduced);
  $("#music-browse").inert = !!panel;
  $("#music-browse").setAttribute("aria-hidden", "false");
  syncSelectionMotion();
  if (!panel) $("[data-action=open]").focus({ preventScroll: true });
}

/**
 * R173（Q51）：岛内可视化模式的**可调参数**在宿主这一侧的唯一通路。
 * 三条规矩：① 持久化只有 `preferences`（那一份 localStorage）这一个出处，岛不存设置；
 * ② 面板由 `folia-host/mode-settings.tsx` 渲染，值从这里给、改动回到这里；
 * ③ 非法值一律丢掉而不是崩在面板里——磁盘上写着没人认识的东西时，用户应该看到默认画面。
 */
function normalizeFoliaTunings(): void {
  const stored = preferences.foliaTunings;
  // 按字符串判：磁盘上那一份的键本来就是任意字符串，认不认识由这里说了算（不是由类型说了算）。
  const known = new Set<string>(FOLIA_MODES.map((m) => m.id));
  const clean: Record<string, Record<string, unknown>> = {};
  if (stored && typeof stored === "object") {
    for (const [mode, value] of Object.entries(stored)) {
      // 只收"认识的档 + plain object"；其余（null / 数组 / 字符串 / 未知模式）整条丢掉
      if (!known.has(mode) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      clean[mode] = { ...(value as Record<string, unknown>) };
    }
  }
  preferences.foliaTunings = clean;
}
normalizeFoliaTunings();
/** 把宿主这份参数喂给岛（岛只拿一份用来渲染的读数，见 island.tsx 的 tunings）。 */
function feedFoliaTunings(): void {
  // **必须给一份新对象**：岛内选择器按引用比较（zustand），喂同一个 preferences.foliaTunings
  // 就是"值改了、引用没改 ⇒ 不重渲染"，表现是"拖了滑杆、重启之后才生效"（真机量到的）。
  // R175：每一档过一遍 `resolveFoliaTuning` —— 移植件的面板与渲染器做"整对象回退"，
  // 喂局部补丁等于"拖一格、其余九格全 undefined"，画面直接坏掉（pendolo 取证抓到）。
  // R189：改走 `resolveFoliaTuningForTheme` —— 亮底下辉光/雾的**缺省**要打折（用户调过的格不动）。
  const bundle: Record<string, Record<string, unknown>> = {};
  const isDaylight = useHostThemeStore.getState().isDaylight;
  for (const mode of Object.keys(FOLIA_TUNING_DEFAULTS)) {
    const resolved = resolveFoliaTuningForTheme(mode, preferences.foliaTunings[mode], isDaylight);
    if (resolved) bundle[mode] = resolved;
  }
  islandHandle?.setTunings(bundle as Parameters<IslandHandle["setTunings"]>[0]);
}
/**
 * R178（拍板 ③）：参数区里要额外说一句实话的档。cappella 的内置头像素材不随包发行 ⇒
 * 那两个来源会被合成层回落成"封面"（见 `folia-host/tuning-defaults.ts`），界面要讲明白，
 * 不许"选了没反应"还不说原因。撤法：这两处（本表 + 那条回落规则）同进退。
 */
const FOLIA_MODE_SETTINGS_NOTES: Partial<Record<FoliaMode, string>> = {
  cappella:
    "本仓未随包发行内置头像：头像来源选「内置头像」或「自定义」时仍显示歌曲封面（这张歌没有封面时画色块）。",
};

function foliaModeSettingsOptions(): ModeSettingsOptions {
  return {
    mode: preferences.foliaMode,
    // 那句"没有可调参数"的实话要说用户认得的名字，不说内部 id（R176）。
    modeLabel: FOLIA_MODES.find((m) => m.id === preferences.foliaMode)?.name ?? preferences.foliaMode,
    note: FOLIA_MODE_SETTINGS_NOTES[preferences.foliaMode],
    getTuning: (mode) =>
      resolveFoliaTuningForTheme(mode, preferences.foliaTunings[mode], useHostThemeStore.getState().isDaylight),
    onPatch: (mode, patch) => {
      const merged = { ...(preferences.foliaTunings[mode] ?? {}), ...patch };
      preferences.foliaTunings[mode] = merged;
      savePrefs();
      feedFoliaTunings();
      // 面板自己也要重渲染：滑杆的显示值来自这里给的那份读数，不刷就是"拖了、画面变了、滑杆没动"。
      // 模块已经加载过（面板正显示着），这里只是复用那份 promise，不会二次下载。
      if (modeSettingsModule) void modeSettingsModule.then((m) => m.refreshModeSettings(foliaModeSettingsOptions()));
    },
  };
}
/** 设置面板渲染之后调用：把这一档的面板挂进那个容器（没有容器就是面板没开，静默返回）。 */
function mountFoliaModeSettings(): void {
  const options = foliaModeSettingsOptions();
  void loadModeSettings().then((m) => {
    // 等模块这段时间里面板可能已经被关掉或重画过 ⇒ 回来时重新找容器，找不到就不挂。
    const box = document.querySelector<HTMLElement>("#folia-mode-settings");
    if (box) m.mountModeSettings(box, options);
  });
}

function savePrefs() {
  save("rhine-music-preferences", preferences);
}
/**
 * F2：主题令牌被 @property 注册并参与 650ms 过渡（music-theme.css / music.css），
 * 而下面 setTheme 里那次 refreshHostTheme() 是同步读 getComputedStyle —— 读到的是**过渡起点**的值
 * （Task 0 实测：点完按钮同一拍 pageBg 仍是 rgb(232,229,225)，+60ms 已在插值，+3s 才到 rgb(203,214,223)），
 * island.tsx:74 又把它写成内联字面量 host.style.background，此后无人再刷 ⇒ 岛内底色永远停在上一档。
 * 派生色 --folia-* 刻意未注册 @property（注册会吃掉 var() 回退分支，见 lyric-stage.css:39），
 * 所以有封面路径当场就正确 —— 这里只补"过渡收敛后再读一次终值"，不动 CSS 的过渡本身。
 */
let hostThemeSettleToken = 0;
function refreshHostThemeAfterTransition() {
  const token = ++hostThemeSettleToken;
  const root = document.querySelector<HTMLElement>(".music-app");
  const settle = () => {
    if (token !== hostThemeSettleToken) return;   // 快速连点：只有最后一次排程作数
    refreshHostTheme();
    // R202：模糊层的缺省是**按主题**给的（day 浅、night 深）⇒ 主题收敛后要按新档重算一次。
    // 放在 settle（终值那一次）而不是过渡起点：起点那次 isDaylight 还是旧的，重算等于把上一档的缺省再写一遍。
    refreshBackdropNow();
  };
  const onEnd = (event: Event) => {
    if ((event as TransitionEvent).propertyName !== "--page-bg") return;
    root?.removeEventListener("transitionend", onEnd);
    settle();
  };
  root?.addEventListener("transitionend", onEnd);
  // 兜底：减弱动效档会跳过过渡、事件也可能根本不派发，900ms（650ms + 余量）后无论如何都收敛一次。
  setTimeout(() => {
    root?.removeEventListener("transitionend", onEnd);
    settle();
  }, 900);
}
function setTheme(theme: Theme) {
  if (!THEMES.includes(theme)) theme = "day";
  if (theme === preferences.theme) return;
  preferences.theme = theme;
  stage.dataset.theme = theme;
  scene?.setTheme(theme, !preferences.reduced);
  viewer?.setTheme(theme);
  // Folia 内的歌词配色按主题定档，所以换主题要通知舞台。
  // lyricStage 声明在后面，但 setTheme 只由点击委托触发，那时模块已初始化完毕；
  // 启动路径上没有 setTheme 调用，别加（阶段 3 被 TDZ 启动崩溃咬过一次）。
  lyricStage.refreshTheme();
  // R40（第二期）：岛内主题桥也要跟着换档。此前只有进岛与歌词变化时刷新，
  // 结果在封面墙里切主题，墙底色停在进岛那一刻的值（实测：day→dusk→night 岛内 --bg-color 不变）。
  // 与 lyricStage 同理，setTheme 只由点击委托触发，启动路径不调用，不会撞 TDZ。
  refreshHostTheme();
  // F2：上面那次同步刷新拿到的是过渡起点的值，收敛后必须再读一次终值（无封面曲目才会露出这个差）。
  refreshHostThemeAfterTransition();
  document
    .querySelectorAll<HTMLButtonElement>("button[data-theme]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.theme === theme)),
    );
  setMetaThemeColor(theme);
  savePrefs();
}
/**
 * R179（缺陷一）：把顶部导航带的下沿量成一个变量写给 #stage，岛的 inset-top 吃它。
 * 每次量都从 DOM 现读（不缓存高度）：那条带的高度是内容撑的，字体加载完、断点变了都会改。
 */
function syncFoliaSafeTop(): void {
  const header = document.querySelector<HTMLElement>(".music-header");
  const island = document.querySelector<HTMLElement>("#folia-island");
  if (!header || !island) return;
  const h = header.getBoundingClientRect();
  const i = island.getBoundingClientRect();
  stage.style.setProperty(FOLIA_SAFE_TOP_VAR, `${computeFoliaSafeTop(h.bottom, i.top)}px`);
}
/** 顶部带高度会变（字体加载完、断点切换、内容换行）⇒ 观察它自己，比只挂 resize 稳。 */
function watchFoliaSafeTop(): void {
  syncFoliaSafeTop();
  const header = document.querySelector<HTMLElement>(".music-header");
  if (header && typeof ResizeObserver !== "undefined") new ResizeObserver(syncFoliaSafeTop).observe(header);
}
/**
 * R206 ④：顶栏按**窗口宽度**分档收起次要项。档位只写进这一个属性，
 * 收哪几项住在 `topbar-tiers.ts`、收起这个动作住在 `music.css`（与 R203"隐藏只在 CSS 里做"同一条纪律）。
 * 单独抽一个函数（而不是塞进 `fit()` 里）：启动时也要定一次档 —— `fit()` 那一路排在 `start()` 里面，
 * 三维资源没加载成时它根本不跑，那时顶栏反而该是收好的。
 */
function syncTopbarTier(): void {
  stage.dataset.topbar = topbarTier(stage.clientWidth);
}
function fit() {
  // Use the same stage dimensions and aspect boundary as the scene framing.
  stage.dataset.layout = viewportLayout(stage.clientWidth, stage.clientHeight, false).kind;
  syncTopbarTier();
  scene?.resize();
  viewer?.resize();
  syncFoliaSafeTop(); // R179：断点一改，顶部带的位置与高度都跟着改
  if (mode === "detail") {
    syncTabIndicator(false);
    documentDecryption.refresh();
  }
}
window.addEventListener("resize", fit);
syncTopbarTier(); // R206 ④：第一帧就按当前窗口宽度定档（不等用户拖一下窗口）

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw new Error(data?.error || `本地服务请求失败 (${response.status})`);
  return data as T;
}
/**
 * 轮询排程的唯一入口（6.6 · E7）。
 * `loadLibrary` 里每条提前 return 的分支都必须先调用它：原先 `if (refreshing) return;` 直接返回，
 * 于是"这次调用不排程"要靠"另一个在飞的调用结束时替我排"这个跨调用隐式不变量才不断链。
 * 单页签流程下它今天确实没断过（浏览器 62 秒复验见执行日志），但把排程收进一个入口
 * 才是自动刷新的前提：以后任何一条新分支忘了排程，都会立刻在这段里显形。
 * 延迟默认跟随"扫描/补全/介绍是否在跑"，动作后的即时回读用 delayMs 覆盖。
 */
function schedulePoll(options: { delayMs?: number; force?: boolean } = {}) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(
    () => void loadLibrary(options.force ?? false),
    options.delayMs ??
      (library.scan.running ||
      library.enrich?.running ||
      library.introductions?.running
        ? 1400
        : 12000),
  );
}
async function loadLibrary(force = false) {
  // Keep the selected cards and cover atlas stable for the opening shot.
  if (boot?.active) {
    schedulePoll({ delayMs: 1000, force });
    return;
  }
  if (refreshing) {
    // 6.6：并发保护要留，但下一次轮询必须仍然被排上（见 schedulePoll 的说明）。
    schedulePoll();
    return;
  }
  refreshing = true;
  const stateVersion = libraryStateVersion;
  try {
    const next = await request<MusicLibrary>("/api/library");
    apiAvailable = true;
    if (stateVersion === libraryStateVersion && !boot?.active) await receiveLibrary(next, force);
  } catch (error) {
    apiAvailable = false;
    updateStatus();
    updateIntroductionStatus();
    if (force)
      notify(
        `${(error as Error).message}。请使用 npm run music 启动本地音乐服务。`,
      );
  } finally {
    refreshing = false;
  }
  schedulePoll();
}
async function receiveLibrary(next: MusicLibrary, force = false) {
  const previousScan = library.scan;
  const scanCompleted = libraryReceived && !next.scan.running && !next.scan.error &&
    !!next.scan.finishedAt && next.scan.finishedAt !== previousScan.finishedAt;
  const scanFailed = libraryReceived && previousScan.running && !next.scan.running && !!next.scan.error;
  libraryReceived = true;
  const previousIntroductionRun = library.introductions;
  const changed =
    JSON.stringify(next.albums) !== JSON.stringify(library.albums) ||
    JSON.stringify(next.genres) !== JSON.stringify(library.genres);
  library = next;
  if (library.introductions?.running) introductionRequestError = "";
  if (changed || force) await applyLibrary();
  updateStatus();
  if (panel === "library") updateScanStatus();
  updateIntroductionStatus();
  if (
    previousIntroductionRun?.running &&
    library.introductions &&
    !library.introductions.running
  ) {
    const result = library.introductions;
    notify(
      result.error ||
        `专辑介绍查询完成：更新 ${result.updated} 张，未找到可靠资料 ${result.notFound} 张，查询失败 ${result.failed} 张。`,
    );
  }
  if (scanFailed) notify(`音乐库扫描失败：${next.scan.error}`);
  if (scanCompleted && !scanRefreshTimer) {
    notify("音乐库扫描完成，2 秒后自动刷新页面。");
    scanRefreshTimer = setTimeout(() => location.reload(), 2000);
  }
}
/**
 * ⑧ 架上那一行歌单 → **伪专辑**。曲目明细不在这里取（点开才取），所以 `tracks` 恒空。
 * 三条讲究：① id 带 `playlist:` 前缀，点开的路由与真实专辑共用同一处派发；
 * ② 歌手位填"成员里最主要的音乐人"，一条都没匹配上就留空（架子那行显示"未知歌手"）——
 *    不拿歌单名冒充歌手，那个字段在列名/检索/详情里都是"歌手"语义；
 * ③ **封面两种**：服务端给了展示封面（`coverUrl` = 同源 token 地址）就用真图；
 *    没给就照旧按 `coverSeeds` 画程序化拼贴 —— 不按 id 造 artwork URL（F3 那条老错）。
 *    R198 起 `coverUrl` 只会是服务端签出来的同源地址（第三方 URL 不出服务端）。
 */
function playlistAlbum(row: MusicPlaylistShelfRow): MusicAlbum {
  return {
    id: playlistAlbumId(row.id),
    title: row.name,
    artist: row.artist,
    genreId: PLAYLIST_GROUP_ID,
    rawGenres: [],
    folder: `歌单 · ${row.id}`,
    tracks: [],
    producers: [],
    offline: false,
    kind: "playlist",
    shelfCounts: { items: row.items, matched: row.matched, unmatched: row.unmatched },
    coverSeeds: row.coverSeeds,
    ...(row.coverUrl ? { coverUrl: row.coverUrl } : {}),
  };
}
/**
 * ⑨ 在线音乐人组 → 第二张伪专辑。与 `playlistAlbum` 同构，三条讲究照搬：
 * ① id 带 `artist:` 前缀（点开走面板，不开 3D 详情面）；
 * ② 不伪造 genreId（会让"按流派统计"对不上账），走第二个保留分组；
 * ③ 不写 `coverUrl`：架上那格仍是按成员文本算出的程序化色块（D7 保守默认，取真封面列待确认）。
 */
function artistAlbum(row: MusicOnlineArtistShelfRow): MusicAlbum {
  return {
    id: artistAlbumId(row.slug),
    title: row.name,
    artist: row.name,
    genreId: ONLINE_ARTIST_GROUP_ID,
    rawGenres: [],
    folder: `在线音乐人 · ${row.slug}`,
    tracks: [],
    producers: [],
    offline: false,
    kind: "artist",
    shelfCounts: { items: row.items, matched: row.items, unmatched: 0 },
    coverSeeds: row.coverSeeds,
  };
}
/** 架上最后一次读到的歌单行与"有几张没铺出来"；读失败时保留上一次的，不让这一列整列消失。 */
let playlistShelfRows: MusicPlaylistShelfRow[] = [];
let playlistShelfOmitted = 0;
/** ⑨ 音乐人组同理；`artistsOmitted` 要说得出来，不许悄悄截断。 */
let artistShelfRows: MusicOnlineArtistShelfRow[] = [];
let artistShelfOmitted = 0;
async function fetchPlaylistShelf() {
  // R203（壁纸 surface M0 · Task 2 判据③）：这一问服务的是三维架子上的"歌单 / 在线音乐人"那两列
  // （浏览层），surface 里架子不出现 ⇒ 没有对象，一律不发（run log §0.5 里那两条按事实改道的读法）。
  if (isWallpaperSurface) return [];
  try {
    const shelf = await request<MusicPlaylistShelf>("/api/playlists/shelf");
    playlistShelfRows = Array.isArray(shelf?.playlists) ? shelf.playlists : [];
    playlistShelfOmitted = Number(shelf?.omitted ?? 0) || 0;
    artistShelfRows = Array.isArray(shelf?.artists) ? shelf.artists : [];
    artistShelfOmitted = Number(shelf?.artistsOmitted ?? 0) || 0;
  } catch {
    // 这一列少了不该把整个曲库刷新带坏：留着上一次读到的行，界面上仍是那几张歌单。
  }
  return playlistShelfRows;
}
async function applyLibrary() {
  const hadAlbums = albums.length > 0;
  const previousRowId = records[selected]?.id;
  const previousId = currentAlbum()?.id;
  const previousDetail = JSON.stringify(currentAlbum());
  const visualKey = (items: MusicAlbum[], groups: MusicGenre[]) =>
    JSON.stringify([
      items.map((a) => [a.id, a.title, a.artist, a.genreId, a.coverUrl]),
      groups.map((g) => [g.id, g.name]),
    ]);
  const oldVisual = visualKey(albums, genres);
  if (library.albums.length) demo = false;
  // ⑧ 歌单与真实专辑**同一次排序**（D6：不置顶、不特例），所以拼在排序之前而不是之后。
  // ⑨ 音乐人组也一样并入这一次排序：三样东西共用一条排序轴，谁都不给自己开"永远在第一列"的后门。
  const shelfRows = await fetchPlaylistShelf();
  albums = orderMusicAlbums(
    [
      ...(demo ? demoAlbums : library.albums),
      ...shelfRows.map(playlistAlbum),
      ...artistShelfRows.map(artistAlbum),
    ],
    preferences.sortMode,
  );
  genres = demo ? demoGenres : library.genres;
  setMusicAlbums(albums, genres, preferences.sortMode, preferences.shelfLayout);
  // 专辑布局下 records 是曲目粒度，行 id 形如 `专辑id#曲目id`：
  // 先按整行 id 复原（停在原来那一首），拿不到再退回"同一张专辑的第一行"。
  const restoredRow = records.findIndex((r) => r.id === previousRowId);
  const restoredAlbum = records.findIndex((r) => (r.album?.id ?? r.id) === previousId);
  selected = Math.max(0, restoredRow >= 0 ? restoredRow : restoredAlbum);
  // 列记忆按**键**存，不按显示名：专辑分组下两张同名专辑会共用一个键，翻页回来会串列。
  columnMemory = new Map(
    archiveColumnKeys.map((key, lane) => [
      key,
      records[columnFiles(lane)[0]]?.id,
    ]),
  );
  if (scene && ready && oldVisual !== visualKey(albums, genres)) {
    const reopen = presentation.openingOrDetail;
    cancelTrackReveal();
    libraryRebuilding = true;
    libraryIntent = undefined;
    presentation.reset();
    detailTransition.hide(true);
    browseTransition.hide(true);
    try { await scene.refreshLibrary(selected); }
    finally { libraryRebuilding = false; }
    const intent = libraryIntent as LibraryIntent | undefined;
    libraryIntent = undefined;
    scene.setMode("archive");
    if (intent && "index" in intent)
      select(intent.index, intent.navigation, intent.openAfter, intent.route);
    else if ((intent ? intent.mode === "detail" : reopen) && albums.length)
      presentation.open();
    else showBrowseSurface();
  }
  if (!albums.length) {
    cancelTrackReveal();
    presentation.reset();
  }
  stage.dataset.mode = mode;
  $("#music-empty").hidden = albums.length > 0;
  // Ordinary index refreshes must not reveal a page while its peer is exiting.
  if (!ready || !hadAlbums || !albums.length) {
    if (albums.length && mode === "archive") browseTransition.show(true);
    else browseTransition.hide(true);
    // Detail is revealed exclusively by the camera completion gate.
    if (presentation.phase !== "detail") detailTransition.hide(true);
    $("#music-browse").inert = !albums.length || mode !== "archive" || !!panel;
    $("#music-detail").inert = !albums.length || mode !== "detail" || !!panel;
    $("#music-browse").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "archive"),
    );
    $("#music-detail").setAttribute(
      "aria-hidden",
      String(!albums.length || mode !== "detail"),
    );
  }
  updateSelection();
  if (mode === "detail" && previousDetail !== JSON.stringify(currentAlbum()))
    renderDetail();
  updateStatus();
}
/**
 * R203（壁纸 surface M0 · Task 4）：这一档可能长时间没人守着 ⇒ 三种"画不出东西"的状态必须各说一句人话
 * （不许黑屏、不许静默）。**不新造第二块状态 UI**：作者只有 `updateStatus()` 这一处，
 * 载体只有既有那行 `#library-status`（CSS 第 9 段把它改挂到左下角、按 R195 那三步给可读性）。
 * 一次性读数的声明必须排在 `updateStatus` 之前（R103 / R161 那两条 TDZ 教训）。
 */
let displayModePinnedNotice = false;
function updateStatus() {
  const n = library.albums.length,
    tracks = library.albums.reduce((sum, a) => sum + a.tracks.length, 0);
  // 这一档不切演出/歌词模式（`setDisplayMode` 在那一格里拒了），拒过一次就报一句，报完即清。
  const pinned = displayModePinnedNotice;
  displayModePinnedNotice = false;
  // R203：下面三格都排在既有那几格**之后**、缺省格 `demo`/`""` **之前**——缺省格是 `""`（隐行），
  // surface 专属的话写在它后面就永远读不到。三格合起来正是 Task 4 点名的三种态
  // （后端坏了 = 最前那格 `!apiAvailable`，既有、一字未动；岛没挂上；曲库空的），外加"被要求切模式"。
  // 每一格都以 `isWallpaperSurface` 开头短路 ⇒ 主窗口一个字都不改（判据②）。
  const label = !apiAvailable
    ? "本地音乐服务尚未连接"
    : library.scan.running
      ? "正在扫描音乐库…"
      : library.enrich?.running
        ? `补充在线资料 ${library.enrich.completed}/${library.enrich.total}`
        : library.introductions?.running
          ? `查询专辑介绍 ${library.introductions.completed}/${library.introductions.total}`
          : isWallpaperSurface && islandState === "failed"
            // 岛的懒加载 chunk 挂了。既有降级路径（回落自研歌词面）在跑，但"画面组件没上来"这件事必须说出来，
            // 还要把原因带上——`syncFoliaIsland` 的 catch 已经把原文写进 `#folia-island` 的 data-fallback。
            ? `画面组件没能加载：${$("#folia-island").dataset.fallback ?? "未知原因"} · 已回落到本机自研歌词面（按 Esc 退出这一页）`
            : isWallpaperSurface && !library.albums.length
              // 一句里把三件事说完：这一页干什么、现在缺什么、去哪儿补。演示封面那一层也如实点名，
              // 不拿"曲库空的"盖住"屏幕上其实是演示专辑"（两者同时成立，只说一半就是假话）。
              ? "这里只负责画面：本地曲库还没有专辑（现在架子上是演示专辑封面）——音乐文件夹要在主窗口里选，这一页会自己跟上"
              : isWallpaperSurface && pinned
                ? "这一页只负责画面：不切换演出/歌词模式（要切请回主窗口）"
                : isWallpaperSurface && !player.state.currentTrack
                  // 真机第一遍抓到的最后一块静默：曲库有专辑、但还没按播放 ⇒ 屏幕上只有一片糊底，
                  // 没有任何东西说明"它在等什么"。这一句就是那块空白的话。
                  ? "这一页只负责画面：还没有歌在播——按空格，或用下方控制条的播放键；要挑专辑请回主窗口"
                  : demo
                  ? "演示专辑 · 加入音乐后显示真实封面"
                  : "";
  $("#library-status span").textContent = label;
  $("#library-status").hidden = !label;
  $("#library-status").classList.toggle(
    "working",
    !!library.scan.running ||
      !!library.enrich?.running ||
      !!library.introductions?.running,
  );
  $("#library-count").textContent = demo
    ? "DEMONSTRATION"
    : `${n} ALBUMS / ${tracks} TRACKS`;
}
function updateSelection(navigation?: ArchiveNavigation) {
  const a = currentAlbum();
  if (!a) {
    selectionInitialized = false;
    textMotion.finish();
    titleMotion.finish();
    return;
  }
  const location = fileLocation(selected),
    files = columnFiles(location.lane),
    idx = files.indexOf(selected);
  const animated = selectionInitialized && selectionMotionEnabled();
  selectionInitialized = true;
  textMotion.update(
    {
      number: idx + 1,
      total: files.length,
      genresTotal: archiveColumns.length,
      code: selected + 1,
      genreIndex: location.lane + 1,
      genre: archiveColumns[location.lane],
      genreName: archiveColumns[location.lane],
      format: a.kind === "playlist" ? "歌单" : a.kind === "artist" ? "在线音乐人" : demo
        ? "DEMO"
        : [...new Set(a.tracks.map((t) => t.format))].join(" / "),
      artist: a.artist,
      meta: [
        a.year ? String(a.year) : "年份未提供",
        // ⑧ 伪专辑没有曲目数组（明细点开才取），所以这一行必须走歌单自己的说法，
        // 否则会写成"0 首曲目"——那与架子那行的"歌单 · 3 首"自相矛盾。用同一个函数算，两处不会漂。
        a.kind === "playlist" || a.kind === "artist"
          ? shelfClearance(a)
          : demo
            ? "演示封面"
            : `${a.tracks.length} 首曲目`,
        a.tracks.length ? time(albumDuration(a)) : "",
      ]
        .filter(Boolean)
        .join("  /  "),
    },
    animated,
    navigation,
  );
  titleMotion.update(a.title, animated);
  $("#selection-title").title = a.title;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "#music-browse .album-stepper button",
  ))
    button.disabled = records.length < 2;
  tickMotion.update(
    files.map((index) => ({ index, id: records[index].id, title: records[index].title })),
    selected,
    preferences.reduced,
    navigation,
  );
  $("#detail-card-id").textContent =
    `ALBUM / ${String(selected + 1).padStart(3, "0")}`;
  // Hidden archive content can prepare its static reels before the reveal.
  if (!animated) syncSelectionMotion();
}
function commitSelection(index: number, navigation?: ArchiveNavigation, keepDetail = false) {
  selected = wrap(index, records.length);
  columnMemory.set(
    archiveColumnKeys[fileLocation(selected).lane],
    records[selected].id,
  );
  if (keepDetail) scene?.switchMusicAlbum(selected, navigation);
  else scene?.select(selected, navigation);
  updateSelection(navigation);
  effects.play(
    navigation && "axis" in navigation && navigation.axis === "lane"
      ? "column"
      : "tick",
  );
}
function select(index: number, navigation?: ArchiveNavigation, openAfter = presentation.openingOrDetail, route?: AlbumSelection["route"]) {
  if (!records.length || !ready || boot?.active || index < 0) return;
  if (route !== "archive") cancelTrackReveal();
  const pending = libraryRebuilding && libraryIntent && "index" in libraryIntent
    ? libraryIntent : presentation.pendingSelection;
  const previous = pending?.navigation;
  if (pending) {
    // Coalesced key presses still reach the matching physical loop cell.
    navigation = previous && navigation && "axis" in previous && "axis" in navigation && previous.axis === navigation.axis
      ? { axis: navigation.axis, direction: previous.direction + navigation.direction }
      : undefined;
  }
  if (libraryRebuilding) {
    libraryIntent = { index: wrap(index, records.length), navigation, openAfter, route };
    return;
  }
  presentation.select({ index: wrap(index, records.length), navigation, route }, openAfter);
}
/** Playback can reuse its open album; other targets take the archive route. */
function revealAlbum(albumId: string, trackId?: string, options: { reuseOpenAlbum?: boolean } = {}) {
  closePanel(() => {
    cancelTrackReveal();
    if (!ready || boot?.active) return;
    // 专辑布局下一行是一首曲目，所以按"这张专辑 + 这首曲目"定位；其他布局下 record.track 为空，
    // `!record.track` 那一支让它照旧命中专辑行。
    const index = records.findIndex(
      (record) =>
        (record.album?.id ?? record.id) === albumId &&
        (!trackId || record.track?.id === trackId || !record.track),
    );
    const album = albums.find((item) => item.id === albumId);
    if (index < 0 || !album || (trackId && !album.tracks.some((track) => track.id === trackId))) {
      notify("这张专辑或歌曲已不在当前音乐库中，请刷新音乐库后重试。");
      return;
    }
    if (options.reuseOpenAlbum && trackId && !libraryRebuilding &&
      currentAlbum()?.id === albumId && presentation.openingOrDetail &&
      !presentation.pendingSelection &&
      ["detail", "opening", "switching"].includes(presentation.phase)) {
      // Preserve the camera and current scroll position. If the album is still
      // entering, the usual detail gate below will wait before revealing it.
      setTab("tracks");
      pendingTrackReveal = { albumId, trackId };
      return;
    }
    if (trackId) pendingTrackReveal = { albumId, trackId };
    select(index, undefined, true, "archive");
  });
}
function navigationSelection() {
  if (libraryRebuilding && libraryIntent && "index" in libraryIntent) return libraryIntent.index;
  return presentation.pendingSelection?.index ?? selected;
}
function stepAlbum(direction: number) {
  if (!records.length) return;
  const cursor = navigationSelection();
  const files = columnFiles(fileLocation(cursor).lane);
  if (files.length > 1) {
    select(files[wrap(files.indexOf(cursor) + direction, files.length)], {
      axis: "row",
      direction,
    });
    return;
  }
  // A column with a single album has nothing to step through, so the arrows fall
  // back to cycling the whole library across columns (stage 4 decision).
  if (records.length > 1)
    select(wrap(cursor + direction, records.length), {
      axis: "row",
      direction,
    });
}
function stepGenre(direction: number) {
  if (!records.length || archiveColumns.length < 2) return;
  const lane = wrap(
    fileLocation(navigationSelection()).lane + direction,
    archiveColumns.length,
  );
  const remembered = columnMemory.get(archiveColumnKeys[lane]);
  const index = records.findIndex((r) => r.id === remembered);
  select(index >= 0 ? index : columnFiles(lane)[0], {
    axis: "lane",
    direction,
  });
}
function setMode(next: "archive" | "detail") {
  if (boot?.active) return;
  if (next === "archive") {
    cancelTrackReveal();
    detailRevealArmed = false;   // 回到架子上就不再有"打开时要揭示哪一首"
  }
  if (libraryRebuilding) { libraryIntent = { mode: next }; return; }
  if (next === "detail") {
    // ⑧ 伪专辑（文本歌单）没有曲目、也没有"专辑详情"可看：点开去**已有的**歌单详情面板。
    // 不新造第二个详情页，也不让 3D 详情面打开成一张空专辑（那会显示"0 首歌曲"还什么都能点）。
    const album = currentAlbum();
    const playlistSlug = album ? playlistSlugOf(album.id) : "";
    if (album?.kind === "playlist" && playlistSlug) {
      playlistOpenId = playlistSlug;
      openPanel("playlist");
      return;
    }
    // ⑨ 音乐人组同理：明细点开才取，3D 详情面不打开（那会是一张 0 首的空专辑还什么都能点）。
    const artistSlug = album ? artistSlugOf(album.id) : "";
    if (album?.kind === "artist" && artistSlug) {
      artistOpenSlug = artistSlug;
      openPanel("artist");
      return;
    }
    if (album) presentation.open();
  } else presentation.back();
}
function syncTabIndicator(animate = true) {
  const button = document.querySelector<HTMLElement>(`#tab-${activeTab}`);
  const indicator = document.querySelector<HTMLElement>(".music-tab-indicator");
  if (!button || !indicator) return;
  indicator.style.transition = animate && !preferences.reduced ? "" : "none";
  indicator.style.transform = `translateX(${button.offsetLeft}px) scaleX(${button.offsetWidth})`;
}
function setTab(tab: "tracks" | "about") {
  if (activeTab === tab) return;
  cancelTrackReveal();
  activeTab = tab;
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncTabIndicator();
  const a = currentAlbum();
  if (!a) return;
  const content = $("#album-tab-content");
  content.innerHTML =
    tab === "tracks" ? trackList(a, a.discCount || 1) : albumAbout(a);
  content.setAttribute("aria-labelledby", `tab-${tab}`);
  documentDecryption.refresh();
  tabTransition.reveal(content, preferences.reduced);
  updatePlayingRows();
  effects.play("ui-tick");
}
function renderDetail() {
  const a = currentAlbum();
  if (!a) return;
  trackFocus.cancel();
  const discs =
    a.discCount || Math.max(1, ...a.tracks.map((t) => t.discNumber || 1));
  const bits =
    a.tracks.length && a.tracks.every((t) => t.lossless === false)
      ? "有损编码"
      : valueRange(
          a.tracks.map((t) => t.bitsPerSample),
          (n) => `${n} bit`,
        );
  const rate = valueRange(
    a.tracks.map((t) => t.sampleRate),
    (n) => `${Number((n / 1000).toFixed(1))} kHz`,
  );
  const bitrate = valueRange(
    a.tracks.map((t) => t.bitrate),
    (n) => `${Math.round(n / 1000)} kbps`,
  );
  const fields = [
    ["RELEASE / 发行年份", a.year || "未提供"],
    ["ARTIST / 歌手", a.artist],
    ["GENRE / 流派", genreName(a.genreId)],
    ["VOLUMES / 内含 CD", demo ? "—" : `${discs} CD · ${a.tracks.length} 首`],
    ["FORMAT / 文件格式", formatList(a)],
    ["RESOLUTION / 位深与采样率", `${bits} / ${rate}`],
    ["BITRATE / 码率", bitrate],
    ["DURATION / 总时长", time(albumDuration(a))],
  ];
  const article = $("#album-detail-content"),
    sameAlbum = detailIdentity === a.id,
    scroll = sameAlbum ? article.scrollTop : 0;
  detailIdentity = a.id;
  article.innerHTML = `<div class="detail-overline"><span>ALBUM ${String(selected + 1).padStart(3, "0")}</span><div class="detail-album-navigation" role="group" aria-label="切换专辑"><button data-action="prev" aria-label="上一张专辑">↑ 上一张</button><button data-action="next" aria-label="下一张专辑">下一张 ↓</button></div></div>
    <h1 title="${esc(a.title)}">${albumTitleMarkup(a.title)}</h1><p class="detail-artist">${esc(a.artist)}${a.offline ? '<span class="offline-badge">目录离线</span>' : ""}</p>
    <div class="album-facts">${fields.map(([name, value]) => `<div><small>${name}</small><span>${esc(String(value))}</span></div>`).join("")}</div>
    <div class="music-tabs" role="tablist" aria-label="专辑信息"><button role="tab" id="tab-tracks" data-tab="tracks" tabindex="${activeTab === "tracks" ? 0 : -1}" aria-selected="${activeTab === "tracks"}" aria-controls="album-tab-content"><span>01</span> 歌单</button><button role="tab" id="tab-about" data-tab="about" tabindex="${activeTab === "about" ? 0 : -1}" aria-selected="${activeTab === "about"}" aria-controls="album-tab-content"><span>02</span> 专辑介绍</button><i class="music-tab-indicator" aria-hidden="true"></i></div>
    <div id="album-tab-content" role="tabpanel" aria-labelledby="tab-${activeTab}">${activeTab === "tracks" ? trackList(a, discs) : albumAbout(a)}</div>`;
  article.scrollTop = scroll;
  syncTabIndicator(false);
  documentDecryption.reset(
    article,
    preferences.reduced || scene?.decryptionFrame.phase === "clear",
  );
  updatePlayingRows();
}
function trackList(a: MusicAlbum, discs: number) {
  if (!a.tracks.length)
    return `<div class="empty-tracks"><strong>${demo ? "这是一张封面演示卡片" : "这个专辑还没有可播放曲目"}</strong><p>${demo ? "用于检查封面原始比例与卡片材质。扫描本地音乐库后，这里会显示真实曲目。" : "请检查音乐文件是否完整，并重新扫描音乐库。"}</p><button data-action="library">打开音乐库设置 ↗</button></div>`;
  let disc = -1;
  return `<div class="track-list" aria-label="专辑歌曲列表">${a.tracks
    .map((t, index) => {
      const discNo = t.discNumber || 1;
      const head =
        discs > 1 && discNo !== disc
          ? `<div class="disc-heading">DISC ${String(discNo).padStart(2, "0")}</div>`
          : "";
      disc = discNo;
      return `${head}<button class="track-row" data-track="${esc(t.id)}" ${a.offline ? "disabled" : ""} aria-label="播放 ${esc(t.title)}"><span class="track-number">${String(t.trackNumber || index + 1).padStart(2, "0")}</span><span class="track-name"><strong>${esc(t.title)}</strong><small>${esc(t.artist)}</small></span><span class="track-format">${esc(t.format)}${!t.browserPlayable ? '<i title="需要兼容的播放内核"> ↗</i>' : ""}</span><span class="track-duration">${time(t.duration)}</span></button>`;
    })
    .join("")}</div>${producerBlock(a)}`;
}
function albumAbout(a: MusicAlbum) {
  return `<section class="album-about"><small>ABOUT THIS ALBUM</small>
    ${a.description ? `<p>${esc(a.description)}</p>${a.descriptionSource ? `<a class="text-button" href="${esc(a.descriptionSource.url)}" target="_blank" rel="noopener">来源：${esc(a.descriptionSource.name)} ↗</a>${a.descriptionSource.license ? `<small class="introduction-license">${esc(a.descriptionSource.license)}</small>` : ""}` : ""}` : `<h3>专辑介绍待补充</h3><p>从公开百科核对专辑与歌手后读取介绍，附上来源并保存在本机。无法确认对应专辑时保留空白。</p>`}
    ${!demo ? `<button data-action="introduction-album" class="text-button" ${introductionsStarting || library.introductions?.running ? "disabled" : ""}>${a.description ? "更新" : "查询"}专辑介绍 ↗</button><p class="introduction-feedback" data-introduction-feedback="${esc(a.id)}" role="status">${esc(introductionAlbumStatus(a))}</p>` : ""}
    <div class="source-note"><span>本地目录</span><code>${esc(a.folder)}</code></div><div class="genre-tags">${a.rawGenres.map((g) => `<span>${esc(g)}</span>`).join("")}</div></section>${producerBlock(a)}`;
}
function introductionAlbumStatus(a: MusicAlbum) {
  const lookup = a.introduction;
  if (lookup?.status === "error")
    return `介绍查询失败：${lookup.error || "资料来源暂时无法访问，请稍后重试。"}${a.description ? " 已有介绍仍然保留。" : ""}`;
  if (lookup?.status === "uncertain")
    return `找到可能的同名专辑，尚无法可靠确认，暂未采用介绍。${a.description ? " 已保留原有介绍。" : ""}`;
  if (lookup?.status === "not-found")
    return a.description
      ? "本次未找到可靠更新，已保留原有介绍。"
      : "未找到可核实的专辑介绍，可以稍后重试。";
  if (a.description) return "介绍已保存在本机，可离线阅读。";
  return "尚未查询专辑介绍。";
}
function updateIntroductionStatus() {
  const job = library.introductions;
  const running = introductionsStarting || !!job?.running;
  const button = document.querySelector<HTMLButtonElement>(
    "#introduction-refresh",
  );
  if (button) {
    button.disabled = running || !apiAvailable || !library.albums.length;
    button.textContent = running
      ? "正在查询专辑介绍…"
      : "查询 / 更新专辑介绍 ↗";
  }
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-action="introduction-album"]',
  ))
    control.disabled = running || !apiAvailable;
  for (const feedback of document.querySelectorAll<HTMLElement>(
    "[data-introduction-feedback]",
  )) {
    const album = albums.find(
      (a) => a.id === feedback.dataset.introductionFeedback,
    );
    if (album)
      feedback.textContent = running
        ? "正在查询专辑介绍，已有资料仍可阅读。"
        : introductionAlbumStatus(album);
  }
  const progress = document.querySelector<HTMLProgressElement>(
    "#introduction-progress",
  );
  if (progress) {
    progress.hidden = !running;
    progress.max = Math.max(1, job?.total || 0);
    progress.value = job?.completed || 0;
    if (introductionsStarting && !job?.running)
      progress.removeAttribute("value");
  }
  const missing = library.albums.filter((album) => !album.description?.trim());
  const coverage = document.querySelector<HTMLElement>(
    "#introduction-coverage",
  );
  if (coverage)
    coverage.textContent = `已有介绍 ${library.albums.length - missing.length} / ${library.albums.length} 张 · 尚缺 ${missing.length} 张`;
  const status = document.querySelector<HTMLElement>("#introduction-status");
  if (status)
    status.textContent = !apiAvailable
      ? "本地音乐服务尚未连接，连接后可查询介绍。"
      : introductionRequestError
        ? `无法开始查询：${introductionRequestError}`
        : !library.albums.length
          ? "扫描本地音乐文件夹后，即可查询专辑介绍。"
          : introductionsStarting
            ? "正在提交专辑介绍查询…"
            : job?.running
              ? `已处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张${job.currentAlbum ? `\n正在查询：${job.currentAlbum}` : ""}`
              : job?.error
                ? `查询未完成：${job.error}`
                : job && job.total > 0
                  ? `上次查询：处理 ${job.completed} / ${job.total} 张 · 更新 ${job.updated} 张 · 未找到可靠资料 ${job.notFound} 张 · 查询失败 ${job.failed} 张`
                  : "查询会核对专辑、歌手与年份；无法确认的结果不会覆盖已有介绍。";
  const details = document.querySelector<HTMLDetailsElement>(
    "#introduction-missing",
  );
  if (details) {
    details.hidden = !missing.length;
    details.querySelector("summary")!.textContent =
      `查看尚缺介绍的 ${missing.length} 张专辑`;
    details.querySelector("ul")!.innerHTML = missing
      .map(
        (album) =>
          `<li><strong>${esc(album.title)}</strong><span>${esc(album.artist)} · ${esc(introductionAlbumStatus(album))}</span></li>`,
      )
      .join("");
  }
}
function producerBlock(a: MusicAlbum) {
  return `<section class="producer-section"><div><small>ALBUM CREDITS / 制作人员</small>${!demo ? '<button data-action="enrich-album">补充在线资料 ↗</button>' : ""}</div>${a.producers.length ? `<dl>${a.producers.map((p) => `<div><dt>${esc(p.role)}${p.trackTitle ? ` · ${esc(p.trackTitle)}` : ""}</dt><dd>${esc(p.name)}</dd></div>`).join("")}</dl>` : "<p>暂无制作资料。本地标签优先，MusicBrainz 资料可查询并缓存在本机。</p>"}${a.online?.status === "uncertain" ? "<p>找到多个可能的发行版本，暂未自动采用资料。</p>" : ""}${a.online?.error ? `<p>${esc(a.online.error)}</p>` : ""}</section>`;
}
function updatePlayingRows() {
  document
    .querySelectorAll<HTMLButtonElement>("[data-track]")
    .forEach((row) => {
      const active = row.dataset.track === playerState?.currentTrack?.id;
      row.classList.toggle("playing", active);
      row.setAttribute("aria-current", String(active));
    });
}
let lastPlayerError = "";
const transportTitleMotion = setupTransportTitle(
  $<HTMLButtonElement>("#transport-track"),
  $("#transport-track-label"),
);
transportTitleMotion.setReduced(preferences.reduced);
/**
 * R60：在线歌词匹配的注入点。三条刻意的设计——
 * ① 每次匹配前先读快照里的 `onlineLyrics.enabled`：默认关闭时这里直接回 null（零请求），
 *    而且开关是**即时生效**的，不必重建 client；
 * ② 只有"这首曲目完全没有歌词，或只有无时间轴的内嵌纯文本"才会走到这里
 *    （6.6：服务端另有 `localLyric.timed` 把关位，两处都挡；带时间轴的本地词绝对优先）；
 * ③ 任何异常都归一成"未命中 + 原因"，客户端那条 upgrade promise 永不 reject。
 */
type OnlineReply = OnlineMatchOutcome & {
  trackId?: string;
  localLyrics?: "present" | "untimed" | "absent";
  near?: OnlineNearCandidate[];
  claim?: { provider?: string; title?: string; artist?: string; claimedAt?: string };
  claimFailed?: string;
  error?: string;
};
/**
 * F4：在线曲目不在本地索引里，服务端要凭随请求带来的描述字段去匹配（服务端逐项校验，见 online-lyrics.mjs）。
 * R144：客户端与「歌词匹配」面板**共用这一份构造**——两处各拼一次就会有一处忘了带 album。
 */
function onlineLyricDescriptor(track: MusicTrack) {
  return track.sourceKind === "online"
    ? { online: { title: track.title, artist: track.artist, album: track.album ?? "", durationMs: Math.round((track.duration ?? 0) * 1000) } }
    : {};
}
const lyricsClient = createLyricsClient({
  online: {
    match: async (track) => {
      if (!library.onlineLyrics?.enabled) return null;
      try {
        const response = await fetch("/api/online/lyrics/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trackId: track.id, ...onlineLyricDescriptor(track) }),
        });
        const payload = (await response.json().catch(() => null)) as OnlineReply | null;
        if (!response.ok) {
          return { matched: false, reason: payload?.error ?? `在线匹配请求失败（HTTP ${response.status}）` };
        }
        if (payload?.localLyrics === "present") {
          return { matched: false, reason: payload.reason ?? "本地已有带时间轴的歌词，未发起在线请求" };
        }
        return payload ?? { matched: false, reason: "在线匹配没有返回结果" };
      } catch (error) {
        return { matched: false, reason: `在线匹配请求失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  },
});
const lyricStage = createLyricStage({
  root: $("#lyric-stage"),
  client: lyricsClient,
  player,
  reduced: () => preferences.reduced,
  pulseTier: () => preferences.lyricPulse,
  // 封面链与岛（feedSong）同一条：先认**正在播放的曲目**——本地按 `track.albumId` 找它所属专辑
  // （R38 口径，不用界面选中专辑），在线退到它自带的同源封面；没在播才退到档案架选中的那张。
  // 旧实现让"架子上选中的专辑"顶掉了播放曲目：播在线曲目时模糊底与取色都是错的那张（R202-F3）。
  cover: () => {
    const t = player.state.currentTrack ?? null;
    const a = t ? albums.find((al) => al.id === t.albumId) : undefined;
    return a?.coverUrl ?? t?.coverUrl ?? currentAlbum()?.coverUrl;
  },
  intensity: () => preferences.lyricIntensity,
  theme: () => preferences.theme,
});
/**
 * Folia 岛（移植第一期）：适配层 + 主题桥 + 懒加载挂载。
 * 岛加载/挂载失败时回退自研 lyric-stage（data-folia-view="legacy" + 可读原因），
 * 与集成设计 §3.2 的降级路径一致。
 */
let islandHandle: IslandHandle | null = null;
const refreshHostThemeOnly = installHostThemeBridge({
  intensity: () => preferences.lyricIntensity,
  themeName: () => preferences.theme,
});
/**
 * R189：主题换档会改 `isDaylight`，而辉光/雾的缺省打折是**按亮底生效**的 ⇒ 换档必须重算一遍。
 * 两件事一次做完（只重算不重喂 = "面板显示 0.60、画面还是 1.00"）：
 *  ① 重喂岛（`feedFoliaTunings` 读 store 里的 isDaylight）；
 *  ② 面板开着就重画（滑杆显示值来自 getTuning，不刷就是"主题换了、滑杆没动"）。
 * 启动路径上 `islandHandle` 还是 null、面板模块也没加载 ⇒ 两处都是 no-op，不会撞 TDZ。
 */
function refreshHostTheme(): void {
  refreshHostThemeOnly();
  feedFoliaTunings();
  if (modeSettingsModule) void modeSettingsModule.then((m) => m.refreshModeSettings(foliaModeSettingsOptions()));
}
let islandState: "off" | "loading" | "on" | "failed" = "off";
/**
 * R203（Task 4）：岛挂载失败那句话**只在失败刚开始那一次报**。
 * 为什么必须有这道闸（不是防御性代码）：`syncFoliaIsland` 的既有形状是"状态不是 on/loading 就再试一次"，
 * 而帧循环每帧都问一遍 ⇒ 一旦 failed，**每一帧**都会重挂一次、每一帧都进一次 catch。
 * 不加这道闸，我刚补的那次 `updateStatus()` 就变成每帧重写状态行——这一档要无人值守挂很久，那是白烧。
 * 挂载成功时把闸重新打开：以后真再坏一次，还得再说得出。
 */
let islandFailureAnnounced = false;
/**
 * R162（任务九）音乐人网格：数据由宿主算，岛只画。
 * 这三格必须声明在这里（`lyricViewWanted`、帧循环、命令表都会读它们）——
 * 模块级绑定声明晚于使用就是 R103 / R161 那两条 TDZ 的复发面。
 */
let artistGridModel: ArtistGridModel | null = null;
/** 网格是不是当前那块画面：它依附岛，开着就该把屏幕交给岛，退出要能自动退回架子。 */
let artistGridViewActive = false;
/** 岛是异步挂载的：喂料先记这一格，挂载完成那一帧再冲出去（不然就是"喂给了一个还不存在的岛"）。 */
let artistGridPending: ArtistGridFeed | null = null;
function syncFoliaIsland(wanted: boolean) {
  const island = $("#folia-island");
  if (!wanted) {
    if (islandState === "on") islandHandle?.unmount();
    islandHandle = null;
    islandState = "off";
    // 岛一卸装就把自己的存储清回空（island.tsx 的 unmount），宿主页面上此刻什么都不再喂它。
    // "已喂"记录必须跟着作废，否则重挂后每一帧都被门判成"没变"⇒ 墙是空的、词也不回来。
    foliaFeed.invalidate();
    // R202：离开岛视图 ⇒ 模糊层收干净（它是画面之下的一层，站在档案架上不该留着）。
    foliaBackdrop?.reset();
    foliaBackdrop = null;
    stage.dataset.foliaView = "legacy";
    island.hidden = true;
    syncFoliaLayoutButton();
    return;
  }
  if (islandState === "on" || islandState === "loading") return;
  islandState = "loading";
  void import("./folia-host/island")
    .then((m) => {
      // R23：适配层在岛 chunk 内创建，信号写入与订阅同模块实例。
      islandHandle = m.mountFoliaIsland(island, {
        player,
        pulse: () => ({ spectrum: () => lyricStage.pulseSpectrum() }),
        lyricOffsetMs: () => 0,
        // R36（第二期）：封面墙的返回键要把偏好写回宿主。
        onLayoutChange: (layout) => {
          // R162：网格里按返回/Esc 要求回 classic —— 顺带把"网格开着"这一档关掉，
          // 屏幕之后该不该继续给岛，交回 lyricViewWanted 原来那套判据重算。
          if (artistGridViewActive && layout !== "artistGrid") closeArtistGrid();
          // 网格是**会话内视图**，不进偏好：重启后没有任何数据能让它成立（明细要点开一位音乐人才取）。
          if (layout !== "artistGrid" && preferences.foliaView !== layout) {
            preferences.foliaView = layout;
            savePrefs();
          }
          syncFoliaLayoutButton();
        },
        // R131：岛内工具面板那颗按钮写的请求，由这里的面板来回答。
        // R134（Q10 批复）：上游预置的 `queue` 现在是一条真命令 ⇒ 直接开队列那一档列表，
        // 不再"只开面板忽略 id"；其余认不出的 id 仍然只开命令表，不猜"最接近的那条"。
        onCommandPaletteRequest: (commandId) => {
          if (commandId === ISLAND_QUEUE_REQUEST) { openQueuePalette(); return; }
          mountCommandPalette();
          paletteSource = "commands";
          commandPalette.openPalette();
        },
        // R109：岛内那颗循环/随机按钮改的是内核那一份模式，偏好要跟着落盘（与返回键同一处理方式：
        // 动作在内核，持久化回宿主，两处都不自己另存一份状态）。
        notifyPlaybackMode: (mode) => {
          if (preferences.playbackMode !== mode) {
            preferences.playbackMode = mode;
            savePrefs();
          }
        },
        // R130：岛内那颗「喜欢」转交宿主 —— 收藏是本机一份 JSON，岛不持有数据，只有一份用来重渲染的读数。
        songLiked: () => favoriteLiked === true,
        toggleSongLike: () => void toggleFavorite(),
        // R131：上游预留的命令口子接到本批的面板表上（同一张表 ⇒ 面板里看得见的，岛里才按得动）。
        invokeCommand: (commandId) => {
          if (!commandPalette.runById(commandId)) notify("这条命令现在不可用（可能状态已经变了）。");
        },
        canInvokeCommand: (commandId) => commandPalette.canRun(commandId),
        // R162：音乐人网格的三个动作。岛只往上送 id，权威（曲库、队列、取数）全在宿主这一侧。
        playArtistGridTrack: (songId) => playArtistGridTrack(songId),
        playArtistGridAlbum: (albumId) => playArtistGridAlbum(albumId),
        addArtistGridToQueue: (songIds) => addArtistGridToQueue(songIds),
        // 单曲那一颗走的是同一条追加通路（同一份回执、同一条去重判据），不另写一套。
        addArtistGridTrackToQueue: (songId) => addArtistGridToQueue([songId]),
      });
      islandState = "on";
      // R203：挂上了就把那句"失败"的话收回（下一次真再挂不上时，那句话还得能再说一遍）。
      islandFailureAnnounced = false;
      // R162：岛是异步挂的 —— 如果在它挂好之前用户就点了「网格视图」，那份描述符先记在 pending 上，
      // 这里补一次即可（重挂也走同一条：岛的存储回到空，宿主手里的 model 才是那一份真相）。
      if (artistGridViewActive && artistGridModel) artistGridPending = artistGridModel.feed;
      stage.dataset.foliaView = "island";
      island.hidden = false;
      // R179：岛刚现身就量一次顶部带（并观察它）——晚一步就会有一帧内容压在导航带下面。
      watchFoliaSafeTop();
      refreshHostTheme();
      if (islandHandle) {
        // 挂载完成这一处也要作废：卸装与挂载之间岛换了身子（新建 root、岛存储回默认），
        // 而宿主这四个缓存记的还是上一副身子的"已喂"。两处都清，重挂后第一帧就是全量补喂。
        foliaFeed.invalidate();
        feedFoliaIsland();
        // R162（真机抓到的一处，离线全绿）：这一次 setLayout 会经 onLayoutChange 回灌宿主，
        // 而"网格里要求回 classic"正是我那条退出判据的形状 ⇒ 挂载时恢复偏好的那一跳
        // 会把用户刚点开的网格当场关掉（表现：点了没反应，画面回到歌词面）。
        // 网格开着时不恢复偏好——布局由 flushArtistGridFeed 那一条说了算。
        if (!artistGridViewActive) islandHandle.setLayout(preferences.foliaView);
        islandHandle.setMode(preferences.foliaMode);
        // R173（Q51）：挂载之后要把已存的参数补喂一次——不补就是"偏好里有、岛拿默认值"，
        // 与 R118（卸装即回空而宿主缓存不失效）同一族。
        feedFoliaTunings();        syncFoliaLayoutButton();   // R63：挂载后立刻把布局同步到 #stage 的 data 属性上
        // R203：外壳读数也要在挂载完成这一处补推一次——岛新建的 root 从缺省 false 起步，
        // 而空闲计时器只在"变档那一刻"回调，挂载时正好闲着就没人推 ⇒ 又是一处"偏好里有、岛拿缺省"（R118 / R173 同族）。
        islandHandle.setPlayerChromeHidden(islandChromeHidden());
      }
    })
    .catch((error) => {
      islandState = "failed";
      stage.dataset.foliaView = "legacy";
      island.hidden = true;
      island.dataset.fallback = error instanceof Error ? error.message : "island-mount-failed";
      syncFoliaLayoutButton();
      // R203（Task 4）：降级路径本身是既有的，缺的是**说出来**——不补这一次状态刷新，用户只会看到
      // 画面换了个长相、一句话不报（这一档将来是挂在墙上的，没人会去开控制台）。
      // 闸只放一次：帧循环会每帧重试挂载，不设闸就是每帧重写一次状态行。
      if (!islandFailureAnnounced) {
        islandFailureAnnounced = true;
        updateStatus();
      }
    });
}
/** 宿主侧的"岛已经收过哪一份"。卸装与挂载完成两处都要作废它（见 feed-gate.ts 头部）。 */
const foliaFeed = createFoliaFeedGate();
/**
 * R202：背景模糊层。宿主侧、画面之下的一层；参数由 `preferences.backdrop`（用户改过的格）与
 * 主题缺省（`resolveBackdrop`）当场合成 —— 换主题时没改过的格跟着主题走。
 * 只在岛视图里 update；离开岛视图时收干净（`backdropActive` 的 off 那一档）。
 */
let foliaBackdrop: FoliaBackdropHandle | null = null;
function currentBackdropParams() {
  return resolveBackdrop(useHostThemeStore.getState().isDaylight, preferences.backdrop);
}
/**
 * 封面档的来源：**正在播放的曲目优先**（原始需求原话"把当前播放曲目的封面作为这层模糊图的来源"）——
 * 本地走它所属的专辑（R38 口径：按 `track.albumId` 查，**不用界面选中专辑**，跨专辑时两者会错位），
 * 在线退到它自带的那张同源封面；没在播才退到档案架选中的那张（等待态也有东西垫）。
 * 旧实现在线曲目会被"架子上选中的专辑"顶掉（用户实报：播 Candy 却糊出黑马那张，R202-F3）。
 */
function currentBackdropCover(): string | null {
  const track = playerState?.currentTrack ?? null;
  const album = track ? albumOf(track) : undefined;
  return album?.coverUrl ?? track?.coverUrl ?? currentAlbum()?.coverUrl ?? null;
}
/**
 * 屏幕上真的在渲染哪个布局：岛挂着就以岛存储为唯一真相（驱动像素的是它），
 * 岛不在时回落到宿主偏好（那正是下次挂载会渲染的东西，此刻屏幕上也确实没有岛）。
 * 看板 c980fa6 嫌疑③：按钮文案读偏好、渲染读岛存储、点击按偏好算 next，三份真相脱钩就是
 * "点了没反应"。现在文案、DOM 属性、点击算 next 全部只经这一个入口，偏好只负责持久化。
 */
const currentFoliaLayout = (): IslandLayout => islandHandle?.getLayout() ?? preferences.foliaView;
/** R38（第二期）：曲目→专辑按 track.albumId 查，不再用界面选中专辑——封面墙的队列跨专辑时两者会错位。 */
const albumOf = (track: MusicTrack) => albums.find((a) => a.id === track.albumId);
function toFoliaSong(track: MusicTrack): SongResult {
  const album = albumOf(track);
  return {
    id: track.id,
    name: track.title,
    artists: [{ name: track.artist }],
    album: album ? { id: album.id, name: album.title, coverUrl: album.coverUrl } : null,
    // R130：`sourceRef` 要显式给。上游 `getPlaybackSourceRef` 的兜底分支是"认不出来就当在线曲目"
    //（appPlaybackGuards.ts:63-70），而我们的 SongResult 从来没带过这个字段 ⇒
    // 本地曲目在岛里被判成 online，收藏那颗因此恒灰（真机抓到的就是这个）。
    sourceRef: track.sourceKind === "online"
      ? { kind: "online", providerId: (track.provider ?? "netease") as "netease", mediaId: track.id }
      : { kind: "local", mediaId: track.id },
    // 跳③（看板 95fe081）：在线曲目没有本地专辑分组（上面那格是 null），封面挂在曲目自己身上，
    // 值已经是服务端换算好的同源地址。缺这一格就是用户报的"歌单播放时封面墙没有封面"。
    ...(track.coverUrl ? { coverUrl: track.coverUrl } : {}),
    durationMs: Math.round(track.duration * 1000),
  };
}
function feedFoliaIsland() {
  if (!islandHandle) return;
  const track = playerState?.currentTrack ?? null;
  if (foliaFeed.takeSong(track)) {
    const album = track ? albumOf(track) : undefined;
    islandHandle.feedSong(
      track ? toFoliaSong(track) : null,
      // 与歌词面/封面档同一条链（R38 口径）：本地按 `track.albumId` 找**它所属**的专辑，
      // 在线退到自己那张同源封面（都没有才 null，岛画占位）。界面选中专辑在这条链里没有位置。
      album?.coverUrl ?? track?.coverUrl ?? null,
      track?.duration ?? 0,
    );
  }
  // 封面墙的行列只由播放队列决定（上游 latticeModel 的口径）。引用与签名的两层门在 feed-gate 里。
  const queue = playerState?.queue ?? [];
  if (foliaFeed.takeQueue(queue)) islandHandle.feedQueue(queue.map(toFoliaSong));
  // R128（Q1）：传输态以前**一个调用方都没有**，岛里那份 playerState 永远停在 IDLE ——
  // 表现是"正在播的那张卡上播放键一直是 ▶"，以及岛内一切按 paused 判的东西都不成立。
  // 换算（内核五档 → 岛三档）留在适配层，这里只负责"变了才再说一遍"。
  const transport = playerState?.transport ?? "idle";
  if (foliaFeed.takeTransport(transport)) {
    islandHandle.feedTransport(transport === "playing", transport === "paused");
  }
  const data = lyricStage.lyricData();
  if (foliaFeed.takeLyrics(data)) {
    islandHandle.feedLyrics((data ?? null) as LyricData | null);
    refreshHostTheme();
  }
  // R202：背景模糊层一帧一更（`update` 内部只在任一格变了时才写 DOM；封面解码是一次性、不进逐帧路径）。
  if (!foliaBackdrop) foliaBackdrop = createFoliaBackdrop();
  foliaBackdrop.update(currentBackdropParams(), currentBackdropCover());
}
/**
 * 墙上「重取封面」（R126 · 方案 A）。岛只发一个事件，出网与如实汇报都留在宿主：
 * 岛不持有播放权，也不该持有"要不要出网"的决定权。
 * 按曲目 id 去重：那颗按钮没有"进行中"的视觉状态（墙上的格子会随队列重建），
 * 所以连点两下不该打两次网——服务端那侧的判据（同身份逐字 + 真取到图）才是权威。
 */
const coverRetryPending = new Set<string>();
interface CoverRetryDetail {
  id?: string;
  title?: string;
  artist?: string;
  /** R146：这一首的时长（毫秒）。缺它就没有"另一家同一首"那条回落的证据。 */
  durationMs?: number;
}
interface CoverRetryReply {
  ok?: boolean;
  coverUrl?: string;
  reason?: string;
  error?: string;
  updated?: number;
  /** 图是另一家给的时候，服务端把那一家的名字带回来（徽标与提示都要说得出图是谁给的）。 */
  coverFrom?: string;
}
async function retryOnlineCover(detail: CoverRetryDetail) {
  const id = String(detail?.id ?? "");
  if (!id || coverRetryPending.has(id)) return;
  coverRetryPending.add(id);
  notify("正在按这一首的身份重问封面…");
  try {
    const response = await fetch("/api/online/covers/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trackId: id, title: String(detail.title ?? ""), artist: String(detail.artist ?? ""),
        durationMs: Number(detail.durationMs ?? 0),
      }),
    });
    const payload = (await response.json().catch(() => null)) as CoverRetryReply | null;
    // 回执分三档说实话：请求没成 / 服务端说没补到（带原因）/ 补到了但这一首已不在队列。
    if (!response.ok) {
      notify(payload?.error ?? `重取封面的请求失败（HTTP ${response.status}）`);
      return;
    }
    if (payload?.ok !== true || !payload.coverUrl) {
      notify(`没取到封面：${payload?.reason ?? "服务端没给原因"}`);
      return;
    }
    const touched = player.applyTrackCover(id, payload.coverUrl);
    const where = payload.updated
      ? `写回 ${payload.updated} 条匹配缓存，重启后还在`
      : "这一首不在任何匹配缓存里，只在这次会话里显示";
    // R146：图来自另一家时说明白——不然用户会以为"匹配那一家本来就有图，是程序没取到"。
    const from = payload.coverFrom ? `（这张图是 ${ONLINE_PROVIDER_LABELS[payload.coverFrom as keyof typeof ONLINE_PROVIDER_LABELS] ?? payload.coverFrom} 给的，匹配那一首自己没给封面地址）` : "";
    notify(touched
      ? `封面已补上${from}（${where}）`
      : "封面已取到，但这一首不在队列里了（墙上那一格不会变）");
  } catch {
    notify("重取封面失败：与本机服务的请求没完成");
  } finally {
    coverRetryPending.delete(id);
  }
}
document.addEventListener("rhine:cover-retry", (event) => {
  void retryOnlineCover((event as CustomEvent<CoverRetryDetail>).detail ?? {});
});
/**
 * R130 收藏 / 喜欢。
 * **键由服务端算，界面只送身份字段** —— 指纹算法（归一 + 哈希）住在 `scripts/favorites.mjs` 一处，
 * 前端再实现一遍就是第二个真相，而且两边一定会漂（服务端换了归一规则，收藏会整批失联而界面毫无察觉）。
 * 代价是换歌时多一次本机请求（读一个 JSON，亚毫秒级），换来的是"是否已收藏"这个判断只有一个出处。
 */
interface FavoriteIdentity {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  sourceKind?: string;
  /** 同源封面地址（R135/Q11）。服务端拿它反解回原地址；反解不出就不存。 */
  coverUrl?: string;
}
function favoriteIdentity(track: MusicTrack | null | undefined): FavoriteIdentity | null {
  if (!track) return null;
  return {
    id: track.id, title: track.title, artist: track.artist,
    ...(track.album ? { album: track.album } : {}),
    durationMs: Math.round((track.duration ?? 0) * 1000),
    sourceKind: track.sourceKind ?? "local",
    // R135（Q11）：在线曲目把**同源**封面地址一起送过去，服务端拿它反解回原地址存进清单。
    // 这条地址本来就出不了我们自己的域名，前端也拿不到第三方那条（见 music-server 的换算两行）。
    ...(track.coverUrl ? { coverUrl: track.coverUrl } : {}),
  };
}
/** null = 不知道（清单读不出来）。不知道就要禁用按钮，而不是画成"未收藏"——那是把失败说成事实。 */
let favoriteLiked: boolean | null = null;
let favoriteCheckToken = 0;
let favoritePending = false;
let favoriteTrackId = "";
function syncFavoriteButton() {
  const button = $<HTMLButtonElement>("#favorite-toggle");
  if (!button) return;
  const known = favoriteLiked !== null;
  const hasTrack = Boolean(player.state.currentTrack);
  button.disabled = !known || !hasTrack || favoritePending;
  button.setAttribute("aria-pressed", String(favoriteLiked === true));
  // 三种"点不动"要分得开：没放歌 / 清单读不到 / 正在请求中。都写成"暂时读不到"就是把没做的事说成做不了。
  const label = !hasTrack ? "收藏（先放一首歌）"
    : !known ? "收藏（本机清单没读到，暂时不可用）"
    : favoritePending ? "收藏处理中…"
    : favoriteLiked ? "取消收藏" : "收藏这首";
  button.setAttribute("aria-label", label);
  button.title = hasTrack ? `${label} · 收藏只写在本机文件里，不上传` : label;
  button.dataset.liked = String(favoriteLiked === true);
  // 岛里那份读数只在"宿主问完服务端"的这一刻更新：两处按钮因此永远说同一句话。
  islandHandle?.setSongLiked(favoriteLiked === true);
}
async function refreshFavoriteState(track: MusicTrack | null) {
  const identity = favoriteIdentity(track);
  if (!identity) {
    favoriteLiked = null;
    syncFavoriteButton();
    return;
  }
  const token = ++favoriteCheckToken;
  try {
    const data = await request<{ liked: boolean }>("/api/favorites", { action: "check", track: identity });
    if (token !== favoriteCheckToken) return;   // 换歌换得快：旧的回执不许覆盖新的
    favoriteLiked = data.liked === true;
  } catch {
    if (token === favoriteCheckToken) favoriteLiked = null;
  }
  syncFavoriteButton();
}
async function toggleFavorite() {
  const track = player.state.currentTrack;
  const identity = favoriteIdentity(track);
  if (!track || !identity) {
    notify("先放一首歌再收藏（收藏的对象是「正在播的这一首」）");
    return;
  }
  if (favoritePending) return;
  favoritePending = true;
  syncFavoriteButton();
  try {
    const data = await request<{ liked: boolean; count: number }>("/api/favorites", { action: "toggle", track: identity });
    favoriteLiked = data.liked === true;
    syncFavoriteButton();   // 里面会把新读数一并推给岛
    notify(data.liked ? `已收藏「${track.title}」（本机共 ${data.count} 条）` : `已取消收藏「${track.title}」（本机共 ${data.count} 条）`);
  } catch (error) {
    notify(`收藏失败：${(error as Error).message}`);
  } finally {
    favoritePending = false;
    syncFavoriteButton();
  }
}
/**
 * R131 命令面板（候选 ⑤ 的最后一项）。表在这里、DOM 与键盘路由也在这里；纯状态机在 `command-palette.ts`。
 * 三条讲究：① 每条命令都只是**转发一个已经存在的宿主动作**，本文件不实现新行为；
 * ② 可用性写成谓词（不是常量），所以"没有当前曲目"时那几条播放命令根本不会出现在面板里；
 * ③ 岛内 `invokeCommandById` 读的是同一张表 ⇒ 面板里看得见的，岛里才按得动（反之亦然）。
 */
/**
 * R134（Q10 批复）：面板可以喂两种列表——命令表 与 当前播放队列。
 * 这个名字声明在命令表之前：表里那一行的 `run` 是闭包（求值时才碰），但同一批的偏好校验要读它，
 * 声明在后面就是 TDZ（M3-b 那条 `player.subscribe` 回调的同一课，别再犯一次）。
 */
/** 岛内那颗按钮预置的 id（移植件写死传 'queue'，见 LatticeFocusButton 的 openCommandPaletteCommand）。 */
const ISLAND_QUEUE_REQUEST = "queue";
let paletteSource: "commands" | "queue" = "commands";
const commandDefinitions: Command[] = [
  { id: "play-pause", title: "播放 / 暂停", hint: "空格键的另一种入口", keywords: "play pause bofang zanting", group: "播放",
    available: () => Boolean(player.state.currentTrack), run: () => void player.toggle() },
  { id: "track-next", title: "下一首", hint: "按当前播放模式挑下一首", keywords: "next xiayisou skip", group: "播放",
    available: () => player.state.queue.length > 1, run: () => void player.next() },
  { id: "track-prev", title: "上一首", hint: "随机模式下沿这一轮的历史后退", keywords: "previous shangyisou", group: "播放",
    available: () => player.state.queue.length > 1, run: () => void player.previous() },
  { id: "stop", title: "停止播放", hint: "回到开头并停下（不是暂停）", keywords: "stop tingzhi", group: "播放",
    available: () => Boolean(player.state.currentTrack), run: () => player.stop() },
  { id: "playback-mode", title: "切换播放模式", hint: "顺序 / 列表循环 / 单曲循环 / 随机", keywords: "loop shuffle mode xunhuan suiji", group: "播放",
    available: () => true, run: () => { preferences.playbackMode = player.cyclePlaybackMode(); savePrefs(); notify(`播放模式：${PLAYBACK_MODE_NAMES[preferences.playbackMode].name}`); } },
  { id: "favorite-toggle", title: "收藏 / 取消收藏这一首", hint: "只写在本机文件里，不上传", keywords: "like heart collect shoucang", group: "播放",
    available: () => Boolean(player.state.currentTrack), run: () => void toggleFavorite() },
  { id: "locate-playing", title: "定位到正在播的专辑", hint: "把架子移到当前这张专辑", keywords: "locate current dingwei", group: "播放",
    available: () => Boolean(playerState?.currentTrack), run: () => { const track = playerState?.currentTrack; if (track) revealAlbum(track.albumId, track.id, { reuseOpenAlbum: true }); } },
  { id: "show-queue", title: "看整条队列", hint: "从任意一首接着播", keywords: "queue duilie 队列 list", group: "播放",
    available: () => player.state.queue.length > 0, run: () => openQueuePalette() },
  { id: "view-folia", title: "切到歌词面", hint: "演出视图的另一半", keywords: "lyrics page cige gequ", group: "视图",
    available: () => true, run: () => setDisplayMode("folia") },
  { id: "view-rhine", title: "切回演出面", hint: "Rhine 那套文字与封面", keywords: "rhine performance yanchu", group: "视图",
    available: () => true, run: () => setDisplayMode("rhine") },
  { id: "layout-wall", title: "歌词面 ↔ 封面墙", hint: "整条播放队列铺成海报墙", keywords: "wall lattice fengmianqiang", group: "视图",
    available: () => islandState === "on" && displayMode === "folia", run: () => { if (!islandHandle) return; islandHandle.setLayout(currentFoliaLayout() === "lattice" ? "classic" : "lattice"); } },
  // R162（任务九）：一位音乐人的浏览面。可用性只认"手上有没有一份能画的数据"——
  // 在线组要点开过（⑨那份明细在手上），本地要选中过一张专辑（按它的歌手署名取组）。
  { id: "artist-grid", title: "以网格看这位音乐人", hint: "头像 + 说明 + 热门曲目 + 专辑（六边形无限画布）",
    keywords: "artist grid wangge yinyueren lattice", group: "视图",
    available: () => Boolean(artistDetail) || Boolean(currentAlbum()), run: () => openArtistGrid() },
  { id: "mode-detail", title: "打开当前专辑", hint: "进入详情面", keywords: "detail album zhuanji", group: "视图",
    available: () => Boolean(currentAlbum()), run: () => setMode("detail") },  { id: "mode-archive", title: "回到专辑架", hint: "退出详情面", keywords: "archive架 shelve jia", group: "视图",
    available: () => true, run: () => setMode("archive") },
  { id: "theme-day", title: "主题：暖昼", hint: "暖白玻璃与日光", keywords: "theme day light rizhou", group: "视图",
    available: () => preferences.theme !== "day", run: () => setTheme("day") },
  { id: "theme-dusk", title: "主题：黄昏", hint: "薄暮冷灰与暖调聚光", keywords: "theme dusk twilight huanghun", group: "视图",
    available: () => preferences.theme !== "dusk", run: () => setTheme("dusk") },
  { id: "theme-night", title: "主题：深夜", hint: "极简星空与透光白卡", keywords: "theme night dark shenye", group: "视图",
    available: () => preferences.theme !== "night", run: () => setTheme("night") },
  { id: "open-library", title: "打开音乐库", hint: "根目录与扫描", keywords: "library ku", group: "浏览",
    available: () => true, run: () => openPanel("library") },
  { id: "open-search", title: "打开搜索", hint: "本地与在线两页", keywords: "search sousuo", group: "浏览",
    available: () => true, run: () => openPanel("search") },
  { id: "open-playlists", title: "打开歌单", hint: "本机文本歌单", keywords: "playlist gedan", group: "浏览",
    available: () => true, run: () => openPanel("playlists") },
  { id: "open-favorites", title: "打开收藏", hint: "本机收藏清单（含播不了的）", keywords: "favorites like heart shoucang", group: "浏览",
    available: () => true, run: () => openPanel("favorites") },
  { id: "open-settings", title: "打开设置", hint: "播放、画质与在线能力", keywords: "settings shezhi", group: "浏览",
    available: () => true, run: () => openPanel("settings") },
  // R144：歌词没配上时的出路。可用性判据是"有一首在播的歌"——面板要对着某首歌问，没有对象就不显示。
  { id: "open-lyric-match", title: "歌词匹配…", hint: "重试，或从接近的候选里手工指定一首", keywords: "lyric gecai ci pipei claim renling", group: "浏览",
    available: () => Boolean(player.state.currentTrack), run: () => openPanel("lyrics") },
  { id: "rescan", title: "重新扫描曲库", hint: "全盘重扫，命中缓存时很快", keywords: "rescan scan saomiao", group: "本机",
    available: () => true, run: () => void scan() },
  { id: "covers-refresh", title: "补一次在线封面", hint: "只补当前没有封面的专辑", keywords: "cover fengmian backfill", group: "本机",
    available: () => library.online?.covers !== false, run: () => void refreshCovers() },
];
/**
 * 同一台状态机喂两种列表（R134 · Q10 批复）：命令表 与 当前播放队列。
 * 切换只改"这一帧该列哪一份"——过滤、光标、↑↓、Enter、Esc、转义、滚动全部共用。
 * 队列那一档若另起一块面板，就会有两套键盘处理，两套迟早漂（而且岛里那颗按钮要连两件事）。
 * （`ISLAND_QUEUE_REQUEST` 与 `paletteSource` 声明在命令表之前，理由见那里的注释。）
 */

/**
 * 队列第 k 首 → 一条"命令"。`run` 是**以整条队列继续、从这一首起播**（R114 那套语义：
 * 全量入队、回执读内核队列实际长度），不是单首队列——跳播之后 ↑↓ 与四档模式都还得有邻居。
 * id 里带上下标：同一首歌在队列里可以出现两次，只按曲目 id 找会跳错格。
 */
function queueCommands(): Command[] {
  const queue = player.state.queue;
  return queue.map((track, index) => ({
    id: `queue-row:${index}:${track.id}`,
    title: track.title,
    hint: `第 ${index + 1} 首 · ${track.artist}${index === player.state.currentIndex ? " · 正在播放" : ""}`,
    keywords: `${track.artist} ${track.album ?? ""} queue duilie 队列`,
    group: "队列",
    available: () => true,
    run: () => void jumpToQueueIndex(index, track.id),
  }));
}

/** 列表是上一次渲染时的那一份：队列可能已经变了，所以按下标跳之前要再对一次曲目 id。 */
async function jumpToQueueIndex(index: number, expectedId: string) {
  const queue = player.state.queue;
  const target = queue[index];
  if (!target) {
    notify(`队列现在只有 ${queue.length} 条，第 ${index + 1} 首已经不在了（队列刚变过），没有跳。`);
    return;
  }
  if (target.id !== expectedId) {
    notify(`第 ${index + 1} 首已经换成《${target.title}》了（队列刚变过），这次没有跳，请重新打开列表。`);
    return;
  }
  await player.play(target.id, queue).catch(() => undefined);
  notify(`跳到队列第 ${index + 1} 首 · 《${target.title}》（队列共 ${player.state.queue.length} 条）`);
}

function openQueuePalette() {
  mountCommandPalette();
  if (!player.state.queue.length) {
    notify("队列是空的：先放一首歌，再回来看整条队列。");
    return;
  }
  paletteSource = "queue";
  commandPalette.openPalette();
}

/**
 * R203（壁纸 surface M0）：这个 surface 的可用命令**白名单**（不是黑名单）。
 * 三条讲究：
 *  · **白名单式**：以后新加一条命令默认就**不进**这个 surface（与 `check-music-chain.mjs` 里
 *    R194 那条"只认白名单、不用排除法"同一个道理 —— 排除法会随着新命令漏掉新的越界面）。
 *  · 收的是"画面与本机播放"那一类：传输四件套、播放模式、收藏（岛内动作行本来就有这颗，
 *    M0 不裁既有画面能力）、看整条队列、歌词面 ↔ 封面墙、三档主题。
 *  · 排除的是"去处在外壳里 / 会拉面板数据 / 会动曲库与出网"那一类：六个 `open-*`、`rescan`、
 *    `covers-refresh`、`locate-playing`、`mode-detail` / `mode-archive`、`artist-grid`、
 *    `view-folia` / `view-rhine`（这一档的 `data-display` 是钉住的，见 `setDisplayMode`）。
 * 判据落在这**唯一一处**过滤（Task 2 判据③的可检对应物）；命令表本身一个字不改 ⇒ 主窗口逐字节不变。
 */
const SURFACE_COMMAND_IDS = new Set([
  "play-pause",
  "track-next",
  "track-prev",
  "stop",
  "playback-mode",
  "favorite-toggle",
  "show-queue",
  "layout-wall",
  "theme-day",
  "theme-dusk",
  "theme-night",
]);

const commandPalette = createCommandPalette({
  commands: () => (paletteSource === "queue"
    ? queueCommands()
    : isWallpaperSurface
      ? commandDefinitions.filter((command) => SURFACE_COMMAND_IDS.has(command.id))
      : commandDefinitions),
  render: renderCommandPalette,
  caption: () => (paletteSource === "queue" ? "队列" : "命令"),
  emptyText: () => (paletteSource === "queue"
    ? "队列里现在没有可跳的曲目。"
    : "现在没有可用的命令（先放一首歌，或清掉检索词）。"),
});
function renderCommandPalette() {
  const box = document.querySelector<HTMLElement>("#command-palette-list");
  if (box) box.innerHTML = commandPalette.markup();
  const overlay = document.querySelector<HTMLElement>("#command-palette");
  if (overlay) overlay.hidden = !commandPalette.isOpen();
  // 注意：**来源不在这里重置**。执行一条命令的顺序是"先关面板、再执行"（否则"打开设置面板"这类
  // 命令刚开起来的画面会被随后的关闭抹掉），而关闭会走到这里渲染一次——在这里改来源，
  // 紧接着的 `activate()` / `runById()` 就会去**另一份列表**里找那一行
  // （真机量到：从队列列表里"跳播第三行"执行成了命令表里的第三行 = 「上一首」）。
  // 来源只在两个"打开"的入口里定：`routeCommandKeys` 的 Ctrl+P 分支与 `openQueuePalette()`。
  const foot = document.querySelector<HTMLElement>(".command-foot");
  if (foot) {
    foot.textContent = paletteSource === "queue"
      ? "↑↓ 选择 · Enter 跳到那一首 · Esc 回命令表"
      : "↑↓ 选择 · Enter 执行 · Esc 关闭";
  }
  // 光标行必须看得见：列表超过一屏时（18 条命令全展开就有 68vh 装不下的时候），
  // 只改 class 不滚动的话，按 ↓ 到第 12 行时光标在卡片外面。
  document.querySelector<HTMLElement>("#command-palette-list .command-row.is-cursor")
    ?.scrollIntoView({ block: "nearest" });
  const input = document.querySelector<HTMLInputElement>("#command-palette-query");
  if (commandPalette.isOpen()) {
    // 提示语也要跟着当前那份列表走：队列那一档里写"输入命令名"就是一句假话（同一批里
    // 已经因为"文案留在过去"记过一次，不打算留第二处）。
    if (input) input.placeholder = paletteSource === "queue" ? "输入歌名或歌手（从队列里跳播）" : "输入命令名（拼音或英文也行）";
    input?.focus();
  } else if (input) input.value = "";
}
function mountCommandPalette() {
  if (document.querySelector("#command-palette")) return;
  const shell = document.createElement("div");
  shell.id = "command-palette";
  shell.hidden = true;
  shell.className = "command-overlay";
  shell.innerHTML =
    `<div class="command-scrim" data-action="command-close"></div>` +
    `<section class="command-panel" role="dialog" aria-modal="true" aria-label="命令面板">` +
    `<input id="command-palette-query" type="search" placeholder="输入命令名（拼音或英文也行）" aria-label="检索命令" autocomplete="off">` +
    `<div id="command-palette-list"></div>` +
    `<p class="command-foot">↑↓ 选择 · Enter 执行 · Esc 关闭</p></section>`;
  document.body.appendChild(shell);
  shell.addEventListener("input", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === "command-palette-query") commandPalette.setQuery(target.value);
  });
  shell.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    if (target.dataset.action === "command-close") { commandPalette.closePalette(); return; }
    if (target.dataset.action === "command-run") {
      const id = target.dataset.command ?? "";
      // 先关面板再执行：命令里就有"打开设置面板"这类会换画面的动作，先执行完再关会把刚开的面板一起关掉。
      commandPalette.closePalette();
      if (!commandPalette.runById(id)) notify("这条命令现在不可用（可能状态已经变了），请重新打开面板。");
    }
  });
}
/**
 * 键盘路由。用 capture 注册在**最前面**：`Ctrl+P` 在输入框聚焦时也要能开面板
 * （宿主那条 keydown 监听对输入框是直接 return 的，挂在它后面就永远收不到）。
 *
 * 面板吃掉按键时除 `preventDefault` 还要 `stopPropagation`：capture 阶段只拦默认动作、
 * 不拦同一条事件的其它监听器。真机量到过——按 Esc 关面板，宿主那条"Esc = 回到专辑架"
 * 也跟着执行了，岛一起被卸装（`music-app.ts` 里 `setMode("archive")` 那支）。
 */
function swallowCommandKey(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}
function routeCommandKeys(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "p") {
    swallowCommandKey(event);
    mountCommandPalette();
    if (commandPalette.isOpen()) commandPalette.closePalette();
    else {
      // 来源在**打开的那一刻**定：Ctrl+P 是"打开命令表"，队列那一档只由「看整条队列」这条命令
      // 或岛里那颗按钮进去（见 openQueuePalette）。放在关闭处就会与"先关后执行"打架。
      paletteSource = "commands";
      commandPalette.openPalette();
    }
    return;
  }
  if (!commandPalette.isOpen()) return;
  if (event.key === "Escape") { swallowCommandKey(event); commandPalette.closePalette(); return; }
  if (event.key === "ArrowDown") { swallowCommandKey(event); commandPalette.move(1); return; }
  if (event.key === "ArrowUp") { swallowCommandKey(event); commandPalette.move(-1); return; }
  if (event.key === "Enter") {
    swallowCommandKey(event);
    const current = commandPalette.current();
    commandPalette.closePalette();
    if (current && !commandPalette.activate()) notify("这条命令现在不可用（可能状态已经变了）。");
  }
}
document.addEventListener("keydown", routeCommandKeys, { capture: true });
/** R33（第二期）：布局切换只改偏好 + 岛内渲染，按钮文案由同一条 sync 通路回灌。 */
function syncFoliaLayoutButton() {
  // R63：布局落到 DOM 属性上，CSS 才能只在 classic 系放行宿主的段落与徽标
  //（封面墙不放行：墙的词画在展开卡内，浮一层满幅文字会压住海报）。
  stage.dataset.foliaLayout = currentFoliaLayout();
  if (playerState) syncTransportControls(playerState);
}
/** R47（第三期）：视觉模式切换。岛未挂载时只落偏好，下次挂载自动读到。 */
function setFoliaMode(next: FoliaMode) {
  if (!FOLIA_MODES.some((m) => m.id === next)) return;
  preferences.foliaMode = next;
  savePrefs();
  // R184：属性与岛内渲染同步落 —— 需要"按档放开安全区"的那三档靠它命中 CSS。
  stage.dataset.foliaMode = next;
  islandHandle?.setMode(next);
  document
    .querySelectorAll<HTMLButtonElement>("[data-action^='folia-mode-']")
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.action === `folia-mode-${next}`)));
  // R173（Q51）：换档之后"当前模式的参数"那一节要跟着换（面板容器还在，只是渲染的内容按新模式给）。
  mountFoliaModeSettings();
  notify(`视觉模式：${FOLIA_MODES.find((m) => m.id === next)?.name ?? next}`);
}
/** displayMode is a playback-view setting: browse always renders the Rhine array. */
/**
 * 歌词面该不该接管屏幕。本地曲目要先打开专辑详情（那里有封面与曲目列表一起展示）；
 * 在线曲目没有本地专辑可选——不在这里放行，就是"词取到了却永远不上屏"（F4）。
 */
function lyricViewWanted() {
  // R203（壁纸 surface M0）：这一档的存在意义就是"把屏幕交给岛"。下面那两条判据在服务端新载入的
  // 这一页里永远不成立（`data-mode` 是 archive、没走过"打开专辑"那一步），照原样判就是岛永不挂载、
  // 屏幕一片空白（Task 0 §0.4 逐条判定里最硬的一条）。
  if (isWallpaperSurface) return true;
  if (displayMode !== "folia") return false;
  // R162：音乐人网格依附同一台岛。它开着的时候屏幕就该交给岛，
  // 否则表现是"数据喂进去了、画面还在架子上"（网格自己没有任何入口能进）。
  if (artistGridViewActive) return true;
  return mode === "detail" || player.state.currentTrack?.sourceKind === "online";
}
/** 只在状态真的变了的那一次动舞台与悬浮条：帧循环每帧都会问一遍，在线曲目播完要能自动退回。 */
let lyricViewShown: boolean | null = null;
function applyLyricView() {
  const wanted = lyricViewWanted();
  if (wanted === lyricViewShown) return;
  lyricViewShown = wanted;
  lyricStage.setMode(wanted ? "folia" : "rhine");
  if (wanted) lyricStage.refresh();
  syncChromeReveal();
}
function setDisplayMode(next: DisplayMode) {
  // R203（壁纸 surface M0）：这一档的 `data-display` 是**定死的**，不是用户可切换的偏好。
  // 三条理由，缺一条都会写错：① 这一档的整个外壳隐藏 + 岛视图那组规则都挂在
  // `[data-display="folia"]` 上（R200 铺满 / R117 让位 / R195 去底），切回 rhine 就是一块既没有外壳
  // 也没有画面的空白；② 原路径会 `savePrefs()`，等于从这块"只画东西"的表面改掉了主窗口的显示模式偏好；
  // ③ 任务口径写的是这个 surface 不放"能改用户数据的入口"。故这里**先拒、并说得出为什么**（不许静默）。
  if (isWallpaperSurface) {
    // 不静默：按了就算按了，这一档要能说得出"这里不切模式"。那句话由 `updateStatus()` 那一处唯一作者给。
    displayModePinnedNotice = true;
    updateStatus();
    return;
  }
  const resolved = resolveDisplayMode(next);
  displayMode = resolved;
  preferences.displayMode = resolved;
  savePrefs();
  stage.dataset.display = resolved;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-action='mode-rhine'], [data-action='mode-folia']",
  ))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.action === `mode-${resolved}`),
    );
  if (mode === "detail") {
    lyricStage.setMode(resolved);
    if (resolved === "folia") lyricStage.refresh();
    lyricViewShown = resolved === "folia";
  } else {
    applyLyricView();
    if (resolved === "folia" && !lyricViewWanted()) notify("歌词模式将在打开专辑后生效");
  }
  syncChromeReveal();
}
stage.dataset.display = displayMode;
// Declared before subscribe: the listener runs synchronously on registration.
let progressDragging = false;
/**
 * 同上：`player.subscribe` 的回调在注册那一刻就同步跑一次，回调里引用的模块级绑定
 * **必须声明在这之前**，否则第一次调用撞的是 TDZ（`Cannot access 'x' before initialization`）。
 * M3-b 的徽标状态就漏过一次这条既有约定，被收口的真机控制台报错抓到（台账 R103）。
 */
let scopeTrackId = "";
/**
 * 沉浸视图的"活动浮现 / 空闲淡出"：顶栏与悬浮控制条共用这一个计时器。
 * 各起一个一定会漂，出现"顶栏还在、控制条已经消失"的割裂态。
 */
const chromeReveal = createIdleReveal({
  idleMs: 3000,
  onReveal: () => applyChrome(true),
  onHide: () => applyChrome(false),
  // 指针停在顶栏、控制条或那颗退出热点上时不收起；收起后它们 pointer-events:none，:hover 自然不成立。
  // R203（Task 3）把热点加进来的理由是**安全**不是手感：这一档静息 3 秒后 chrome 一收、热点跟着收，
  // 若是"慢慢把指针移到角上准备退出"，等待途中那颗会自己淡掉 ⇒ 三条退路里少了一条肉眼可见的。
  // 主窗口里那颗元素根本不存在 ⇒ 多出来的这一格是空匹配 ⇒ 默认态一个字不变（判据②）。
  keepOpen: () =>
    !!document.querySelector(".music-header:hover, .folia-controls:hover, .folia-surface-exit:hover"),
});
function applyChrome(on: boolean) {
  stage.dataset.chrome = on ? "on" : "off";
  lyricStage.setRevealed(on);
  // R203：外壳浮现态变了就把这一格推给岛（公式见 islandChromeHidden，只有一处）。
  islandHandle?.setPlayerChromeHidden(islandChromeHidden());
}
/**
 * R203（壁纸 surface M0）：喂给移植件既有那一格 `isPlayerChromeHidden` 的值。**公式只有这一处**
 * （`function` 声明而非 const：`player.subscribe` 那两条 TDZ 教训（R103 / R161）——挂载完成与空闲
 * 计时器两个调用点都可能在模块求值期间撞到箭头常量）。
 * 两个条件缺一不可：① 只有 `?wallpaper=1` 这一档才隐藏外壳；② 悬浮控制条此刻必须是淡出的。
 * 第二条是算术不是审美：`playerBottomBarLayout.ts` 里 presence=1 给字幕 112px、presence=0 给 32px，
 * 差的就是 `PLAYER_BOTTOM_BAR_SUBTITLE_CLEARANCE_PX`（80px），而控制条占 `bottom:40px` 那一截
 * ⇒ 控制条在场时喂 true 会让字幕沉到它下面叠压（R117 / R144 同族，Task 0 末记的那处取舍）。
 */
function islandChromeHidden(): boolean {
  return isWallpaperSurface && stage.dataset.chrome !== "on";
}
/** 只有"歌词模式 + 播放视图"才是沉浸态；其余场合顶栏必须一直在，所以停表并强制浮现。 */
function syncChromeReveal() {
  if (lyricViewWanted()) {
    chromeReveal.start();
    // 控制条是这一刻才挂进 DOM 的，而 syncTransportControls 只在播放器离散变化时跑；
    // 不补一次，标题与可用性会一直停在空值直到下一次切歌。
    if (playerState) syncTransportControls(playerState);
  } else chromeReveal.stop();
}
/**
 * R161（任务八）· 播放上报的客户端那一侧。**这三格必须声明在 `player.subscribe` 之前**：
 * `subscribe` 在注册那一刻就同步跑一次回调，回调里引用的 `let/const` 若声明在后面就是 TDZ
 * （真机第一次打开就整页卡在"正在载入三维专辑架"，控制台 `ReferenceError: Cannot access … before initialization`）
 * —— 这是 R103 那条"离线全绿、只有浏览器抓得到"的同一类，自检里有一条静态顺序判据钉着它。
 */
let reportEnabled = false;
const reportedTracks = new Set<string>();
let reportedTrackOf = "";

player.subscribe((state) => {
  playerState = state;
  // 面板开着的时候底下的队列变了 ⇒ 必须重画一次。不重画的话：屏幕上还是旧的那几行，
  // 而 Enter 执行的是**新列表**里同一行的那首歌（真机量到：看着点《恋人》、跳成了《模特》）。
  // 声明顺序在这之前（`commandPalette` 于 1820 行建），所以订阅回调同步跑那一次也不会碰 TDZ。
  if (commandPalette.isOpen()) renderCommandPalette();
  const titleVisible = !!state.currentTrack &&
    (state.transport === "playing" || state.transport === "paused" || state.transport === "loading");
  transportTitleMotion.update(state.currentTrack?.title ?? "", titleVisible);
  void refreshPlaybackScope(state);
  $("#play-pause").setAttribute("aria-pressed", String(state.playing));
  $("#play-pause").setAttribute(
    "aria-label",
    state.playing ? "暂停" : "播放",
  );
  $("#play-pause").title = state.currentTrack
    ? `${state.playing ? "暂停" : "播放"}：${state.currentTrack.title}`
    : "播放当前专辑";
  if (state.error && state.error !== lastPlayerError) notify(state.error);
  lastPlayerError = state.error || "";
  updatePlayingRows();
  syncTransportControls(state);
  void lyricStage.sync(state);
  maybeReportPlayback(state);
});

/**
 * R161（任务八）· 播放上报的触发点。三条讲究：
 *   · **只在开关开着时才发那一问**：关着的分支直接 return，连 fetch 都不构造
 *     （"默认关时零请求"这条判据测的就是这一格）；
 *   · 一轮只报一次：客户端先按曲目 id 记一笔，服务端还有一道（两边各记各的：
 *     服务端那份是"这台机器的去重"，客户端这份是"别为同一首连发四个包"）；
 *   · 失败**不打扰用户**：上报是顺手的事，报不上去不该在界面上冒红字（要查看服务日志那一行）。
 */
function maybeReportPlayback(state: typeof player.state): void {
  if (!reportEnabled) return;
  const track = state?.currentTrack;
  if (!track || !track.id.startsWith("on-")) return;      // 本地曲目一个字节都不发（按 id 形状判，与服务端同一把尺）
  if (track.id !== reportedTrackOf) { reportedTrackOf = track.id; reportedTracks.clear(); }
  const position = state.currentTime ?? 0;
  if (position < 30 || reportedTracks.has(track.id)) return;
  reportedTracks.add(track.id);
  void request<{ sent?: boolean }>("/api/online/report", { trackId: track.id, positionSec: Math.floor(position) })
    .catch(() => { /* 不影响播放，也不弹提示：这不是用户要做决定的事 */ });
}

/** 开关的真源在服务端配置里（前端那份只是缓存）：读不到就按关处理——缺省必须是"不发"。 */
async function refreshReportSetting(): Promise<void> {
  // R203：播放上报服务的是"这一首向平台报一次"，它开关的那块界面在设置面板里（外壳）。
  // surface 连这一次读开关都不发 ⇒ `reportEnabled` 留在缺省 false，`maybeReportPlayback` 一个字节都不发。
  if (isWallpaperSurface) return;
  try {
    const config = await request<{ playReporting?: boolean }>("/api/config");
    reportEnabled = config?.playReporting === true;
  } catch {
    reportEnabled = false;
  }
}

/**
 * M3-b：「试听片段 / 完整播放」这枚徽标。
 *
 * 三条讲究：
 *   ① **依据只来自取址结果**（上游的 `freeTrialInfo`），不拿 `<audio>` 的时长去猜"这首是不是整首"——
 *      时长是解码器给的，试听片段与整首在解码器眼里都只是"一段能播的音频"；
 *   ② 一次切歌只问一次（`scopeTrackId` 那道闸），回来时若已经换歌就把答案丢掉——
 *      把上一首的"完整播放"贴到这一首上是这类异步最常见的错法；
 *   ③ 未知就说未知：查不到、路由关了、音源没有——三种都显示"播放范围未知"并把原因放进 title，
 *      不伪装成"试听"（那会让人以为登录了也白登）也不伪装成"完整"（那是骗）。
 */
/**
 * 音源来源的中文名（R141）。与 `playlists-ui.ts` 那份同一口径；这里单独一份是因为这两处的用法不同：
 * 那一处给的是"匹配到的是哪家"，这一处给的是"声音实际从哪家取来"（回落时两者可以不一样）。
 */
const ONLINE_SOURCE_LABELS: Record<string, string> = { netease: "网易云", qq: "QQ 音乐", kugou: "酷狗" };

/** R143（任务四）的边距。**这个数在服务端与界面必须同源**：界面上写的是解释，
 * 服务端算的是判定，两处各写一份迟早会漂（文案说 10 分、实际按 5 分挑）。 */
const ONLINE_PREFERENCE_MARGIN = 10;

/**
 * R141 回落要用的"这首歌是谁"。**故意放在 `refreshPlaybackScope` 外面**：
 * 下面那个函数是"播放范围"的判据所在，那里有一条纪律扫它的函数体——试听还是整首**只准来自取址结果**，
 * 不许拿时长猜（时长是解码器给的，试听与整首在它眼里没区别）。这一格只是把曲名歌手时长交给服务端去检索，
 * 不参与任何范围判断；放在外面既守住那条纪律的文字，也守住它的实质：范围那一段里读不到 duration。
 */
function onlineTrackIdentityPayload(track: MusicTrack) {
  return { title: track.title, artist: track.artist, durationMs: Math.round((track.duration ?? 0) * 1000) };
}

async function refreshPlaybackScope(state: MusicPlayerState) {
  // R203：这枚徽标挂在传输区（`.playback-scope`，外壳的一部分），surface 里既没地方显示它、
  // 就不该为它出这一问（Task 2 判据③：零 fetch 到播放器外壳路由）。
  if (isWallpaperSurface) return;
  const badge = document.querySelector<HTMLElement>("[data-role='playback-scope']");
  if (!badge) return;
  const track = state.currentTrack;
  if (!track || !track.id.startsWith("on-")) {
    if (scopeTrackId) { badge.hidden = true; badge.textContent = ""; scopeTrackId = "" }
    return;
  }
  if (scopeTrackId === track.id) return;
  scopeTrackId = track.id;
  badge.hidden = false;
  badge.dataset.scope = "unknown";
  badge.textContent = "播放范围查询中";
  try {
    // 随请求带上"这首歌是谁"（三样描述字段，服务端只拿去检索与挑同名曲，绝不当地址用）：
    // 不带的话主源说"没有可播文件"时就只能报失败——R141 的回落需要这一格。
    const result = await request<{
      scope?: string; trialSeconds?: number; ok?: boolean; reason?: string;
      sourceProvider?: string; fallbackFrom?: string;
    }>("/api/online/audio-scope", {
      trackId: track.id,
      online: onlineTrackIdentityPayload(track),
    });
    if (scopeTrackId !== track.id) return;
    const label = result.scope === "trial" ? `试听片段${result.trialSeconds ? ` ${result.trialSeconds} 秒` : ""}`
      : result.scope === "full" ? "完整播放"
        : result.scope === "unavailable" ? "没有可用音源"
          : "播放范围未知";
    // 回落过来的那一首要写**真正在播的那一家**（"网易云 · 完整播放（回落）"）：
    // 徽标说的是"现在这个声音从哪儿来"，跟着曲目对象上原来那个 provider 写就是一句假话。
    const source = result.sourceProvider ? ONLINE_SOURCE_LABELS[result.sourceProvider] ?? result.sourceProvider : "";
    badge.textContent = result.sourceProvider && source ? `${source} · ${label}（回落）` : label;
    badge.dataset.scope = result.scope ?? "unknown";
    badge.title = result.sourceProvider
      ? `这首在${ONLINE_SOURCE_LABELS[result.fallbackFrom ?? ""] ?? result.fallbackFrom ?? "原来源"}没有可播文件，本机回落到${source}的同名曲取到完整版本。播放范围与来源都只按取址结果说，不拿时长猜。`
      : result.reason ?? (result.scope === "trial"
        ? "这是平台的版权规则：未登录或非 VIP 账号只开放试听片段。在音乐库面板的「扫码登录」里用你自己的账号登录后，按该账号的权益播放。"
        : "");
  } catch (error) {
    if (scopeTrackId !== track.id) return;
    badge.textContent = "播放范围未知";
    badge.dataset.scope = "unknown";
    badge.title = `查询失败：${(error as Error).message}`;
  }
}

function syncTransportControls(state: MusicPlayerState) {
  const slider = $<HTMLInputElement>("#progress-slider");
  const usable = !!state.currentTrack && state.duration > 0;
  slider.disabled = !usable;
  if (usable) slider.max = String(state.duration);
  if (!progressDragging)
    slider.value = String(Math.min(state.currentTime, state.duration));
  $("#progress-current").textContent = time(state.currentTime);
  $("#progress-total").textContent = time(state.duration);
  const single = state.queue.length < 2;
  $<HTMLButtonElement>("#track-prev").disabled = single;
  $<HTMLButtonElement>("#track-next").disabled = single;
  // R109：模式那颗的文字/提示/高亮全部取自内核状态——界面自己再记一份"当前模式"就一定会与内核漂
  //（岛内那颗按钮是同一个动作的第二个入口，它改完这里要跟着变，反过来也是）。
  const modeButton = $<HTMLButtonElement>("#playback-mode");
  const modeLabel = PLAYBACK_MODE_NAMES[state.playbackMode];
  const modeNext = PLAYBACK_MODES[(PLAYBACK_MODES.indexOf(state.playbackMode) + 1) % PLAYBACK_MODES.length];
  modeButton.textContent = modeLabel.short;
  modeButton.setAttribute("aria-label", `播放模式：${modeLabel.name}`);
  modeButton.title = `${modeLabel.name} · 点击切到${PLAYBACK_MODE_NAMES[modeNext].name}`;
  if (state.playbackMode === "sequential") delete modeButton.dataset.mode;
  else modeButton.dataset.mode = "active";
  // 这颗**永远可点**：模式是偏好不是传输动作。第一版照着 prev/next 加了 `disabled = queue.length < 2`，
  // 真机上点第一下就再没反应（disabled 的按钮收不到 click），四档周期卡在头一档一动不动。
  // R130：换歌之后问一次服务端"这一首收藏了吗"。判据只看曲目 id 变没变——
  // 这个函数每次状态推送都会跑（含进度心跳），不加这道判据就是每 250ms 一次本机请求。
  if ((state.currentTrack?.id ?? "") !== favoriteTrackId) {
    favoriteTrackId = state.currentTrack?.id ?? "";
    void refreshFavoriteState(state.currentTrack ?? null);
    // R203（Task 4/6）：换曲就是"这一页有没有东西可画"变了 ⇒ 让那一行跟着重算。
    // 只在这一档补（主窗口那句从来不看曲目），且跟着上面那道"曲目 id 变了才问"的既有判据走同一条，
    // 不加判据就是每 250ms 一次心跳都重写一遍 DOM。
    if (isWallpaperSurface) updateStatus();
  }
  syncFavoriteButton();
  lyricStage.syncControls({
    playing: state.playing,
    title: state.currentTrack?.title ?? "",
    single,
    currentTime: state.currentTime,
    duration: state.duration,
    dragging: progressDragging,
    intensityLabel: intensityNames[preferences.lyricIntensity],
    // 三个布局判据同一个出处（currentFoliaLayout）：文案、按下一次算的 next、DOM 属性不许各读一份真相。
    layoutLabel: currentFoliaLayout() === "lattice" ? "歌词" : "封面墙",
    layoutActive: currentFoliaLayout() === "lattice",
    layoutAvailable: islandState === "on",
  });
}
// 底部胶囊与 Folia 悬浮条共用同一条 seek 通路。用文档级委托而不是查询后逐个绑定：
// 悬浮条是进 Folia 才动态创建的，模块初始化时那次 querySelectorAll 根本看不到它的 slider。
document.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest?.("input[data-seek]")) progressDragging = true;
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLElement;
  if (el.matches?.("input[data-seek]")) player.seek(Number((el as HTMLInputElement).value));
});
window.addEventListener("pointerup", () => {
  progressDragging = false;
});

let panelFocus: HTMLElement | null = null;
let panelTransition: SurfaceTransition | undefined,
  panelClosing = false,
  pendingPanelAfter: (() => void) | undefined;
function closePanel(after?: () => void) {
  if (!panel) {
    after?.();
    return;
  }
  pendingPanelAfter = after;
  if (panelClosing) return;
  panelClosing = true;
  panelTransition?.hide(preferences.reduced, () => {
    // R212：面板关了，登录心跳必须停（它只服务"面板开着"这一场景；重开时 renderAuthRows 会再拉起）。
    stopAuthHeartbeat();
    panel = null;
    panelClosing = false;
    panelTransition?.dispose();
    panelTransition = undefined;
    // R173（Q51）：面板关了就把那个第二根卸掉——留着它是白占一份 React 树，
    // 而且下次开面板会往一个已经没人看的容器里渲染。没加载过就没挂，这里不动它。
    if (modeSettingsModule) void modeSettingsModule.then((m) => m.unmountModeSettings());
    $("#music-panel-root").innerHTML = "";
    for (const node of [
      $("#music-browse"),
      $("#music-detail"),
      $(".music-header"),
      $("#three-scene"),
    ])
      node.inert = false;
    $("#music-browse").inert = presentation.phase !== "archive";
    $("#music-detail").inert = presentation.phase !== "detail";
    panelFocus?.focus({ preventScroll: true });
    const next = pendingPanelAfter;
    pendingPanelAfter = undefined;
    next?.();
  });
}
function openPanel(next: Panel) {
  if (!next) return closePanel();
  // R212：切面板时旧的 auth rows 会被下面这行 innerHTML 整根换掉 —— 先把心跳停掉；
  // 新面板若又是设置页，renderAuthRows 会自己再拉起。
  stopAuthHeartbeat();
  cancelTrackReveal();
  panelTransition?.dispose();
  pendingPanelAfter = undefined;
  panelClosing = false;
  if (!panel) panelFocus = document.activeElement as HTMLElement;
  panel = next;
  const titles = {
    library: ["MUSIC LIBRARY", "本地音乐库"],
    search: ["FIND MUSIC", "搜索专辑与歌曲"],
    settings: ["SYSTEM SETTINGS", "播放与画质"],
    playlists: ["PLAYLISTS", "我的歌单"],
    playlist: ["PLAYLIST", "歌单详情"],
    artist: ["ONLINE ARTIST", "在线音乐人"],
    favorites: ["FAVORITES", "收藏"],
    lyrics: ["LYRIC MATCH", "歌词匹配"],
  };
  $("#music-panel-root").innerHTML =
    `<div class="music-panel-scrim" data-action="dismiss-panel"><section class="music-panel" role="dialog" aria-modal="true" aria-labelledby="music-panel-title"><div class="panel-heading"><div><small>${titles[next][0]}</small><h2 id="music-panel-title">${titles[next][1]}</h2></div><button data-action="close-panel" aria-label="关闭">×</button></div><div id="panel-body"></div></section></div>`;
  for (const node of [
    $("#music-browse"),
    $("#music-detail"),
    $(".music-header"),
    $("#three-scene"),
  ])
    node.inert = true;
  const scrim = $(".music-panel-scrim");
  scrim.hidden = true;
  panelTransition = new SurfaceTransition(scrim, $(".music-panel"));
  panelTransition.show(preferences.reduced);
  effects.play("page-open");
  if (next === "library") renderLibraryPanel();
  if (next === "search") renderSearchPanel();
  if (next === "settings") {
    renderSettingsPanel();
    // R160（任务七）：打开设置就把输出设备列一次。`enumerateDevices()` 不出网、也不要权限
    // （未授权时它给的是空 label/空 id，那一档界面另有说明），所以"点开就看到"比"先点刷新"更诚实。
    // 真机量到：不补这一句，第一次打开这一行写的是"列出 0 个输出设备"，而那 0 是"还没问过"的 0。
    void refreshOutputSinks().then(() => repaintOutputDeviceRow());
  }
  if (next === "playlists") void renderPlaylistsPanel();
  if (next === "playlist") void renderPlaylistDetail();
  if (next === "artist") void renderArtistPanel();
  if (next === "favorites") void renderFavoritesPanel();
  if (next === "lyrics") void renderLyricMatchPanel();
  (
    document.querySelector<HTMLElement>("#album-search") ||
    $("#music-panel-root button")
  )?.focus({ preventScroll: true });
}
/**
 * 在线能力的自我声明（Task 9 立，2026-10-04 随"联网默认打开"改写）。
 * 它原先只出现在"开启前的二次确认"里；默认开启后没有那次确认了，所以这段必须常驻面板——
 * "UI 标明联网来源"这条红线不因为默认值变了而缩水。内容仍须与实现逐字一致：
 * 只有本地没有带时间轴歌词的曲目才会出网；来源集合与 provider 表（QQ / AMLL）一致；
 * 不下载音频、不改写标签、不落盘（匹配结果只在内存里）。
 */
const ONLINE_LYRICS_DISCLOSURE =
  "联网状态：本机播放器会为本地没有带时间轴歌词的曲目联网查询匹配歌词（含逐字时间轴），" +
  "来源按顺序是 QQ 音乐、网易云、酷狗与 AMLL 逐字库；其中网易云与酷狗经由本机自己起的本地在线后端进程转发" +
  "（该进程只监听 127.0.0.1，随在线能力关闭而退出）。" +
  "不下载歌曲、不改写音频标签、不保存歌词到磁盘；匹配到的歌词旁会标注“在线匹配 · QQ/网易云/酷狗/AMLL”。" +
  // R149（Q21）：数据目录里第一次多出一份认领记录，这句让它常驻可见——上面那句"不保存歌词到磁盘"仍然逐字为真，
  // 这份文件记的是"哪一家的哪一首"，不是正文；两件事一起说，用户才不会在目录里撞见一个新文件要猜它是谁写的。
  "如果你手工指定过某一条歌词，数据目录里会多一份 lyric-claims.json：它只记“哪一家的哪一首被认下来了”，" +
  "不含歌词正文，也不含任何账号凭据；不想要了可以在同一处点「取消认领」，或直接删掉那个文件。" +
  "第三方非官方接口可能随时变动，失效时本地播放不受影响。";

const onlineLyricsStatus = (enabled: boolean) =>
  enabled
    ? "当前：已开启（默认） —— 本地没有带时间轴歌词的曲目会在播放时查询匹配。"
    : "当前：已关闭 —— 不发起任何在线请求；关掉后本地歌词与播放照常，只是不再配词。";

/**
 * 出网审计（R75，2026-10-05 随"联网默认打开"补齐的补偿装置）。
 * 默认关闭时"零请求"本身就是承诺；默认打开之后，"我们只打了该打的地方"变成用户无法自行验证的一句话，
 * 所以把播放器主动发起的每一次出网摊开在这一节里。
 * 文案必须与实现一致：表里只有主机 + 用途 + 状态 + 耗时（服务端就不记 URL 查询串与请求头），
 * 而第三方封装包内部自己发的请求我们包不住 —— 这一句不许写成"全部出网都在这里"。
 */
const ONLINE_AUDIT_NOTE =
  "下表是播放器主动发起的出网记录，只保留最近若干条、只在内存里（不落盘、不记曲目名与查询内容）。" +
  "第三方后端库内部的请求以“<provider> 调用”一行汇总，无法逐条列出主机——这是选用非官方封装包的固有代价。";

type OnlineAuditRow = { host: string; kind: string; status: number; bytes: number; ms: number; via: string; at: number };
type OnlineAuditSnapshot = { items: OnlineAuditRow[]; totals: { requests: number; bytes: number; byHost: Record<string, number> } };

const ONLINE_AUDIT_KIND_LABELS: Record<string, string> = {
  lyrics: "歌词匹配",
  metadata: "专辑资料",
  introduction: "专辑简介",
  search: "在线搜索",
  stream: "在线试听",
  // 这一档现在管两件事：给没有封面的**专辑**补图、给**在线曲目**取图（看板 ⑨ 追加）。
  // 两者都是"取一张封面图"，审计表上用户要看的是打了谁、多少字节，不是我们的模块边界 ⇒ 仍是一个 kind。
  cover: "在线封面",
  // QQ 的歌单是父进程自写的请求（R138，不经桥），所以这里有一档与下面 `/bridge/playlist` 并列：
  // 一个是"经本地在线后端拿歌单"，一个是"自己出网拿歌单"，用户在审计表里看到的是同一件事的两个去处。
  playlist: "歌单导入",
  unknown: "未标注用途",
  bridge: "在线后端调用",
  // 桥那条路由的 kind 是路由路径（Task 5 起有真实行），直接显示成 /bridge/lyrics 用户读不懂。
  "/bridge/lyrics": "歌词匹配（经本地在线后端）",
  "/bridge/audio-source": "音源取址（经本地在线后端）",
  "/bridge/search": "在线搜索（经本地在线后端）",
  "/bridge/playlist": "歌单导入（经本地在线后端）",
  // M3-a Task D/E：登录这一档要摊开，尤其 MQTT——它不是 https 请求，guardedFetch 管不到它，
  // 唯一的可见性就是这两行中文名。少了它们，"QQ 登录时还开了一条长连"就只剩代码里的注释知道。
  auth: "扫码登录请求",
  "auth-mqtt": "扫码登录的长连接（QQ，独立于普通请求）",
  "/bridge/auth": "扫码登录（经本地在线后端）",
};

function onlineAuditLine(row: OnlineAuditRow) {
  const kind = ONLINE_AUDIT_KIND_LABELS[row.kind] ?? row.kind;
  // status 0 有两种完全不同的含义，必须分开说：
  //   guard + 0 = 我们自己的静态校验把它拦下了，一个包都没发出去；
  //   backend + 0 = 叫了第三方库、库确实打了它的接口，只是这一次没成功。
  // 把后者也写成"已拦下"会把一次真实出网掩盖掉。
  const outcome =
    row.status !== 0 ? `HTTP ${row.status}`
      : row.via === "backend" ? "调用未成功"
        : "已拦下（未出网）";
  const time = new Date(row.at).toLocaleTimeString("zh-CN", { hour12: false });
  return `${time} · ${row.host} · ${kind} · ${outcome} · ${row.ms}ms`;
}

async function renderOnlineAudit() {
  const box = document.querySelector<HTMLElement>("[data-role='online-audit']");
  if (!box) return;
  try {
    const audit = await request<OnlineAuditSnapshot>("/api/online/audit");
    const rows = audit.items.slice(0, 12).map(onlineAuditLine);
    const summary = audit.totals.requests
      ? `合计 ${audit.totals.requests} 笔 · 共 ${audit.totals.bytes.toLocaleString("zh-CN")} 字节`
      : "本次会话还没有发起过在线请求。";
    box.innerHTML = `<p>${esc(ONLINE_AUDIT_NOTE)}</p><p><b>最近出网记录</b></p>${
      rows.length ? `<ul class="online-audit-list">${rows.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""
    }<p>${esc(summary)}</p>`;
  } catch (error) {
    // 全部在线开关关掉时服务端返回 404 并清空了表：这里要说的是"不再记录"，不是"读取出错"。
    const message = (error as Error).message ?? "";
    box.innerHTML = `<p>${esc(ONLINE_AUDIT_NOTE)}</p><p>${esc(
      message.includes("已全部关闭") ? "在线能力已全部关闭：不再记录出网，此前的记录已随关闭一并清空。" : `出网记录暂时读不到：${message}`,
    )}</p>`;
  }
}

/**
 * 扫码登录的界面（M3-a Task E）。
 *
 * 三条与凭据有关的规矩在这一节里是看得见的：
 *   ① 界面只拿**状态**：`source / entries / updatedAt / state / expiresAt / reason`，
 *      服务端那两条路由的响应里根本没有凭据字段（§7.1 的运行时半有断言钉着），
 *      所以这里连"删掉几个字段"都不必做——没有可删的东西；
 *   ② 二维码是一张 `data:image/png;base64` 的图，它是**登录流程的一次性句柄的图像**，不是凭据，
 *      175 秒是**本机显示时长**；R215 起"到点"不再算作废 —— 实测手机确认可能迟 1.5~2 分钟，
 *      到点后继续低频问上游、图不清、那一行改说"仍在等手机确认"；只有**上游**说 expired 才清；
 *   ③ 轮询**上一轮 settle 之后才排下一轮**（`setTimeout` 在 `finally` 里），节奏由服务端 `pollMs` 给；
 *      R215：过了显示时长换成本地那一档低频（`AUTH_OVERTIME_POLL_MS`）——前后端各写一个数字迟早会漂。
 */
type AuthProviderView = { source: string; entries: number | null; updatedAt: number | null; envConfigured?: boolean };
type AuthSnapshot = {
  providers: { netease: AuthProviderView; kugou: AuthProviderView; qq: AuthProviderView };
  pending: { provider: string; state: string; expiresAt: number }[];
  pollMs: number;
  /** 每一家各自的下一次问的时间（酷狗那一路的上游端点会被限流，节奏必须比另两家慢）。 */
  pollMsBy?: Record<string, number>;
};
/**
 * 三家扫码登录的行。**这段注释放在表外面**：自检要能干净地判"表里有没有一句已不是事实的话"，
 * 注释夹在条目之间会让那条判据把自己绊倒（第一版就红在这里）。
 *
 * 酷狗那一格从前写着"二维码能出，但上游对本机的扫码状态查询恒回错误码 20010 ⇒ 扫了也不会确认"
 * （R139 任务一的探针结论，2026-10-09）。**那句话已经不是事实**：真凶是我们自己把参数名写错了——
 * 包 `module/login_qr_check.js` 取的是 `params.key`（再由它映射成上游查询串里的 `qrcode`），
 * 我们传的是 `{ qrcode }` ⇒ 包读到 `undefined` ⇒ 上游恒回 502/20010，还被误判成"酷狗要求设备注册"。
 * 改对之后同一张码回 `HTTP 200 / status:1`（2026-10-10 一手实测，三变体对照见
 * memory/kugou-login-param-run-log.md）。那句"扫了也不会确认"于是删掉：留着就是叫用户相信一件
 * 我们已知的假事。`blocked` 这个字段与它的渲染都保留（下一家真有已知堵点时还得用它说人话）。
 */
const AUTH_PROVIDERS_UI = [
  // `blocked` 一律**显式写出来**（空串 = 这一路没有已知的堵点）：三家同一张形状，
  // 少一家就变成联合类型取不到属性，而"只有酷狗那行有这句话"本身是一条要能数的判据。
  { id: "netease", label: "网易云音乐", blocked: "" },
  // 第三家（R136）。这一行**没有**"退出会通知上游"那句话可说：包 v1.6.0 没有登出模块，
  // 服务端把这件事写在 logout 的 reason 里，界面照原话显示，不许转成"已通知上游"。
  // 这一格的 `blocked` 从空串变成一句实话（R154 · 2026-10-10 一手实测）：
  // 酷狗今天确实有已知限制，而且限制不是"我们没接"——是**要登录**、以及上游给的 CDN 会漂。
  // 句子只允许说量到的那两件事，不许写成"酷狗不能播"（实测有过整首成功的那一次），也不许提错误码。
  { id: "kugou", label: "酷狗音乐", blocked: "登录后才参与检索与播放；能否整首由该账号权益与上游给的 CDN 决定（本机不为音频放开明文，也不做下载）" },
  { id: "qq", label: "QQ 音乐", blocked: "" },
] as const;
const AUTH_STATE_LABELS: Record<string, string> = {
  waiting: "等待扫码",
  scanned: "已扫码，请在手机上确认",
  confirmed: "已登录",
  expired: "二维码已过期",
  error: "这一步没走通",
  /** 用户点了"取消"：服务端那一轮还挂着（会随 TTL 自己作废），但本机不再等它。 */
  cancelled: "已在本机取消这一轮",
};
const AUTH_SOURCE_LABELS: Record<string, string> = {
  env: "已登录（凭据来自环境变量）",
  file: "已登录（凭据在本机会话文件里）",
  none: "未登录",
};
/** provider → 轮询定时器。两家可以各有一张码在扫，所以是一张表而不是一个变量。 */
const authTimers = new Map<string, number>();
/**
 * 当前这一轮的二维码图（按家存，进程内）。**必须存在模块状态里而不是只写进 DOM**：
 * 面板每 2 秒轮询一次、每次轮询都整体重画那两行，直接 `innerHTML` 上去的图会被下一拍抹掉
 * （真机上表现成"点了没反应/码一闪就没"）。图片只在界面上显示，绝不出这台机器。
 */
const authQrImages = new Map<string, { image: string; expiresAt: number }>();

/**
 * 「取消这次扫码」要能**取消得掉**（真机量出来的缺陷：第一版只停表 + 删图，
 * 下一次任何重画都从服务端的 pending 里把同一轮又捞回来，倒计时继续走，等于什么都没取消）。
 * 取消是本机侧的动作（服务端那一轮随 TTL 自己作废，不为此加一条路由），所以要记的是
 * "我取消的是**哪一轮**"——用那一轮的 `expiresAt` 当身份，新取一张码自然就是新的身份。
 */
const authCancelledAt = new Map<string, number>();
const authPendingAt = new Map<string, number>();

/**
 * 已登录那一行的"是谁"（R136）。**只存昵称与档位两样文本**：
 * 服务端那份账号形状里还有 `avatarUrl`，它是**第三方域名的地址** —— 封面那一路早就定了同一条红线
 * （第三方地址不进 DOM，浏览器自己去打就不在我们的出网表里了），所以头像要上界面得先像封面那样
 * 经服务端代理，那一跳本批不做，列进待确认。
 * 缓存按家存时间戳：账号信息一次问答一次网，面板每次轮询（2 秒）都去问是不可接受的。
 * R217：`status`/`reason` 是"这一问的结果"三档（上游认账 / 上游不认 / 问不到）——收尾文案读它们，见 auth-badge.ts。
 */
const authAccounts = new Map<string, AuthAccountCacheEntry>();
const AUTH_ACCOUNT_TTL_MS = 10 * 60_000;

async function loadAuthAccount(provider: string) {
  const cached = authAccounts.get(provider);
  if (cached && Date.now() - cached.at < AUTH_ACCOUNT_TTL_MS) return;
  let entry: AuthAccountCacheEntry;
  try {
    const asked = await request<{ loggedIn?: boolean; nickname?: string; vipLabel?: string; reason?: string }>(
      "/api/online/auth/account", { provider },
    );
    // R217：两种 `loggedIn:false` 在这里分开（上游不认 vs 问不到）——分档判据只在 auth-badge 一处。
    const { status, reason } = classifyAuthAccount(asked);
    entry = {
      nickname: status === "ok" ? asked?.nickname ?? "" : "",
      vipLabel: status === "ok" ? asked?.vipLabel ?? "" : "",
      status,
      reason,
      at: Date.now(),
    };
  } catch {
    // 请求本身都没发出去（服务没起来 / 网络层抛了）——同样是"问不到"，**不是**"失效"。
    entry = { nickname: "", vipLabel: "", status: "unreachable", reason: "", at: Date.now() };
  }
  authAccounts.set(provider, entry);
  // 问不到（上游坏了 / 被限流挡住）也记一笔时间：不然每次重画都去撞一次网。
  if (document.querySelector<HTMLElement>("[data-role='auth-rows']")?.isConnected) void renderAuthRows();
}

function authRowText(provider: (typeof AUTH_PROVIDERS_UI)[number], view: AuthProviderView, pendingRow?: { state: string; expiresAt: number }) {
  if (pendingRow) {
    const left = Math.max(0, Math.round((pendingRow.expiresAt - Date.now()) / 1000));
    const label = AUTH_STATE_LABELS[pendingRow.state] ?? pendingRow.state;
    if (pendingRow.state === "waiting" || pendingRow.state === "scanned") {
      // R215：本地显示时长走完**不是**终态（实测确认可能迟 1.5~2 分钟）——留在"剩 0 秒"是骗人。
      if (left <= 0) return "已过显示时长，仍在等手机确认（可能延迟一两分钟）";
      return `${label} · 剩 ${left} 秒`;
    }
    return label;
  }
  if (view.source === "none") return "未登录";
  // "是谁"与"是什么档位"只有问过一次上游才知道：没问到就只说登录着，不拿一个空串冒充昵称。
  const account = authAccounts.get(provider.id);
  const who = account?.nickname ? ` · ${account.nickname}` : "";
  const tier = account?.vipLabel ? ` · ${account.vipLabel}` : "";
  // entries 是条数（QQ 那一份是密文，服务端不知道条数，回 null）——把"登录着"这件事说成事实而不是感觉。
  const base = view.source === "env"
    ? `${AUTH_SOURCE_LABELS.env}${who}${tier}`
    : `${AUTH_SOURCE_LABELS.file}${view.entries === null ? "" : ` · ${view.entries} 项`} · ${
      view.updatedAt ? new Date(view.updatedAt).toLocaleString("zh-CN", { hour12: false }) : "时间未知"}${who}${tier}`;
  // R217：本机"有凭据"只说明文件在，**不说明上游认账**。收尾过三档（上游不认 ⇒ 整行换口径；
  // 问不到 ⇒ 原行后面如实接一句；问过且认 ⇒ 原样）——判据与文案都在 auth-badge.ts。
  return applyAuthAccountState(base, account);
}

function authRowMarkup(provider: (typeof AUTH_PROVIDERS_UI)[number], view: AuthProviderView, pendingRow?: { state: string; expiresAt: number }) {
  const state = pendingRow?.state;
  const busy = state === "waiting" || state === "scanned";
  const signedIn = view.source !== "none";
  // R217：上游明确不认这份凭据 ⇒ 「重新扫码」入口要回到这一行（走同一颗 auth-start 动作）。
  const rescan = signedIn && showsRescan(authAccounts.get(provider.id)?.status);
  const qr = authQrImages.get(provider.id);
  const qrShown = !!qr && busy;
  const qrSeconds = qr ? Math.max(0, Math.round((qr.expiresAt - Date.now()) / 1000)) : 0;
  const qrBody = qrShown
    ? `<img class="auth-qr-image" width="180" height="180" alt="扫码登录用的二维码" src="${esc(qr.image)}">` +
      `<p>用${provider.label} App 的扫一扫。${
        qrSeconds > 0
          ? `二维码在本机显示 ${qrSeconds} 秒；手机确认可能延迟一两分钟，确认到了会自动登录。`
          : "已过显示时长，仍在等手机确认（可能延迟一两分钟）；确认到了会自动登录。"}<br>` +
      `${esc(state === "scanned" ? "已扫码——请在手机上点确认（本机仍在等）。" : "二维码只在这台机器的界面上显示，不会上传。")}</p>`
    : "";
  return `<div class="auth-row" data-auth-provider="${provider.id}">` +
    `<span class="auth-name">${provider.label}</span>` +
    `<span class="auth-state" data-role="auth-state">${esc(authRowText(provider, view, pendingRow))}</span>` +
    (busy
      ? `<button class="text-button" data-action="auth-cancel" data-auth="${provider.id}">取消这次扫码</button>`
      : signedIn
        ? (rescan
          ? `<button class="text-button" data-action="auth-start" data-auth="${provider.id}">重新扫码 ↗</button>` +
            `<button class="text-button" data-action="auth-logout" data-auth="${provider.id}">退出登录 ↗</button>`
          : `<button class="text-button" data-action="auth-logout" data-auth="${provider.id}">退出登录 ↗</button>`)
        : `<button class="text-button" data-action="auth-start" data-auth="${provider.id}">扫码登录 ↗</button>`) +
    // 已知的堵点写在**这一行下面**（不塞进 `.auth-row`：那是 flex 行，塞进去会变成同一行的第三个格子）。
    // 位置放在行与二维码之间 ⇒ 用户点"扫码登录"之前就看得到，而不是扫完才知道白扫。
    `</div>${provider.blocked ? `<p class="auth-blocked-note">${esc(provider.blocked)}</p>` : ""}` +
    `<div class="auth-qr" data-auth-qr="${provider.id}" data-role="auth-qr"${qrShown ? "" : " hidden"}>${qrBody}</div>`;
}

async function renderAuthRows() {
  const box = document.querySelector<HTMLElement>("[data-role='auth-rows']");
  if (!box) return;
  try {
    const snapshot = await request<AuthSnapshot>("/api/online/auth");
    const pending = new Map(snapshot.pending.map((row) => [row.provider, row]));
    // 取消过的轮次要**一直显示成已取消**，直到服务端那一轮换了身份（新的 expiresAt）：
    // 只看 pending 会把用户刚取消的那一轮又画成"等待扫码"，倒计时继续走 —— 那是没取消。
    const shown = AUTH_PROVIDERS_UI.map((provider) => {
      const row = pending.get(provider.id);
      authPendingAt.set(provider.id, row?.expiresAt ?? 0);
      return { provider, row, cancelled: !!row && authCancelledAt.get(provider.id) === row.expiresAt };
    });
    box.innerHTML = shown.map((entry) => authRowMarkup(entry.provider, snapshot.providers[entry.provider.id],
      entry.cancelled ? { state: "cancelled", expiresAt: entry.row?.expiresAt ?? 0 } : entry.row)).join("");
    // 匹配偏好那一行要说"当前哪几家已登录"——那句白话承诺（"更可能按你的账号权益完整播放"）
    // 到底有没有生效条件，用户得在这里看得见，而不是自己去猜。
    const loggedInNames = AUTH_PROVIDERS_UI
      .filter((entry) => entry.id !== "kugou" && snapshot.providers[entry.id]?.source !== "none")
      .map((entry) => entry.label);
    const prefState = document.querySelector<HTMLElement>("[data-role='pref-source-state']");
    if (prefState) {
      prefState.textContent = loggedInNames.length
        ? `当前已登录：${loggedInNames.join("、")} —— 开着这一项时，${loggedInNames.join("、")}里过线的候选在与全局最高分相差 ${ONLINE_PREFERENCE_MARGIN} 分以内会被优先选。`
        : `当前一家都没登录：这一项开着也什么都不改（没有可优先的源）。`;
    }
    // 已登录的那几家各问一次"是谁"（带 TTL 缓存，不在每次轮询里重复问）：
    // GET /auth 本身仍是纯本地自省，出网只发生在这一次、且只在面板开着时。
    for (const entry of shown) {
      if (snapshot.providers[entry.provider.id]?.source !== "none") void loadAuthAccount(entry.provider.id);
    }
    for (const entry of shown) {
      // 有进行中的那一轮就接着轮询：面板被切走再切回来时，二维码图不在（它只在点"扫码登录"那一次拿），
      // 但状态与倒计时必须接着走，不能停在"等待扫码"骗人。已取消的那一轮除外。
      const pollMs = snapshot.pollMsBy?.[entry.provider.id] ?? snapshot.pollMs ?? 2000;
      const live = entry.row && !entry.cancelled && (entry.row.state === "waiting" || entry.row.state === "scanned");
      if (live) scheduleAuthPoll(entry.provider.id, pollMs);
      else stopAuthPoll(entry.provider.id);
    }
    // R214：把刚读到的这份快照交给心跳当起点（**只在不跑时生效**）—— 首开就已是登录态不补一句假 toast，
    // "开面板 → 十来秒内就扫码"那条也不被拖慢（起点就是这次读到的真值）。
    authHeartbeat.seed(snapshot.providers);
    // R212：面板还开着就把低频心跳拉起来（只读本地自省）。关掉/切走由 stopAuthHeartbeat 收。
    if (box.isConnected) authHeartbeat.start();
  } catch (error) {
    box.innerHTML = `<p>${esc((error as Error).message.includes("联网功能已关闭")
      ? "联网功能已关闭：扫码登录随之不可用（在上面的「在线能力」里重新打开即可）。"
      : `登录状态暂时读不到：${(error as Error).message}`)}</p>`;
  }
}

/**
 * R212 · 登录面板的"刷新窗口"。与扫码那 2 秒轮询（`authTimers`，问 `/poll`）**完全分开**：
 * 这一颗只读 `GET /api/online/auth`（纯本地自省：读内存 + stat 会话文件，不出网、不碰桥）。
 * 起因（验收侧现场）：扫码其实**已成功**（会话已落盘、`source:"file"` 读得到），但界面在本地终态后
 * 不再自我发现 ⇒ 用户以为"没登上"，重开面板才显示。R136 ① 是同一族的另一面（界面看的那个状态
 * 与服务端真状态不是同一份）。
 */
const authHeartbeat = createAuthHeartbeat({
  read: () => request<AuthSnapshot>("/api/online/auth"),
  render: () => {
    void renderAuthRows();
  },
  notifyLogin: () => notify("登录成功：这台设备现在按你账号的版权权益播放。"),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // 元素还在文档里才跑：面板关掉/切走之后这一拍自己也会停（关掉那两处另有显式 stop，双保险）。
  alive: () => !!document.querySelector<HTMLElement>("[data-role='auth-rows']")?.isConnected,
});

/** R212：面板关掉/切走时停心跳；面板再开时 `renderAuthRows` 会自己把它拉回来。 */
function stopAuthHeartbeat() {
  authHeartbeat.stop();
}

/** 停掉某一家的轮询：面板关掉、扫码结束、用户取消都要走到这里。 */
function stopAuthPoll(provider: string) {
  const timer = authTimers.get(provider);
  if (timer !== undefined) {
    clearTimeout(timer);
    authTimers.delete(provider);
  }
  authPollDelay.delete(provider);
}

/**
 * 某一家的下一次间隔（毫秒）。**问失败就退避**：一手量测是酷狗那个状态查询端点会在连续快问之后
 * 整段回 HTTP 502（同一张码 60 问全 200，随后 120 问全 502、跨 30 分钟），
 * 这时候按原节奏继续猛问只会让它在更长一段时间里都是坏的 —— 退避既保住码，也少折磨上游。
 */
const authPollDelay = new Map<string, number>();
const AUTH_POLL_MAX_DELAY_MS = 30_000;
/** R215：过了本地显示时长之后的**续问**节奏（10~15 秒档）——确认可能迟到一两分钟，不能再按 2 秒猛问、也不许停。 */
const AUTH_OVERTIME_POLL_MS = 12_000;

/** 上一轮 settle 之后才排下一轮；容器已经不在文档里（面板被切走）就自己停。 */
function scheduleAuthPoll(provider: string, pollMs: number) {
  if (authTimers.has(provider)) return;      // 一轮只排一个：重复点按钮不该叠出并行轮询
  // R215：是否已过显示时长按"那一轮的 expiresAt"**现算**（跟着轮次走、不缓存）；过了就换低频续问。
  const effectiveMs = () => ((authPendingAt.get(provider) ?? 0) <= Date.now() ? AUTH_OVERTIME_POLL_MS : pollMs);
  const delay = authPollDelay.get(provider) ?? effectiveMs();
  const timer = setTimeout(async () => {
    authTimers.delete(provider);
    let terminal = false;
    let retryable = false;
    try {
      const result = await request<{ state?: string; reason?: string; retryable?: boolean }>(`/api/online/auth/poll`, { provider });
      const state = result.state ?? "error";
      retryable = result.retryable === true;
      terminal = state !== "waiting" && state !== "scanned" && !retryable;
      if (state === "confirmed") {
        notify("登录成功：这台设备现在按你账号的版权权益播放。");
        authAccounts.delete(provider);          // 刚登上：那一份"是谁"要重问一次，别拿登录前的空值糊上去
        void loadAuthAccount(provider);
      }
      else if (terminal) notify(`扫码登录${AUTH_STATE_LABELS[state] ?? state}${result.reason ? `：${result.reason}` : ""}`);
      // 那句"可稍后重试，二维码仍然有效"服务端已经说完了，界面别再叠一层同义的话
      // （真机上第一版拼出来是"…（可稍后重试，二维码仍然有效）（二维码仍然有效，正在退避重试）"）。
      else if (retryable && state === "error") notify(`扫码登录暂时问不到：${result.reason ?? "上游没应答"}`);
    } catch (error) {
      terminal = true;
      notify(`扫码登录的状态问不到了：${(error as Error).message}`);
    }
    // 可重试 ⇒ 那张码**不许被丢掉**（服务端也还留着那一轮的句柄），只是把下一问推远一点；
    // 反过来，真到终态（过期 / 坏了且不可重试）就必须删图停表，不能留一张看着还能扫的废码。
    authPollDelay.set(provider, retryable
      ? Math.min((authPollDelay.get(provider) ?? pollMs) * 2, AUTH_POLL_MAX_DELAY_MS)
      : effectiveMs());                                  // R215：过期后写回的也是低频（第一版只改了读侧，实测 2 秒节奏漏过去了）
    const box = document.querySelector<HTMLElement>("[data-role='auth-rows']");
    if (terminal) {
      authQrImages.delete(provider);   // 扫完/过期/坏了：那张废图不该继续留在面板上
      // R212：本地终态**不代表上游没戏**（手机确认可能晚一步、会话已经落盘）⇒ 别把"看"也一起停掉：
      // 再给几次低频心跳机会，仍无变化，心跳自己会停（armLate 的窗口）。
      authHeartbeat.armLate();
    }
    if (!box?.isConnected) return;                       // 面板已关：不排下一轮，也不刷 DOM
    await renderAuthRows();
    if (!terminal && box?.isConnected) scheduleAuthPoll(provider, pollMs);
    if (terminal) void renderOnlineAudit();              // 登录这一跳要当场出现在出网表里
  }, delay);
  authTimers.set(provider, timer);
}

async function startQrLogin(provider: string) {
  // 二维码那一格是行的**兄弟节点**（它要在行下面铺开），所以按家的 id 直接找它自己，
  // 不能从 `[data-auth-provider=…]` 那行里往下找 —— 那样永远找不到，点一下就静默什么都不发生。
  const box = document.querySelector<HTMLElement>(`[data-auth-qr='${provider}']`);
  if (!box) {
    notify("登录那一格还没画出来，请稍后再点一次「扫码登录」。");
    return;
  }
  box.hidden = false;
  box.innerHTML = '<p>正在取二维码…</p>';
  // 重新取码就是新的一轮：把"这一家已取消"那格清掉，否则取消过的记录会一直压着后面的轮次
  // （清在这里而不是记 loginId：界面上拿不到句柄，而 expiresAt 每次取码都不同）。
  authCancelledAt.delete(provider);
  try {
    const result = await request<{ state?: string; reason?: string; qr?: { image?: string }; expiresAt?: number }>(
      "/api/online/auth/start", { provider },
    );
    if (!result.qr?.image) {
      box.innerHTML = `<p>${esc(result.reason ?? "没有拿到二维码")}</p>`;
      await renderAuthRows();
      return;
    }
    // 图片直接喂 <img>：不引任何二维码生成依赖（Task C 实测 qrimg 就是 data URI）。
    authQrImages.set(provider, { image: result.qr.image, expiresAt: result.expiresAt ?? Date.now() + 175_000 });
    void renderOnlineAudit();
  } catch (error) {
    box.innerHTML = `<p>取二维码失败：${esc((error as Error).message)}</p>`;
  }
  await renderAuthRows();
}

async function logoutAuth(provider: string) {
  try {
    const result = await request<{ ok?: boolean; reason?: string }>("/api/online/auth/logout", { provider });
    // reason 由服务端给原话（三家各不相同：QQ 是"上游那一跳撤销不了已签发的 token"、酷狗是"包根本没有
    // 登出接口，这一步不出网"）。界面**不替它改写**成"已通知上游"那种更体面的说法。
    notify(result.ok
      ? `已退出登录。${result.reason ?? "本机保存的凭据已删除"}，本地音乐与在线试听不受影响。`
      : `退出没完全成功：${result.reason ?? "未知原因"}`);
  } catch (error) {
    notify(`退出登录失败：${(error as Error).message}`);
  }
  stopAuthPoll(provider);
  authQrImages.delete(provider);
  authAccounts.delete(provider);
  await renderAuthRows();
  void renderOnlineAudit();
}

/**
 * 在线能力的四张子开关（R77 的界面兑现）。
 *
 * 为什么当时补这一段：Task 6/7 的路由在被关闭时回的是"可在设置里重新勾选"，而界面上当时只有
 * 「在线匹配歌词」一个框——那句话对搜索与试听是**指向不存在控件的假指引**。
 * 默认打开的联网能力，"能一键关掉"必须是真的能关掉，不是只在服务端有那个字段。
 * 同一道理，`covers` 这一行是**跟着 M3-c 的实现一起加的**：服务端有了会读这张开关的那一轮补图，
 * 界面上才许出现这个勾选框。反过来也不留空框——每一行的 hint 都写清"关掉之后哪一类请求归零"。
 */
const ONLINE_SWITCHES_UI = [
  { key: "lyrics", label: "在线匹配歌词", hint: "只为本地没有带时间轴歌词的曲目查询；关闭后这一类请求归零" },
  { key: "search", label: "在线搜索", hint: "搜索面板的「在线」页签；关闭后该页签不再发起任何检索请求" },
  { key: "streaming", label: "在线试听", hint: "经本机中转的流式试听：音频字节不落盘、不缓存，关闭后在线曲目不再取音源" },
  {
    key: "covers",
    label: "在线封面",
    hint: "两件事共用这张开关：给「既无内嵌也无文件夹封面」的专辑问一次补图，以及取在线搜索结果的曲目封面。"
      + "补来的图都存在本机 dataDir/artwork，绝不写回音频文件；关闭后这一类请求归零，界面回到占位图",
  },
] as const;
/** 与服务端 ONLINE_DEFAULTS 同向：四张全默认开（covers 今天没有实现，表里留着等 M3 加勾选框）。 */
const ONLINE_DEFAULTS_UI = { lyrics: true, search: true, streaming: true, covers: true };

async function applyOnlineSwitch(key: keyof typeof ONLINE_DEFAULTS_UI, toggle: HTMLInputElement) {
  const wanted = toggle.checked;
  const before = { ...ONLINE_DEFAULTS_UI, ...library.online };
  const next = { ...before, [key]: wanted };
  const rollBack = () => {
    toggle.checked = before[key] !== false;
    library = { ...library, online: before };
  };
  try {
    // 整张表一起发：store.updateConfig() 对 online 是**整个替换**，只发一个键会把另外几张写没。
    const saved = await request<{ online?: Record<string, boolean> }>("/api/config", { online: next });
    library = { ...library, online: { ...next, ...saved.online } };
    void renderOnlineAudit();
    const label = ONLINE_SWITCHES_UI.find((entry) => entry.key === key)?.label ?? "在线能力";
    notify(saved.online?.[key] !== false ? `${label}已开启。` : `${label}已关闭：这一类在线请求不再发起，随时可以在这里打开。`);
  } catch (error) {
    rollBack();
    notify(`在线开关保存失败，已回弹为改动前那一档：${(error as Error).message}`);
  }
}

/**
 * 联网默认打开（2026-10-04 定案）⇒ 原来那次"勾选前二次确认"取消：用户第一次打开设置时这一项
 * 已经是勾上的，再要确认一次等于让他为一个已经生效的行为点头。取消的是**开启方向**的确认，
 * 关闭方向照旧给出"不会再发起任何在线请求"的说明，出网范围那段声明改成常驻文案（见上）。
 * 保存成功才把状态写回内存里的快照（在线注入点每次匹配前读的就是它，所以开关即时生效，不必重建
 * client）；保存失败一律回弹成**改动之前那一档**并同步内存快照——默认开启后"失败即回弹为关闭"
 * 会把用户刚做的关闭悄悄做实，方向反了。
 */
async function applyOnlineLyricsSwitch(toggle: HTMLInputElement) {
  const wanted = toggle.checked;
  const before = library.onlineLyrics?.enabled === true;
  const rollBack = () => {
    toggle.checked = before;
    library = { ...library, onlineLyrics: { enabled: before } };
    const state = document.querySelector("[data-role='online-lyrics-state']");
    if (state) state.textContent = onlineLyricsStatus(before);
  };
  try {
    const saved = await request<{ onlineLyrics?: { enabled: boolean } }>("/api/config", {
      onlineLyrics: { enabled: wanted },
    });
    const enabled = saved.onlineLyrics?.enabled === true;
    library = { ...library, onlineLyrics: { enabled } };
    const state = document.querySelector("[data-role='online-lyrics-state']");
    if (state) state.textContent = onlineLyricsStatus(enabled);
    // 开关一变就刷新出网表：全关时服务端会连记录一起清空，面板上必须当场显示"不再记录"，
    // 否则用户看到的是上一次打开时留下的行，"关着零暴露"在界面上就不成立。
    void renderOnlineAudit();
    notify(enabled
      ? "在线歌词匹配已开启：只查询歌词，不下载音乐。"
      : "在线歌词匹配已关闭：不会再发起任何在线请求，随时可以在这里打开。");
  } catch (error) {
    rollBack();
    notify(`在线歌词开关保存失败，已回弹为${before ? "开启" : "关闭"}：${(error as Error).message}`);
  }
}

/**
 * 「重新补一次封面」：把 M3-c 的 `force` 路由接成一个按钮。三句讲究：
 *   ① 按钮只负责"再排一轮"，**跑成什么样由服务端说**（开关关着它回 404，那句实话直接进 notify）；
 *   ② 一进去先看 `covers.running`，正在跑就别再排一轮（多点几下不该叠出并行轮询）；
 *   ③ 补不补得到都在服务日志里各留一行（`backfillCovers` 那侧），界面上不假装"已完成"。
 */
async function refreshCovers() {
  if (demo) { notify("演示曲库不联网。"); return; }
  if (!library.albums.length) { notify("还没有曲库：先添加音乐文件夹。"); return; }
  if (library.covers?.running) { notify("封面补全正在跑这一轮，等它跑完再点。"); return; }
  try {
    const next = await request<MusicLibrary>("/api/online/cover/backfill", { force: true });
    // 与介绍那一路同理：这一问的应答可能比下一次轮询更早，版本号要抬，免得旧快照把它盖掉。
    libraryStateVersion++;
    apiAvailable = true;
    await receiveLibrary(next);
    const job = next.covers;
    notify(job?.total
      ? `封面补全已开始：${job.total} 张没有封面的专辑各问一次（已有封面的不碰，进度在服务日志里逐张留行）。`
      : "没有需要补封面的专辑：每张都已经有内嵌或同目录封面。");
  } catch (error) {
    notify(`封面补全没开始：${(error as Error).message}`);
  }
}

function renderLibraryPanel() {
  $("#panel-body").innerHTML =
    `<p class="panel-intro">根目录中的每首单曲各是一张卡片，优先使用自身内嵌封面。子文件夹按专辑展示，优先使用文件夹封面。</p><label class="field-label" for="music-roots">音乐文件夹<span>多个目录各占一行</span></label><textarea id="music-roots" rows="3" placeholder="/Users/你的用户名/Music">${esc(library.roots.map((r) => r.path).join("\n"))}</textarea><div class="panel-actions"><button class="primary-button" data-action="scan">保存目录并扫描 ↗</button><button data-action="rescan">重新扫描</button></div><div id="scan-status" class="scan-status"></div><div class="library-metrics"><div><b>${library.albums.length}</b><span>专辑</span></div><div><b>${library.albums.reduce((n, a) => n + a.tracks.length, 0)}</b><span>曲目</span></div><div><b>${library.genres.filter((g) => library.albums.some((a) => a.genreId === g.id)).length}</b><span>流派</span></div></div><section class="panel-section"><h3>在线资料与本地分类</h3><p>向 MusicBrainz 查询专辑名称与艺术家，补充流派和制作人员；音乐文件留在本机。已有资料使用缓存，人工分类优先保留。</p><button data-action="enrich-library" class="text-button">补充缺失的在线资料 ↗</button><button data-action="edit-genres" class="text-button">编辑流派归并规则 ↗</button></section><section class="panel-section"><h3>封面显示</h3><p>方形、竖版、横版封面均保持原始比例，完整放入卡片正面。没有封面时显示专辑名称占位，不使用其他专辑的图片。</p><button data-action="covers-refresh" class="text-button">重新补一次封面 ↗</button>${!library.albums.length ? '<button data-action="demo" class="text-button">查看演示封面 ↗</button>' : ""}</section>`;
  updateScanStatus();
  const configSection = document.createElement("section");
  configSection.className = "panel-section";
  configSection.id = "online-config";
  $("#panel-body").append(configSection);
  void (async () => {
    try {
      const config = await request<{
        musicBrainzContact?: string;
        musicBrainzConfigured?: boolean;
        onlineEnabled?: boolean;
        onlineLyrics?: { enabled: boolean };
        preferLoggedInSource?: boolean;
        preferSamePlatformSource?: boolean;
        playReporting?: boolean;
        kugouDeviceIdentity?: boolean;
      }>("/api/config");
      if (!configSection.isConnected) return;
      configSection.innerHTML = `<h3>资料库连接</h3><label class="field-label" for="metadata-contact">MusicBrainz 联系邮箱或项目网址</label><input id="metadata-contact" type="text" value="${esc(config.musicBrainzContact || "")}" placeholder="你的联系邮箱或公开项目网址"><p>按 MusicBrainz 要求用于标识本应用的资料请求，不用于注册或订阅。</p><label class="settings-row"><span>扫描后自动补充新专辑资料<small>默认已开启，可在此关闭；已有缓存不重复查询，断网仍可浏览与播放</small></span><input type="checkbox" id="online-enabled" ${config.onlineEnabled ? "checked" : ""}></label><button class="text-button" data-action="save-online">保存资料库设置 ↗</button><p>${config.musicBrainzConfigured ? "资料库请求标识已配置，扫描后自动补充缺资料的专辑。" : "尚未配置联系方式：这一项虽默认开启，在线资料补全会整轮跳过（MusicBrainz 要求请求带联系人）。本地曲库与播放不受影响。"}</p>`;
      // 在线能力单独一段，且与上面那个「扫描后自动补充资料」是两个独立开关：
      // onlineEnabled 早已被 MusicBrainz 补全占用（R61），复用会让一个勾选框管两件不同性质的事。
      const onlineLyricsSection = document.createElement("section");
      onlineLyricsSection.className = "panel-section";
      onlineLyricsSection.id = "online-lyrics-config";
      onlineLyricsSection.innerHTML = `<h3>在线能力（默认已开启，可在此关闭）</h3>${ONLINE_SWITCHES_UI.map((entry) => `<label class="settings-row"><span>${entry.label}<small>${entry.hint}</small></span><input type="checkbox" id="online-${entry.key}-enabled" data-online-switch="${entry.key}" ${library.online?.[entry.key] !== false ? "checked" : ""}></label>`).join("")}<p>${esc(ONLINE_LYRICS_DISCLOSURE)}</p><p data-role="online-lyrics-state">${esc(onlineLyricsStatus(library.online?.lyrics !== false))}</p><div data-role="online-audit"></div>`;
      configSection.after(onlineLyricsSection);
      void renderOnlineAudit();
      // M3-a Task E：扫码登录单独一节，放在「在线能力」之后（它依赖在线能力开着，路由才会应答）。
      // 这段声明必须与实现一致：登录后拿到的是**这个账号自己的权益**，VIP 歌对非 VIP 账号仍是试听。
      const authSection = document.createElement("section");
      authSection.className = "panel-section";
      authSection.id = "online-auth-config";
      authSection.innerHTML = `<h3>扫码登录（可选）</h3>` +
        `<p>在线流式播放默认只有 30 秒试听片段——这是平台的版权规则，不是缺陷。用你自己的账号扫码登录后，` +
        `能播完整歌曲的就按你账号的权益播完整歌曲；<b>VIP 歌曲对非 VIP 账号仍然只有试听</b>，` +
        `本机不做任何绕过。本地音乐始终完整播放，与登录态无关。</p>` +
        `<p>凭据只保存在这台机器的服务端（数据目录下的会话分区，仅本机用户可写的文件），浏览器与界面都拿不到它；` +
        `这里只显示状态。三家各自独立、各自扫码，登录一家不会让另一家变成已登录。` +
        `出网记录可以在上一节的表里逐条看到，包括 QQ 登录用的一条长连接。</p>` +
        // R143（任务四）：有边距的偏好。文案要把"边距是多少、超出怎么办、没登录时怎样"三件都说清，
        // 否则用户会以为这是一个"只播登录源"的硬开关（那不是它的语义，那会把能播的换成不能播的）。
        `<label class="settings-row"><span>匹配时优先已登录的音源<small>` +
        `歌单逐条匹配时，如果已登录那一家也找到了过线的同名曲、且分数与全局最高分相差不超过 ${ONLINE_PREFERENCE_MARGIN} 分，` +
        `就选已登录那一家（这样更可能按你的账号权益完整播放）；相差超过 ${ONLINE_PREFERENCE_MARGIN} 分仍取分数最高的那条。` +
        `一家都没登录时这一项什么都不改（默认关闭）。它不会把不过线的候选抬成匹配。</small></span>` +
        `<input type="checkbox" id="prefer-logged-in-source" ${config.preferLoggedInSource ? "checked" : ""}></label>` +
        `<button class="text-button" data-action="save-pref-source">保存匹配偏好 ↗</button>` +
        `<p data-role="pref-source-state"></p>` +
        // R156（任务三）：同平台优先。文案必须把"它不保证更能播"这句说出来——
        // 同平台那一家没登录时，这一条可能把结果换成一首取不到文件的歌（两条偏好的真实冲突，
        // 不是实现缺陷）。缺省开（用户本批明确要的行为），一句话可关回。
        `<label class="settings-row"><span>导入自哪个平台就优先那个平台<small>` +
        `歌单文件头部带来历注释（形如 <code># qq-playlist …</code>）时，逐条匹配先在同一家里找同名曲：` +
        `它与全局最高分相差不超过 ${ONLINE_PREFERENCE_MARGIN} 分就选它，超过 ${ONLINE_PREFERENCE_MARGIN} 分仍取最高分那条。` +
        `两条偏好是叠着走的：<b>先同平台 → 再已登录那一家 → 再全局最高分</b>，都用同一个 ${ONLINE_PREFERENCE_MARGIN} 分边距，` +
        `也都<b>不会</b>把没过匹配线的候选抬成匹配。<b>注意：优先同平台不保证更能播</b>——` +
        `那一家你没登录时，它可能反而取不到文件（此时徽标会写「同平台优先（…已让位）」，` +
        `关掉这一项或去登录那一家都可以）。来历注释被删掉，这一条就对这张单失效（退化成只按分数挑）。` +
        `</small></span>` +
        `<input type="checkbox" id="prefer-same-platform-source" ${config.preferSamePlatformSource !== false ? "checked" : ""}></label>` +
        `<button class="text-button" data-action="save-same-platform">保存同平台偏好 ↗</button>` +
        // R161（任务八）：播放上报。**缺省关**，而且这一句必须把"报什么"写全 ——
        // 一个只写"上报你的播放记录"的开关等于没写隐私口径。
        `<label class="settings-row"><span>播放上报（默认关闭）<small>` +
        `开着之后，<b>在线曲目</b>听到第 30 秒起，会向<b>这一首本来就是从它那儿来的那一家</b>` +
        `报一次"我在听这首"（网易 / 酷狗各一条通道；QQ 的桥里没有这一条）。` +
        `报过去的只有三样：<b>平台自己的曲目标识、收听到第几秒、一次动作名</b>——` +
        `曲名歌手专辑文本不发、本地文件路径与曲库结构不发、整条队列与歌单不发、不建"播放历史"文件、` +
        `不发给任何第三方统计。本地曲目<b>一条都不报</b>。` +
        `没登录那一家时不会发（没有"我的听歌记录"可报）。每一笔都进得出网审计。` +
        `关掉这一项只是不再报，不影响播放。` +
        `</small></span>` +
        `<input type="checkbox" id="play-reporting" ${config.playReporting === true ? "checked" : ""}></label>` +
        `<button class="text-button" data-action="save-play-reporting">保存播放上报设置 ↗</button>` +
        `<p data-role="play-reporting-state">${config.playReporting === true ? "当前：开着（听满 30 秒的在线曲目会报给来源平台）" : "当前：关着（缺省）——本机不会向任何平台送播放记录，一次请求都不发。"}</p>` +
        // R154（任务一）：酷狗设备身份的**备用路**开关，缺省关。文案必须是量出来的事实：
        // 今天接通酷狗音频靠的是"显式带一个空的设备号"（上游读成"没有设备"），不是伪造设备身份，
        // 所以这里不能写成"打开才能播酷狗"（那是假话），也不能暗示本机在冒充手机。
        `<label class="settings-row"><span>酷狗设备身份备用路（默认关）<small>` +
        `本机已向酷狗接通第三个可播音源，靠的是随请求明确带上"这台机器没有设备号"（实测这样就给完整文件），` +
        `<b>不需要也不会在默认情况下伪造设备身份</b>。只有当酷狗上游改口、明确回"本次请求需要验证"时，` +
        `这一项才允许调用一次设备注册换取设备号并重试一次；那种请求伪装的是一台安卓设备，` +
        `平台可能识别并限制它，所以默认关着。关掉或保持默认时，本机的酷狗音频仍然照常（登录即可）。</small></span>` +
        `<input type="checkbox" id="kugou-device-identity" ${config.kugouDeviceIdentity ? "checked" : ""}></label>` +
        `<button class="text-button" data-action="save-kugou-device">保存设备身份偏好 ↗</button>` +
        `<div class="auth-rows" data-role="auth-rows"><p>正在读取登录状态…</p></div>`;
      authSection.dataset.onlineAuthPanel = "true";
      onlineLyricsSection.after(authSection);
      void renderAuthRows();
      // F3：歌单文件夹可指定。这里显示的是**当前真正在用的目录**（服务端给的绝对路径），
      // 输入框留空 = 回到默认；改完把老目录里的歌单与 sidecar 复制过来（不删源）。
      const playlistDirSection = document.createElement("section");
      playlistDirSection.className = "panel-section";
      playlistDirSection.id = "playlist-dir-config";
      playlistDirSection.innerHTML = `<h3>歌单文件夹</h3><p>每张歌单是这里的一个 <code>&lt;名字&gt;.playlist.txt</code> 纯文本文件，逐条匹配的缓存在同名的 <code>.matches.json</code>。用任何编辑器改完，回到界面即生效。</p>` +
        `<p class="panel-intro">当前：<code>${esc(library.playlistDir ?? "")}</code>（默认 <code>${esc(library.playlistDirDefault ?? "")}</code>）</p>` +
        `<label class="field-label" for="playlist-dir">改成别的文件夹<small>要绝对路径，如 D:\\音乐\\歌单；留空即回到默认</small></label>` +
        `<input id="playlist-dir" type="text" placeholder="${esc(library.playlistDirDefault ?? "")}">` +
        `<div class="panel-actions"><button class="text-button" data-action="save-playlist-dir">应用 ↗</button></div>` +
        `<p id="playlist-dir-state" class="scan-status" role="status" aria-live="polite"></p>`;
      onlineLyricsSection.after(playlistDirSection);
      onlineLyricsSection
        .querySelector<HTMLInputElement>("#online-lyrics-enabled")
        ?.addEventListener("change", (event) =>
          void applyOnlineLyricsSwitch(event.currentTarget as HTMLInputElement),
        );
      // 另外两张（搜索 / 试听）走同一个保存通路：整张表一起发、失败回弹到改动前那一档。
      for (const entry of ONLINE_SWITCHES_UI) {
        if (entry.key === "lyrics") continue;
        onlineLyricsSection
          .querySelector<HTMLInputElement>(`#online-${entry.key}-enabled`)
          ?.addEventListener("change", (event) =>
            void applyOnlineSwitch(entry.key, event.currentTarget as HTMLInputElement),
          );
      }
    } catch (error) {
      if (configSection.isConnected)
        configSection.innerHTML = `<p>${esc((error as Error).message)}</p>`;
    }
  })();
}
function updateScanStatus() {
  const el = document.querySelector("#scan-status");
  if (el)
    el.textContent = library.scan.running
      ? "正在扫描，已有曲库可以继续浏览…"
      : library.scan.error ||
        library.roots
          .filter((r) => r.status === "offline")
          .map((r) => `${r.path} 暂时离线，原索引已保留。`)
          .join("\n") ||
        (library.scan.finishedAt
          ? `上次扫描 ${new Date(library.scan.finishedAt).toLocaleString("zh-CN")}`
          : "尚未扫描音乐目录。");
}
function renderSearchPanel() {
  $("#panel-body").innerHTML =
    `<input class="album-search" id="album-search" type="search" placeholder="专辑、歌曲、歌手、流派…" aria-label="搜索专辑与歌曲"><div class="genre-filters"><button data-filter="" class="active">全部</button>${genres
      .filter((g) => albums.some((a) => a.genreId === g.id))
      .map((g) => `<button data-filter="${esc(g.id)}">${esc(g.name)}</button>`)
      .join("")}</div>${searchTabMarkup()}<div id="album-results"></div>`;
  renderSearchResults();
}

/**
 * 「本地 / 在线」页签（Task 7）。两页的语义不同，所以是两个渲染分支而不是"同一列表加个来源标签"：
 * 本地结果点击 = 定位到那张专辑（维持原行为），在线结果点击 = 直接试听（它不在本地库里，没有可定位的专辑）。
 */
function searchTabMarkup() {
  return `<div class="genre-filters search-tabs" role="tablist" aria-label="搜索范围">
    <button data-search-tab="local" role="tab" aria-selected="${searchTab === "local"}" class="${searchTab === "local" ? "active" : ""}">本地</button>
    <button data-search-tab="online" role="tab" aria-selected="${searchTab === "online"}" class="${searchTab === "online" ? "active" : ""}">在线</button>
  </div>`;
}
let searchTab: "local" | "online" = "local";
/** 最近一次在线检索的结果：点击行时按 id 回到这里取条目，再把契约转成内核曲目。 */
let onlineResults: OnlineSearchItem[] = [];
/** 上一次检索的原样结果（渲染只读它，不再触发网络——见 `paintOnlineResults`）。 */
let onlineResponse: OnlineSearchResponse | null = null;
// F2：哪一行正开着"加进哪张歌单"的选择器（-1 = 没开），以及点开时读到的歌单清单。
let addChooserIndex = -1;
let addChooserLists: PlaylistSummary[] = [];
let onlineSearchToken = 0;
/**
 * 在线检索的输入防抖。真机第一版没有这一层：`Input.insertText` 一次输入就发了 4 笔检索
 * （出网审计表里 `search ×4` 就是那次留下的），每敲一个字都去问一次第三方接口既费也吵。
 * 本地那一页不受影响——它只是过滤内存里的索引。
 */
const ONLINE_SEARCH_DEBOUNCE_MS = 600;
let onlineSearchTimer: number | undefined;
function scheduleOnlineSearch() {
  window.clearTimeout(onlineSearchTimer);
  onlineSearchTimer = window.setTimeout(() => void renderOnlineResults(), ONLINE_SEARCH_DEBOUNCE_MS);
}

/**
 * 纯渲染：只把上一次的结果与选择器状态画出来，一次网都不出。
 * F2 一开始把选择器的"重画"直接接在 `renderOnlineResults()` 上，真机审计立刻露馅：
 * 打开选择器、加完歌单各算一次检索（`search:4` 而不是 1）——那个函数是"检索 + 渲染"两件事。
 */
function paintOnlineResults(): void {
  const box = $("#album-results");
  if (!box) return;
  if (library.online?.search === false) {
    box.innerHTML = '<div class="no-results">在线搜索已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）。</div>';
    return;
  }
  const response = onlineResponse;
  if (!response) {
    box.innerHTML = '<div class="no-results">输入歌名、歌手或专辑名开始在线检索。检索会联网，结果不下载、只在本机中转试听。</div>';
    return;
  }
  // F2：每行右侧一个"加入歌单"。行本身是 `<button>`，按钮不能套按钮，所以外面包一层网格。
  const rows = response.items.map((item, index) => {
    const row = `<button class="album-result song-result online-result" data-online-track="${esc(item.id)}" aria-label="试听 ${esc(item.title)}，${esc(item.artist)}"><span class="result-cover">${coverImage(item.coverUrl ?? "", `${item.title}封面`)}</span><span class="result-copy"><strong>${esc(item.title)}</strong><small>${esc(item.artist)}${item.album ? ` · ${esc(item.album)}` : ""}</small></span><em>${esc(ONLINE_PROVIDER_NAMES[item.provider] ?? item.provider)} · ${esc(formatDuration(item.durationMs / 1000))} · 试听</em><i>↗</i></button>`;
    const add = `<button class="text-button online-add" data-action="playlist-add-open" data-online-index="${index}" aria-label="把 ${esc(item.title)} 加入歌单">加入歌单</button>`;
    const chooser = index === addChooserIndex ? addToPlaylistMarkup(addChooserLists, item) : "";
    // R127：手工指定模式下每一行多一颗"指定这一条"（写回目标行）。与"加入歌单"并列而不是替换它——
    // 用户可能看着这一行改主意："这首我其实想收进另一张单子"。
    const pick = pickTarget ? pickRowMarkup(index, item) : "";
    return `<div class="online-row">${row}${add}${pick}</div>${chooser}`;
  });
  const banner = pickTarget ? pickBannerMarkup(pickTarget, playlistDetail?.name ?? pickTarget.playlistId) : "";
  const summary = `<div class="no-results">${esc(perSourceSummary(response.perSource))}${response.total ? ` · 共约 ${esc(String(response.total))} 条` : ""}${response.error ? ` · ${esc(response.error)}` : ""}</div>`;
  box.innerHTML = banner + (rows.length ? rows.join("") + summary : `<div class="no-results">${response.ok ? "在线没有检索到结果。" : esc(response.error ?? "在线检索没有成功")}</div>${summary}`);
}

async function renderOnlineResults() {
  const query = ($<HTMLInputElement>("#album-search")?.value || "").trim();
  const box = $("#album-results");
  if (!box) return;
  // 四张子开关默认都是"开"，所以判据一律是 `!== false`（写 `=== true` 会把没写过配置的缺省态当成关闭）。
  if (library.online?.search === false) {
    onlineResponse = null;
    onlineResults = [];
    paintOnlineResults();
    return;
  }
  if (!query) {
    onlineResponse = null;
    onlineResults = [];
    paintOnlineResults();
    return;
  }
  const token = ++onlineSearchToken;
  box.innerHTML = '<div class="no-results">正在联网检索…</div>';
  try {
    const response = await requestOnlineSearch(query, { offset: 0, limit: 20 });
    if (token !== onlineSearchToken || !box.isConnected) return;
    onlineResponse = response;
    onlineResults = response.items;
    addChooserIndex = -1;   // 换了一次结果集，旧行号不再对应任何东西
    paintOnlineResults();
  } catch (error) {
    if (token !== onlineSearchToken || !box.isConnected) return;
    box.innerHTML = `<div class="no-results">在线检索失败：${esc((error as Error).message)}</div>`;
  }
}

/** F2：打开 / 收起某一行的"加进哪张歌单"。清单是点开才读的——那是本地读盘，不出网。 */
async function toggleAddChooser(index: number) {
  if (addChooserIndex === index) {
    addChooserIndex = -1;
    paintOnlineResults();
    return;
  }
  addChooserIndex = index;
  addChooserLists = [];
  paintOnlineResults();
  try {
    const data = await request<{ playlists: PlaylistSummary[] }>("/api/playlists");
    if (addChooserIndex !== index) {
      // 另一种"点了没反应"：清单读回来得太晚。分两样看——
      //   · 用户已经去点别行 ⇒ 那一次点击拥有画面，这里再说话就是噪音；
      //   · 结果集被换掉 / 选择器被关掉（-1）⇒ 他这次点击凭空蒸发了，必须说。
      if (addChooserIndex === -1) notify("这一行对应的检索结果已经不在了，请重新点「加入歌单」。");
      return;
    }
    addChooserLists = data.playlists;
  } catch (error) {
    if (addChooserIndex !== index) {
      if (addChooserIndex === -1) notify("这一行对应的检索结果已经不在了，请重新点「加入歌单」。");
      return;
    }
    addChooserIndex = -1;
    notify(`读歌单列表失败：${(error as Error).message}`);
  }
  paintOnlineResults();
}

/**
 * F2：把一行搜索结果写进歌单。
 * 交出去的是我们**自己签发**的那条同源地址（`audioUrl`），身份由服务端反解成文本第 4 段——
 * 前端不负责拼格式，否则同一份格式知识就有两处真源（`mediaMid` 也就不用出契约了，见 R78）。
 */
async function addOnlineEntryToPlaylist(id: string, name: string) {
  const item = onlineResults[addChooserIndex];
  // 静默返回是这一条链上最坏的一种失败：用户看到的就是"点了没反应"，而服务端根本没被问过
  // （看板 c84bb56 的实机症状）。本仓纪律：失败必须说出口，且说的是**这一步为什么没做成**。
  if (!item) {
    notify("这一行对应的检索结果已经不在了（多半是期间又检索了一次），请重新点「加入歌单」。");
    return;
  }
  const newName = name.trim();
  if (!id && !newName) {
    notify("新歌单要有个名字");
    return;
  }
  const payload = {
    action: "add",
    ...(id ? { id } : { name: newName }),
    items: [{ title: item.title, artist: item.artist, album: item.album, durationMs: item.durationMs, audioUrl: item.audioUrl }],
  };
  try {
    const result = await request<{ playlist: { id: string; name: string; items: unknown[] } }>("/api/playlists", payload);
    addChooserIndex = -1;
    paintOnlineResults();
    notify(`已把「${item.title}」加进「${result.playlist.name}」（现在 ${result.playlist.items.length} 条）`);
  } catch (error) {
    notify(`加入歌单失败：${(error as Error).message}`);
  }
}
/**
 * R127（方案 B）：「手工指定」的目标行（null = 不在指定模式）。
 * 与"加入歌单"唯一的区别是**这一条会改用户那份文本文件**，所以：
 *   · 目标行带着"当时看到的原文"去，服务端写之前先对照，对不上就一个字都不写；
 *   · 每一步失败都要说出口（静默失败在这条链上的表现就是"点了没反应"或"改错了行"）。
 */
let pickTarget: PlaylistPickTarget | null = null;

/** 搜索面板两页的切换。提出来共用是因为「手工指定」也要直接落到在线那一页，且按钮态必须同步。 */
function applySearchTab(next: "online" | "local") {
  searchTab = next;
  document.querySelectorAll("[data-search-tab]").forEach((button) => {
    const active = (button as HTMLElement).dataset.searchTab === searchTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderSearchResults();
}

function startPick(index: number) {
  const item = playlistDetail?.items[index];
  if (!playlistDetail || !item) {
    notify("这一行对应的歌单条目已经不在了，请重新打开这张歌单。");
    return;
  }
  if (!item.line || !item.lineText) {
    notify("服务端没给出这一行的行号与原文，做不到只改这一行；请重新打开这张歌单。");
    return;
  }
  pickTarget = {
    playlistId: playlistDetail.id, line: item.line, expect: item.lineText,
    title: item.entry.title, artist: item.entry.artist,
  };
  openPanel("search");
  const box = $<HTMLInputElement>("#album-search");
  if (box) box.value = [item.entry.title, item.entry.artist].filter(Boolean).join(" ");
  applySearchTab("online");
}

async function runPick(index: number) {
  const target = pickTarget;
  if (!target) {
    notify("已经不在手工指定模式里了，请重新点未匹配那一行的「手工指定」。");
    return;
  }
  const item = onlineResults[index];
  if (!item) {
    notify("这一行对应的检索结果已经不在了（多半是期间又检索了一次），请重新点「手工指定」。");
    return;
  }
  try {
    const result = await request<{ line: number; before: string; after: string }>("/api/playlists", {
      action: "replace", id: target.playlistId, line: target.line, expect: target.expect,
      entry: { title: item.title, artist: item.artist, album: item.album, durationMs: item.durationMs, audioUrl: item.audioUrl },
    });
    pickTarget = null;
    openPanel("playlist");          // 回到那张歌单：徽标当场从"未匹配"变成"已匹配 · 来源"
    notify(`第 ${result.line} 行已换成「${item.title} - ${item.artist}」（原来那行是「${result.before}」）`);
  } catch (error) {
    // 服务端拒绝时文件原样未动——这句必须说，否则用户会以为已经改掉了。
    notify(`手工指定没写成：${(error as Error).message}（文件没有改动）`);
  }
}
let searchGenre = "";
function renderSearchResults() {
  // 两页各走各的渲染：在线那一页要出网，绝不能在切到"本地"时被顺手触发；
  // 而且它走防抖（每敲一个字就问一次第三方接口，真机实测一次输入发了 4 笔检索）。
  if (searchTab === "online") {
    scheduleOnlineSearch();
    return;
  }
  const query = ($<HTMLInputElement>("#album-search")?.value || "")
    .trim()
    .toLocaleLowerCase();
  const results: string[] = [];
  for (const a of albums) {
    if (searchGenre && a.genreId !== searchGenre) continue;
    if (!query || `${a.title} ${a.artist} ${genreName(a.genreId)}`.toLocaleLowerCase().includes(query)) {
      results.push(`<button class="album-result" data-album="${esc(a.id)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(a.title)}</strong><small>${esc(a.artist)} · ${esc(genreName(a.genreId))}</small></span><em>专辑</em><i>↗</i></button>`);
    }
    if (!query) continue;
    for (const track of a.tracks) {
      if (!`${track.title} ${track.artist}`.toLocaleLowerCase().includes(query)) continue;
      // Preserve the exact song identity; selecting a result navigates without playing.
      results.push(`<button class="album-result song-result" data-album="${esc(a.id)}" data-search-track="${esc(track.id)}" aria-label="定位歌曲 ${esc(track.title)}，${esc(a.title)}"><span class="result-cover">${cover(a)}</span><span class="result-copy"><strong>${esc(track.title)}</strong><small>${esc(track.artist)} · ${esc(a.title)}</small></span><em>歌曲</em><i>↗</i></button>`);
    }
  }
  $("#album-results").innerHTML = results.length
    ? results.join("")
    : '<div class="no-results">没有找到专辑或歌曲。</div>';
}
/**
 * 歌单面板（Task 11）。列表与详情都**每次重新拉**：歌单是磁盘上的文本，
 * 用户在编辑器里改完不该要重启或刷新才能看到（与 Task 8 的"每请求重读"同一口径）。
 */
let playlistDetail: PlaylistDetail | null = null;

/**
 * 面板可能已经关了：等网络响应那几秒里用户点了 ×，`#panel-body` 就不在了。
 * 这时"往面板里写"没有对象，**静默放弃才是正确答案**——把它抛出去会被上层误读成
 * "那件事失败了"（实机那句「匹配失败：Cannot set properties of null (setting 'innerHTML')」
 * 就是这么来的，而服务端其实已经匹配成功）。判据沿用 `editGenres` 那一套：连 `isConnected` 一起看，
 * 面板重开过就是另一个节点，写到游离节点上等于什么都没发生。
 */
function livePanelBody(): HTMLElement | null {
  const body = document.querySelector<HTMLElement>("#panel-body");
  return body?.isConnected ? body : null;
}

async function renderPlaylistsPanel() {
  const opening = livePanelBody();
  if (!opening) return;
  opening.innerHTML = `<p class="panel-intro">正在读取歌单…</p>`;
  try {
    const data = await request<{ playlists: PlaylistSummary[] }>("/api/playlists");
    if (panel !== "playlists") return;
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = listMarkup(data.playlists, library.playlistDir);
  } catch (error) {
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = `<p class="panel-intro">歌单读取失败：${esc((error as Error).message)}</p>`;
  }
}

async function renderPlaylistDetail() {
  const id = playlistOpenId;
  if (!id) {
    void renderPlaylistsPanel();
    return;
  }
  const opening = livePanelBody();
  if (!opening) return;
  opening.innerHTML = `<p class="panel-intro">正在读取 ${esc(id)}…</p>`;
  try {
    const data = await request<PlaylistDetail>(`/api/playlists/${encodeURIComponent(id)}/tracks`);
    if (panel !== "playlist") return;
    playlistDetail = data;
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = detailMarkup(data);
  } catch (error) {
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = `<p class="panel-intro">歌单读取失败：${esc((error as Error).message)}</p>`;
  }
}
let playlistOpenId = "";

function playlistStatus(message: string) {
  const node = document.querySelector<HTMLElement>("#playlist-status");
  if (node) node.textContent = message;
  else notify(message);
}

/**
 * 整单播放与单条「试听」都走内核的 `play(id, tracks)` **全量入队**。
 * 只塞一首进去 = "当前曲播完即停、下一首也切不动"（实机 279 条那条 bug 就是这么来的），
 * 而 R109 那四档模式、`ended` 自然续播、上一首/下一首全部以队列为准——队列里没有就没有。
 *
 * 回执读的是**内核队列的实际长度**，不是我们递出去的那份：`play()` 会按 id 去重，
 * 同一在线曲目在歌单里出现两次时队列会短一截，照抄"279 条"就成了假话。
 */
async function playPlaylistFromDetail(entryIndex?: number) {
  if (!playlistDetail) return;
  const { tracks, entries } = playlistQueue(playlistDetail.items);
  if (!tracks.length) {
    playlistStatus("这张歌单还没有任何一条匹配上，先点「联网匹配整单」。");
    return;
  }
  const wanted = entryIndex === undefined ? entries[0] : entryIndex;
  const at = entries.indexOf(wanted);
  const start = tracks[at === -1 ? 0 : at];
  await player.play(start.id, tracks).catch(() => undefined);
  const queued = player.state.queue.length;
  const skipped = playlistDetail.items.length - tracks.length;
  const deduped = tracks.length - queued;
  const notes: string[] = [];
  if (skipped) notes.push(`整单 ${playlistDetail.items.length} 条里 ${skipped} 条未匹配，已跳过`);
  if (deduped > 0) notes.push(`${deduped} 条与队列里已有的曲目重复，按 id 去重后不再排第二次`);
  playlistStatus(`正在播放已匹配的 ${queued} 条${notes.length ? `（${notes.join("；")}）` : ""}`);
  // R198：起播成功之后给这张歌单选一张**展示封面**（服务端取"已匹配条目里第一条有封面的"）。
  // 只在真变了的时候重建架子（`applyLibrary` 会重排 + 必要时刷新场景）——不变的点击不该白重建一次。
  const cover = await request<{ changed?: boolean }>(
    `/api/playlists/${encodeURIComponent(playlistDetail.id)}/display-cover`,
    { action: "set" },
  ).catch(() => null);
  if (cover?.changed) await applyLibrary().catch(() => undefined);
}

/**
 * 收藏列表视图（R132 · 把 R130 那条功能闭环）。"在不在曲库、能不能播"读的是服务端那一份事实
 * （`GET /api/favorites/view`：清单 + 现算的指纹索引），界面不第二次算指纹。
 * 队列在这里现算：本地行取曲库里的**真曲目对象**（收藏快照只有身份、没有可播地址），
 * 在线行走既有窄契约（`toMusicTrack`）——两者混排进同一条队列是安全的，
 * 内核按 `track.audioUrl` 播，本地与在线本来就走同一条通路（`music-player.ts` 那一行的 ?? 分支）。
 */
let favoritesDetail: FavoritesView | null = null;

function favoriteStatus(message: string) {
  const node = document.querySelector<HTMLElement>("#favorite-status");
  if (node) node.textContent = message;
  else notify(message);
}

/** 本地行的封面 = 它所在专辑那张（`albums` 里的 coverUrl 由服务端算好，没有就是 undefined）。 */
function favoriteCoverOf(row: FavoriteRow): string {
  // 在线行：R135（Q11）存过封面才由服务端换回同源 token 地址；没存过就是空串 ⇒ 界面画既有占位。
  if (row.sourceKind === "online") return row.online?.coverUrl ?? "";
  if (!row.albumId) return "";
  return albums.find((album) => album.id === row.albumId)?.coverUrl ?? "";
}

async function renderFavoritesPanel() {
  const opening = livePanelBody();
  if (!opening) return;
  opening.innerHTML = `<p class="panel-intro">正在读取收藏…</p>`;
  try {
    const data = await request<FavoritesView>("/api/favorites/view");
    if (panel !== "favorites") return;   // 读回来之前面板已经关了或换页了：旧回执不许覆盖新画面
    favoritesDetail = data;
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = favoritesMarkup(data, { coverOf: favoriteCoverOf });
  } catch (error) {
    favoritesDetail = null;
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = `<p class="panel-intro">收藏读取失败：${esc((error as Error).message)}</p>`;
  }
}

/**
 * R144 ·「歌词匹配」面板的本地状态。
 * 近候选只存在这一处：面板重画时按 `data-index` 取回那条候选的**身份**再发给服务端。
 * 服务端对收到的每一项都重新校验形状（`claimEntryFrom`），所以这里被改也换不来一次越权出网。
 */
let lyricMatchState: { trackId: string; near: OnlineNearCandidate[] } | null = null;

/** 面板与歌词客户端各问各的会漂，所以请求构造只这一份（描述字段复用 `onlineLyricDescriptor`）。 */
async function askLyricMatch(track: MusicTrack, retry: boolean): Promise<OnlineReply> {
  try {
    const response = await fetch("/api/online/lyrics/match", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: track.id, ...(retry ? { retry: true } : {}), ...onlineLyricDescriptor(track) }),
    });
    const payload = (await response.json().catch(() => null)) as OnlineReply | null;
    if (!response.ok) return { matched: false, reason: payload?.error ?? `匹配请求失败（HTTP ${response.status}）` };
    return payload ?? { matched: false, reason: "匹配没有返回结果" };
  } catch (error) {
    return { matched: false, reason: `匹配请求失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 面板抬头那句"现在是什么状态"——只根据服务端这一次的答复造句，不去猜界面。 */
function lyricMatchCurrentLine(reply: OnlineReply): string {
  if (reply.localLyrics === "present") return "本地已有带时间轴的歌词，它优先（这一条不会被在线结果替换）";
  if (reply.matched) {
    const origin = ONLINE_PROVIDER_LABELS[reply.provider ?? "qq"] ?? reply.provider ?? "在线";
    return `${reply.claimed ? "已在用你手动认领的那一条" : "自动匹配已给出"} · ${origin} · ${reply.isWordByWord ? "逐字" : "行级"}（${reply.score ?? 0} 分）`;
  }
  return "没有歌词";
}

async function renderLyricMatchPanel(status?: string) {
  const opening = livePanelBody();
  if (!opening) return;
  const track = player.state.currentTrack;
  if (!track) {
    opening.innerHTML = `<p class="panel-intro">先放一首歌，这里才有可匹配的对象。</p>`;
    return;
  }
  opening.innerHTML = `<p class="panel-intro">正在问一次在线匹配…</p>`;
  const switchedOff = library.onlineLyrics?.enabled !== true;
  const reply = switchedOff ? { matched: false, reason: "在线歌词已关闭，未发起任何请求" } : await askLyricMatch(track, false);
  if (panel !== "lyrics") return;   // 答复回来之前面板已经关了或换页了：旧回执不许覆盖新画面
  lyricMatchState = { trackId: track.id, near: reply.near ?? [] };
  const body = livePanelBody();
  if (!body) return;
  body.innerHTML = lyricMatchMarkup({
    track: { title: track.title, artist: track.artist, album: track.album, durationMs: Math.round((track.duration ?? 0) * 1000) },
    current: lyricMatchCurrentLine(reply),
    ...(reply.matched ? {} : { reason: reply.reason }),
    near: reply.near ?? [],
    ...(reply.claim ? { claim: reply.claim } : {}),
    ...(reply.claimFailed ? { claimFailed: reply.claimFailed } : {}),
    ...(status ? { status } : {}),
    ...(switchedOff ? { switchedOff: true } : {}),
  });
}

/**
 * 认领 / 取消之后要让界面真的换词：客户端那份按曲目 id 的缓存必须作废，
 * 舞台也要重走一次加载（`lyricStage.refresh()` 只把"当前是哪首"清掉，两者缺一不可）。
 */
function reloadCurrentLyrics() {
  lyricsClient.reset();
  lyricStage.refresh();
  // Q27（R151 记下的那一格，本批补）：`refresh()` 只是把"当前是哪首"清掉，**真去取词的是 `sync()`**。
  // 缺这一句时认领/取消认领/重试之后画面不动，要等到下一次播放器状态变化（换曲、按暂停）才换——
  // 用户看到的正是"点下去没反应"。同一形状在 R133 那两处（减弱动效、动画档位）已经补过一次，
  // 那两处的写法就是 `refresh()` 紧跟 `sync(player.state)`。
  void lyricStage.sync(player.state);
}

async function claimLyricCandidate(index: number) {
  const track = player.state.currentTrack;
  const candidate = lyricMatchState?.trackId === track?.id ? lyricMatchState?.near[index] : undefined;
  if (!track || !candidate) {
    notify("这条候选已经过期了（换过曲目），请重新打开面板再挑。");
    return;
  }
  try {
    const response = await fetch("/api/online/lyrics/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: track.id, ...onlineLyricDescriptor(track), candidate }),
    });
    const report = (await response.json().catch(() => null)) as
      { ok?: boolean; written?: boolean; error?: string; replaced?: boolean; total?: number; file?: string; timedLines?: number } | null;
    if (!response.ok || !report?.ok) {
      // 没写就是没写：这句必须说得出"文件没动"，否则用户会以为已经认领成功了。
      await renderLyricMatchPanel(`没有写入认领记录：${report?.error ?? `请求失败（HTTP ${response.status}）`}（文件没有改动）`);
      notify(`认领没成：${report?.error ?? "请求失败"}`);
      return;
    }
    reloadCurrentLyrics();
    await renderLyricMatchPanel(
      `已认领《${candidate.title}》（${ONLINE_PROVIDER_LABELS[candidate.provider] ?? candidate.provider}）：`
      + `${report.replaced ? "替换原有那一条" : "新增一条"}，共 ${report.total ?? 1} 条 · 取到 ${report.timedLines ?? 0} 行带时间轴歌词 · 记录写进 ${report.file ?? "lyric-claims.json"}`,
    );
    notify("已按你挑的那一条取词。");
  } catch (error) {
    notify(`认领请求失败：${(error as Error).message}`);
  }
}

async function clearLyricClaim() {
  const track = player.state.currentTrack;
  if (!track) return;
  try {
    const response = await fetch("/api/online/lyrics/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: track.id, action: "clear", ...onlineLyricDescriptor(track) }),
    });
    const report = (await response.json().catch(() => null)) as { ok?: boolean; removed?: boolean; total?: number; error?: string } | null;
    if (!response.ok || !report?.ok) {
      notify(`取消认领没成：${report?.error ?? `请求失败（HTTP ${response.status}）`}`);
      return;
    }
    reloadCurrentLyrics();
    await renderLyricMatchPanel(report.removed
      ? `已取消认领，还剩 ${report.total ?? 0} 条记录（歌词回到自动匹配的结果）`
      : "这一首本来就没有认领记录（没有改动任何文件）");
    notify(report.removed ? "已取消认领。" : "本来就没有认领记录。");
  } catch (error) {
    notify(`取消认领请求失败：${(error as Error).message}`);
  }
}

async function retryLyricMatch() {
  const track = player.state.currentTrack;
  if (!track) { notify("先放一首歌。"); return }
  notify("正在重新问一次在线匹配…");
  const reply = await askLyricMatch(track, true);
  reloadCurrentLyrics();
  await renderLyricMatchPanel(reply.matched
    ? `这一次配上了：${lyricMatchCurrentLine(reply)}`
    : `还是没有配上：${reply.reason ?? "四源都没有可用结果"}`);
}

/**
 * 收藏行 → 内核队列 + 平行数组 `rows`（第 k 格来自视图第几行）。
 * 这两样必须一起算出来：只返回队列的话，"从第 5 行起播"就会去索引过滤后的数组 ⇒ 播错歌
 * （R114 那条 bug 的第二半，同一格不打算再踩第三次）。
 */
function favoritesQueue(view: FavoritesView): { tracks: MusicTrack[]; rows: number[] } {
  const byId = new Map<string, MusicTrack>();
  for (const album of albums) {
    for (const track of album.tracks) if (!byId.has(track.id)) byId.set(track.id, track);
  }
  const tracks: MusicTrack[] = [];
  const rows: number[] = [];
  view.items.forEach((row, index) => {
    if (!row.playable) return;
    if (row.sourceKind === "online") {
      if (row.online) {
        rows.push(index);
        tracks.push(toMusicTrack(row.online));
      }
      return;
    }
    const found = row.trackId ? byId.get(row.trackId) : undefined;
    // 服务端说可播而前端曲库里查不到 ⇒ 只有一种可能：这份视图与前端手里的曲库不是同一刻的
    //（后台刚重扫完）。不塞一个半成品进队列，也不报错——回执那句"跳过 N 条"会说清。
    if (!found) return;
    rows.push(index);
    tracks.push(found);
  });
  return { tracks, rows };
}

async function playFavoritesFromView(rowIndex?: number) {
  const view = favoritesDetail;
  if (!view) return;
  const { tracks, rows } = favoritesQueue(view);
  if (!tracks.length) {
    favoriteStatus("这一份收藏里目前没有可播的条目（本地的都不在曲库里，在线的播不了）。");
    return;
  }
  const at = rowIndex === undefined ? 0 : rows.indexOf(rowIndex);
  const start = tracks[at === -1 ? 0 : at];
  await player.play(start.id, tracks).catch(() => undefined);
  // 条数读内核那份，不读自己算的：去重与失败都在内核里（R114 的"回执读实际长度"）。
  const queued = player.state.queue.length;
  const notes: string[] = [];
  if (view.missing) notes.push(`${view.missing} 条播不了，已跳过`);
  const deduped = tracks.length - queued;
  if (deduped > 0) notes.push(`${deduped} 条与队列里已有的曲目重复，按 id 去重后不再排第二次`);
  favoriteStatus(`正在播放收藏里的 ${queued} 条${notes.length ? `（${notes.join("；")}）` : ""}`);
}

/** 取消收藏那一行，然后**重读视图**（清单变了、行号也变了，不自己就地删格）。 */
async function removeFavoriteAt(rowIndex: number) {
  const row = favoritesDetail?.items[rowIndex];
  if (!row) return;
  try {
    const data = await request<{ liked: boolean; count: number }>("/api/favorites", {
      action: "toggle",
      track: {
        id: row.online?.id ?? row.trackId ?? "", title: row.title, artist: row.artist,
        ...(row.album ? { album: row.album } : {}),
        durationMs: row.durationMs, sourceKind: row.sourceKind,
      },
    });
    // 回执按服务端说的报：清单是它管的，界面猜"应该已经删掉了"就是把一次失败说成成功。
    notify(data.liked ? `已收藏「${row.title}」` : `已取消收藏「${row.title}」（本机共 ${data.count} 条）`);
    // 传输区与岛内那颗心问的是"正在播的这一首收藏了吗"——问一次，不自作主张改读数（两处入口同一个动作）。
    void refreshFavoriteState(player.state.currentTrack);
    void renderFavoritesPanel();
  } catch (error) {
    favoriteStatus(`取消收藏失败：${(error as Error).message}`);
  }
}

/**
 * ⑨ 在线音乐人组：明细点开才取（与歌单同一口径），架上那一行只带条数与色块原料。
 */
let artistOpenSlug = "";
let artistDetail: MusicOnlineArtistDetail | null = null;

function artistStatus(message: string) {
  const node = document.querySelector<HTMLElement>("#artist-status");
  if (node) node.textContent = message;
  else notify(message);
}

async function renderArtistPanel() {
  const slug = artistOpenSlug;
  if (!slug) {
    artistStatus("没有选中任何一位音乐人，先在架子上点开一格。");
    return;
  }
  const opening = livePanelBody();
  if (!opening) return;
  opening.innerHTML = `<p class="panel-intro">正在读取 ${esc(slug)}…</p>`;
  try {
    const data = await request<MusicOnlineArtistDetail>(`/api/online/artists/${encodeURIComponent(slug)}`);
    if (panel !== "artist") return;
    artistDetail = data;
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = artistMarkup(data);
  } catch (error) {
    const body = livePanelBody();
    if (!body) return;
    body.innerHTML = `<p class="panel-intro">音乐人组读取失败：${esc((error as Error).message)}</p>`;
  }
}

/**
 * 整组播放照 `playPlaylistFromDetail` 那条修好的路走（R114 的教训原文：
 * 算出 279 条却只把一首塞进内核，回执还说 279）：
 * **全量入队 + 回执读内核队列的实际长度**。内核会按 id 去重，照抄自己递出去的数就是假话。
 */
async function playArtistGroup(entryIndex?: number) {
  if (!artistDetail) {
    artistStatus("这一组的明细还没取回来（或已经换了一位），请重新点开。");
    return;
  }
  const tracks = artistDetail.items.map(toMusicTrack);
  if (!tracks.length) {
    artistStatus("这位音乐人组里一条可播的曲目都没有。");
    return;
  }
  const start = tracks[entryIndex === undefined ? 0 : Math.min(Math.max(entryIndex, 0), tracks.length - 1)];
  await player.play(start.id, tracks).catch(() => undefined);
  const queued = player.state.queue.length;
  const deduped = tracks.length - queued;
  artistStatus(`正在播放「${artistDetail.name}」的 ${queued} 条${deduped > 0 ? `（${deduped} 条重复，按 id 去重后不再排第二次）` : ""}`);
}

/**
 * R162（任务九）· 音乐人网格的宿主侧。
 *
 * 与 ⑨（R122 在线按音乐人分组播放）的分工就写在这里，因为它决定以后加入口的人往哪儿挂：
 * - **⑨ 管数据**：把本机歌单里已匹配的在线条目按歌手聚成组（架上那一列 + `/api/online/artists/<slug>`）；
 * - **九 管一组的浏览面**：把⑨那份条目画成原版那面六边形网格（头像 + 说明 + 热门曲目 + 专辑）。
 * 两者共用同一份原料与同一条播放通路（R114：整份入队、回执读内核队列实际长度）。
 */
/** 进入网格：算好描述符 → 把屏幕交给岛 → 喂料并换布局（岛还没挂上就先记账）。 */
function showArtistGrid(model: ArtistGridModel, origin: string) {
  artistGridModel = model;
  artistGridPending = model.feed;
  artistGridViewActive = true;
  // 真机抓到的观感缺陷：从音乐人面板里点「网格视图」，网格在**面板底下**渲染出来了，
  // 用户看到的还是那张面板（rect 一切正常、DOM 也变了，只有看图判得出）。
  // 网格是整屏视图 ⇒ 打开它先把面板收起来；明细留在模块级变量里，回来还看得见。
  closePanel();
  setDisplayMode("folia");
  syncFoliaIsland(true);
  flushArtistGridFeed();
  const noAlbum = model.albumsWithoutName > 0 ? `；${model.albumsWithoutName} 条没写专辑，归进「（未标专辑）」` : "";
  notify(`音乐人网格：${model.feed.name} · ${model.feed.trackCount} 首 · ${model.feed.albumCount} 张专辑（${origin}）${noAlbum}`);
}

/** 岛挂载完成（或已经挂着）才有地方喂；没挂上就留着，下一帧再冲。 */
function flushArtistGridFeed() {
  if (!artistGridPending || !islandHandle) return;
  const feed = artistGridPending;
  artistGridPending = null;
  islandHandle.feedArtist(feed);
  islandHandle.setLayout("artistGrid");
}

/** 退出网格：屏幕该不该继续给岛，交回 `lyricViewWanted` 原来那套判据重算。 */
function closeArtistGrid() {
  if (!artistGridViewActive) return;
  artistGridViewActive = false;
  artistGridModel = null;
  artistGridPending = null;
  islandHandle?.feedArtist(null);
  applyLyricView();
  syncChromeReveal();
}

function openArtistGridFromOnline(): boolean {
  if (!artistDetail) {
    notify("这一组的明细还没取回来（或已经换了一位），先在架子上点开一位音乐人。");
    return false;
  }
  const tracks = artistDetail.items.map(toMusicTrack);
  const model = buildArtistGridModel({
    id: `online:${artistDetail.id}`,
    name: artistDetail.name,
    // 说明卡那句话的全部依据就是⑨那份明细自己说的来历——本产品没有平台侧的音乐人简介，
    // 也不去够（够它要新增出网主机），所以这里只写本机推得出的事实。
    description: artistDetail.playlists.length
      ? `来自本机 ${artistDetail.playlists.length} 张歌单里已匹配的在线条目（${artistDetail.playlists.slice(0, 3).join("、")}${artistDetail.playlists.length > 3 ? " 等" : ""}）· 共 ${tracks.length} 首`
      : `来自本机歌单里已匹配的在线条目 · 共 ${tracks.length} 首`,
    tracks,
    viewOf: (track) => ({
      albumName: String(track.album ?? ""),
      // 在线曲目的封面只可能是服务端签好的同源地址（/api/online/artwork/<token>）。
      albumCover: track.coverUrl,
    }),
    toSong: toFoliaSong,
  });
  if (!model) {
    artistStatus("这位音乐人组里一条可播的曲目都没有，网格没有可画的东西。");
    return false;
  }
  showArtistGrid(model, "在线组");
  return true;
}

function openArtistGridFromLocal(): boolean {
  const album = currentAlbum();
  if (!album) {
    notify("先在架子上选中一张专辑，再按它的歌手署名开网格。");
    return false;
  }
  // 分组键与架子 `artist` 档**同一个出处**（music-order 的 musicArtistKey），
  // 这里再写一份规范化就是第二个真相，迟早和架子对不上账。
  const key = musicArtistKey(album);
  const own = albums.filter((entry) => musicArtistKey(entry) === key);
  const albumById = new Map(own.map((entry) => [entry.id, entry]));
  const tracks = own.flatMap((entry) => entry.tracks);
  const model = buildArtistGridModel({
    id: `local:${key}`,
    name: album.artist.trim().replace(/\s+/g, " ") || "未知歌手",
    description: `本机曲库里署名「${album.artist}」的专辑：${own.length} 张 · ${tracks.length} 首（本地扫描，不联网）`,
    tracks,
    viewOf: (track) => {
      const owner = albumById.get(track.albumId);
      return { albumName: owner?.title ?? "", albumCover: owner?.coverUrl, albumYear: owner?.year };
    },
    toSong: toFoliaSong,
  });
  if (!model) {
    notify("这位歌手在本机曲库里一首可播的曲目都没有（可能整张专辑都不在曲库里了）。");
    return false;
  }
  showArtistGrid(model, "本地曲库");
  return true;
}

function openArtistGrid() {
  if (panel === "artist" && artistDetail) {
    openArtistGridFromOnline();
    return;
  }
  openArtistGridFromLocal();
}

/** 网格里点一张曲目卡：按 id 回查宿主那份数据，整组入队（R114 —— 岛递回来的快照不当权威）。 */
function playArtistGridTrack(songId: string) {
  const model = artistGridModel;
  if (!model) {
    notify("网格的数据已经不在了（换过一位音乐人或已退出）。");
    return;
  }
  const index = model.tracks.findIndex((track) => track.id === songId);
  if (index < 0) {
    notify("这一格已经不在当前这份网格里了。");
    return;
  }
  void playArtistGridTracks(model.tracks, `「${model.feed.name}」的第 ${index + 1} 首起`, index);
}

/** 网格里点一张专辑卡：播的是这张专辑在那一组里的曲目（同一份原料，不另取数）。 */
function playArtistGridAlbum(albumId: string) {
  const model = artistGridModel;
  const tracks = model?.albumTracks.get(albumId);
  if (!model || !tracks?.length) {
    notify("这张专辑卡对应的曲目已经不在当前那份网格里了。");
    return;
  }
  void playArtistGridTracks(tracks, `「${tracks[0].album ? albumTitleOf(tracks[0]) : model.feed.name}」`, 0);
}

async function playArtistGridTracks(tracks: MusicTrack[], label: string, startIndex: number) {
  const start = tracks[Math.min(Math.max(startIndex, 0), tracks.length - 1)];
  await player.play(start.id, tracks).catch(() => undefined);
  const queued = player.state.queue.length;
  const deduped = tracks.length - queued;
  notify(`正在播放 ${label}：队列里 ${queued} 条${deduped > 0 ? `（${deduped} 条重复，按 id 去重后不再排第二次）` : ""}`);
}

/** 「全部加入队列」：追加而不打断正在播的那一首（内核按 id 去重，回执读队列实际涨了多少）。 */
function addArtistGridToQueue(songIds: string[]) {
  const model = artistGridModel;
  if (!model) {
    notify("网格的数据已经不在了，这一次没有排进任何东西。");
    return;
  }
  const picked = songIds
    .map((id) => model.tracks.find((track) => track.id === id))
    .filter((track): track is MusicTrack => Boolean(track));
  if (!picked.length) {
    notify("网格递回来的这些曲目不在当前那份数据里（可能已经换了一位音乐人）。");
    return;
  }
  const before = player.state.queue.length;
  player.setQueue([...player.state.queue, ...picked]);
  const added = player.state.queue.length - before;
  notify(added > 0
    ? `已排入 ${added} 条${before ? `（队列从 ${before} 条涨到 ${player.state.queue.length} 条）` : "（队列为空，这是第一次排入）"}`
    : picked.length === 1
      ? "这一条已经在队列里了，没有重复排第二次"
      : `${picked.length} 条全都已经在队列里了，没有重复排第二次`);
}

/** 专辑卡的标题（点专辑那一条回执要说"播的是哪张"）。 */
function albumTitleOf(track: MusicTrack): string {
  return currentAlbumOf(track)?.title ?? track.album ?? "这张专辑";
}

function currentAlbumOf(track: MusicTrack): MusicAlbum | undefined {
  return albums.find((entry) => entry.id === track.albumId);
}

/**
 * R165（任务十一）：此刻能往账号歌单里加的那一首——**只有在线曲目**能加（本地文件在平台那边没有身份，
 * 加进去等于让平台按曲名去猜一首不是同一版的东西，与任务八"本地曲目一条都不报"同一个理由）。
 */
function accountPlaylistAddable(): AccountPlaylistAddable | null {
  const track = player.state.currentTrack;
  if (!track || track.sourceKind !== "online") return null;
  const provider = String(track.provider ?? "");
  if (provider !== "netease" && provider !== "kugou") return null;
  return { provider, trackId: track.id, label: `${track.title} - ${track.artist}` };
}

/**
 * 加歌到账号歌单：先二次确认（写操作），再交服务端。
 * 回执要说清"加进了哪一张、平台收了几条"，失败要把服务端/平台那句原话贴出来，不许糊成"写入失败"。
 */
async function addCurrentTrackToAccountPlaylist(button: HTMLElement) {
  const status = document.querySelector<HTMLElement>("#account-playlist-status");
  const provider = button.dataset.provider ?? "";
  const playlistId = button.dataset.accountId ?? "";
  const playlistName = button.dataset.accountName ?? "";
  const trackId = button.dataset.trackId ?? "";
  const trackName = button.dataset.trackName ?? "";
  const say = (line: string) => { if (status) status.textContent = line; else notify(line); };
  if (!provider || !playlistId || !trackId) {
    say("这一行没带上平台、歌单或曲目标识，一次都不发。");
    return;
  }
  const ok = window.confirm(
    `这是写操作：要把「${trackName}」加进你在${ONLINE_PROVIDER_LABELS[provider as keyof typeof ONLINE_PROVIDER_LABELS] ?? provider}账号里的歌单《${playlistName}》。\n\n` +
      "本工具只加不删——加错了要回平台上删，我们不提供删除入口。确认就继续。",
  );
  if (!ok) { say("没确认，这一笔没有发出去。"); return; }
  say("正在写入你的账号歌单…");
  try {
    const reply = await request<{ ok?: boolean; sent?: number; skipped?: number }>(
      "/api/online/playlist/add", {
        provider, playlistId, confirm: "add-to-account-playlist",
        tracks: [{ id: trackId, name: trackName }],
      });
    const sent = Number(reply.sent ?? 0);
    const skipped = Number(reply.skipped ?? 0);
    say(sent > 0
      ? `已加进《${playlistName}》${sent} 条${skipped > 0 ? `（另有 ${skipped} 条形状不合，没有发出去）` : ""}`
      : `平台收了这一笔，但一条也没加进去（《${playlistName}》）`);
  } catch (error) {
    say(`没写进去：${(error as Error).message}`);
  }
}

async function matchWholePlaylist() {
  if (!playlistOpenId) return;
  playlistStatus("正在联网逐条匹配…");
  let summary: { total: number; matched: number; searches: number; failed: { entry: { title: string }; reason: string }[] };
  try {
    summary = await request<{ total: number; matched: number; searches: number; failed: { entry: { title: string }; reason: string }[] }>(
      `/api/playlists/${encodeURIComponent(playlistOpenId)}/match`, {});
  } catch (error) {
    // 「匹配失败」这四个字只配给"匹配这件事本身失败"。曾经重渲染也在这个 try 里，
    // 面板被用户关掉时写 #panel-body 抛的 TypeError 就从这里冒出来，报成一句假失败——
    // 而服务端那 279 条其实已经配上了。UI 竞态不是业务失败，两件事不许共用一句回执。
    playlistStatus(`匹配失败：${(error as Error).message}`);
    return;
  }
  // 先重渲染再写状态行：renderPlaylistDetail() 会重建 #playlist-status，
  // 顺序反了这句回执会被自己清空（真机截图 44 上那一行就是空的）。
  await renderPlaylistDetail();
  playlistStatus(`匹配完成：${summary.matched}/${summary.total} 条配上，本次联网查询 ${summary.searches} 次` +
    (summary.failed.length ? `；没配上的如「${summary.failed[0].entry.title}」（${summary.failed[0].reason}）` : ""));
}

async function matchOnePlaylistEntry(index: number) {
  if (!playlistDetail) return;
  const entry = playlistDetail.items[index]?.entry;
  if (!entry) return;
  playlistStatus(`正在重新匹配「${entry.title}」…`);
  try {
    const response = await requestOnlineSearch(`${entry.title} ${entry.artist}`.trim(), { offset: 0, limit: 20 });
    playlistStatus(response.ok
      ? `「${entry.title}」在线找到 ${response.items.length} 条候选（整单匹配会按打分取最佳一条）`
      : `「${entry.title}」没有检索到结果：${response.error || perSourceSummary(response.perSource)}`);
  } catch (error) {
    playlistStatus(`重搜失败：${(error as Error).message}`);
  }
}

/** 导出：下载那份用户能自己编辑的文本（可携带性），不是内部 JSON。 */
async function exportPlaylist() {
  if (!playlistOpenId) return;
  try {
    const data = await request<{ playlist: { name: string; text: string } }>(`/api/playlists/${encodeURIComponent(playlistOpenId)}`);
    const blob = new Blob([data.playlist.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(data.playlist.name === playlistOpenId ? playlistOpenId : playlistOpenId);
    link.click();
    URL.revokeObjectURL(url);
    playlistStatus("已导出为文本歌单（粘回浏览器或存进 playlists/ 目录都能再读）。");
  } catch (error) {
    playlistStatus(`导出失败：${(error as Error).message}`);
  }
}

/**
 * R160（任务七）· 音频输出设备。三件事都按 2026-10-10 在 headless Edge 上的一手量测写：
 *   ① `HTMLMediaElement.prototype.setSinkId` / `.sinkId` **存在**（Chromium 系），Firefox / Safari 没有
 *      ⇒ 那一档要显示"这台浏览器不支持"，不是留一个永远不生效的下拉框；
 *   ② `navigator.mediaDevices.enumerateDevices()` 在**未授权**时给的 `deviceId / label / groupId
 *      全是空串`（实测：3 个设备、audiooutput 1 个、三个字段都空）
 *      ⇒ 未授权时"具体设备"根本选不了，界面上必须这么写，不能假装列得出名字；
 *   ③ `setSinkId("")` 是**成功**的（回到系统默认），不是"没选设备所以报错"。
 * 授权那一颗按钮是**显式点击**才要麦克风权限的：只为给音箱起个名字就静默弹权限，
 * 是本项目一贯不做的那类事（与"不为方便就多出网"同一条立场）。拿到权限后立刻把轨停掉，
 * 只为了读一次设备名单——**不采集、不落盘、不上传**。
 */
let outputSinks: MediaDeviceInfo[] = [];
let outputSinksLabelled = false;

function outputSinksSupported(): boolean {
  return typeof HTMLMediaElement.prototype.setSinkId === "function" && !!navigator.mediaDevices?.enumerateDevices;
}

async function refreshOutputSinks(): Promise<{ count: number; labelled: boolean; reason: string }> {
  if (!outputSinksSupported()) return { count: 0, labelled: false, reason: "这台浏览器不支持选择音频输出设备" };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    outputSinks = devices.filter((device) => device.kind === "audiooutput");
    // "有没有名字"不靠 label 猜第二次：只要有一条 label 非空，就说明这一轮是授权后的结果
    outputSinksLabelled = outputSinks.some((device) => String(device.label ?? "").length > 0);
    return { count: outputSinks.length, labelled: outputSinksLabelled, reason: "" };
  } catch (error) {
    return { count: 0, labelled: false, reason: String((error as Error)?.message ?? error ?? "").slice(0, 120) };
  }
}

/** 只为拿设备名与 id 而存在的那一次授权：立刻停轨，不采集也不落盘。 */
async function grantOutputSinksPermission(): Promise<{ ok: boolean; reason: string }> {
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, reason: "这台浏览器没有 getUserMedia，拿不到设备名" };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    return { ok: false, reason: `没拿到授权（${(error as Error)?.name ?? "未知原因"}）：设备列表仍然只有"跟随系统默认"可选` };
  }
  for (const track of stream.getTracks()) track.stop();
  const listed = await refreshOutputSinks();
  return { ok: listed.count > 0, reason: listed.reason };
}

function outputDeviceMarkup(): string {
  if (!outputSinksSupported()) {
    return `<div id="output-device-row"><label class="settings-row"><span>音频输出设备<small>这台浏览器不提供切换输出设备的能力（setSinkId），声音跟随系统默认</small></span><select id="output-device-setting" disabled aria-label="音频输出设备"><option value="">跟随系统默认</option></select></label></div>`;
  }
  const options = [`<option value="">跟随系统默认</option>`]
    .concat(outputSinks.map((device, index) => device.deviceId
      ? `<option value="${esc(device.deviceId)}" ${preferences.outputDevice === device.deviceId ? "selected" : ""}>${esc(device.label || `输出设备 ${index + 1}`)}</option>`
      : ""));
  const hint = !outputSinks.length
    ? "浏览器没给出可切换的输出设备（headless、隐私模式、或这台机器只有一路输出时都会这样）⇒ 只能跟随系统默认。"
    : !outputSinksLabelled
      ? "浏览器在没有授权时不给设备名与 id（实测三个字段都是空串）⇒ 现在只有\u201c跟随系统默认\u201d可选。"
        + "要点「授权并列出设备」才会拿到名字；那次授权只为读一次名单，音频轨立刻停掉，不采集、不落盘、不上传。"
      : `列出 ${outputSinks.length} 个输出设备。换设备只影响这台浏览器的声音去向，不动音乐文件，也不联网。`;
  return `<div id="output-device-row"><label class="settings-row"><span>音频输出设备<small>${esc(hint)}</small></span>` +
    `<select id="output-device-setting" aria-label="音频输出设备">${options.join("")}</select></label>` +
    `<button class="text-button" data-action="output-devices-refresh">刷新设备列表 ↗</button>` +
    (outputSinks.length && !outputSinksLabelled
      ? `<button class="text-button" data-action="output-devices-grant">授权并列出设备 ↗</button>` : "") +
    `<p id="output-device-status" class="scan-status" role="status" aria-live="polite"></p></div>`;
}

/** 换设备/授权之后重画那一行（不整块重开设置面板——那会把用户的滚动位置与别的行一起弄丢）。 */
function repaintOutputDeviceRow(): void {
  const row = document.querySelector<HTMLElement>("#output-device-row");
  if (row) row.outerHTML = outputDeviceMarkup();
}

async function applyOutputDevice(deviceId: string): Promise<void> {
  const reply = await player.setOutputDevice(deviceId);
  const status = document.querySelector<HTMLElement>("#output-device-status");
  if (!reply.supported) {
    preferences.outputDevice = "";
    savePrefs();
    if (status) status.textContent = reply.reason;
    return;
  }
  if (!reply.ok) {
    // **不许"因为选了设备反而没声音"**：播放器已经把那一首退回默认输出了，这里把选择也一起撤回，
    // 否则下次开机还会撞上同一个错。
    preferences.outputDevice = "";
    savePrefs();
    const select = document.querySelector<HTMLSelectElement>("#output-device-setting");
    if (select) select.value = "";
    if (status) status.textContent = `切到那台设备失败（${reply.reason || "浏览器拒绝"}），已回到系统默认继续播放。`;
    return;
  }
  preferences.outputDevice = deviceId;
  savePrefs();
  if (status) status.textContent = deviceId
    ? "已切换输出设备。若列表里没有你要的那一台，点「刷新设备列表」（插上新耳机之后也要点一次）。"
    : "已回到跟随系统默认。";
}

/**
 * R202：背景模糊层那一节的控件（来源三档 + 模糊程度 + 不透明度）。只在这一个出处拼，避免样式写法漂移。
 * 值一律 read 自 `resolveBackdrop`（用户改过的格 → 主题缺省），不在这里重抄缺省数字。
 */
function backdropMarkup(): string {
  const p = currentBackdropParams();
  const sources: { id: BackdropSource; name: string; hint: string }[] = [
    { id: "off", name: "关", hint: "不垫任何模糊层" },
    { id: "underlay", name: "下层画面", hint: "把背后的档案场景模糊掉" },
    { id: "cover", name: "当前曲封面", hint: "放大当前曲封面再高斯模糊" },
  ];
  const cards = sources.map((s) => `<button data-action="backdrop-source-${s.id}" aria-pressed="${p.source === s.id}"><i></i><strong>${s.name}</strong><span>${s.hint}</span></button>`).join("");
  // 不透明度只在封面档有意义（下层画面档没有"不透明度"可言）。
  const opacityRow = p.source === "cover"
    ? `<label class="settings-row"><span>不透明度</span><input type="range" data-backdrop="opacity" aria-label="背景模糊层不透明度" min="0" max="100" step="1" value="${Math.round(p.opacity * 100)}"></label>`
    : "";
  return `<div class="theme-cards" id="backdrop-source-cards">${cards}</div>
    <label class="settings-row"><span>模糊程度</span><input type="range" data-backdrop="blur" aria-label="背景模糊程度" min="0" max="80" step="1" value="${p.blur}"></label>
    ${opacityRow}
    <p>只在歌词面与封面墙生效（垫在画面之下的一层）。「下层画面」不额外取图；「当前曲封面」用的是本机缓存里的同源封面。岛视图里右侧那块专辑信息会跟着一起模糊（关掉这一层就回到原样）。改动立刻生效并记在本机偏好里，重启之后仍在。</p>`;
}
/** 改完参数立刻按新读数刷一次模糊层（不等下一帧的喂料；且离开岛视图时它是空的，update 会自己 no-op）。 */
function refreshBackdropNow(): void {
  if (!foliaBackdrop) foliaBackdrop = createFoliaBackdrop();
  foliaBackdrop.update(currentBackdropParams(), currentBackdropCover());
}
function renderSettingsPanel() {
  $("#panel-body").innerHTML =
    `<section class="panel-section"><h3>外观主题</h3><div class="theme-cards">${THEMES.map((t) => `<button data-theme="${t}" aria-pressed="${preferences.theme === t}" class="${t}"><i></i><strong>${themeNames[t]}</strong><span>${themeHints[t]}</span></button>`).join("")}</div></section>
    <section class="panel-section"><h3>Folia 视觉模式</h3><div class="theme-cards">${FOLIA_MODES.map((m) => `<button data-action="folia-mode-${m.id}" aria-pressed="${preferences.foliaMode === m.id}"><i></i><strong>${m.name}</strong><span>${m.hint}</span></button>`).join("")}</div><p>只在歌词面生效；封面墙有自己的歌词画布，不受这里影响。</p></section>
    <section class="panel-section" id="folia-mode-settings-section"><h3>当前模式的参数</h3><div id="folia-mode-settings"></div><p>这一节跟着上面选的那一档走：没有参数的档会直接说明。改动立刻生效并记在本机偏好里，重启之后仍在。</p></section>
    <section class="panel-section" id="backdrop-settings-section"><h3>背景模糊</h3>${backdropMarkup()}</section>
    <section class="panel-section"><h3>音乐库排列</h3><label class="settings-row"><span>排列方式<small>切换后自动刷新页面</small></span><select id="music-sort" aria-label="音乐库排列方式">${(["genre", "artist", "album"] as MusicSortMode[]).map((value) => `<option value="${value}" ${preferences.sortMode === value ? "selected" : ""}>${sortLabels[value].name}</option>`).join("")}</select></label><label class="settings-row"><span>专辑架分组<small>切换后自动刷新页面</small></span><select id="music-shelf-layout" aria-label="专辑架分组">${(["genre", "artist", "album"] as MusicShelfLayout[]).map((value) => `<option value="${value}" ${shelfLayoutPreference === value ? "selected" : ""}>${shelfLabels[value].name}</option>`).join("")}</select></label><p>${esc(shelfLabels[shelfLayoutPreference].hint)}排列方式只决定专辑的先后顺序，分组方式决定架子上铺哪几列，两者可以任意组合。</p></section>
    <section class="panel-section" id="introduction-settings"><h3>专辑介绍</h3><p>从公开百科查询并更新专辑介绍，附上资料来源。介绍保存在本机，不需要配置 MusicBrainz 联系信息；音乐文件不会上传。</p><p id="introduction-coverage"></p><button class="primary-button" id="introduction-refresh" data-action="introductions-library">查询 / 更新专辑介绍 ↗</button><progress id="introduction-progress" aria-label="专辑介绍查询进度" max="1" value="0" hidden></progress><p id="introduction-status" class="scan-status" role="status" aria-live="polite"></p><details id="introduction-missing" hidden><summary></summary><ul></ul></details></section>
    ${qualityMarkup(renderQuality)}
    <section class="panel-section"><h3>动效与显示</h3><label class="settings-row"><span>减少动态效果<small>简化镜头、文字加载和页签过渡</small></span><input type="checkbox" id="reduced-motion" ${preferences.reduced ? "checked" : ""}></label><label class="settings-row"><span>无歌词动画<small>歌词视图里，纯音乐曲目用跳动的音符或频谱条代替文字提示</small></span><select id="lyric-pulse-setting" aria-label="无歌词动画档位">${LYRIC_PULSE_TIERS.map((value) => `<option value="${value}" ${preferences.lyricPulse === value ? "selected" : ""}>${lyricPulseLabels[value]}</option>`).join("")}</select></label><p>${lyricPulseHints[preferences.lyricPulse]}</p><button class="text-button" data-action="fullscreen">切换全屏 ↗</button></section>
    <section class="panel-section"><h3>声音</h3><label class="settings-row"><span>歌曲音量</span><input type="range" id="volume" aria-label="歌曲音量" min="0" max="100" value="${Math.round(preferences.volume * 100)}"></label><label class="settings-row"><span>切歌淡入淡出<small>当前歌曲先淡出，再淡入下一首</small></span><input type="checkbox" id="song-fade-setting" ${preferences.songFade ? "checked" : ""}></label><label class="settings-row"><span>界面音效<small>玻璃卡片与终端操作</small></span><input type="checkbox" id="sound-setting" ${preferences.sound ? "checked" : ""}></label><label class="settings-row"><span>音效音量</span><input type="range" id="sound-volume" aria-label="音效音量" min="0" max="100" value="${Math.round(preferences.soundVolume * 100)}"></label><label class="settings-row"><span>氛围 BGM<small>专辑开始前淡出，停止后淡入</small></span><input type="checkbox" id="bgm-setting" ${preferences.bgm ? "checked" : ""}></label><label class="settings-row"><span>BGM 音量</span><input type="range" id="bgm-volume" aria-label="BGM 音量" min="0" max="100" value="${Math.round(preferences.bgmVolume * 100)}"></label>${outputDeviceMarkup()}<button class="text-button" data-action="sound-preview">试听界面音效 ↗</button><p>当前版本支持 macOS，使用浏览器播放本地音乐。DSF / DFF 暂不支持播放，其他格式取决于浏览器解码能力。</p></section>
    <section class="panel-section" id="data-dir-section"><h3>数据目录</h3><p>收藏、歌单、登录凭据与索引/封面缓存都放在这里；程序目录里不放你的数据。要彻底清除：直接删掉这个目录就行；绿色版另有托盘菜单的「清空全部数据」入口。</p><label class="settings-row"><span>现在的位置<small id="data-dir-source"></small></span><input type="text" id="data-dir-path" readonly aria-label="数据目录路径"></label><div class="panel-actions"><button data-action="copy-data-dir" class="text-button">复制路径 ↗</button></div></section>
    <section class="panel-section"><h3>开发与资源</h3><p>音乐适配与维护：<a href="https://github.com/RonaldDeng/Rhine-Music-Demo" target="_blank" rel="noopener">RonaldDeng ↗</a><br>原版界面：<a href="https://github.com/LBEILC/RhineLabUI" target="_blank" rel="noopener">LBEILC / RhineLabUI ↗</a></p><p><a href="/licenses/project-mit.txt" target="_blank" rel="noopener">代码 MIT 许可 ↗</a> · <a href="https://github.com/RonaldDeng/Rhine-Music-Demo/blob/v0.2.0/NOTICE.md" target="_blank" rel="noopener">版权与资源说明 ↗</a></p><p>第三方依赖许可：<a href="/licenses/amll-ttml.txt" target="_blank" rel="noopener">@applemusic-like-lyrics/ttml（AGPL-3.0-only）↗</a> · <a href="/licenses/xmldom.txt" target="_blank" rel="noopener">@xmldom/xmldom（MIT）↗</a> · <a href="/licenses/three.txt" target="_blank" rel="noopener">three.js ↗</a> · <a href="/licenses/music-metadata.txt" target="_blank" rel="noopener">music-metadata ↗</a></p><a href="/?original=1&scene=archive" target="_blank" rel="noopener">打开原版档案界面 ↗</a><p><a href="/fonts/MiSans-license.pdf" target="_blank" rel="noopener">MiSans 字体许可 ↗</a></p></section>`;
  updateQuality();
  updateIntroductionStatus();
  mountFoliaModeSettings();
  void syncDataDirRow();
}

/**
 * R209 · 设置面板里的「数据目录」那一行（只读；口径第 8 条）。
 * **路径由服务端只读接口给**（页面自己不知道进程外的数据目录 —— 那是服务侧的事），
 * 取不到就如实写"读不到"，**不猜路径**。`source` 一档把"这个位置是谁定的"也说清楚。
 */
async function syncDataDirRow(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#data-dir-path");
  const hint = document.querySelector<HTMLElement>("#data-dir-source");
  if (!input) return;
  const naming: Record<string, string> = {
    env: "来自环境变量 MUSIC_DATA_DIR",
    "packaged-default": "绿色版的默认位置",
    "dev-default": "开发形态的默认位置",
    "server-default": "本机默认位置",
  };
  try {
    const info = await request<{ path?: string; source?: string }>("/api/data-dir");
    input.value = info?.path ?? "";
    if (hint) hint.textContent = naming[info?.source ?? ""] ?? "";
  } catch {
    input.value = "";
    if (hint) hint.textContent = "读不到（本地服务没起来？）";
  }
}

/** R209 · 复制那一行（剪贴板拿不到就替用户选中，让人自己按 Ctrl+C —— 不许静默失败）。 */
async function copyDataDirPath(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>("#data-dir-path");
  const value = input?.value ?? "";
  if (!value) {
    notify("数据目录还没读出来，稍等一下再复制。");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    notify("数据目录路径已复制。");
  } catch {
    input?.select();
    notify("复制没成功，已经替你选中，按 Ctrl+C 即可。");
  }
}
function updateQuality() {
  renderQuality = normalizeQuality(renderQuality);
  preferences.renderQuality = renderQuality;
  scene?.setQuality(renderQuality);
  viewer?.setQuality(renderQuality);
  syncQualityUI(renderQuality);
  const summary = document.querySelector("#quality-summary");
  if (summary)
    summary.textContent = `渲染 ${renderQuality.scale}% · 像素上限 ${renderQuality.pixelRatio}× · ${renderQuality.antialias === "off" ? "原始抗锯齿" : "SMAA"}`;
  savePrefs();
}
async function editGenres() {
  const body = document.querySelector("#panel-body");
  try {
    const rules = await request<GenreRules>("/api/genre-rules");
    if (!body?.isConnected || panel !== "library") return;
    body.innerHTML = `<p class="panel-intro">这里编辑展示流派、别名和专辑人工分类。保存后重新归并本地索引，不修改音频标签。</p><label class="field-label" for="genre-json">本地流派规则</label><textarea id="genre-json" class="json-editor" spellcheck="false">${esc(JSON.stringify(rules, null, 2))}</textarea><div class="panel-actions"><button data-action="save-genres" class="primary-button">保存并应用</button><button data-action="library">返回音乐库</button></div><p id="genre-error" role="alert"></p>`;
  } catch (error) {
    notify((error as Error).message);
  }
}
async function scan(saveRoots = false) {
  if (scanSubmitting || library.scan.running) return;
  scanSubmitting = true;
  clearTimeout(scanRefreshTimer);
  scanRefreshTimer = undefined;
  ++libraryStateVersion;
  try {
    const roots = saveRoots
      ? $<HTMLTextAreaElement>("#music-roots")
          .value.split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const next = await request<MusicLibrary>("/api/library/scan", roots ? { roots } : {});
    ++libraryStateVersion; // Discard polls started before this accepted scan.
    notify("开始扫描音乐库，已有专辑可以继续浏览。");
    await receiveLibrary(next);
    schedulePoll({ delayMs: 600 });
  } catch (error) {
    notify((error as Error).message);
  } finally {
    scanSubmitting = false;
  }
}
async function enrich(one = false) {
  if (demo) return;
  try {
    await request(
      "/api/library/enrich",
      one ? { albumIds: [currentAlbum()!.id] } : {},
    );
    notify("已开始补充流派和制作资料，结果将缓存在本机。");
    await loadLibrary();
  } catch (error) {
    notify((error as Error).message);
  }
}
async function queryIntroductions(one = false) {
  const album = currentAlbum();
  if (demo || !library.albums.length || (one && !album)) return;
  if (introductionsStarting || library.introductions?.running) {
    notify("专辑介绍正在查询，进度可在设置中查看。");
    return;
  }
  introductionsStarting = true;
  introductionRequestError = "";
  updateIntroductionStatus();
  try {
    const next = await request<MusicLibrary>("/api/library/introductions", {
      ...(one ? { albumIds: [album!.id] } : {}),
      force: true,
    });
    // A GET started before this accepted job must not restore an older snapshot.
    libraryStateVersion++;
    apiAvailable = true;
    await receiveLibrary(next);
    const job = next.introductions;
    notify(
      job?.running
        ? `${one ? "这张专辑" : "音乐库"}的介绍查询已开始，可在设置中查看进度。`
        : job?.error ||
            (job && job.total > 0
              ? `专辑介绍查询完成：更新 ${job.updated} 张，未找到可靠资料 ${job.notFound} 张，查询失败 ${job.failed} 张。`
              : "当前没有需要查询的专辑。"),
    );
    schedulePoll({ delayMs: 800 });
  } catch (error) {
    introductionRequestError = (error as Error).message;
    notify(introductionRequestError);
  } finally {
    introductionsStarting = false;
    updateIntroductionStatus();
  }
}
function playAlbum(id?: string) {
  const a = currentAlbum();
  // ⑧ 伪专辑（歌单）不在这里直接播：它的曲目要经匹配、要跳过未匹配并计数，那条路只有详情面板有。
  // 选中的是一张歌单时按下播放，给一句实话比静默什么都不做要好（静默会让人以为播放器坏了）。
  if (a?.kind === "playlist") {
    notify(`「${a.title}」是一张文本歌单：在架子上点开它，在里面用「整单播放」。`);
    return;
  }
  if (a?.kind === "artist") {
    notify(`「${a.title}」是在线音乐人组：在架子上点开它，在里面用「播放全部」。`);
    return;
  }
  if (!a?.tracks.length || a.offline) return;
  void player.play(id || a.tracks[0].id, a.tracks);
}

document.addEventListener("click", (e) => {
  if (boot?.active) return;
  const target = (e.target as HTMLElement).closest<HTMLElement>(
    "button, [data-action]",
  );
  if (!target) return;
  /**
   * **显式动作优先于定位用的 data-***。这些"定位分支"（theme / track / select / onlineTrack / playlist）
   * 认的是属性本身，而一颗按钮可以同时带着"点谁"和"做什么"——在线结果那排选择器里那颗就是
   * `data-playlist="X" data-action="playlist-add-to"`。从前定位分支排在前面，于是
   * "把这首歌加进 X"被当成"打开 X 这张歌单"：一条请求都不发、一句提示也没有（真机复现见
   * memory/overnight-six-run-log.md §五，截图 80）。全仓只有一颗按钮同时带这两类属性，
   * 但这条判据要写成通则——下一颗这样写的按钮不该再撞一次。
   */
  const explicitAction = Boolean(target.dataset.action);
  if (target.dataset.action === "dismiss-panel" && e.target !== target) return;
  if (!explicitAction && target.dataset.theme) {
    setTheme(target.dataset.theme as Theme);
    return;
  }
  if (!explicitAction && target.dataset.track) {
    playAlbum(target.dataset.track);
    return;
  }
  if (!explicitAction && target.dataset.select) {
    const rulerStep = Number(target.dataset.rulerStep);
    select(Number(target.dataset.select),
      target.dataset.rulerStep !== undefined && Number.isInteger(rulerStep)
        ? { axis: "row", direction: rulerStep } : undefined);
    return;
  }
  if (!explicitAction && target.dataset.onlineTrack) {
    // 在线结果：点击即试听。与本地结果的"定位"语义分开走（两个 data-* 不复用，见 online-search.ts 头注）。
    const item = onlineResults.find((entry) => entry.id === target.dataset.onlineTrack);
    if (!item) {
      notify("这条在线结果已经不在最近一次检索结果里了，请重新检索。");
      return;
    }
    // 委托监听器是同步的（这一支里其它分支也一样），所以不 await：失败由内核的 state.error 走界面。
    playOnlineTrack(player, toMusicTrack(item)).catch(() => undefined);
    return;
  }
  if (target.dataset.searchTab) {
    applySearchTab(target.dataset.searchTab === "online" ? "online" : "local");
    return;
  }
  if (!explicitAction && target.dataset.playlist) {
    playlistOpenId = target.dataset.playlist;
    openPanel("playlist");
    return;
  }
  if (target.dataset.action === "playlists") {
    openPanel("playlists");
    return;
  }
  if (target.dataset.action === "favorites") {
    openPanel("favorites");
    return;
  }
  if (target.dataset.action === "playlist-import") {
    const box = document.querySelector<HTMLElement>("#playlist-import-box");
    if (!box) return;
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    // 三家都认（R137）：平台由**域名**判，不靠用户先选一家。R138 起 QQ 那条真的能导了
    // （字段名量完：`playlist-qq.mjs`），手机分享那台主机 i2.y.qq.com 也在识别集里。
    // R158 起酷狗手机分享那条（`m.kugou.com/songlist/gcid_…/`）也能导了，但**只给首屏**：
    // 这一句必须写在入口里，不能等用户导完才发现少了八百首（整单要 collection_ 那个 id）。
    box.innerHTML = `<label class="field-label" for="playlist-import-text">粘贴网易 / QQ / 酷狗的歌单链接、歌单 id，或一段"歌名 - 歌手"文本</label>` +
      `<textarea id="playlist-import-text" class="json-editor" rows="5" spellcheck="false" placeholder="https://music.163.com/playlist?id=…&#10;https://y.qq.com/n/ryqq/playlist/…&#10;https://i2.y.qq.com/…playlist.html?id=…&#10;collection_1_1341266283_964007_0&#10;https://m.kugou.com/songlist/gcid_xxxxxxxxxxxxxx/&#10;或：恋人 - 李荣浩"></textarea>` +
      `<p class="scan-status">纯数字按网易认（QQ 与酷狗请贴整条链接，或用它自己的 id）。` +
      `酷狗手机分享那条（gcid_ 开头）只能导分享页里的**首屏十首**——那一族链接里没有整单要的那个 id，导入后会写明共多少条。` +
      `一次导入最多取 1000 条曲目，这是本工具继承的上限、不是接口给的；` +
      `歌单文本文件最多写 2000 行——两个数各管各的：前者管"从平台取几条"，后者管"磁盘那个文件多大"。</p>` +
      `<div class="panel-actions"><button class="primary-button" data-action="playlist-import-run">导入 ↗</button></div>` +
      `<p id="playlist-import-status" class="scan-status" role="status" aria-live="polite"></p>`;
    document.querySelector<HTMLTextAreaElement>("#playlist-import-text")?.focus();
    return;
  }
  if (target.dataset.action === "playlist-import-run") {
    const field = document.querySelector<HTMLTextAreaElement>("#playlist-import-text");
    const status = document.querySelector<HTMLElement>("#playlist-import-status");
    const text = (field?.value ?? "").trim();
    if (!text) {
      if (status) status.textContent = "先粘贴一点东西。";
      return;
    }
    if (status) status.textContent = "正在导入…";
    request<PlaylistImportResult>("/api/online/playlist/import", { text })
      .then((result) => {
        playlistOpenId = result.id;
        openPanel("playlist");
        // 少了条数时那句说明要**跟着名字一起说**：只报"已导入 41 条"而不说上游报 47 条，
        // 用户就会以为这张单本来就只有 41 条（真机上第一版那句还写成"落成 41 条"，与"已导入 40 条"自相矛盾）。
        // 名字放在括号里而不是「」里：酷狗与网易的歌单名自己就常带「」（实测「0.8x」慢速歌曲），套两层没法读。
        notify(result.truncated || result.dropped || result.firstScreen
          ? `已导入 ${result.items} 条（${result.name}）：${result.warning ?? "源单更长，已截断"}`
          : `已导入「${result.name}」共 ${result.items} 条`);
      })
      .catch((error: Error) => {
        if (status) status.textContent = `导入失败：${error.message}`;
        else notify(`导入失败：${error.message}`);
      });
    return;
  }
  if (target.dataset.action === "output-devices-refresh") {
    void (async () => {
      const listed = await refreshOutputSinks();
      repaintOutputDeviceRow();
      const status = document.querySelector<HTMLElement>("#output-device-status");
      if (status) {
        status.textContent = listed.reason
          ? `刷新失败：${listed.reason}`
          : `列出 ${listed.count} 个输出设备${listed.labelled ? "" : "（浏览器没给名字与 id，需要授权才能选具体设备）"}。`;
      }
    })();
    return;
  }
  if (target.dataset.action === "output-devices-grant") {
    void (async () => {
      const granted = await grantOutputSinksPermission();
      repaintOutputDeviceRow();
      const status = document.querySelector<HTMLElement>("#output-device-status");
      if (status) {
        status.textContent = granted.ok
          ? "已拿到设备名单（那一次麦克风流在读取名单前就停掉了：不采集、不落盘、不上传）。"
          : granted.reason;
      }
    })();
    return;
  }
  if (target.dataset.action === "account-playlist-list") {
    const provider = target.dataset.provider ?? "";
    const box = document.querySelector<HTMLElement>("#account-playlist-box");
    const status = document.querySelector<HTMLElement>("#account-playlist-status");
    const label = ACCOUNT_PLAYLIST_PROVIDERS.find((entry) => entry.id === provider)?.label ?? provider;
    if (!provider || !box) return;
    if (status) status.textContent = `正在列${label}账号里的歌单…`;
    request<{ ok?: boolean; provider?: string; items?: AccountPlaylistRow[]; skipped?: number[]; reason?: string }>(
      "/api/online/playlist/mine", { provider })
      .then((reply) => {
        const items = reply.items ?? [];
        box.hidden = false;
        box.innerHTML = accountPlaylistMarkup(items, accountPlaylistAddable());
        // "列不出来"与"账号里就没有"是两件事：前者把服务端那句原因原样贴出来（可能是没登录、
        // 可能是形状没量到），后者是那句 no-results。混成一句"没有歌单"就是在撒谎。
        const skipped = reply.skipped?.length ? ` · ${reply.skipped.length} 行形状不认识，没有列进来` : "";
        if (status) {
          status.textContent = `${label}：列出 ${items.length} 张${skipped}。选一张「导入为文本」，`
            + "或把正在播的那一首在线曲目加进去（写操作，会再确认一次）。";
        }
      })
      .catch((error: Error) => {
        box.hidden = false;
        box.innerHTML = "";
        if (status) status.textContent = `${label}：没列出来 —— ${error.message}`;
      });
    return;
  }
  // R165（任务十一）· 把正在播的那一首在线曲目加进"我自己账号里的这张歌单"——本仓第一条写侧在线通路。
  // 四条红线里"二次确认"落在这里（服务端还要另一道 confirm 标记），"只加不删"落在桥那侧没有删除分支。
  if (target.dataset.action === "account-playlist-add") {
    void addCurrentTrackToAccountPlaylist(target);
    return;
  }
  if (target.dataset.action === "account-playlist-import") {
    const id = target.dataset.accountId ?? "";
    const name = target.dataset.accountName ?? "";
    const status = document.querySelector<HTMLElement>("#account-playlist-status");
    if (!id) return;
    if (status) status.textContent = "正在导入这张账号歌单…";
    // **走的就是粘贴导入那一条路**（把 id 当"粘贴的东西"交进去）：不新开第二条取数通路（R114 那一课）。
    request<PlaylistImportResult>("/api/online/playlist/import", { text: id, ...(name ? { name } : {}) })
      .then((result) => {
        playlistOpenId = result.id;
        openPanel("playlist");
        // R220：来源身份写进去几行也要在回执里看得见（没写进去同样要说，不许静默）。
        const identityNote = result.sourceIdentities
          ? (result.sourceIdentities.failed
            ? " · 来源身份没写进去（原因在服务日志里），这些行仍走搜索匹配"
            : ` · 来源身份已存 ${result.sourceIdentities.filled} 行（这些行不再靠搜索认歌）`)
          : "";
        notify((result.truncated || result.dropped || result.firstScreen
          ? `已导入 ${result.items} 条（${result.name}）：${result.warning ?? "源单更长，已截断"}`
          : `已导入「${result.name}」共 ${result.items} 条 · 来自你的账号歌单`) + identityNote);
      })
      .catch((error: Error) => {
        if (status) status.textContent = `导入失败：${error.message}`;
        else notify(`导入失败：${error.message}`);
      });
    return;
  }
  if (target.dataset.action === "playlist-new") {
    const name = window.prompt("新歌单名字（会成为文件名，1-40 个中文/字母/数字/短横线）")?.trim();
    if (!name) return;
    request<{ playlist: { id: string } }>("/api/playlists", { action: "create", name, text: `# name: ${name}\n` })
      .then((result) => {
        playlistOpenId = result.playlist.id;
        openPanel("playlist");
      })
      .catch((error: Error) => notify(`新建失败：${error.message}`));
    return;
  }
  if (target.dataset.action === "playlist-add-open") {
    // 行号来自 `data-online-index`。缺了/不是整数/超出当前结果集 ⇒ 直接说，不要把它交给
    // `toggleAddChooser(NaN)`（那会安静地"打开一个永远画不出来的选择器"，症状同样是点了没反应）。
    const index = Number(target.dataset.onlineIndex);
    if (!Number.isInteger(index) || index < 0 || index >= onlineResults.length) {
      notify("这一行对应的检索结果已经不在了，请重新检索后再试。");
      return;
    }
    void toggleAddChooser(index);
    return;
  }
  if (target.dataset.action === "playlist-add-to") {
    const playlistId = target.dataset.playlist ?? "";
    if (!playlistId) {
      // 从前这里会带着空 id 掉进"新歌单要有个名字"那句——用户点的是**已有**歌单，那句话是假的。
      notify("这颗按钮没带上目标歌单的标识，请重新点一次「加入歌单」。");
      return;
    }
    void addOnlineEntryToPlaylist(playlistId, "");
    return;
  }
  if (target.dataset.action === "playlist-add-create") {
    const box = document.querySelector<HTMLInputElement>("#playlist-add-new");
    void addOnlineEntryToPlaylist("", box?.value ?? "");
    return;
  }
  if (target.dataset.action === "playlist-add-cancel") {
    addChooserIndex = -1;
    paintOnlineResults();
    return;
  }
  // R127（方案 B）：未匹配那一行的「手工指定」→ 检索 → 「指定这一条」→ 只改那一行。
  if (target.dataset.action === "playlist-pick-open") {
    addChooserIndex = -1;
    startPick(Number(target.dataset.entry));
    return;
  }
  if (target.dataset.action === "playlist-pick-run") {
    void runPick(Number(target.dataset.onlineIndex));
    return;
  }
  if (target.dataset.action === "playlist-pick-cancel") {
    pickTarget = null;
    paintOnlineResults();
    return;
  }
  if (target.dataset.action === "artist-play-all") {
    void playArtistGroup();
    return;
  }
  // R162（任务九）：⑨ 那一份明细的浏览面。数据就是面板手里这一份，一次额外的网都不出。
  if (target.dataset.action === "artist-grid-view") {
    openArtistGridFromOnline();
    return;
  }
  if (target.dataset.action === "artist-play-entry") {
    const at = Number(target.dataset.entry);
    if (!Number.isInteger(at) || at < 0) {
      artistStatus("这一行没带上条目序号，请重新点开这位音乐人。");
      return;
    }
    void playArtistGroup(at);
    return;
  }
  if (target.dataset.action === "playlist-match-all") {
    void matchWholePlaylist();
    return;
  }
  if (target.dataset.action === "favorite-play-all") {
    void playFavoritesFromView();
    return;
  }
  if (target.dataset.action === "favorite-play") {
    void playFavoritesFromView(Number(target.dataset.favoriteIndex));
    return;
  }
  if (target.dataset.action === "favorite-remove") {
    void removeFavoriteAt(Number(target.dataset.favoriteIndex));
    return;
  }
  if (target.dataset.action === "playlist-play-all") {
    void playPlaylistFromDetail();
    return;
  }
  // R198：把展示封面删掉（架子那一格回退成程序化拼贴）。删的是 sidecar 里那一格，
  // 下次点「播放已匹配的 N 条」会重新选一张 —— 这条往返写在 run log 里，界面不假装它是永久开关。
  if (target.dataset.action === "playlist-cover-clear") {
    const id = playlistDetail?.id;
    if (id) {
      void request(`/api/playlists/${encodeURIComponent(id)}/display-cover`, { action: "clear" })
        .then(() => applyLibrary())
        .then(() => renderPlaylistDetail())
        .catch(() => playlistStatus("没删掉这张歌单的展示封面，稍后再试。"));
    }
    return;
  }
  // R220：按这张单的来历重新列一次账号歌单，把每行的**来源身份**补进 sidecar（`.playlist.txt` 不动）。
  // 报告要数得出来（补到几行 / 没补到几行，R125/R126 的口径），失败要说为什么——不许静默。
  if (target.dataset.action === "playlist-fill-identity") {
    const id = playlistDetail?.id;
    if (!id) return;
    playlistStatus("正在按这张单的来历重新列一次账号歌单…");
    void request<{ ok?: boolean; filled?: number; unfilled?: number; total?: number; error?: string }>(
      `/api/playlists/${encodeURIComponent(id)}/source-identity`, {},
    )
      .then((result) => {
        if (!result?.ok) { playlistStatus(result?.error ?? "补来源身份没成（服务端没给出原因）。"); return; }
        playlistStatus(`来源身份已补：${result.filled ?? 0} 行改用它在账号单里自己的那条 id（不再靠搜索认歌），`
          + `${result.unfilled ?? 0} 行没对上、仍走搜索匹配。文本文件一个字都没改。`);
        return renderPlaylistDetail();
      })
      .catch((error) => playlistStatus(`补来源身份没成：${(error as Error).message}`));
    return;
  }
  if (target.dataset.action === "playlist-play-entry") {
    void playPlaylistFromDetail(Number(target.dataset.entry));
    return;
  }
  if (target.dataset.action === "playlist-match-entry") {
    void matchOnePlaylistEntry(Number(target.dataset.entry));
    return;
  }
  if (target.dataset.action === "playlist-export") {
    void exportPlaylist();
    return;
  }
  if (target.dataset.action === "playlist-delete") {
    const id = playlistOpenId;
    if (!id || !window.confirm(`删除歌单「${id}」？这会删掉那个文本文件（它的匹配缓存也会一起删掉）。`)) return;
    request<{ playlists: PlaylistSummary[] }>("/api/playlists", { action: "delete", id })
      .then(() => {
        playlistOpenId = "";
        openPanel("playlists");
        notify(`已删除歌单「${id}」`);
      })
      .catch((error: Error) => notify(`删除失败：${error.message}`));
    return;
  }
  if (target.dataset.album) {
    revealAlbum(target.dataset.album, target.dataset.searchTrack);
    return;
  }
  if (target.dataset.tab) {
    setTab(target.dataset.tab as "tracks" | "about");
    return;
  }
  if (target.dataset.filter !== undefined) {
    searchGenre = target.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === searchGenre,
        ),
      );
    renderSearchResults();
    return;
  }
  const action = target.dataset.action;
  if (["library", "search", "settings"].includes(action || "")) {
    searchGenre = "";
    openPanel(action as Panel);
    return;
  }
  // R144 ·「歌词匹配」面板的四颗按钮。显式 `data-action` 排在任何定位 `data-*` 之前（R121 那条通则）。
  if (action === "open-lyric-match") {
    openPanel("lyrics");
    return;
  }
  if (action === "retry-lyrics") {
    void retryLyricMatch();
    return;
  }
  if (action === "claim-lyric") {
    void claimLyricCandidate(Number(target.dataset.index));
    return;
  }
  if (action === "clear-lyric-claim") {
    void clearLyricClaim();
    return;
  }
  switch (action) {
    case "locate-playing": {
      const track = playerState.currentTrack;
      if (track) revealAlbum(track.albumId, track.id, { reuseOpenAlbum: true });
      break;
    }
    case "close-panel":
    case "dismiss-panel":
      closePanel();
      break;
    case "open": {
      // 6.6「按专辑」：一行是一首曲目，打开详情时把这一首揭示出来（真正的登记在帧循环里，见 detailRevealArmed）。
      detailRevealArmed = !!records[selected]?.track;
      setMode("detail");
      break;
    }
    case "back":
      setMode("archive");
      break;
    case "model-viewer":
      // Temporarily unavailable for the simplified CD shell (no inner assembly).
      break;
    case "sound-preview":
      effects.play("page-open");
      break;
    case "fullscreen":
      void (
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      ).catch(() => notify("当前浏览器无法进入全屏。"));
      break;
    case "prev":
      stepAlbum(-1);
      break;
    case "next":
      stepAlbum(1);
      break;
    case "genre-prev":
      stepGenre(-1);
      break;
    case "genre-next":
      stepGenre(1);
      break;
    case "genres":
      openPanel("search");
      break;
    case "mode-rhine":
      setDisplayMode("rhine");
      break;
    case "mode-folia":
      setDisplayMode("folia");
      break;
    case "lyric-intensity": {
      const order: LyricIntensity[] = ["calm", "normal", "chaotic"];
      const next = order[(order.indexOf(preferences.lyricIntensity) + 1) % order.length];
      preferences.lyricIntensity = resolveLyricIntensity(next);
      savePrefs();
      lyricStage.refreshIntensity();
      refreshHostTheme();
      // 按钮标签由 syncTransportControls 统一回灌，改档后立刻刷新。
      if (playerState) syncTransportControls(playerState);
      notify(`动效强度：${intensityNames[preferences.lyricIntensity]}`);
      break;
    }
    case "folia-layout": {
      if (islandState !== "on" || !islandHandle) {
        notify("封面墙依附 Folia 岛，当前是自研歌词面");
        break;
      }
      // next 按"屏幕上现在是什么"算，不按偏好算：岛存储才是渲染的那一份，
      // 用偏好算会让两者脱钩时点下去切到同一个布局（看着就是"点了没反应"，看板 c980fa6 嫌疑③）。
      // R162：网格那一档不在这个两颗按钮的循环里 —— 它有自己的返回键与 Esc 梯子；
      // 布局按钮在网格上按下去 = 退出网格回歌词面（不是跳到封面墙，那会让人找不到刚才在哪）。
      if (currentFoliaLayout() === "artistGrid") {
        islandHandle.setLayout("classic");
        notify("已退出音乐人网格（歌词面）");
        break;
      }
      const next: IslandLayout = currentFoliaLayout() === "lattice" ? "classic" : "lattice";
      // setLayout 会经 onLayoutChange 写偏好并刷新按钮，这里不重复落盘。
      islandHandle.setLayout(next);
      notify(next === "lattice" ? "封面墙：整条播放队列铺成海报墙" : "歌词面");
      break;
    }
    case "favorite-toggle":
      // R130：传输区与岛内那颗「喜欢」是同一个动作的两个入口，都走这一个函数（与播放模式同一处理方式）。
      void toggleFavorite();
      break;
    case "folia-mode-cadenza":
      setFoliaMode("cadenza");
      break;
    case "folia-mode-cappella":
      setFoliaMode("cappella");
      break;
    case "folia-mode-claddagh":
      setFoliaMode("claddagh");
      break;
    case "folia-mode-classic":
      setFoliaMode("classic");
      break;
    case "folia-mode-fume":
      setFoliaMode("fume");
      break;
    case "folia-mode-lumiere":
      setFoliaMode("lumiere");
      break;
    case "folia-mode-monet":
      setFoliaMode("monet");
      break;
    case "folia-mode-partita":
      setFoliaMode("partita");
      break;
    case "folia-mode-pendolo":
      setFoliaMode("pendolo");
      break;
    case "folia-mode-sonnet":
      setFoliaMode("sonnet");
      break;
    case "folia-mode-still":
      setFoliaMode("still");
      break;
    case "folia-mode-tempera":
      setFoliaMode("tempera");
      break;
    case "folia-mode-tilt":
      setFoliaMode("tilt");
      break;
    // R202：背景模糊层来源三档（关 / 下层画面 / 当前曲封面）。卡片与 setFoliaMode 同一套点击委托形状。
    case "backdrop-source-off":
    case "backdrop-source-underlay":
    case "backdrop-source-cover": {
      const next = (target.dataset.action as string).replace("backdrop-source-", "") as BackdropSource;
      preferences.backdrop = { ...preferences.backdrop, source: next };
      savePrefs();
      // 面板要重画：不透明度那一格只在封面档出现（来源一变行数就变），且 aria-pressed 要跟着动。
      renderSettingsPanel();
      refreshBackdropNow();
      break;
    }
    case "track-prev":
      void player.previous();
      break;
    case "track-next":
      void player.next();
      break;
    case "play-pause":
      playerState.currentTrack ? void player.toggle() : playAlbum();
      break;
    case "stop":
      player.stop();
      break;
    case "playback-mode": {
      // 内核返回的是**真正生效**的那一档（非法值它会回落），所以这里不自己算下一档、也不再归一。
      const next = player.cyclePlaybackMode();
      preferences.playbackMode = next;
      savePrefs();
      notify(`播放模式：${PLAYBACK_MODE_NAMES[next].name}`);
      break;
    }
    case "scan":
      void scan(true);
      break;
    case "rescan":
      void scan();
      break;
    case "enrich-album":
      void enrich(true);
      break;
    case "enrich-library":
      void enrich();
      break;
    case "introduction-album":
      void queryIntroductions(true);
      break;
    case "introductions-library":
      void queryIntroductions();
      break;
    case "covers-refresh":
      void refreshCovers();
      break;
    case "copy-data-dir":
      void copyDataDirPath();
      break;
    case "edit-genres":
      void editGenres();
      break;
    case "auth-start":
      void startQrLogin(target.dataset.auth ?? "netease");
      break;
    case "auth-logout":
      void logoutAuth(target.dataset.auth ?? "netease");
      break;
    case "auth-cancel": {
      // 取消是**本机侧**的动作：停掉轮询、把那张废图清掉，并记下"取消的是哪一轮"。
      // 服务端那一轮不需要一个"取消"接口也会随 TTL 作废，为这个再加一条路由不值 ——
      // 但**不记这一笔就等于没取消**：下一次重画会从 pending 里把同一轮又捞回来，倒计时继续走
      // （真机上量到的就是这个：点了取消，那一行仍然"等待扫码 · 剩 284 秒"）。
      const provider = target.dataset.auth ?? "netease";
      const at = authPendingAt.get(provider) ?? 0;
      if (at) authCancelledAt.set(provider, at);
      stopAuthPoll(provider);
      authQrImages.delete(provider);
      const qr = document.querySelector<HTMLElement>(`[data-auth-qr='${provider}']`);
      if (qr) { qr.innerHTML = ""; qr.hidden = true }
      notify("已在本机停止等待这次扫码（服务端那一轮会在二维码过期时自动作废）。");
      void renderAuthRows();
      break;
    }
    case "save-playlist-dir":
      void (async () => {
        const state = $<HTMLInputElement>("#playlist-dir-state");
        const raw = ($<HTMLInputElement>("#playlist-dir").value ?? "").trim();
        if (raw && !window.confirm(`把歌单文件夹改成 ${raw}？\n\n现有歌单与匹配缓存会【复制】到新目录，老目录里的原件保留不动。`)) return;
        try {
          const saved = await request<{ playlistDir?: string; playlistMove?: { copied: number; skipped: number } }>(
            "/api/config", { playlistDir: raw },
          );
          await loadLibrary(true);
          const moved = saved.playlistMove;
          notify(moved
            ? `歌单文件夹已切到 ${saved.playlistDir}（复制 ${moved.copied} 个文件${moved.skipped ? `，${moved.skipped} 个同名跳过` : ""}；老目录里的原件保留）`
            : `歌单文件夹保持 ${saved.playlistDir}`);
          if (state) state.textContent = moved ? `已复制 ${moved.copied} 个文件到新目录。` : "未变更。";
        } catch (error) {
          notify(`改歌单文件夹失败：${(error as Error).message}`);
          if (state) state.textContent = (error as Error).message;
        }
      })();
      break;
    case "save-pref-source":
      void (async () => {
        const box = $<HTMLInputElement>("#prefer-logged-in-source");
        try {
          // 只发这一项：`updateConfig` 是"给了才改"的语义，捎带别的东西等于在另一个按钮里改设置。
          await request("/api/config", { preferLoggedInSource: box.checked });
          notify(box.checked
            ? "已开启：匹配时会在分数相差 10 分以内优先已登录那一家（一家都没登录时什么都不改）。"
            : "已关闭：匹配回到只按分数挑（与之前逐字一致）。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-same-platform":
      void (async () => {
        const box = $<HTMLInputElement>("#prefer-same-platform-source");
        try {
          // 只发这一项（那颗按钮的纪律：一个按钮只改它自己那一格）。
          await request("/api/config", { preferSamePlatformSource: box.checked });
          notify(box.checked
            ? `已开启：带来历注释的歌单逐条匹配时优先原平台（${ONLINE_PREFERENCE_MARGIN} 分边距内；不保证更能播，没登录时可能反而取不到）。`
            : "已关闭：匹配回到「只按登录偏好与分数挑」（来历注释从此不参与挑平台）。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-play-reporting":
      void (async () => {
        const box = $<HTMLInputElement>("#play-reporting");
        const turningOn = box.checked;
        // **开的那一方向要二次确认**（关不需要——关是回到缺省）。
        // 这一项与别的开关不同：它不是"要不要联网取东西"，而是"要不要把我在听什么送出去"，
        // 方向相反，所以点一下不能就算表过态。
        if (turningOn && !window.confirm(
          "确认开启播放上报？\n\n开着之后，在线曲目听满 30 秒会向它的来源平台（网易 / 酷狗）报一次"
          + "「我在听这一首」，报过去的只有：平台曲目标识、收听到第几秒、动作名。\n"
          + "本地曲目不报；曲名歌手文本、文件路径、整条队列都不报；不建播放历史文件。\n"
          + "随时可以关掉（关是即时生效的）。",
        )) {
          box.checked = false;
          return;
        }
        try {
          await request("/api/config", { playReporting: turningOn });
          reportEnabled = turningOn;                       // 前端那份缓存立刻跟上，不等下一次读配置
          const state = document.querySelector('[data-role="play-reporting-state"]');
          if (state) {
            state.textContent = turningOn
              ? "当前：开着 —— 听满 30 秒的在线曲目会报给来源平台（本地曲目不报）。"
              : "当前：关着（缺省）—— 本机不会向任何平台送播放记录，一次请求都不发。";
          }
          notify(turningOn ? "已开启播放上报（可随时关）。" : "已关闭播放上报：不再发出任何播放记录。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-kugou-device":
      void (async () => {
        const box = $<HTMLInputElement>("#kugou-device-identity");
        try {
          // 只发这一项（与上面那颗按钮同一条纪律：一个按钮只改它自己那一格）。
          await request("/api/config", { kugouDeviceIdentity: box.checked });
          notify(box.checked
            ? "已允许设备身份备用路：只有酷狗上游明确回「本次请求需要验证」时才会用一次，且只重试一次。"
            : "已关闭（默认）：本机不向酷狗注册设备身份。酷狗音频不受影响——它靠的是明确带「没有设备号」。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-online":
      void (async () => {
        try {
          await request("/api/config", {
            musicBrainzContact:
              $<HTMLInputElement>("#metadata-contact").value.trim(),
            onlineEnabled: $<HTMLInputElement>("#online-enabled").checked,
          });
          notify("资料库设置已保存。可以开始补充专辑资料。");
        } catch (error) {
          notify((error as Error).message);
        }
      })();
      break;
    case "save-genres":
      void (async () => {
        const editor = $<HTMLTextAreaElement>("#genre-json");
        try {
          const body = JSON.parse(editor.value);
          await request("/api/genre-rules", body);
          await loadLibrary(true);
          notify("分类规则已保存并应用。");
          if (editor.isConnected && panel === "library") renderLibraryPanel();
        } catch (error) {
          const errorNode = document.querySelector("#genre-error");
          if (editor.isConnected && errorNode)
            errorNode.textContent = (error as Error).message;
          else notify((error as Error).message);
        }
      })();
      break;
    case "demo":
      demo = true;
      closePanel(() => void applyLibrary());
      break;
  }
});
document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.quality && el.type === "range") {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]: Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "bgm-volume") {
    preferences.bgmVolume = Number(el.value) / 100;
    player.setBgmVolume(preferences.bgmVolume);
    savePrefs();
  }
  if (el.id === "sound-volume") {
    preferences.soundVolume = Number(el.value) / 100;
    effects.configure({
      sound: preferences.sound,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "album-search") renderSearchResults();
  if (el.id === "volume") {
    preferences.volume = Number(el.value) / 100;
    player.setVolume(preferences.volume);
    savePrefs();
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "music-sort" && ["genre", "artist", "album"].includes(el.value)) {
    if (preferences.sortMode === el.value) return;
    preferences.sortMode = el.value as MusicSortMode;
    savePrefs();
    location.reload();
    return;
  }
  // 6.6 分组轴：与排序沿用同一套"刷新页面"策略（热切换要处理 visualKey、封面 atlas 代际与相机重定位，
  // 属独立改动面，本期不新造）。两个控件各自只写自己的偏好，互不赋值。
  if (el.id === "music-shelf-layout" && ["genre", "artist", "album"].includes(el.value)) {
    if (preferences.shelfLayout === el.value) return;
    preferences.shelfLayout = el.value as MusicShelfLayout;
    savePrefs();
    location.reload();
    return;
  }
  if (el.id === "quality-preset") {
    preferences.quality = el.value as QualityPreset;
    renderQuality = normalizeQuality(qualityPresets[preferences.quality]);
    updateQuality();
  }
  if (el.dataset.quality) {
    renderQuality = normalizeQuality({
      ...renderQuality,
      [el.dataset.quality]:
        el.dataset.quality === "antialias" ? el.value : Number(el.value),
    });
    updateQuality();
  }
  if (el.id === "sound-setting") {
    preferences.sound = el.checked;
    effects.configure({
      sound: el.checked,
      music: false,
      soundVolume: preferences.soundVolume,
      musicVolume: 0,
    });
    savePrefs();
  }
  if (el.id === "song-fade-setting") {
    preferences.songFade = el.checked;
    player.setSongFadeEnabled(el.checked);
    savePrefs();
  }
  if (el.id === "reduced-motion") {
    preferences.reduced = el.checked;
    transportTitleMotion.setReduced(el.checked);
    if (el.checked) {
      browseTransition.finish();
      detailTransition.finish();
    }
    syncSelectionMotion();
    scene?.setReduced(el.checked);
    stage.classList.toggle("reduce-motion", el.checked);
    updateSelection();
    savePrefs();
    // R133：无歌词动画的"减弱动效 ⇒ 降到 basic"这条规则是在 mount 时读的。
    // 不立刻重挂的话，用户先选「跟随音频 / 频谱条」再打开减弱动效，画面会照旧满屏跳
    // （真机量到的：减弱动效打开后 effective 仍是 spectrum，直到下一次换曲才改）。
    // 这是 R124 那条规则一直存在的漏，两档一起补。
    lyricStage.refresh();
    lyricStage.sync(player.state);
  }
  if (el.id === "output-device-setting") {
    // 选完立刻生效（不等换曲）：失败由 applyOutputDevice 里那一段"退回默认 + 撤回选择"兜住
    void applyOutputDevice(el.value);
  }
  if (el.id === "lyric-pulse-setting") {
    const next = el.value as LyricPulseTier;
    preferences.lyricPulse = LYRIC_PULSE_TIERS.includes(next) ? next : "basic";
    savePrefs();
    // 档位是每次 mount 时读的，让舞台立刻重建一次当前画面。
    lyricStage.refresh();
    lyricStage.sync(player.state);
  }
  if (el.id === "bgm-setting") {
    preferences.bgm = el.checked;
    player.setBgmEnabled(el.checked);
    savePrefs();
  }
  // R202：背景模糊层三格（来源 / 模糊程度 / 不透明度）。改一格存一格（磁盘只存补丁），
  // 没改过的格永远跟着主题缺省走 —— 与 foliaTunings 同一条口径。
  if (el.dataset.backdrop === "blur") {
    preferences.backdrop = { ...preferences.backdrop, blur: Number(el.value) };
    savePrefs();
    refreshBackdropNow();
    return;
  }
  if (el.dataset.backdrop === "opacity") {
    preferences.backdrop = { ...preferences.backdrop, opacity: Number(el.value) / 100 };
    savePrefs();
    refreshBackdropNow();
    return;
  }
});
document.addEventListener("keydown", (e) => {
  if (boot?.active) return;
  if (viewer?.isOpen) return;
  if (e.key === "Escape") {
    panel ? closePanel() : setMode("archive");
    return;
  }
  if (panel) {
    if (e.key === "Tab") {
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "#music-panel-root button:not([disabled]), #music-panel-root input, #music-panel-root textarea, #music-panel-root select, #music-panel-root a",
        ),
      ];
      if (!items.length) return;
      const first = items[0],
        last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }
  if (
    (e.target as HTMLElement).matches("[role=tab]") &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
  ) {
    e.preventDefault();
    setTab(
      e.key === "Home"
        ? "tracks"
        : e.key === "End"
          ? "about"
          : activeTab === "tracks"
            ? "about"
            : "tracks",
    );
    $(`#tab-${activeTab}`).focus();
    return;
  }
  if (
    (e.target as HTMLElement).matches(
      "input, textarea, select, [contenteditable=true]",
    )
  )
    return;
  if (e.key === "/") {
    e.preventDefault();
    searchGenre = "";
    openPanel("search");
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepGenre(-1);
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepGenre(1);
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    stepAlbum(-1);
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    stepAlbum(1);
  }
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    setMode("detail");
  }
  // The input guard above already returns for focused fields, so L never eats typing.
  if (e.key === "l" || e.key === "L") {
    e.preventDefault();
    setDisplayMode(displayMode === "folia" ? "rhine" : "folia");
  }
  if (e.code === "Space" && !(e.target as HTMLElement).closest("button, a")) {
    e.preventDefault();
    playerState.currentTrack ? void player.toggle() : playAlbum();
  }
});

let lastFrame = 0,
  frameCount = 0;
function frame(ms: number) {
  if (!document.hidden && scene) {
    const opening = boot?.update(ms / 1000);
    // Folia mode keeps the last 3D frame as a static backdrop; lyric timing is driven by this
    // same loop, never by timeupdate. Parking must wait for the presentation to settle: the
    // state machine polls scene flags that only advance inside scene.update(), so parking
    // during opening/switching freezes the browse→detail transition forever.
    const foliaStage = lyricViewWanted();
    // 在线曲目没有"打开专辑"这一步，歌词面的进出只能在这里对账（播完/换回本地曲要能自动退回）。
    applyLyricView();
    const parkScene = foliaStage && presentation.phase === "detail";
    if (!viewer?.isOpen && !parkScene) scene.update(ms / 1000, opening?.cinema);
    if (foliaStage) lyricStage.applyTime(player.clockTime());
    if (foliaStage) {
      syncFoliaIsland(true);
      feedFoliaIsland();
      // R162：网格的喂料等岛挂好才冲（挂载是异步的，点按钮那一帧可能还没有岛）。
      flushArtistGridFeed();
      if (stage.dataset.foliaView === "island") islandHandle?.tick(player.clockTime());
    } else if (islandState !== "off") {
      syncFoliaIsland(false);
    }
    viewer?.update(ms / 1000);
    if (!viewer?.isOpen && !boot?.active) presentation.update();
    const phase = presentation.phase;
    if (stage.dataset.presentation !== phase) stage.dataset.presentation = phase;
    const cameraPhase = scene.musicPresentationPhase;
    if (stage.dataset.cameraPhase !== cameraPhase) stage.dataset.cameraPhase = cameraPhase;
    if (presentation.phase === "detail") {
      documentDecryption.update(
        ms / 1000,
        scene.decryptionFrame,
        preferences.reduced,
        !viewer?.isOpen,
      );
      if (pendingDetailFocus && !panel && !viewer?.isOpen) {
        $("#album-detail-content").focus({ preventScroll: true });
        pendingDetailFocus = false;
      }
      // 6.6「按专辑」：详情真的开到 open 这一档，才把"要揭示哪一首"交给下面的既有通路。
      if (detailRevealArmed && $("#music-detail").dataset.transition === "open") {
        detailRevealArmed = false;
        const row = records[selected];
        if (row?.track && row.album && currentAlbum()?.id === row.album.id && !pendingTrackReveal) {
          pendingTrackReveal = { albumId: row.album.id, trackId: row.track.id };
        }
      }
      if (
        pendingTrackReveal &&
        !panel &&
        !viewer?.isOpen &&
        $("#music-detail").dataset.transition === "open" &&
        currentAlbum()?.id === pendingTrackReveal.albumId
      ) {
        const content = $("#album-detail-content");
        const trackId = pendingTrackReveal.trackId;
        const row = Array.from(
          content.querySelectorAll<HTMLButtonElement>(".track-row"),
        ).find((item) => item.dataset.track === trackId);
        // 行还没渲染出来时不清 pendingTrackReveal，下一帧再试；否则这次揭示就永久丢了
        // （专辑切换与详情内容渲染之间本来就有一帧差，第四期靠搜索通路踩不到，本期的 open 通路会）。
        if (row) {
          pendingTrackReveal = undefined;
          trackFocus.reveal(content, row, preferences.reduced);
        }
      }
    }
    frameCount++;
    if (ms - lastFrame > 1500) {
      $("#runtime-info").textContent =
        `${Math.round((frameCount * 1000) / (ms - lastFrame))} FPS / ${themeNames[preferences.theme]}`;
      // Keep read-only render diagnostics alongside the existing resolution
      // attributes, without adding controls or per-frame DOM work.
      if (!viewer?.isOpen) {
        const { drawCalls, triangles, selectionLight } = scene.getStats();
        $("#three-scene").dataset.renderStats = JSON.stringify({
          drawCalls,
          triangles,
        });
        $("#three-scene").dataset.selectionLight =
          JSON.stringify(selectionLight);
      }
      frameCount = 0;
      lastFrame = ms;
    }
  } else {
    frameCount = 0;
    lastFrame = ms;
  }
  requestAnimationFrame(frame);
}
async function start() {
  // This local application owns its live index. An old archive PWA must not serve stale UI.
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }
  await loadLibrary(true);
  try {
    fit();
    scene = new ArchiveScene($("#three-scene"));
    // Keep a direct visual comparison URL without adding another user setting.
    if (new URLSearchParams(location.search).get("lighting") !== "baseline")
      scene.enableSelectionLighting();
    await Promise.all([
      scene.load(),
      document.fonts.load("400 20px MiSans"),
      document.fonts.load("600 20px MiSans"),
    ]);
    ready = true;
    $("#three-scene canvas").setAttribute(
      "aria-label",
      `三维专辑阵列，左右切${shelfLabel.column}，上下切${shelfLabel.rows}`,
    );
    stage.classList.toggle("reduce-motion", preferences.reduced);
    await scene.refreshLibrary(selected);
    scene.setTheme(preferences.theme);
    scene.setQuality(renderQuality);
    scene.setReduced(preferences.reduced);
    scene.onSelect = (index, cell) => {
      if (!boot?.active && presentation.phase === "archive" && !panel)
        select(index, cell ? { cell } : undefined);
    };
    scene.onNavigate = (axis, direction) => {
      if (!boot?.active && presentation.phase === "archive" && !panel)
        axis === "lane" ? stepGenre(direction) : stepAlbum(direction);
    };
    $("#music-loading").remove();
    // R161（任务八）：上报开关的真源在服务端配置里，开机读一次缓存到前端（读不到 ⇒ 按关处理）。
    void refreshReportSetting();
    // R160（任务七）· 输出设备：开机时把偏好里那把 id 交给播放器（**空串 = 跟随系统默认，一次 setSinkId 都不发**），
    // 并挂上 `devicechange`：插拔耳机之后列表会自己变，用户点"刷新"之前先给一次自动重列。
    if (preferences.outputDevice) void applyOutputDevice(preferences.outputDevice);
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        void refreshOutputSinks().then(() => repaintOutputDeviceRow());
      });
    }
    updateSelection();
    // R203（Task 6 真机抓到的两格，都来自"这一档没有外壳"这个事实）：
    //  ① 进场遮罩里那颗「跳过进场 ↗」是外壳按钮，会浮在这块本该只有画面的屏上；
    //  ② 更要紧的是那个 `role=dialog aria-modal` 的遮罩**自己处理 Escape**（按 Esc = 跳过进场），
    //     于是三条退路里最不依赖可见性的那条，在开场那几秒是失灵的（Task 3 判据"三路都要能退"当场不成立）。
    // 走既有的"立即显示档案架"那一支（与 `?scene=archive` 同一条路），不新造任何跳过逻辑。
    const skipOpening = isWallpaperSurface
      || new URLSearchParams(location.search).get("scene") === "archive";
    if (albums.length && !skipOpening) {
      boot?.start(performance.now() / 1000);
    } else {
      scene.showMusicArchiveImmediately(performance.now() / 1000);
      effects.setScene("archive");
      if (albums.length) showBrowseSurface();
      else browseTransition.hide(true);
      $("#music-browse").inert = !albums.length;
      $("#music-browse").setAttribute("aria-hidden", String(!albums.length));
    }
    syncSelectionMotion();
    requestAnimationFrame((ms) => {
      stage.classList.add("theme-motion-ready");
      frame(ms);
    });
  } catch (error) {
    console.error(error);
    $("#music-loading").innerHTML =
      `<strong>三维资源未能加载</strong><small>${esc((error as Error).message)}</small><button data-action="library">检查音乐库</button>`;
  }
}
/**
 * R206 ③（歌词面右下那颗「沉浸全屏」）：页内全屏 + 播放器外壳让位，只留底部中间那条控制条。
 * 三条讲究都写在 `folia-host/immersive.ts` 头部，这里只补接线那一格：
 *  · 隐藏仍然只有 CSS 那一个出处 —— 这一档挂到**同一个 `data-surface` 属性的另一个值**上，
 *    不新造第二套隐藏状态机（R203 判据④ 钉过"第二套=0"）；关掉时把属性**删掉**而不是写空串，
 *    "不带参数时属性缺席"那条不变式（判据②）才继续逐字成立。
 *  · 壁纸那一档（壳推的 `?wallpaper=1`）不挂这颗：那一档有自己的角落热点与三条退出，
 *    两颗并排在右下角只会互相挡，而且两头抢同一个属性。
 *  · 挂在模块求值阶段、不挂在 `start()` 后面 —— 与 R203 那三路退出同一条理由：
 *    `start()` 抛错恰恰是最需要退出去的时刻。
 */
const immersive = createImmersiveToggle(stage, {
  fullscreen: documentFullscreenAdapter(document),
  onSurfaceChange: (immersiveOn) => {
    if (isWallpaperSurface) return;
    if (immersiveOn) stage.dataset.surface = IMMERSIVE_SURFACE_VALUE;
    else delete stage.dataset.surface;
  },
});
if (!isWallpaperSurface) immersive.activate();
/** R203（壁纸 surface M0 · Task 3）：三路退出——`Esc` / 双击 / 右下角热点，一条都不能少。
 * 这一档将来要长期挂着（无人值守），退不出去就是把人关在里面（方案 §四.5 把"退出通道"写成安全要求，
 * M0 在浏览器里先把三路落地、真机逐条点到）。三路在那个模块里共用同一个 `exit()`：
 * 先按需退全屏，再换到"去掉 `wallpaper` 那一格"的同一张页——三份导航迟早漂（R131 同一条道理）。
 * **挂在模块求值阶段、不挂在 `start()` 里面**：`start()` 抛错（三维资源没加载成）恰恰是最需要退出去的时刻，
 * 挂在它后面等于"失败态把三条退路一起收走"。
 */
if (isWallpaperSurface) {
  createSurfaceExit(stage, {
    // 面板开着时那颗 Esc 已有主人（R134 一手量到：capture 里的 preventDefault 拦不住同一条事件的
    // 其它监听器，Esc 关面板顺带执行了宿主动作、岛一起被卸装）；三维资源查看器开着时同理不吃按键。
    blocked: () => commandPalette.isOpen() || Boolean(viewer?.isOpen),
    exitFullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : undefined),
    // `replace` 而不是 `assign`：退出去之后，后退键不该把人再塞回这块挂屏。
    navigate: (url) => location.replace(url),
  }).activate();
}
void start();
Object.assign(window, {
  rhineMusic: {
    get library() {
      return library;
    },
    get selectedAlbum() {
      return currentAlbum();
    },
    get player() {
      return player.state;
    },
    stats: () => scene?.getStats(),
    orbit: () => scene?.orbitState,
    lyrics: () => lyricStage.state,
    foliaLines: () => lyricStage.lyricData()?.lines.map((l) => l.fullText) ?? [],
    foliaLineWords: () => lyricStage.lyricData()?.lines.map((l) => (l.words ?? []).map((w) => w.text)) ?? [],
    mediaTime: () => player.clockTime(),
    sceneFrames: () => scene?.frameCount ?? 0,
    get presentation() {
      return { phase: presentation.phase, cameraPhase: scene?.musicPresentationPhase,
        pendingIndex: presentation.pendingSelection?.index,
        menuVisible: !$("#music-detail").hidden,
        cameraReady: scene?.musicPresentationReady,
        archiveReady: scene?.musicArchiveReady };
    },
  },
});
