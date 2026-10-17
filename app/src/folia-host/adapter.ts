/**
 * Folia 岛适配层（自撰，非移植）：把宿主唯一播放内核的信号喂进 folia 的 store 与 MotionValue。
 * 纪律：不引入第二条 rAF（由 music-app 的 frame 循环调 tick）；不新建 MediaElementSource
 * （频谱读 lyric-pulse 既有 analyser，见台账 R19）；岛内不持有播放权。
 * 频段分带与空闲呼吸的数学逐字移植自上游 usePlaybackVisualizerBridge.ts:95-130（台账 R18）。
 */
import { usePlaybackStore } from "../folia/stores/usePlaybackStore";
import { audioBands, audioPower, currentTime, lyricCurrentTime } from "../folia/stores/motionSignals";
import { PlayerState, type LyricData, type SongResult } from "../folia/types";
import type { MusicPlaybackMode, MusicPlayer } from "../music-player";

type Pulse = { spectrum(): Uint8Array | null };

const BAND_EDGES: [number, number][] = [
  [20, 150],
  [150, 400],
  [400, 1200],
  [1000, 3500],
  [3500, 12000],
];

/** 上游 getEnergy 的 bin 映射：index = floor(hz / 21.5)。 */
const bandEnergy = (bins: Uint8Array, fromHz: number, toHz: number): number => {
  const start = Math.floor(fromHz / 21.5);
  const end = Math.floor(toHz / 21.5);
  let sum = 0;
  for (let index = start; index <= end; index += 1) sum += bins[index] ?? 0;
  const count = end - start + 1;
  return count > 0 ? sum / count : 0;
};

const process = (value: number, boost = 2): number => Math.pow(value / 255, boost) * 255;

export interface FoliaAdapterOptions {
  player: MusicPlayer;
  pulse: () => Pulse | null;
  lyricOffsetMs: () => number;
  /** R36（第二期）：封面墙的主题变量写回岛容器；由 mountFoliaIsland 注入。 */
  hostElement?: HTMLElement;
  /** R36（第二期）：岛内返回键/打开播放器要求换布局，由岛转交宿主持久化。 */
  requestLayout?: (layout: "classic" | "lattice" | "artistGrid") => void;
  /** R109：岛内那颗循环/随机按钮改了模式，转交宿主写偏好（与 `requestLayout` 同一条路子）。 */
  notifyPlaybackMode?: (mode: MusicPlaybackMode) => void;
  /** R130：收藏态由宿主持有（本机一份 JSON），岛只读不回写数据。 */
  songLiked?: () => boolean;
  /** R130：岛内那颗「喜欢」转交宿主做真正的收藏切换。 */
  toggleSongLike?: () => void;
  /** R131：命令面板的预留口子（上游 `invokeCommandById` 那一条）——宿主的面板打开并执行某条命令。 */
  invokeCommand?: (commandId: string) => void;
  /** R131：这条命令现在能不能执行（不可用的 id 岛里就不该给一个会没反应的入口）。 */
  canInvokeCommand?: (commandId: string) => boolean;
  /**
   * R162 音乐人网格的三个动作，全部只递一个 **id**：曲库、队列、在线取数都在宿主那一侧，
   * 岛拿到的 `SongResult` 只是画卡片的快照，不许它反过来当"要播的那一首"的权威
   * （与 R114 同一条口径：播的是宿主算出来的整份队列，不是卡片对象自己）。
   */
  playArtistGridTrack?: (songId: string) => void;
  playArtistGridAlbum?: (albumId: string) => void;
  addArtistGridToQueue?: (songIds: string[]) => void;
  /** R162：卡片上那颗单曲「加入播放队列」（真机第一遍点它没人接）。 */
  addArtistGridTrackToQueue?: (songId: string) => void;
}

export type FoliaAdapter = ReturnType<typeof createFoliaAdapter>;

export function createFoliaAdapter(options: FoliaAdapterOptions) {
  const store = usePlaybackStore;
  const player = options.player;
  let lastLineIndex = -1;
  let timeline: [number, number][] = [];

  const toPlayerState = (playing: boolean, paused: boolean) =>
    playing ? PlayerState.PLAYING : paused ? PlayerState.PAUSED : PlayerState.IDLE;

  /**
   * R37（第二期）登记的能力差，**2026-10-07 由 R109 补上一半**：内核有了播放模式
   * （顺序 / 列表循环 / 单曲循环 / 随机），`toggleLoop` 与 `shuffleQueue` 接到同一个内核状态上，
   * `loopMode` 改成**读的时候算**（内核那一份是唯一真源，这里再存一份迟早会漂）。
   * **R130 补上收藏那一格**：`toggleSongLike` 从空函数变成转交宿主，`isSongLiked` 改成 getter
   * （这个对象是每次挂载建一次并长期持有的，写死布尔值就永远读不到宿主的最新状态）。
   * 命令面板仍挂在候选区 ⑤ 的另一半（`invokeCommandById`），本文件下面那条注释说明它的状态。
   * 上游的形状照旧不改：`loopMode: "off" | "all" | "one"`（playerControlSlotActions.ts:11）。
   * 岛内的随机没有独立档位，映射成"off + shuffleQueue 开关"，与传输区那颗按钮共用内核的周期。
   */
  const latticeControls = {
    playback: {
      prev: () => void player.previous(),
      next: () => void player.next(),
      toggleLoop: () => {
        options.notifyPlaybackMode?.(player.cyclePlaybackMode());
      },
      shuffleQueue: () => {
        // 上游这一颗是"随机开关"，宿主那一颗是四档周期里的第三档 ⇒ 开=进随机，再按=回顺序。
        // 从随机退出时回 `sequential` 而不是"上一档"：岛里没有周期概念，用户按两下要回到原点。
        const target = player.state.playbackMode === "shuffle" ? "sequential" : "shuffle";
        options.notifyPlaybackMode?.(player.setPlaybackMode(target));
      },
      toggleSongLike: () => {
        options.toggleSongLike?.();
      },
      // getter：宿主那份收藏态会变，写死就把岛钉在挂载那一刻的读数上
      get isSongLiked() {
        return options.songLiked?.() === true;
      },
      isFmMode: false,
    },
    // getter 而不是常量：这个对象是每次挂载建一次并长期持有的，写死 "off" 就永远读不到内核的变化。
    get loopMode(): "off" | "all" | "one" {
      const mode = player.state.playbackMode;
      return mode === "repeat-one" ? "one" : mode === "repeat-all" ? "all" : "off";
    },
    // R131：上游为命令面板预留的那条口子。宿主的面板（Ctrl+P）是唯一执行者，岛只是另一个入口。
    invokeCommandById: (commandId: string) => {
      options.invokeCommand?.(commandId);
    },
    canInvokeCommandById: (commandId: string) => options.canInvokeCommand?.(commandId) === true,
  };

  return {
    hostElement: options.hostElement ?? null,
    latticeControls,
    requestLayout: (layout: "classic" | "lattice" | "artistGrid") => options.requestLayout?.(layout),
    playSong: (song: SongResult) => void player.play(song.id),
    // R162：网格那三颗动作只转发宿主的既有通路（入队/播放的权威都在宿主）。
    playArtistGridTrack: (songId: string) => options.playArtistGridTrack?.(songId),
    playArtistGridAlbum: (albumId: string) => options.playArtistGridAlbum?.(albumId),
    addArtistGridToQueue: (songIds: string[]) => options.addArtistGridToQueue?.(songIds),
    addArtistGridTrackToQueue: (songId: string) => options.addArtistGridTrackToQueue?.(songId),
    togglePlayback: () => player.toggle(),
    seek: (time: number) => player.seek(time),
    feedSong(song: SongResult | null, coverUrl: string | null, duration: number) {
      store.getState().setCurrentSong(song);
      store.getState().setCachedCoverUrl(coverUrl);
      store.getState().setDuration(duration);
      lastLineIndex = -1;
    },
    feedLyrics(data: LyricData | null) {
      store.getState().setLyricsState(data);
      timeline = (data?.lines ?? []).map((line) => [
        line.startTime,
        line.renderHints?.renderEndTime ?? line.endTime ?? line.startTime,
      ]);
      lastLineIndex = -1;
    },
    feedTransport(playing: boolean, paused: boolean) {
      store.getState().setPlayerState(toPlayerState(playing, paused));
    },
    /** 由 music-app 的单 rAF 循环调用；clock 为宿主播放钟（秒）。 */
    tick(clock: number) {
      currentTime.set(clock);
      lyricCurrentTime.set(clock - options.lyricOffsetMs() / 1000);

      const pulse = options.pulse();
      const bins = pulse?.spectrum() ?? null;
      const playing = options.player.state.playing;
      if (playing && bins && bins.length) {
        const [bass, lowMid, mid, vocal, treble] = BAND_EDGES.map(([f, t]) => bandEnergy(bins, f, t));
        audioPower.set(process((bass + lowMid) / 2, 3));
        audioBands.bass.set(process(bass, 1.8));
        audioBands.lowMid.set(process(lowMid, 2));
        audioBands.mid.set(process(mid, 2));
        audioBands.vocal.set(process(vocal, 1.5));
        audioBands.treble.set(process(treble, 2));
      } else {
        // 上游空闲呼吸：无 analyser 数据时用慢正弦顶替，保持动效不死板（R18 同参数）。
        const breath = (Math.sin(Date.now() / 2000) + 1) * 20;
        audioPower.set(breath);
        audioBands.bass.set(breath);
        audioBands.lowMid.set(breath);
        audioBands.mid.set(breath);
        audioBands.vocal.set(breath);
        audioBands.treble.set(breath);
      }

      const lyricClock = clock - options.lyricOffsetMs() / 1000;
      let index = -1;
      for (let i = 0; i < timeline.length; i += 1) {
        const [start, end] = timeline[i];
        if (lyricClock >= start && lyricClock < end) { index = i; break; }
        if (lyricClock >= start) index = i;
      }
      if (index !== lastLineIndex) {
        lastLineIndex = index;
        store.getState().setCurrentLineIndex(Math.max(0, index));
      }
    },
    reset() {
      lastLineIndex = -1;
      timeline = [];
    },
  };
}
