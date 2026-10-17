import type { MusicPlayer } from "./music-player";

/**
 * 无歌词曲目的四档：关 / 基础循环 / 音符跟音频 / 频谱条。
 * 后两档都吃真实电平，共用同一张 analyser 与同一套 dB 域映射（`createBandReader`），
 * 区别只在"几格、每格多宽、画成音符还是画成条"。
 */
export type LyricPulseTier = "off" | "basic" | "audio" | "spectrum";
/** 需要真实电平的两档（降级、减弱动效、可用性判据都按这一组判，不在三处各写一遍）。 */
export const AUDIO_DRIVEN_TIERS: readonly LyricPulseTier[] = ["audio", "spectrum"];

/** 音符字形按宽度错落排开，跳动时读起来像一排均衡器。用转义写死，避免源码编码丢字。 */
const NOTE_GLYPHS = ["♩", "♪", "♫", "♬", "♪", "♩"] as const;

/**
 * 六颗音符各绑一条频段（Hz，不是 bin 序号）。
 * 为什么按 Hz 再换算：一格 bin 的宽度 = 采样率 ÷ fftSize（本机 44.1kHz / 512 ⇒ 约 86Hz 一格），
 * 写死 bin 区间的话，换 fftSize 或换采样率就整体错位；按 Hz 算则永远落在听得见的地方。
 * 低段分得细、高段分得粗，与音乐能量的分布一致（贝斯 / 低中 / 中 / 上中 / 临场 / 空气）。
 */
const NOTE_BAND_HZ: readonly [number, number][] = [
  [20, 250],
  [250, 700],
  [700, 1500],
  [1500, 3000],
  [3000, 7000],
  [7000, 22050],
];
/**
 * 每条频段的固定补偿（dB）。依据 = 真机一手实测（本机曲库一首连续 481 帧，每段取均值）：
 * 20–250Hz 中位 −31.2dB、250–700 −35.4、700–1500 −47.5、1500–3000 −62.9、3000–7000 −76.7、7000 以上 −101.4。
 * 频谱天然向低音倾斜：不补偿的话窗口只装得下第一条，其余五颗永远贴地不动。
 * 补偿把六段的中位都对齐到约 −31dB（换录音不必改这张表：显示基准另有一条慢跟的自适应）。
 */
const BAND_TRIM_DB: readonly number[] = [0, 4, 16, 32, 46, 70];
/**
 * 每条频段的显示窗口宽度（dB）。同一次实测里各段 p10~p90 的跨度是 10.5 / 17.0 / 20.3 / 28.8 / 44.7 / 36.2：
 * 厚段（250–700Hz，内容密集）读数很稳，薄段（7kHz 以上，本来没什么内容）读数天然大幅漂。
 * 用同一个宽度去量六段的结果实测过：两颗狂跳（0.09~0.95）、四颗发抖（0.17~0.36），
 * 像一排坏掉的均衡器而不是一排在跳舞 —— 所以宽度按各自的跨度给。
 */
const BAND_SPAN_DB: readonly number[] = [17, 11, 21, 29, 45, 36];
/**
 * 显示基准的跟踪速度（每帧向当前读数靠拢的比例）：约 1.9 秒走完一半。
 * 必须**慢**：这是整条链里唯一"跟着信号走"的东西，它负责吸收录音响度与曲目差异
 * （同一张表服务 −6dB 的母带和 −20dB 的现场录音），
 * 而节拍是 0.3~0.6 秒的事——快了就把拍子一起抹平（前一案用"瞬时涨、慢慢落"的峰值保持，
 * 真机实测六段只剩 0.67~0.78、位移中位数与最大值只差 0.6 像素，就是快了的后果）。
 */
const CENTER_TRACKING = 0.006;
/**
 * 噪声底（dB，已过补偿）：比它还低就按静音处理——不显示、也不要把该段的基准拖下去。
 * 定在 −70 的余量是实测出来的：真机八秒里最安静的真实帧是 −51.7dB，
 * 而数字静音的读数在 −100dB 以下（甚至 −Infinity），中间这条线两头都够不着。
 */
const FLOOR_DB = -70;
/** 暂停、降级、off 档共用的"六段全零"——apply 要连每颗的 --l 一起归零，不能只清总电平。 */
const SILENT_BANDS: readonly number[] = NOTE_BAND_HZ.map(() => 0);

/**
 * 频谱条：16 根、每根**半个倍频程**（60Hz 起、公比 √2 ⇒ 60·2^8 = 15360Hz，最后一根收到奈奎斯特）。
 * 为什么半倍频程而不是等分 Hz：音乐内容的宽带感是对数的，等分 Hz 会把低段全挤进第一格。
 * 为什么从 60Hz 起：fftSize=512 @44.1kHz 一格约 86Hz，比这更窄的区间没有格子可分——
 * 前两根会读到同一格数据，看起来像"两根永远一起动"的坏条（实测里这条判据叫 identicalBars）。
 */
const SPECTRUM_BAND_HZ: readonly [number, number][] = Array.from({ length: 16 }, (unused, index) => [
  Math.round(60 * Math.SQRT2 ** index),
  index === 15 ? 22050 : Math.round(60 * Math.SQRT2 ** (index + 1)),
] as [number, number]);
/**
 * 频谱档那 16 条的补偿与窗口宽度：**2026-10-09 真机一手实测**，不是从上面六条插值来的。
 *
 * 第一版确实是插值出来的（把六条实测曲线按 log 频率插到 16 个中心频率上），实测一量就发现不对：
 * 低四根偏 24~31dB、最高两根偏 −9~+20dB。原因写在下面两条里，都是量出来才知道的：
 *   · 低频端：六条表里 20–250Hz 是**一整条宽频段**（平均掉 bin0~bin2），而 16 条把这一段切成四根，
 *     bin0 单独一读比那一段的均值低 20 多 dB —— 宽段的实测中位不代表窄段的；
 *   · 高频端：10.8kHz 以上在普通录音里就是数字近静音（实测 pre-trim 中位约 −127dB），
 *     把它"对齐到 −31"等于把 FFT 的数值噪声放大成画面 —— 所以最后一根的补偿**故意停在噪声底之下**，
 *     让它平时贴地、真有空气感/镲片时才跳（与 R124 "薄段读数天然大幅漂"同一个教训，处置从"给宽窗口"
 *     换成"让噪声底去挡"，因为这里挡的是数值噪声而不是音乐内容）。
 *
 * 量法：临时实例 + 临时数据目录，无词态曲目（《Your Eyes》）三段各 480 帧 @60.1fps，
 * 每根取 rawBars（已加补偿的 dB）的中位与 p10~p90 跨度；补偿 = 现值 + (−31 − 实测中位)。
 * 原始 JSON 在跑测当时位于 `D:\tag-tools\spectrum\result-raw.json`（一次性工具，收口删除，数值抄在这里）。
 */
const SPECTRUM_TRIM_DB: readonly number[] = [24, 21, 18, 16, 15, 17, 19, 21, 24, 27, 30, 34, 46, 47, 54, 54];
/**
 * 窗口宽度 = 实测 p10~p90 跨度 × 1.5（实测跨度是 11.3 / 9.8 / 9.6 / 8 / 7.1 / 9.5 / 13.2 / 15 /
 * 13.4 / 11.1 / 11.6 / 12.5 / 12.5 / 13.9 / 17.3 / 18.8 dB）。
 * 为什么不能直接用实测跨度：电平是 `(读数 − 慢跟基准) / 跨度 + 0.5`，而 p10~p90 之外**本来就有 20%** 的帧——
 * 拿它当满行程，算术上就注定约 10% 顶格 + 10% 贴地（第一版实测到 17~26% 顶格，正是这个数）。
 * 放宽 1.5 倍之后顶格率回到个位数，而逐帧变化率仍在 0.6 以上（行程没被压平）。
 * 下限 11：再窄就把一格的量化抖动放大成整根在闪。
 */
const SPECTRUM_SPAN_DB: readonly number[] = [17, 15, 14, 12, 11, 14, 20, 22, 20, 17, 17, 19, 19, 21, 26, 28];

/** 一套频段 = 一份读数机器：区间（Hz）、固定补偿（dB）、窗口宽度（dB）。 */
interface BandSpec {
  hz: readonly [number, number][];
  trim: readonly number[];
  span: readonly number[];
}
const NOTE_BANDS: BandSpec = { hz: NOTE_BAND_HZ, trim: BAND_TRIM_DB, span: BAND_SPAN_DB };
const SPECTRUM_BANDS: BandSpec = { hz: SPECTRUM_BAND_HZ, trim: SPECTRUM_TRIM_DB, span: SPECTRUM_SPAN_DB };

/**
 * 频段读数机器（六颗音符与 16 根条共用同一段代码，只是喂不同的表）。
 * 抽出来是为了**不另起一套映射**：dB 域、固定补偿、噪声底、慢跟基准、按跨度铺行程这一条链
 * 两档必须走同一路径，否则改了一处忘了另一处就是"两套可视化"。
 */
function createBandReader(spec: BandSpec) {
  const center: number[] = spec.hz.map(() => 0);
  /** 基准有没有用真实读数播过种：第一条真实读数直接落定，不从 0dB 一路爬下来（爬的几秒整排是平的）。 */
  const seeded: boolean[] = spec.hz.map(() => false);
  /** 原始读数（dB，已加固定补偿，未过噪声底/基准）：只给实测回读用，用来判断窗口装不装得下这首曲子。 */
  const raw: number[] = [];
  const out: number[] = spec.hz.map(() => 0);

  function read(dbBins: Float32Array, binHz: number, binCount: number): number[] {
    raw.length = 0;
    for (const [index, [lowHz, highHz]] of spec.hz.entries()) {
      // binHz 读不到（图谱还没建好）时退回按格数等比切，保证每格都有东西可跟、不会全零。
      const from = binHz > 0 ? Math.floor(lowHz / binHz) : Math.floor((index * binCount) / spec.hz.length);
      const to = Math.max(
        from + 1,
        binHz > 0 ? Math.min(binCount, Math.ceil(highHz / binHz)) : Math.floor(((index + 1) * binCount) / spec.hz.length),
      );
      let sum = 0;
      for (let i = from; i < to; i += 1) {
        const value = dbBins[i] ?? Number.NEGATIVE_INFINITY;
        // 静音格的 dB 读数可能是 -Infinity / NaN，直接平均会把整段拖成非有限值。
        sum += Number.isFinite(value) ? value : FLOOR_DB - 20;
      }
      const decibels = (to > from ? sum / (to - from) : FLOOR_DB - 20) + (spec.trim[index] ?? 0);
      raw.push(decibels);
      // 低于噪声底 = 这段没有声音：不动，也不让基准跟着掉下去（否则安静一会儿回来要先爬好几秒）。
      if (decibels <= FLOOR_DB) {
        out[index] = 0;
        continue;
      }
      if (!seeded[index]) {
        center[index] = decibels;
        seeded[index] = true;
      } else {
        center[index] += (decibels - center[index]) * CENTER_TRACKING;
      }
      const span = spec.span[index] ?? 16;
      // 基准 = 行程中点；偏离基准半个窗口宽 = 走到头。限幅而不是取对数：越界只会是瞬态，压住它不影响其余帧。
      out[index] = Math.max(0, Math.min(1, (decibels - center[index]) / span + 0.5));
    }
    return out;
  }

  return {
    count: spec.hz.length,
    read,
    raw,
    zeros: (): number[] => spec.hz.map(() => 0),
    reset(): void {
      for (let i = 0; i < center.length; i += 1) {
        center[i] = 0;
        seeded[i] = false;
      }
    },
  };
}

export interface NotePulseOptions {
  root: HTMLElement;
  player: MusicPlayer;
  tier: () => LyricPulseTier;
  reduced: () => boolean;
}

export interface NotePulseState {
  /** 实际生效的档位：请求 audio/spectrum 但不可用时会自动降为 basic。 */
  effective: LyricPulseTier;
  /** 降级原因；未降级时为 undefined。进阶档的风险实测就读这里。 */
  fallbackReason?: string;
  level: number;
  sourceCount: number;
  contextState: string;
  /** 六颗音符各自跟的频段电平（0~1，过噪声底与各自基准窗口之后）。 */
  bands: readonly number[];
  /** 与 bands 同序的原始读数：该段平均能量（dB，已加固定补偿，未过噪声底与基准）。 */
  rawBands: readonly number[];
  /** 16 根频谱条各自的电平（0~1），与 bands 走**同一个** readBands 调用、同一套机器。
   *  （不叫 `spectrum`：那个名字在本模块已经是"给岛信号层的那份 byte 数组"，一词不装两义。） */
  bars: readonly number[];
  /** 与 bars 同序的原始读数（dB，已加固定补偿）：实测回读用。 */
  rawBars: readonly number[];
}

/**
 * 无歌词曲目的动画：六颗音符跟音频（audio 档）或 16 根频谱条（spectrum 档）。
 *
 * 两个进阶档用 Web Audio 的 AnalyserNode 取真实电平，这里有三个必须守住的约束：
 *  ① 同一个 <audio> 元素只能 createMediaElementSource 一次，第二次直接抛错，
 *     所以按元素 WeakMap 缓存，换曲目就换新节点并断开旧的；
 *  ② 一旦接进图谱，声音就走图谱了，必须连到 destination，否则整首曲子静音；
 *  ③ byte 数组（getByteFrequencyData）是按 −100~−30dB 硬缩放并截断的，音乐的低段常年高于 −30dB
 *     ⇒ 真机实测六段里有 5.9% 的读数直接顶到 255，低音那颗"永远满格"。跳动读的是同一张谱的
 *     float 数组（getFloatFrequencyData，未截断的 dB），byte 数组原样留着给 Folia 岛信号层（R19）。
 *
 * 频谱档**不新建第二张 analyser、不新建第二条 rAF 循环**：同一个 analyser、同一个 tick，
 * 只是把"六条频段"换成"16 条频段"、把字形换成条。
 */
export function createNotePulse(options: NotePulseOptions) {
  const { root, player, tier, reduced } = options;
  const notes: HTMLElement[] = [];
  const bars: HTMLElement[] = [];
  const sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let bins: Uint8Array | null = null;
  /** 同一张谱的 dB 读数（跳动与频谱条都用它，byte 数组留给岛）。 */
  let dbBins: Float32Array | null = null;
  let activeSource: MediaElementAudioSourceNode | null = null;
  let activeElement: HTMLAudioElement | null = null;
  let effective: LyricPulseTier = "off";
  let fallbackReason: string | undefined;
  let level = 0;
  let silentFrames = 0;
  let silenceDegraded = false;
  let retryCooldown = 0;

  const host = document.createElement("div");
  host.className = "note-pulse";
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", "这首曲目没有歌词");
  for (const glyph of NOTE_GLYPHS) {
    const note = document.createElement("span");
    note.className = "note-pulse__note";
    note.textContent = glyph;
    host.appendChild(note);
    notes.push(note);
  }
  // 频谱条与音符同一层：哪一套显示由 `[data-tier]` 那条 CSS 决定（切换档位不需要重建 DOM，
  // 也就不出现"两套元素各自记自己那份电平"的可能）。
  for (let index = 0; index < SPECTRUM_BANDS.hz.length; index += 1) {
    const bar = document.createElement("span");
    bar.className = "note-pulse__bar";
    bar.style.setProperty("--i", String(index));
    host.appendChild(bar);
    bars.push(bar);
  }
  const srText = document.createElement("span");
  srText.className = "visually-hidden";
  srText.textContent = "这首曲目没有歌词";
  host.appendChild(srText);

  /** 只有浏览器真有 Web Audio 且拿到非零电平才算进阶档可用。 */
  function ensureGraph(element: HTMLAudioElement): boolean {
    if (typeof AudioContext === "undefined") {
      fallbackReason = "浏览器不支持 Web Audio";
      return false;
    }
    try {
      if (!context) {
        context = new AudioContext();
        analyser = context.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        bins = new Uint8Array(analyser.frequencyBinCount);
        dbBins = new Float32Array(analyser.frequencyBinCount);
        // analyser 只做分接，主链路仍然是 source → destination。
        analyser.connect(context.destination);
      }
      let source = sources.get(element);
      if (!source) {
        source = context.createMediaElementSource(element);
        sources.set(element, source);
      }
      if (activeSource && activeSource !== source) activeSource.disconnect();
      if (activeElement !== element) {
        source.connect(analyser!);
        activeSource = source;
        activeElement = element;
      }
      return true;
    } catch (error) {
      fallbackReason = `音频图谱建立失败：${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  /** 两套频段各一台读数机器：音符六条、频谱 16 条。同一帧只跑当前档要的那一台（见 tick）。 */
  const noteReader = createBandReader(NOTE_BANDS);
  const barReader = createBandReader(SPECTRUM_BANDS);

  /** 最近一次读到的电平（tick 每帧写、state 回读用；不在别处再算第二遍）。 */
  let lastBands: readonly number[] = SILENT_BANDS;
  let lastBars: readonly number[] = barReader.zeros();

  /**
   * 读一次谱，喂给当前档要的那台读数机器。
   * 每条频段各读一个电平：段内均值（dB）→ **固定补偿** → **噪声底** → **各自慢跟的基准** → 按各自窗口宽度铺满行程。
   *
   * 为什么不能像从前那样"全频段平均 ÷ 160"：fftSize=512 有 256 格，而音乐能量几乎全在前十几格，
   * 剩下两百多格接近零把平均数拖没 ⇒ 典型流行乐读出来 0.05~0.15，再乘 -0.5em 的位移就是 2~3 像素，
   * 肉眼看不见（用户报"动画太弱"的那一条）。
   *
   * 为什么在 dB 域里做、也不再开方：dB 本身已是对数（等比感知）量，线性铺一次就是感知上均匀的行程；
   * 再开一次方等于把压缩做两遍，会把中段整体抬到顶上。看板那条"改成自适应增益 + 噪声底 + 开方"
   * 的处方在这里按实测改道，保留的是它真正想要的三件事：噪声底、自适应、每格各跟一条频段。
   *
   * `want` 决定这一帧算哪一套：两档共用同一张 analyser、同一次 getFloatFrequencyData，
   * 不各读一次谱（同一帧读两遍会拿到两份不一致的瞬时值，两档的"复用同一机制"就名存实亡）。
   */
  function readBands(want: "notes" | "bars"): { bands: number[]; raw: number[] } {
    const reader = want === "bars" ? barReader : noteReader;
    if (!analyser || !bins || !dbBins) {
      const zeros = reader.zeros();
      if (want === "bars") lastBars = zeros; else lastBands = zeros;
      return { bands: zeros, raw: [] };
    }
    // byte 数组每帧照样填：Folia 岛信号层（R19）读的是它，跳动改读 float 不能把它饿掉。
    analyser.getByteFrequencyData(bins as Uint8Array<ArrayBuffer>);
    analyser.getFloatFrequencyData(dbBins as Float32Array<ArrayBuffer>);
    const binHz = context && analyser.fftSize > 0 ? context.sampleRate / analyser.fftSize : 0;
    const bands = reader.read(dbBins, binHz, bins.length);
    if (want === "bars") lastBars = bands.slice(); else lastBands = bands.slice();
    return { bands, raw: reader.raw.slice() };
  }

  /** 总电平 = 各频段的最大值：静音保护与 `--pulse-level`（整排透明度/光晕）都读它。 */
  function topOf(bands: readonly number[]): number {
    return bands.reduce((max, value) => (value > max ? value : max), 0);
  }

  /**
   * 把这一档读到的电平写进 DOM。`bands` 是"当前档的那一套"（audio 档 6 条、spectrum 档 16 条），
   * 两档各吃自己那条频段而不是共用总电平：整排共用一个数时永远同步起伏，看着像一张纸在抖。
   */
  function apply(value: number, bands: readonly number[]) {
    level = value;
    root.style.setProperty("--pulse-level", value.toFixed(3));
    if (effective === "spectrum") {
      for (const [index, bar] of bars.entries()) bar.style.setProperty("--l", (bands[index] ?? 0).toFixed(3));
    } else {
      for (const [index, note] of notes.entries()) note.style.setProperty("--l", (bands[index] ?? 0).toFixed(3));
    }
  }

  /** 暂停不是故障：读不到电平只该在"正在播放"时算失败，恢复播放要能自动回到进阶档。 */
  function degradeToBasic(reason: string) {
    fallbackReason = reason;
    silenceDegraded = true;
    effective = "basic";
    host.dataset.tier = effective;
    host.dataset.fallback = reason;
    clearVisual();
  }

  function recoverAudio() {
    // 必须走 mount() 重建：软降级可能根本没建过音频图谱，只翻标志位会让 effective
    // 变成 audio 却永远读不到电平，接着被"静音 120 帧"保护以一个莫须有的理由再次降级。
    silenceDegraded = false;
    fallbackReason = undefined;
    delete host.dataset.fallback;
    mount();
  }

  /** 需要真实电平的两档共用一条判据（不在三处各写一遍 `=== "audio" || === "spectrum"`）。 */
  function audioDriven(value: LyricPulseTier): boolean {
    return AUDIO_DRIVEN_TIERS.includes(value);
  }

  /** 两套字形都归零：降级、off/basic 档、暂停定格都走这里——只清当前那一套的话，
   *  换档之后另一套会带着上一次的高度冒出来（暂停时按 spectrum 档尤其明显）。 */
  function clearVisual() {
    root.style.setProperty("--pulse-level", "0.000");
    level = 0;
    for (const note of notes) note.style.setProperty("--l", "0.000");
    for (const bar of bars) bar.style.setProperty("--l", "0.000");
  }

  function mount() {
    if (host.parentNode !== root) root.appendChild(host);
    const wanted = tier();
    // 「减少动态效果」的规则对两个进阶档一视同仁：它们都是"跟着音频动"的，
    // 挡掉一个挡不掉另一个就是漏。
    const requested: LyricPulseTier = reduced() && audioDriven(wanted) ? "basic" : wanted;
    if (!audioDriven(requested)) {
      effective = requested;
      host.dataset.tier = effective;
      clearVisual();
      return;
    }
    const element = player.mediaElement();
    if (!element) {
      // 还没有音频元素（刚切歌、尚未加载）属于可恢复状态，交给 tick 重试。
      silenceDegraded = true;
      effective = "basic";
      host.dataset.tier = effective;
      host.dataset.fallback = "播放元素尚未就绪";
      return;
    }
    if (!ensureGraph(element)) {
      effective = "basic";
      host.dataset.tier = effective;
      host.dataset.fallback = fallbackReason ?? "unavailable";
      return;
    }
    if (context?.state === "suspended") {
      // 自动播放策略下 AudioContext 会以 suspended 起步；resume() 需要用户手势已经发生过。
      void context.resume().catch(() => {
        fallbackReason = "AudioContext 被自动播放策略挂起";
      });
    }
    effective = requested;
    silenceDegraded = false;
    host.dataset.tier = effective;
    delete host.dataset.fallback;
  }

  /** 由同一个 requestAnimationFrame 循环驱动，不新增第二条循环。 */
  function tick() {
    const element = player.mediaElement();
    const playing = !!element && !element.paused && !element.ended;
    if (playing) host.classList.remove("is-idle");
    else {
      // 暂停与未就绪时的静音不算故障：否则用户一按暂停就永久掉出进阶档。
      silentFrames = 0;
      host.classList.add("is-idle");
      clearVisual();
    }
    if (silenceDegraded) {
      // 软降级按秒级节奏重试重建：既不逐帧 mount，也不会因为图谱当初没建成而永远回不来。
      if (!playing || retryCooldown > 0) {
        if (retryCooldown > 0) retryCooldown -= 1;
        return;
      }
      retryCooldown = 60;
      recoverAudio();
      return;
    }
    if (!audioDriven(effective) || !playing) return;
    if (!analyser) {
      mount();
      return;
    }
    const { bands } = readBands(effective === "spectrum" ? "bars" : "notes");
    const value = topOf(bands);
    if (value > 0.001) silentFrames = 0;
    else silentFrames += 1;
    // 连续约两秒读不到电平：图谱多半被策略挡住了，降回基础档并记下原因（两档同一条降级路径）。
    if (silentFrames > 120) {
      degradeToBasic("连续 120 帧读不到电平，已降回基础动画");
      return;
    }
    apply(value, bands);
  }

  function dispose() {
    activeSource?.disconnect();
    activeSource = null;
    activeElement = null;
    void context?.close().catch(() => undefined);
    context = null;
    analyser = null;
    bins = null;
    dbBins = null;
    noteReader.reset();
    barReader.reset();
    lastBands = SILENT_BANDS;
    lastBars = barReader.zeros();
    host.remove();
  }

  return {
    mount,
    tick,
    dispose,
    /** R19：把既有 analyser 的频谱 bins 暴露给 Folia 岛信号层；不新建 MediaElementSource。 */
    spectrum(): Uint8Array | null {
      return analyser && bins ? bins : null;
    },
    get state(): NotePulseState {
      return {
        effective,
        ...(fallbackReason ? { fallbackReason } : {}),
        level,
        sourceCount: activeSource ? 1 : 0,
        contextState: context?.state ?? "none",
        bands: [...lastBands],
        rawBands: noteReader.raw.map((value) => Math.round(value * 10000) / 10000),
        bars: [...lastBars],
        rawBars: barReader.raw.map((value) => Math.round(value * 10000) / 10000),
      };
    },
  };
}

export type NotePulse = ReturnType<typeof createNotePulse>;
