import type { MusicTrack } from "./music-types";

/**
 * 播放模式（R109 · D1）。一个字段四个值，不是两个布尔：传输区只有一个按钮，
 * 两个布尔会造出 `repeat-one + shuffle` 这种没人能解释的组合。
 * 类型放在这里（不在 JSON 契约里）：它是内核的语义，服务端与曲库快照都不认识它。
 */
export type MusicPlaybackMode = "sequential" | "repeat-all" | "repeat-one" | "shuffle";

export interface MusicPlayerState {
  transport: "idle" | "loading" | "playing" | "paused" | "error";
  currentTrack: MusicTrack | null;
  queue: readonly MusicTrack[];
  currentIndex: number;
  playbackMode: MusicPlaybackMode;
  playing: boolean;
  loading: boolean;
  duration: number;
  currentTime: number;
  volume: number;
  songFadeEnabled: boolean;
  bgmVolume: number;
  bgmEnabled: boolean;
  bgmPlaying: boolean;
  error: string | null;
  bgmError: string | null;
  /** This preview uses browser decoding; it does not imply a foobar2000 connection. */
  backend: "browser";
}

type Listener = (state: MusicPlayerState) => void;
type Transport = MusicPlayerState["transport"];
type Fade = { timer: ReturnType<typeof setTimeout>; finish: () => void };

const SONG_FADE_MS = 450;
/**
 * 播放模式的**唯一循环顺序**（R109 · D1）：传输区那一个按钮与岛内的 `toggleLoop` 共用它，
 * 两处各写一套顺序迟早会漂。非法值一律回落 `sequential`（= 今天的行为，升级当天零观感变化）。
 */
export const PLAYBACK_MODES: readonly MusicPlaybackMode[] = Object.freeze([
  "sequential",
  "repeat-all",
  "repeat-one",
  "shuffle",
]);
const unit = (value: number) => Math.max(0, Math.min(1, value));
const seconds = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;
const uniqueTracks = (tracks: readonly MusicTrack[]): MusicTrack[] => {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
};

/**
 * 一个长度为 `length` 的随机排列（Fisher–Yates，`random` 可注入 ⇒ 自检能用固定序列判定）。
 * 随机模式用的是"无重复的一轮"而不是每次独立抽（R109 · D2）：独立抽会连着播同一首，
 * 用户把它当 bug 报；通行语义是一轮之内每首恰好一次，轮空了再重洗。
 */
export function shuffleIndices(length: number, random: () => number = Math.random): number[] {
  const size = Math.max(0, Math.floor(Number(length) || 0));
  const order = Array.from({ length: size }, (_, index) => index);
  for (let index = size - 1; index > 0; index -= 1) {
    const value = Number(random());
    // 注入件坏了（NaN / 越界）也要落在合法下标里：随机模式的"不重复"不能依赖 random 自律。
    const pick = Number.isFinite(value) ? Math.min(index, Math.max(0, Math.floor(value * (index + 1)))) : 0;
    const held = order[index];
    order[index] = order[pick];
    order[pick] = held;
  }
  return order;
}

/** Music transport is independent from TerminalAudio and the Three.js scene lifecycle. */
export class MusicPlayer {
  private value: Omit<MusicPlayerState, "transport">;
  private listeners = new Set<Listener>();
  private song?: HTMLAudioElement;
  private songTrackId?: string;
  /**
   * R160（任务七）· 音频输出设备（`setSinkId`）。**空串 = 跟随系统默认**，
   * 也就是这个功能没被碰过时的行为逐字不变（与 R109 播放模式缺省 `sequential` 同一条纪律）。
   * 选中的设备由界面持久化在偏好里，播放器只持有"当前该用哪一把"，不去读 localStorage（那是第二个真相）。
   */
  private outputSinkId = "";
  /** 上一次 setSinkId 的失败原因（设备被拔掉 / 浏览器拒绝）；界面那句"已回到系统默认"要用它。 */
  private lastSinkError = "";
  private songGain = 1;
  private songFade?: Fade;
  private readonly bgm: HTMLAudioElement;
  private transport: Transport = "idle";
  private operation = 0;
  /**
   * R219：在飞的那一次 `play()`。在线曲目的第一拍要先经服务端取址（实测走回落链时可慢到 ~10 秒），
   * 这段时间里 `toggle()`（播放/暂停那颗、空格、媒体键）**必须等它**而不是把它判过期——
   * 从前的写法是 `++operation` + `pause()`，用户看到的就是"点了没反应，得再点一次"。
   */
  private inflightPlay: Promise<void> | null = null;
  private bgmOperation = 0;
  private bgmTarget = 0;
  private bgmTask: Promise<void> = Promise.resolve();
  private fade?: Fade;
  private gestureReceived = false;
  private disposed = false;
  private pendingSeek: number | null = null;
  /** 随机模式本轮还没播的下标（**不含当前这首** ⇒ 永远不会连着播两遍同一首）。 */
  private pendingShuffle: number[] = [];
  /** 当前队列的这一轮**发过签没有**：发过且抽干 = 这一轮播完了，自动续播要停（R111 · 批复①）。 */
  private shufflePassDealt = false;
  /** 这一轮已经抽干停住了。只有**用户主动**播放才会开新一轮（自动续播那条路到不了 `play()`）。 */
  private shufflePassDone = false;
  /** 走过的下标历史，只给随机模式的「上一首」用（那里 `currentIndex - 1` 没有意义）。 */
  private history: number[] = [];
  private queueSignature = "";
  private readonly random: () => number;

  constructor(
    options: {
      volume?: number;
      songFadeEnabled?: boolean;
      bgmVolume?: number;
      bgmEnabled?: boolean;
      playbackMode?: MusicPlaybackMode;
      random?: () => number;
    } = {},
  ) {
    this.random = options.random ?? (() => Math.random());
    this.value = {
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      playbackMode: PLAYBACK_MODES.includes(options.playbackMode!)
        ? options.playbackMode!
        : "sequential",
      playing: false,
      loading: false,
      duration: 0,
      currentTime: 0,
      volume: Number.isFinite(options.volume) ? unit(options.volume!) : 0.7,
      songFadeEnabled: options.songFadeEnabled ?? true,
      bgmVolume: Number.isFinite(options.bgmVolume)
        ? unit(options.bgmVolume!)
        : 0.18,
      bgmEnabled: options.bgmEnabled ?? true,
      bgmPlaying: false,
      error: null,
      bgmError: null,
      backend: "browser",
    };
    this.bgm = new Audio("/audio/atmosphere.ogg");
    this.bgm.loop = true;
    this.bgm.preload = "none";
    this.bgm.volume = 0;
    this.bgm.addEventListener("error", this.onBgmError);
    document.addEventListener("pointerdown", this.onGesture, { capture: true });
    document.addEventListener("keydown", this.onGesture, { capture: true });
    // Intentionally no visibilitychange handler: music must continue in the background.
  }

  get state(): MusicPlayerState {
    return { ...this.value, transport: this.transport, queue: [...this.value.queue] };
  }

  /**
   * Direct media clock for animation loops. Reads the element instead of the
   * emitted state so lyric timing is not limited by `timeupdate` (~4 Hz) and is
   * never suppressed while a seek is pending. Never emits and never throws.
   */
  clockTime(): number {
    const audio = this.song;
    if (!audio || this.songTrackId !== this.value.currentTrack?.id) return 0;
    return Number.isFinite(audio.currentTime) && audio.currentTime > 0
      ? audio.currentTime
      : 0;
  }

  /** The active song element, or null while switching tracks. One MediaElementSource per element. */
  mediaElement(): HTMLAudioElement | null {
    return this.song && this.songTrackId === this.value.currentTrack?.id
      ? this.song
      : null;
  }

  subscribe(listener: Listener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  setQueue(tracks: readonly MusicTrack[]): void {
    if (this.disposed) return;
    const queue = uniqueTracks(tracks);
    const id = this.value.currentTrack?.id;
    const index = queue.findIndex((track) => track.id === id);
    this.value.queue = queue;
    if (id && index === -1) {
      this.stop();
      this.value.currentTrack = null;
      this.value.duration = 0;
    } else if (index !== -1) {
      this.value.currentTrack = queue[index];
    }
    this.value.currentIndex = index;
    this.syncPassToQueue();
    this.emit();
  }

  /**
   * 给队列里**已经存在**的那一首补一张封面（R126 墙上「重取封面」）。
   * 只换 `coverUrl`：不改顺序、不改 id、不重新入队——正在播的那一首换了对象就会掉出当前淡入淡出。
   * 换的是新对象（不是原地改字段），因为下游按对象身份判"要不要重喂"（`folia-host/feed-gate`）。
   * 返回改了几条：0 = 这一首已经不在队列里，调用方要据此说实话，不能只说"封面已更新"。
   */
  applyTrackCover(id: string, coverUrl: string): number {
    if (this.disposed || !id || !coverUrl) return 0;
    let touched = 0;
    const queue = this.value.queue.map((track) => {
      if (track.id !== id || track.coverUrl === coverUrl) return track;
      touched += 1;
      return { ...track, coverUrl };
    });
    if (!touched) return 0;
    this.value.queue = queue;
    if (this.value.currentTrack?.id === id) {
      this.value.currentTrack = queue.find((track) => track.id === id) ?? this.value.currentTrack;
    }
    this.emit();
    return touched;
  }

  /**
   * 播放模式（R109）。非法值回落 `sequential`，返回值是**真正生效**的那一档
   * ——调用方（界面、岛内适配层）拿返回值更新自己那一份显示，别各自再归一一遍。
   */
  setPlaybackMode(mode: MusicPlaybackMode): MusicPlaybackMode {
    if (this.disposed) return this.value.playbackMode;
    const resolved = PLAYBACK_MODES.includes(mode) ? mode : "sequential";
    if (resolved !== this.value.playbackMode) {
      this.value.playbackMode = resolved;
      // 切进/切出随机都重发一轮：留着上一轮的半截签，切回来时会以为"这些已经播过了"。
      this.pendingShuffle = [];
      this.shufflePassDealt = false;
      this.shufflePassDone = false;
      this.emit();
    }
    return this.value.playbackMode;
  }

  /** 传输区那一个按钮的四档周期；岛内的 `toggleLoop` 是同一个动作的第二个入口，共用这张表。 */
  cyclePlaybackMode(): MusicPlaybackMode {
    const at = PLAYBACK_MODES.indexOf(this.value.playbackMode);
    return this.setPlaybackMode(PLAYBACK_MODES[(at + 1) % PLAYBACK_MODES.length]);
  }

  private syncPassToQueue(): void {
    const signature = this.value.queue.map((track) => track.id).join("\u0000");
    if (signature === this.queueSignature) return;
    this.queueSignature = signature;
    // 换队列就把本轮的签与历史一起作废：下标换了一张队列就没有意义（留着会越界或错播）。
    this.pendingShuffle = [];
    this.shufflePassDealt = false;
    this.shufflePassDone = false;
    this.history = this.value.currentIndex >= 0 ? [this.value.currentIndex] : [];
  }

  /**
   * 随机模式取下一首的下标。一轮 = "当前这首 + 其余各一次"，**抽干就停**（R111 · 批复①：
   * 四档互斥的经典语义——顺序 / 随机各管"走一遍"，单曲 / 列表循环才管重复，想不停就选列表循环）。
   * 重洗时排除当前这首 ⇒ 轮次交界处也不会连着播两遍同一首。
   */
  private drawShuffle(): number {
    const length = this.value.queue.length;
    if (!length) return -1;
    if (length === 1) return 0;
    if (!this.shufflePassDealt) {
      this.shufflePassDealt = true;
      this.shufflePassDone = false;
      this.pendingShuffle = shuffleIndices(length, this.random).filter(
        (index) => index !== this.value.currentIndex,
      );
    }
    if (!this.pendingShuffle.length) {
      // 抽干了 ⇒ 这一轮结束。标成 done 是为了让"用户主动再按播放"能开新一轮，
      // 而自动续播这条路上面会拿到 -1 直接停住（批复①：随机管走一遍，不管重复）。
      this.shufflePassDone = true;
      return -1;
    }
    return this.pendingShuffle.shift()!;
  }

  private removeFromPass(index: number): void {
    const at = this.pendingShuffle.indexOf(index);
    if (at >= 0) this.pendingShuffle.splice(at, 1);
  }

  private recordHistory(index: number): void {
    if (index < 0) return;
    if (this.history[this.history.length - 1] === index) return;
    this.history.push(index);
    if (this.history.length > 64) this.history.shift();
  }

  /** 一首播完之后去哪儿（`ended` 分支唯一的判据）。`null` = 该停了，与今天一致。 */
  private autoNextIndex(): number | null {
    const { queue, currentIndex, playbackMode } = this.value;
    if (!queue.length) return null;
    if (playbackMode === "repeat-one") return currentIndex;
    if (playbackMode === "shuffle") {
      const index = this.drawShuffle();
      return index < 0 ? null : index;
    }
    const next = currentIndex + 1;
    if (next < queue.length) return next;
    return playbackMode === "repeat-all" ? 0 : null;
  }

  /**
   * 用户按「下一首」时去哪儿。**单曲循环不锁人**（D3）：那一档只约束自动续播，
   * 手动这一按照样换歌，否则用户想跳过这一首就办不到。
   */
  private manualNextIndex(): number | null {
    const { queue, currentIndex, playbackMode } = this.value;
    if (!queue.length) return null;
    if (playbackMode === "shuffle") {
      const index = this.drawShuffle();
      return index < 0 ? null : index;
    }
    const next = currentIndex + 1;
    if (next < queue.length) return next;
    return playbackMode === "repeat-all" ? 0 : null;
  }

  async play(id: string, tracks?: readonly MusicTrack[]): Promise<void> {
    // R219：把这一次起播记成"在飞的 Promise"交给 `toggle()`；真正的起播逻辑在 `playNow`（本体一字未动，只是换了私有名）。
    const run = this.playNow(id, tracks);
    this.inflightPlay = run;
    try {
      await run;
    } finally {
      if (this.inflightPlay === run) this.inflightPlay = null;
    }
  }

  private async playNow(id: string, tracks?: readonly MusicTrack[]): Promise<void> {
    if (this.disposed) return;
    const queue = tracks ? uniqueTracks(tracks) : this.value.queue;
    const index = queue.findIndex((track) => track.id === id);
    if (index === -1) {
      this.value.error = "这首歌曲已不在播放队列中，请重新选择。";
      this.emit();
      return;
    }
    const track = queue[index];
    // Updating the queue in a play request keeps cross-album switches in the same fade.
    this.value.queue = queue;
    const request = ++this.operation;
    this.cancelSongFade();
    const resume =
      this.songTrackId === id && this.song && !this.song.ended
        ? this.song
        : undefined;
    this.value.currentTrack = track;
    this.value.currentIndex = index;
    this.syncPassToQueue();
    // 上一轮随机已经抽干停住了 ⇒ 用户主动点播放/点某一首就是**开始新一轮**。
    // 自动续播那条路不会走到这个分支：它拿到 -1 就直接 stop() 了。
    if (this.shufflePassDone) {
      this.shufflePassDone = false;
      this.shufflePassDealt = false;
    }
    // 用户直接点这一首 ⇒ 把它从本轮的签里拿掉（随机那一轮不该再抽中它），并记进历史。
    this.removeFromPass(index);
    this.recordHistory(index);
    this.value.error = null;
    this.value.loading = true;
    this.transport = "loading";
    this.value.playing = !!resume && !resume.paused;
    this.value.currentTime = resume
      ? this.pendingSeek ?? seconds(resume.currentTime)
      : 0;
    this.value.duration =
      (resume ? seconds(resume.duration) : 0) || seconds(track.duration);
    if (!resume) this.pendingSeek = null;
    const unsupported = this.unsupported(track);
    if (unsupported) {
      this.fail(unsupported);
      return;
    }
    this.emit();
    if (request !== this.operation || this.disposed) return;

    if (!resume) {
      const outgoing = this.song;
      if (
        outgoing &&
        !outgoing.paused &&
        !outgoing.ended &&
        this.value.songFadeEnabled
      ) {
        await this.fadeSong(outgoing, 0);
        if (request !== this.operation || this.disposed) return;
      }
      // Release the outgoing source before the next one can start: songs never overlap.
      this.releaseSong();
    }
    const audio = this.song ?? this.createSong(track);

    // A shared transition promise keeps rapid BGM toggles from bypassing this silence gate.
    await this.reconcileBgm();
    if (request !== this.operation || this.disposed || this.song !== audio)
      return;
    try {
      await audio.play();
      if (request !== this.operation || this.disposed || this.song !== audio) {
        if (this.song !== audio || !this.expectsSong()) audio.pause();
        return;
      }
      if (!audio.paused) {
        this.transport = "playing";
        this.value.playing = true;
        this.value.loading = false;
        this.emit();
        if (request !== this.operation || this.disposed || this.song !== audio)
          return;
        if (this.value.songFadeEnabled) await this.fadeSong(audio, 1);
        else this.setSongGain(1);
      }
    } catch (error) {
      if (request !== this.operation || this.disposed || this.song !== audio)
        return;
      this.fail(this.playbackError(track, error));
    }
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (this.transport === "loading" && this.inflightPlay) {
      // R219（乙）：第一拍还在飞（在线取址实测可慢到 ~10 秒）。这段时间界面那颗键写的是「播放」
      //（`state.playing` 还是 false），用户按它的意思显然是**继续要这段播放**，不是"暂停一段还没开始的声音"。
      // 从前的写法是直接 `++this.operation` + `song.pause()` ⇒ 把在飞的第一拍判成过期、丢掉
      // ⇒ 用户看到的正是"点了没反应，必须再点一次"。现在：等它落地，落地成 playing 就让它继续播（延续），
      // 落地成失败就停在那句实话上（`fail()` 已把原因交给界面），**不自动再问一次上游**。
      await this.inflightPlay.catch(() => undefined);
      if (this.disposed) return;
      // 走 `state` 那个出口重读一次：`await` 之后运行时真的会换档，而 TS 对属性的窄化看不到这一点。
      const settled: Transport = this.state.transport;
      if (settled !== "paused") return;
    }
    if (this.transport === "loading" || this.transport === "playing") {
      ++this.operation;
      this.cancelSongFade();
      this.transport = "paused";
      this.song?.pause();
      if (this.songTrackId !== this.value.currentTrack?.id) this.releaseSong();
      else this.setSongGain(1);
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
      await this.reconcileBgm();
      return;
    }
    const track = this.value.currentTrack ?? this.value.queue[0];
    if (track) await this.play(track.id);
  }

  async next(): Promise<void> {
    if (this.disposed) return;
    const index = this.manualNextIndex();
    const track = index === null ? undefined : this.value.queue[index];
    if (track) await this.play(track.id);
    else this.stop();
  }

  async previous(): Promise<void> {
    if (this.disposed) return;
    if (this.value.currentTime > 3 && this.song) {
      this.seek(0);
      return;
    }
    // 随机模式的「上一首」只能沿历史后退：那里的 `currentIndex - 1` 是队列里的邻居，不是刚听过的那首。
    // 退一格就把当前这首从历史上划掉，于是再按一次退到**更早**的那首（不是来回跳同一对）。
    if (this.value.playbackMode === "shuffle" && this.history.length > 1) {
      this.history.pop();
      const back = this.value.queue[this.history[this.history.length - 1]];
      if (back) {
        await this.play(back.id);
        return;
      }
    }
    const track = this.value.queue[Math.max(0, this.value.currentIndex - 1)];
    if (track) {
      if (track.id === this.value.currentTrack?.id) this.seek(0);
      await this.play(track.id);
    }
  }

  seek(position: number): void {
    if (
      this.disposed ||
      !this.song ||
      this.songTrackId !== this.value.currentTrack?.id ||
      !Number.isFinite(position)
    )
      return;
    const duration = seconds(this.song.duration) || this.value.duration;
    const target = Math.max(
      0,
      duration > 0 ? Math.min(duration, position) : position,
    );
    this.pendingSeek = target;
    if (this.song.readyState >= 1) this.applySeek(this.song);
    this.value.currentTime = target;
    this.emit();
  }

  stop(): void {
    if (this.disposed) return;
    ++this.operation;
    this.transport = "idle";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.currentTime = 0;
    this.value.error = null;
    this.emit();
    void this.reconcileBgm();
  }

  setVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.volume = unit(volume);
    this.setSongGain(this.songGain);
    this.emit();
  }

  /** 当前用的输出设备（空串 = 跟随系统默认）与上一次失败原因，都给界面读。 */
  outputDeviceId(): string {
    return this.outputSinkId;
  }

  outputDeviceError(): string {
    return this.lastSinkError;
  }

  private async applySink(audio: HTMLAudioElement, deviceId: string): Promise<{ ok: boolean; reason: string }> {
    try {
      await audio.setSinkId(deviceId);
      this.lastSinkError = "";
      return { ok: true, reason: "" };
    } catch (error) {
      const reason = String((error as Error)?.name ?? (error as Error)?.message ?? error ?? "").slice(0, 120);
      this.lastSinkError = reason;
      // **不许"因为选了设备反而没声音"**：那一首退回系统默认继续播，设备选择留到下一次换曲再试。
      try {
        await audio.setSinkId("");
      } catch {
        /* 连默认都设不回去（这一档浏览器没有 setSinkId）：不再动它，声音照旧从原路出去 */
      }
      return { ok: false, reason };
    }
  }

  /**
   * R160（任务七）· 选输出设备。`deviceId` 传空串就是"跟随系统默认"。
   * 浏览器不支持这一格（Firefox / Safari）时**不改状态**并回一句实话——
   * 界面据此把那行标成"这台浏览器不支持"，而不是让一个永远不生效的下拉框留在设置里。
   */
  async setOutputDevice(deviceId: string): Promise<{ ok: boolean; supported: boolean; reason: string }> {
    const wanted = String(deviceId ?? "").trim();
    // `typeof HTMLMediaElement !== "undefined"` 不是给浏览器准备的（浏览器里它一直在），
    // 是让这一格在**没有 DOM 的环境**（自检跑的 node）里回"不支持"而不是抛 ReferenceError。
    if (typeof HTMLMediaElement === "undefined" || typeof HTMLMediaElement.prototype.setSinkId !== "function") {
      return { ok: false, supported: false, reason: "这台浏览器不支持选择音频输出设备（setSinkId）" };
    }
    this.outputSinkId = wanted;
    const audio = this.song;
    if (!audio || wanted !== "" && audio !== this.mediaElement()) {
      // 没在播 / 元素正在换：只记下，下一次 createSong 会套上；这里不当场失败
      this.lastSinkError = "";
      return { ok: true, supported: true, reason: "" };
    }
    const applied = await this.applySink(audio, wanted);
    return { ok: applied.ok, supported: true, reason: applied.reason };
  }

  setSongFadeEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.value.songFadeEnabled = enabled;
    if (!enabled) {
      this.cancelSongFade();
      // A pending switch will release the old song as soon as its fade resolves.
      if (this.songTrackId === this.value.currentTrack?.id) this.setSongGain(1);
    }
    this.emit();
  }

  setBgmVolume(volume: number): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.value.bgmVolume = unit(volume);
    this.emit();
    void this.reconcileBgm();
  }

  setBgmEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.value.bgmEnabled = enabled;
    this.value.bgmError = null;
    this.emit();
    void this.reconcileBgm();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.operation;
    ++this.bgmOperation;
    this.cancelFade();
    this.releaseSong();
    this.bgm.pause();
    this.bgm.removeEventListener("error", this.onBgmError);
    this.bgm.removeAttribute("src");
    this.bgm.load();
    document.removeEventListener("pointerdown", this.onGesture, {
      capture: true,
    });
    document.removeEventListener("keydown", this.onGesture, { capture: true });
    this.listeners.clear();
  }

  private createSong(track: MusicTrack): HTMLAudioElement {
    const audio = new Audio();
    this.song = audio;
    this.songTrackId = track.id;
    this.songGain = this.value.songFadeEnabled ? 0 : 1;
    audio.preload = "metadata";
    // 换曲会换元素 ⇒ 输出设备要跟着新元素再套一次（`setSinkId` 是每个元素各自的，不是全局的）。
    // 失败不致命：那一首回到系统默认继续播，原因留在 `lastSinkError` 里给界面说。
    if (this.outputSinkId) void this.applySink(audio, this.outputSinkId);
    this.setSongGain(this.songGain);
    const active = () =>
      !this.disposed &&
      this.song === audio &&
      this.value.currentTrack?.id === track.id;
    audio.addEventListener("loadedmetadata", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.applySeek(audio);
      this.emit();
    });
    audio.addEventListener("durationchange", () => {
      if (!active()) return;
      this.value.duration = seconds(audio.duration) || seconds(track.duration);
      this.emit();
    });
    audio.addEventListener("timeupdate", () => {
      if (!active() || this.pendingSeek !== null) return;
      this.value.currentTime = seconds(audio.currentTime);
      this.emit();
    });
    audio.addEventListener("playing", () => {
      if (!active() || audio.paused) return;
      if (this.transport !== "loading" && this.transport !== "playing") {
        audio.pause();
        return;
      }
      this.transport = "playing";
      this.value.playing = true;
      this.value.loading = false;
      this.emit();
    });
    audio.addEventListener("waiting", () => {
      if (!active() || this.transport !== "playing") return;
      this.value.loading = true;
      this.emit();
    });
    audio.addEventListener("pause", () => {
      if (!active() && this.song === audio && audio.paused) {
        this.cancelSongFade();
        return;
      }
      if (
        !active() ||
        this.transport !== "playing" ||
        audio.ended ||
        !audio.paused
      )
        return;
      ++this.operation;
      this.cancelSongFade();
      this.setSongGain(1);
      this.transport = "paused";
      this.value.playing = false;
      this.value.loading = false;
      this.emit();
    });
    audio.addEventListener("ended", () => {
      if (!active() && this.song === audio && audio.ended) {
        // The outgoing song can finish naturally during its fade-out.
        this.cancelSongFade();
        return;
      }
      if (!active() || this.transport !== "playing") return;
      this.cancelSongFade();
      this.value.playing = false;
      this.value.loading = false;
      this.value.currentTime = this.value.duration;
      // 自动续播只看这一处判据（模式的全部差别都藏在 autoNextIndex 里，不在这里再算一遍）。
      const index = this.autoNextIndex();
      const next = index === null ? undefined : this.value.queue[index];
      if (next) {
        // No idle intermediate state, so BGM never appears between songs.
        void this.play(next.id);
      } else {
        ++this.operation;
        this.transport = "idle";
        this.emit();
        void this.reconcileBgm();
      }
    });
    audio.addEventListener("error", () => {
      if (active()) this.fail(this.playbackError(track, audio.error));
      else if (this.song === audio) this.cancelSongFade();
    });
    // 远程（在线试听）曲目由服务端给一条同源的中转地址：/api/online/stream，音频字节不在本机落盘。
    // 本地曲目的 audioUrl 就是曲库算好的 /api/audio/<id>（music-library.mjs:473），所以这一行的
    // 缺省分支与改前逐字相同——本地播放路径的观察面零变化。
    audio.src = track.audioUrl ?? `/api/audio/${encodeURIComponent(track.id)}`;
    return audio;
  }

  private applySeek(audio: HTMLAudioElement): void {
    if (this.pendingSeek === null || audio.readyState < 1) return;
    const target = Math.max(
      0,
      seconds(audio.duration) > 0
        ? Math.min(audio.duration, this.pendingSeek)
        : this.pendingSeek,
    );
    try {
      audio.currentTime = target;
      this.pendingSeek = null;
      this.value.currentTime = target;
    } catch {
      // Metadata may still be arriving; retain the user's seek until it is available.
    }
  }

  private releaseSong(): void {
    this.cancelSongFade();
    const old = this.song;
    this.song = undefined;
    this.songTrackId = undefined;
    this.songGain = 1;
    this.pendingSeek = null;
    if (!old) return;
    old.pause();
    old.removeAttribute("src");
    old.load();
  }

  private setSongGain(gain: number): void {
    this.songGain = unit(gain);
    if (this.song) this.song.volume = unit(this.value.volume * this.songGain);
  }

  private fadeSong(audio: HTMLAudioElement, target: number): Promise<void> {
    this.cancelSongFade();
    if (this.song !== audio) return Promise.resolve();
    const start = this.songGain;
    if (audio.paused || audio.ended || Math.abs(start - target) < 0.001) {
      this.setSongGain(target);
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve,
      };
      const step = () => {
        if (this.songFade !== fade) return;
        const progress = Math.min(1, (performance.now() - startedAt) / SONG_FADE_MS);
        this.setSongGain(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 16);
        else {
          this.songFade = undefined;
          resolve();
        }
      };
      this.songFade = fade;
      step();
    });
  }

  private cancelSongFade(): void {
    if (!this.songFade) return;
    const fade = this.songFade;
    this.songFade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private expectsSong(): boolean {
    return this.transport === "loading" || this.transport === "playing";
  }

  private unsupported(track: MusicTrack): string | null {
    // 在线曲目先走自己的分支：它没有本地扩展名，format 是音源报的容器名（mp3 / m4a…），
    // 用下面那套"DSF/DFF 与 browserPlayable"的本地判据去问它，只会得出一个没有意义的结论——
    // 播不播得了由浏览器解码能力与 /api/online/stream 的响应说话（错误走 playbackError 那侧）。
    if (track.sourceKind === "online") return null;
    if (
      /^(DSD|DSF|DFF)$/i.test(track.format) ||
      /\.(dsf|dff)$/i.test(track.relativePath)
    ) {
      return "当前版本暂不支持 DSF / DFF（DSD）播放，请选择浏览器支持的音频文件。";
    }
    if (!track.browserPlayable)
      return `${track.format} 无法在当前浏览器中播放，请选择浏览器支持的音频文件。`;
    return null;
  }

  private playbackError(track: MusicTrack, error: unknown): string {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError")
      return "浏览器暂未允许播放，请点击播放按钮重试。";
    // 在线曲目的失败文案单独一套：这里说"检查本地服务与音乐文件"会让人去翻硬盘，
    // 而那笔失败其实来自本机与 CDN 之间的一次串流。
    if (track.sourceKind === "online") {
      const media = this.song?.error;
      if (name === "AbortError") return "在线试听被中断，请点击播放按钮重试。";
      if (media?.code === 2) return "在线试听读取失败：网络或音源暂时不可用，稍后重试即可（本地曲目的播放不受影响）。";
      return "在线试听失败：这首没有可用的在线音源（可能是版权限制，或需要登录后才能取），本地曲目照常播放。";
    }
    const media = this.song?.error;
    if (media?.code === 2)
      return "音频读取失败：请检查本地服务和音乐文件是否仍然可用。";
    if (name === "AbortError") return "歌曲播放被中断，请点击播放按钮重试。";
    if (/M4A|ALAC/i.test(`${track.format} ${track.codec ?? ""}`)) {
      return "此 M4A / ALAC 文件未能由当前浏览器解码，或文件已不可用。请检查原文件，或尝试支持该编码的浏览器。";
    }
    if (
      media?.code === 3 ||
      media?.code === 4 ||
      name === "NotSupportedError"
    ) {
      return `无法播放此 ${track.format} 文件：当前浏览器不支持它的编码，或文件已损坏、不可读取。`;
    }
    return `播放失败，请检查 ${track.format} 文件及本地音乐服务后重试。`;
  }

  private fail(message: string): void {
    ++this.operation;
    this.transport = "error";
    this.releaseSong();
    this.value.playing = false;
    this.value.loading = false;
    this.value.error = message;
    this.emit();
    void this.reconcileBgm();
  }

  private onGesture = (): void => {
    if (this.disposed) return;
    this.gestureReceived = true;
    void this.reconcileBgm();
  };

  private onBgmError = (): void => {
    if (this.disposed) return;
    ++this.bgmOperation;
    this.cancelFade();
    this.bgm.pause();
    this.bgm.volume = 0;
    this.bgmTarget = -1;
    this.value.bgmPlaying = false;
    this.value.bgmError = "氛围配乐无法加载，歌曲播放功能仍可使用。";
    this.emit();
  };

  private reconcileBgm(): Promise<void> {
    const idle = this.transport === "idle" || this.transport === "error";
    const target =
      !this.disposed && this.gestureReceived && this.value.bgmEnabled && idle
        ? this.value.bgmVolume
        : 0;
    if (target === this.bgmTarget) return this.bgmTask;
    this.bgmTarget = target;
    const request = ++this.bgmOperation;
    this.cancelFade();
    this.bgmTask = (async () => {
      if (target > 0) {
        try {
          await this.bgm.play();
          if (this.disposed || request !== this.bgmOperation) {
            if (this.disposed || this.bgmTarget <= 0) this.bgm.pause();
            return;
          }
          this.value.bgmError = null;
          this.value.bgmPlaying = true;
          this.emit();
        } catch {
          if (!this.disposed && request === this.bgmOperation) {
            this.bgmTarget = -1;
            this.value.bgmPlaying = false;
            this.value.bgmError =
              "氛围配乐暂未获准播放或无法读取，请再次点击界面重试。";
            this.emit();
          }
          return;
        }
      }
      if (this.disposed || request !== this.bgmOperation) return;
      await this.fadeBgm(target, target > 0 ? 650 : 220);
      if (this.disposed || request !== this.bgmOperation) return;
      if (target === 0) this.bgm.pause();
      this.value.bgmPlaying = target > 0 && !this.bgm.paused;
      this.emit();
    })();
    return this.bgmTask;
  }

  private fadeBgm(target: number, duration: number): Promise<void> {
    this.cancelFade();
    const start = this.bgm.volume;
    if (this.bgm.paused || Math.abs(start - target) < 0.001) {
      this.bgm.volume = target;
      return Promise.resolve();
    }
    const startedAt = performance.now();
    return new Promise((resolve) => {
      const fade: Fade = {
        timer: 0 as unknown as ReturnType<typeof setTimeout>,
        finish: resolve,
      };
      const step = () => {
        if (this.fade !== fade) return;
        const progress = Math.min(
          1,
          (performance.now() - startedAt) / duration,
        );
        this.bgm.volume = unit(start + (target - start) * progress);
        if (progress < 1) fade.timer = setTimeout(step, 24);
        else {
          this.fade = undefined;
          resolve();
        }
      };
      this.fade = fade;
      step();
    });
  }

  private cancelFade(): void {
    if (!this.fade) return;
    const fade = this.fade;
    this.fade = undefined;
    clearTimeout(fade.timer);
    fade.finish();
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("MusicPlayer state listener failed", error);
      }
    }
  }
}
