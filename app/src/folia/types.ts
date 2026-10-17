/**
 * R11 自撰聚合类型文件（移植台账 memory/folia-port-rewrite-log.md）。
 * 歌词类型（LyricData/Line/Word/…）re-export 自本仓 app/src/lyrics/types.ts（与上游逐字一致，单一来源）；
 * 其余声明逐字摘自 folia-major src/types.ts @ 369c34e6f83404c65129479e6bd88d70acb0e43e（AGPL-3.0-only）；
 * SongResult 为宿主最小化重写（R11b）：在线字段（matchedLyricsSource/qqMid/kgHash/…）延后到第四期补。
 */
import type { MotionValue } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import type { PlaybackSourceRef } from './types/onlineMusic';
export type {
  LyricRuby, LyricSyllable, LyricAlternateText, Word, LyricBackgroundVocal,
  SubtitleContentMode, LyricAgent, Line, LyricData,
} from '../lyrics/types';
import type { LineRenderHints } from './utils/lyrics/renderHints';
export type { LineRenderHints };

export interface Theme {
  name: string;
  backgroundColor: string;
  primaryColor: string;
  accentColor: string;
  secondaryColor: string;
  fontStyle: 'sans' | 'serif' | 'mono';
  fontFamily?: string;
  fontFamilyStack?: string[];
  fontWeight?: number;
  animationIntensity: 'calm' | 'normal' | 'chaotic';
  wordColors?: { word: string; color: string; }[];
  lyricsIcons?: string[];
  provider?: string;
  description?: string;
}

export interface AudioBands {
    bass: MotionValue<number>;    // 20-150Hz (Circles)
    lowMid: MotionValue<number>;  // 150-400Hz (Squares)
    mid: MotionValue<number>;     // 400-1200Hz (Triangles)
    vocal: MotionValue<number>;   // 1000-3500Hz (Icons)
    treble: MotionValue<number>;  // 3500Hz+ (Crosses)
    spectrum?: MotionValue<Uint8Array<ArrayBuffer>>; // Raw analyser FFT magnitude bins for full-spectrum visualizers
  }

export enum PlayerState {
  IDLE = 'IDLE',
  PLAYING = 'PLAYING',
  PAUSED = 'PAUSED',
}

export type PlaybackContext = 'main' | 'stage';

export type VisualizerBackgroundMode = BuiltinVisualizerBackgroundMode | (string & {});

export type BuiltinVisualizerBackgroundMode = 'common' | 'monet' | 'nomand' | 'latent' | 'url' | 'sora';


export interface ClassicTuning {
  enableWordRotation: boolean;
  breathingFloatMultiplier: number;
  useLegacyLayout?: boolean;
  wordSpacing?: number;
}

export const DEFAULT_CLASSIC_TUNING: ClassicTuning = {
  enableWordRotation: true,
  breathingFloatMultiplier: 1,
  useLegacyLayout: false,
  wordSpacing: 0.7,
};

export interface StatusMessage {
  type: 'error' | 'success' | 'info';
  text: string;
  nonce?: number;
  durationMs?: number;
  actionLabel?: string;
  /** Icon drawn before actionLabel inside the action button. */
  actionIcon?: LucideIcon;
  onAction?: () => void;
  cancelLabel?: string;
  onCancel?: () => void;
  persistent?: boolean;
}

// Netease / Search API Types

export type ReplayGainMode = 'off' | 'track' | 'album';

// Audio Analysis Types

export interface ReplayGainInfo {
  /** ReplayGain gain values in decibels. */
  trackGain?: number;
  albumGain?: number;
  /** ReplayGain peak values as positive linear ratios. */
  trackPeak?: number;
  albumPeak?: number;
}

export type AmllDbPlatform = 'ncm' | 'qq';

export type LyricProviderSource = 'netease' | 'qq' | 'kugou' | 'amll';

export type ActiveLocalLyricsSource = 'local' | 'embedded' | 'online';
// Where a local song's `local*LyricsContent` came from: a sidecar file picked by the import, or a
// file the user uploaded from the panel. Records written before this field existed have none.

export interface CappellaAvatarImage {
  id: string;
  name: string;
  url: string;
}

export interface CappellaEmojiImage {
  id: string;
  name: string;
  url: string;
}

export interface CappellaTuning {
  showEmoMessages: boolean;
  emojiPackSource: CappellaEmojiPackSource;
  avatarSource: CappellaAvatarSource;
}

// R176（档三 cappella·群唱）：三格逐字照上游 types.ts:482-486（R175 的默认参数比对断言管着它）。
export const DEFAULT_CAPPELLA_TUNING: CappellaTuning = {
  showEmoMessages: true,
  emojiPackSource: 'builtin',
  avatarSource: 'cover',
};

export interface CadenzaTuning {
  fontScale: number;
  widthRatio: number;
  motionAmount: number;
  glowIntensity: number;
  beamIntensity: number;
}

/** R167（任务十二·模式二 cadenza）：声明与数值逐字摘自上游 types.ts:413-419。 */
export const DEFAULT_CADENZA_TUNING: CadenzaTuning = {
  fontScale: 1.12,
  widthRatio: 0.72,
  motionAmount: 1,
  glowIntensity: 1,
  beamIntensity: 0,
};

export interface CladdaghTuning {
  focusScaleRatio: number;
  radiusScale: number;
  ellipseTiltDeg: number;
  showAxisLine: boolean;
  letterSpacingOffset: number;
}

/** R174（claddagh）：声明与数值逐字摘自上游 types.ts 里紧接 CladdaghTuning 的那一段。 */
export const DEFAULT_CLADDAGH_TUNING: CladdaghTuning = {
  focusScaleRatio: 0.65,
  radiusScale: 1.0,
  ellipseTiltDeg: 45,
  showAxisLine: true,
  letterSpacingOffset: 0,
};

export interface DioramaTuning {
  cameraSpeed: number;
  motionAmount: number;
  audioReactivity: number;
  geometryVisibility: DioramaGeometryVisibility;
  /** Number of points requested for each formation anchor; the renderer also enforces a global cap. */
  particleDensity: number;
  /** Spatial scale multiplier for each complete point-cloud formation. */
  particleScale: number;
  /** One soft gradient aura per point-cloud cluster, separate from lyric sung-glow. */
  particleGlowEnabled: boolean;
  particleGlowIntensity: number;
  showParticles: boolean;
  /** Background dust shell, two INDEPENDENT axes (motes-per-line = the product; field clamps to its cap):
   *  背景粒子·圆周密度 = motes around each ring, 背景粒子·径向密度 = layers across the shell thickness. */
  backgroundParticleCircumference: number;
  backgroundParticleRadial: number;
  /** 普通辉光跟唱: soft glow on the unit being sung. Independent toggle + strength. */
  glowEnabled: boolean;
  glowIntensity: number;
  /** 灵魂出窍跟唱: a ghost copy of the sung glyph drifts out of the text. Independent toggle + strength. */
  soulEnabled: boolean;
  soulIntensity: number;
  /** 当前字漂移: a plain ON/OFF sub-switch of 灵魂出窍. ON lets the glyph CURRENTLY being sung drift at the
   *  same 灵魂出窍强度 as every other glyph; OFF holds it perfectly registered (no doubling / reading
   *  obstruction) until it finishes, after which it detaches and flies like the rest. No strength of its
   *  own - it borrows soulIntensity. Only has a visible effect when soulEnabled. */
  soulActiveEnabled: boolean;
  /** 渐变跟唱: the line's fill progressively deepens with the sung progress. Independent toggle + strength. */
  gradientEnabled: boolean;
  gradientIntensity: number;
  /** 关键字着色: the theme's `wordColors` keywords (written by the AI theme from the song's lyrics) become
   *  the follow-sing TARGET colour of the units they cover - hidden until the singing reaches them, never
   *  a resting colour. Same source and matcher as every other visualizer. */
  keywordColoringEnabled: boolean;
}

export interface FumeTuning {
  hidePrintSymbols: boolean;
  disableGeometricBackground: boolean;
  backgroundObjectOpacity: number;
  textHoldRatio: number;
  cameraTrackingMode: 'stepped' | 'smooth';
  cameraSpeed: number;
  glowIntensity: number;
  heroScale: number;
}

// R177（档四 fume·浮名）：八格逐字照上游 types.ts:446-455（默认参数比对断言管着它，含最后一格）。
export const DEFAULT_FUME_TUNING: FumeTuning = {
  hidePrintSymbols: false,
  disableGeometricBackground: true,
  backgroundObjectOpacity: 0.5,
  textHoldRatio: 1,
  cameraTrackingMode: 'smooth',
  cameraSpeed: 1,
  glowIntensity: 1,
  heroScale: 1,
};

export interface LumiereTuning {
  /** 光强倍率, 0.3..2. */
  lightIntensity: number;
  /** 随音乐变亮, 0..2 (0 = 不随音乐变). */
  audioResponse: number;
  /** 烟雾浓度, 0..2. */
  fogDensity: number;
  /**
   * 暗场强度, 0..1：光后面铺一层主题背景色压暗的底，压住 folia 的共享背景（0 = 共享背景原样透出）。
   * 浅色主题保底 0.94（绘光始终在暗场里）。
   */
  darkField: number;
  /** 浮尘数量, 0..2. */
  moteAmount: number;
  /** 图形辉光, 0..2. */
  bloom: number;
  /** 文字辉光, 0..2. */
  textBloom: number;
  /** 未唱字透明度, 0.05..0.6. */
  unlitOpacity: number;
  /** 邻行：1 = 上一行 + 当前行，2 = 上一行 + 当前行 + 下一行. */
  windowNeighbors: 1 | 2;
  /** 崩解强度, 0..2. */
  decay: number;
  /** 背景歌词亮度, 0..2 (0 = 关). */
  echo: number;
  /** 烟雾细节（倍频数）, integer 2..6. */
  fogOctaves: number;
  /** 线稿. */
  lineArt: boolean;
  /** 前景散景. */
  frontBokeh: boolean;
  /** 所有换位都走轨迹线. */
  trails: boolean;
  /**
   * 轨迹过渡：段落之间也和段内换镜头一样在同一个光场里交接（整首歌编成一个场景单元），
   * 没有熄灯 / 闪白 / 拉焦 / 交叉渐变。改它会重新编译程序.
   */
  seamlessTransitions: boolean;
  /** 画框. */
  overlayFrame: boolean;
  /**
   * 仅显示歌词文字：只画歌词与字上的效果（点亮、光晕、闪点、十字爆闪、径迹、追字光斑），
   * 光场、烟雾、星空、线稿、浮尘、背景歌词、主题图标、画框与片尾卡的光都不画。字的明暗仍按光束算.
   */
  textOnly: boolean;
  /** 关键字着色（主题 wordColors）. */
  keywordColors: boolean;
  /** 主题图标（主题 lyricsIcons 画成线稿）. */
  themeIcons: boolean;
  /** 主题色占比, 0..1：0 = 香槟金光；越高光色越接近强调色、点亮 / 未唱的字越接近主色 / 次色. */
  themeColorMix: number;
  /** 画质. */
  renderQuality: LumiereRenderQuality;
}

/**
 * R46（第三期）：绘光默认参数，逐字取自上游 types.ts:759-783。
 * 第一期裁薄 types.ts 时只留了类型没留默认值；宿主不渲染调参面板，
 * 模式一律吃这份默认（`VisualizerLumiere` 的 `lumiereTuning = DEFAULT_LUMIERE_TUNING` 形参默认）。
 */
export const DEFAULT_LUMIERE_TUNING: LumiereTuning = {
  lightIntensity: 1,
  audioResponse: 1,
  fogDensity: 1,
  darkField: 0.75,
  moteAmount: 1,
  bloom: 1,
  textBloom: 1,
  unlitOpacity: 0.22,
  windowNeighbors: 2,
  decay: 1,
  echo: 1,
  fogOctaves: 5,
  lineArt: true,
  frontBokeh: true,
  trails: true,
  seamlessTransitions: true,
  overlayFrame: true,
  textOnly: false,
  keywordColors: true,
  themeIcons: true,
  themeColorMix: 0.3,
  renderQuality: 'full',
};

export interface MonetPortraitImage {
  id: string;
  name: string;
  url: string;
}

export interface MonetTuning {
  keywordColoringEnabled: boolean;
  showDescription: boolean;
  showAudioVisualization: boolean;
  audioStyle: MonetAudioStyle;
  fontScale: number;
  portraitSource: MonetPortraitSource;
  portraitOffsetX?: number;
  portraitStyle?: 'square' | 'rectangular';
  showPortraitDragHanger?: boolean;
}

/** R166（任务十二·模式一 monet）：声明与数值逐字摘自上游 types.ts:1063-1073。 */
export const DEFAULT_MONET_TUNING: MonetTuning = {
  keywordColoringEnabled: true,
  showDescription: true,
  showAudioVisualization: true,
  audioStyle: 'bar',
  fontScale: 1.2,
  portraitSource: 'cover',
  portraitOffsetX: 0,
  portraitStyle: 'square',
  showPortraitDragHanger: true,
};

export interface PartitaTuning {
  showGuideLines: boolean;
  useSemanticLayout: boolean;
  staggerMin: number;
  staggerMax: number;
}

/** R168（任务十二·模式三 partita）：声明与数值逐字摘自上游 types.ts:428-433。 */
export const DEFAULT_PARTITA_TUNING: PartitaTuning = {
  showGuideLines: true,
  useSemanticLayout: true,
  staggerMin: 20,
  staggerMax: 100,
};

/** R175（档二 pendolo）：声明与数值逐字摘自上游 types.ts 里紧接 PendoloTuning 的那一段。 */
export const DEFAULT_PENDOLO_TUNING: PendoloTuning = {
  arcRadius: 0.42,
  arcAngleDeg: 100,
  wheelCenterX: 0.0,
  wheelCenterY: 0.50,
  tickSnappiness: 2.0,
  activeScale: 1.25,
  showGearDecor: 'subtle',
  showCenterGradient: true,
  showCoverOnWatchFace: false,
  enableLineGlow: false,
};

export interface PendoloTuning {
  arcRadius: number;
  arcAngleDeg: number;
  wheelCenterX: number;
  wheelCenterY: number;
  tickSnappiness: number;
  activeScale: number;
  showGearDecor: 'none' | 'subtle' | 'full';
  showCenterGradient?: boolean;
  showCoverOnWatchFace?: boolean;
  enableLineGlow?: boolean;
}

export interface SonnetTuning {
  cameraIntensity: number;
  typographyMotion: number;
  mgDensity: number;
  showOnlyText: boolean;
  showGuide: boolean;
  showBackgroundMg: boolean;
  showFixedGeo: boolean;
  showGiantDecorativeText: boolean;
  showBackgroundDecor: boolean;
  enableTransitions: boolean;
  outerFrameMode: SonnetOuterFrameMode;
  textureResolution: number;
  /** Master switch for the scene-wide post-process stack (grain + contrast). */
  postProcessEnabled: boolean;
  /** Film grain amount, 0..1. */
  postProcessGrain: number;
  /** Contrast boost, 0..1. */
  postProcessContrast: number;
  /** Fixed print-style passes riding the master switch; strength sliders, 0 disables the pass. */
  postProcessRgbShift: number;
  postProcessHalftone: number;
  /** Vignette strength, 0..2 (2 = double the base darkening). */
  postProcessVignette: number;
  /** Radial lens curvature amount, 0..2. */
  postProcessLensDistortion: number;
  /** Radial chromatic dispersion amount, 0..1. */
  postProcessLensDispersion: number;
}

/**
 * R49（第三期）：十四行诗的默认参数，21 个字段逐字取自上游 types.ts:560-581。
 * 与 R46 同一原因：第一期裁薄 types.ts 只留接口没留默认值，宿主不渲染调参面板时模式吃这份默认。
 */
export const DEFAULT_SONNET_TUNING: SonnetTuning = {
  cameraIntensity: 1,
  typographyMotion: 1,
  mgDensity: 1,
  showOnlyText: false,
  showGuide: true,
  showBackgroundMg: true,
  showFixedGeo: true,
  showGiantDecorativeText: true,
  showBackgroundDecor: true,
  enableTransitions: true,
  outerFrameMode: 'full',
  textureResolution: 1.5,
  postProcessEnabled: false,
  postProcessGrain: 0.2,
  postProcessContrast: 0,
  postProcessRgbShift: 0,
  postProcessHalftone: 0,
  postProcessVignette: 0.85,
  postProcessLensDistortion: 0.3,
  postProcessLensDispersion: 0.6,
};

export interface TemperaTuning {
  cameraIntensity: number;
  /** Per-glyph entrance motion strength, 0..2. */
  glyphMotion: number;
  /** Keep each source lyric line in one shot instead of slicing it into half-phrases. */
  wholeLineLyrics: boolean;
  /**
   * 逐字入场时序, 0..1. How much of the way to the shot's lyric end each glyph's entrance
   * stretches, past its 0.34s floor. 0 gives every glyph the same short window - percussive,
   * and the shot is fully at rest well before it cuts. 1 lands the whole shot exactly on its
   * lyric end - continuous, but nothing is ever still. See temperaLayout for the measurements.
   */
  glyphSettleStretch: number;
  /** duo derives blocks from theme hues; mono collapses to a grayscale ink/paper ladder. */
  colorMode: TemperaColorMode;
  showBlocks: boolean;
  showDecor: boolean;
  /** 边角线框: the two registration marks in the top-left and bottom-right corners. */
  showCornerMarks: boolean;
  /**
   * 文字动态反色: the lyric samples the artwork under it and picks whichever of ink/paper
   * contrasts more, per pixel. This is how the mode colours type, not a post-process, so it
   * has its own switch rather than riding `postProcessEnabled`.
   */
  textInversion: boolean;
  /** Pool of user images; each shot picks one. The files themselves live in IndexedDB. */
  layerImages: TemperaLayerImage[];
  /** `back` lets the lyric invert against the picture; `front` puts it over the lyric. */
  layerImageDepth: 'back' | 'front';
  /** 0..1 chance that a given shot shows an image at all. */
  layerImageFrequency: number;
  enableTransitions: boolean;
  textureResolution: number;
  /** Master switch for the scene-wide post-process stack (grain + contrast + print passes). */
  postProcessEnabled: boolean;
  /**
   * 后处理纹理压缩: renders the post-process pass at 1x and stretches it onto the canvas
   * instead of running it at `textureResolution`. Costs sharpness on hatch, screentone and
   * type; buys back the fill rate a full-resolution full-screen pass costs.
   */
  postProcessTextureCompression: boolean;
  /** Film grain amount, 0..1. */
  postProcessGrain: number;
  /** Contrast boost, 0..1. */
  postProcessContrast: number;
  /** RGB shift pass strength, 0..1 (0 disables the pass). */
  postProcessRgbShift: number;
  /** Vignette strength, 0..2 (2 = double the base darkening). */
  postProcessVignette: number;
  /** Radial lens curvature amount, 0..2. */
  postProcessLensDistortion: number;
}

export interface TiltTuning {
  splitProbability: number;
  tiltStyleProbability: number;
  colorScheme?: TiltColorScheme;
}

/** R171（第十四批·档二 tilt）：声明与数值逐字摘自上游 types.ts 里紧接 TiltTuning 的那一段。 */
export const DEFAULT_TILT_TUNING: TiltTuning = {
  splitProbability: 0.75,
  tiltStyleProbability: 0.35,
  colorScheme: 'default',
};

/** R11b 宿主最小 Song：只保留渲染与队列需要的字段；在线字段第四期按需补回并登记。 */
export interface SongResult {
  id: string;
  name: string;
  artists: { id?: string; name: string; entityId?: string }[];
  album: { id?: string; name: string; coverUrl?: string; entityId?: string } | null;
  /**
   * 曲目**自己**那张封面（看板 95fe081 跳③，宿主 R11b 重写里新增的字段）。
   * 在线曲目没有本地专辑分组（`album` 为 null），但服务端已把它的封面代理成同源地址；
   * 封面墙是队列可视化，一张卡=一首队列条目 ⇒ 缺这个字段就是"歌单播放时封面墙没有封面"。
   * 只可能是同源 `/api/online/artwork/<token>`，第三方那条 URL 从不出服务端（与 audioUrl 同一条红线）。
   */
  coverUrl?: string;
  durationMs: number;
  isPureMusic?: boolean;
  sourceType?: 'netease' | 'cloud';
  t?: 0 | 1 | 2;
  sourceRef?: PlaybackSourceRef;
  replayGain?: ReplayGainInfo;
}

export interface UnifiedSong extends SongResult {
  isLocal?: boolean;
  /**
   * R162：这两个字段本产品**永远不填**（没有 Navidrome 服务器）。
   * 加它们只为让三个移植件（gridTrackNavigation / PolaroidCard / polaroidCardParts）
   * 保持与上游逐字一致——上游的 Pick<UnifiedSong, 'isNavidrome' | 'navidromeData'> 需要键存在。
   * 逐字移植优先于"类型里少两个没用的字段"，改移植件要多登记三处白名单。
   */
  isNavidrome?: boolean;
  navidromeData?: unknown;
}

/**
 * R162 音乐人网格的**宿主喂料形状**（替代上游那三条取数支路的产出）。
 * 三条纪律写在这里，是因为它们都是红线而不是实现细节：
 * - `cover` / `songs[].coverUrl` / `albums[].coverUrl` 只可能是同源地址
 *   （`/api/artwork/<id>` 或 `/api/online/artwork/<token>`）——第三方那条 URL 不出服务端；
 * - `description` 由宿主拼好（在线组说"来自本机哪几张歌单的已匹配条目"、本地说"曲库里 N 首 M 张"），
 *   岛内不许自己编一位音乐人的简介——我们没有平台侧的编辑文案，编出来就是假资料；
 * - 对象身份只在"新开一次网格 / 数据真的变了"时更换（宿主那侧的断言钉着）。
 */
export interface ArtistGridFeed {
  /** 这一组的唯一键（在线组 = 服务端给的 slug，本地 = 歌手名规范化）；也决定网格的导航恢复键。 */
  id: string;
  name: string;
  cover?: string;
  description: string;
  aliases?: string[];
  trackCount: number;
  albumCount: number;
  /** 热门曲目：网格只取前 10 格（与上游同一档），地址由服务端签好的那条走。 */
  songs: SongResult[];
  /** 专辑卡：`publishedAt` 是毫秒时间戳，本产品没有这个读数就留空（卡片那一行自然不显示年份）。 */
  albums: { id: string; name: string; coverUrl?: string; publishedAt?: number }[];
}
export interface LatentBackgroundTuning {
  displayMode: LatentBackgroundDisplayMode;
  colorSource: LatentBackgroundColorSource;
  dynamicOnlyInPlayer: boolean;
  enhancedBeatResponse: boolean;
  ditheringSpeed: number;
  ditheringAudioSpeed: number;
  ditheringSize: number;
  ditheringOpacity: number;
  meshSpeed: number;
  meshAudioSpeed: number;
  meshDistortion: number;
  meshSwirl: number;
  overlayEnabled: boolean;
  overlayOpacity: number;
}

export interface MonetBackgroundImage {
  id: string;
  name: string;
  url: string;
}

export interface MonetBackgroundTuning {
  backgroundSource: MonetBackgroundSource;
  backgroundLayout: MonetBackgroundLayout;
  backgroundBlurPx: number;
  backgroundOverlayOpacity: number;
  backgroundGrayscale: number;
  backgroundSaturation: number;
  backgroundWash: number;
  backgroundHalfPaneOffsetX: number;
  backgroundWashColorMode: MonetBackgroundWashColorMode;
  backgroundWashCustomColor: string;
  /** 整张背景图的缓慢缩放漂移；纯 CSS 合成层动画，不参与背景烘焙。 */
  backgroundDriftEnabled: boolean;
  /** 漂移幅度 0..1，同时决定位移距离和为防止露边而预放大的倍率。 */
  backgroundDriftStrength: number;
  /** 是否在烘焙的 overlay 里绘制那几条 1px 竖向纹理。 */
  backgroundStreaksEnabled: boolean;
}

export interface NomandBackgroundTuning {
  imageSource: NomandBackgroundSource;
  effect: NomandBackgroundEffect;
  ditheringType: NomandBackgroundDitheringType;
  size: number;
  colorSteps: number;
  originalColors: boolean;
  inverted: boolean;
  flutedGlassSize: number;
  flutedGlassDistortion: number;
  flutedGlassBlur: number;
  paperTextureContrast: number;
  paperTextureRoughness: number;
  paperTextureFiber: number;
  halftoneDotsSize: number;
  halftoneDotsRadius: number;
  halftoneDotsContrast: number;
  halftoneDotsOriginalColors: boolean;
  halftoneDotsInverted: boolean;
  lensDistortionSpread: number;
  lensDistortionBulge: number;
  lensDistortionDispersion: number;
  overlayEnabled: boolean;
  overlayOpacity: number;
}

export interface SoraBackgroundTuning {
  /** Skips the WebGL starfield and shows a static solid black (night) / white (daylight) frame. */
  blank: boolean;
}

export interface UrlBackgroundItem {
  id: string;
  url: string;
  note: string;
}

export type CappellaEmojiPackSource = 'builtin' | 'custom';

export type CappellaAvatarSource = 'cover' | 'builtin' | 'color' | 'custom';

export interface DioramaGeometryVisibility {
  /** Parent switch: hides the whole point-cloud layer without discarding child preferences. */
  enabled: boolean;
  /**
   * 'clouds' = per-lyric point-cloud formations (the family switches below apply).
   * 'corridor' = one always-on point tunnel threaded along the flight path (families ignored).
   * The two never render together - picking one replaces the other.
   */
  mode: DioramaGeometryMode;
  /** Point-cloud cubes used by architectural formations. */
  strands: boolean;
  /** Open cylindrical point-cloud shells. */
  blobs: boolean;
  /** Triangular tetrahedron point-cloud crystals. */
  ribbons: boolean;
  /** Circular point-cloud loops. */
  rings: boolean;
}

export type LumiereRenderQuality = 'full' | 'balanced' | 'low';

export type MonetAudioStyle = 'bar' | 'line';

export type MonetPortraitSource = 'cover' | 'custom';

export type SonnetOuterFrameMode = 'none' | 'frame' | 'full';

export type TemperaColorMode = 'duo' | 'mono' | 'gradient';

/** Where an image tends to sit; the exact spot is picked per shot from the seed. */

export type LatentBackgroundDisplayMode = 'dithering' | 'mesh' | 'both';

export type LatentBackgroundColorSource = 'cover-theme' | 'cover-only';

export type MonetBackgroundSource = 'cover-derived' | 'uploaded-global';

export type MonetBackgroundLayout = 'full-overlay' | 'half-pane-gradient';

export type MonetBackgroundWashColorMode = 'theme' | 'custom';

export type NomandBackgroundSource = 'cover-derived' | 'uploaded-global';

export type NomandBackgroundEffect = 'dithering' | 'fluted-glass' | 'paper-texture' | 'halftone-dots' | 'lens-distortion';

export type NomandBackgroundDitheringType = '2x2' | '4x4' | '8x8';

export type TemperaLayerImageAlign = 'left' | 'center' | 'right' | 'free';

/** Vertical counterpart to `TemperaLayerImageAlign`; `free` lets each shot choose a band. */

export type TemperaLayerImageVerticalAlign = 'top' | 'center' | 'bottom' | 'free';

/**
 * One image in the user's Tempera pool - character art, a logo, a texture. Each shot picks one
 * of them and places it itself, so an image carries a *tendency* rather than coordinates:
 * hand-placing every picture would defeat the point of a pool. The file itself sits in
 * IndexedDB under the same `id`, keeping the tuning small enough to sync.
 */

export type TiltColorScheme = 'default' | 'swap' | 'accentAll' | 'primaryAll';

export type DioramaGeometryMode = 'clouds' | 'corridor';
export type VisualizerMode = BuiltinVisualizerMode | (string & {});

export type VisualizerFrameRate = 'off' | 120 | 90 | 60;

export interface TemperaLayerImage {
  id: string;
  name: string;
  align: TemperaLayerImageAlign;
  verticalAlign: TemperaLayerImageVerticalAlign;
  /** Height as a fraction of the viewport height; width follows the source aspect. */
  scale: number;
  opacity: number;
}

/**
 * R52（第三期）：tempera 的三个常量逐字取自上游 types.ts:611-619 与 674-696。
 * 与 R46/R49 同一原因（第一期裁薄时只留了接口）。`layerImages: []` 与 R44 的图片池 stub 一致：
 * 本产品没有自定义图层，tempera 只用内置 composition。
 */
export const TEMPERA_MAX_LAYER_IMAGES = 16;

export const DEFAULT_TEMPERA_LAYER_IMAGE: Omit<TemperaLayerImage, 'id' | 'name'> = {
  align: 'free',
  verticalAlign: 'bottom',
  scale: 0.7,
  opacity: 1,
};

export const DEFAULT_TEMPERA_TUNING: TemperaTuning = {
  cameraIntensity: 1,
  glyphMotion: 1,
  wholeLineLyrics: false,
  glyphSettleStretch: 0.5,
  colorMode: 'duo',
  showBlocks: true,
  showDecor: true,
  showCornerMarks: true,
  textInversion: true,
  layerImages: [],
  layerImageDepth: 'back',
  layerImageFrequency: 0.6,
  enableTransitions: true,
  textureResolution: 1.5,
  postProcessEnabled: true,
  postProcessTextureCompression: false,
  postProcessGrain: 0.2,
  postProcessContrast: 0,
  postProcessRgbShift: 0,
  postProcessVignette: 0.85,
  postProcessLensDistortion: 0.3,
};
export type BuiltinVisualizerMode = 'classic' | 'cadenza' | 'partita' | 'fume' | 'monet';
