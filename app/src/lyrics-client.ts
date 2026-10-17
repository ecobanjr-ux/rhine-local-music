import type { MusicTrack } from "./music-types";
import type { LyricData } from "./lyrics/types";
import { parseLyrics } from "./lyrics/index.ts";

/** Where the lyric text came from, normalised for the UI. */
export type LyricSourceName = "embedded" | "sidecar" | "online" | "none";
export type LyricFormatName = "lrc" | "ttml" | "qrc" | "lyrics" | "none";
/** 在线匹配来源。第五期 Task 5 从两源扩到四源（顺序 = 服务端 LYRIC_SOURCES 那份单一真源）。 */
export type OnlineProvider = "qq" | "netease" | "amll" | "kugou";

/**
 * 来源的中文名：歌词徽标与设置面板的联网声明共用这一份。
 * 之所以要"共用"而不是各写一遍：「UI 标明来源」这条红线要求两处说法一致，
 * 而 check-music-theme-ui 会拿这张表去核对面板文案与徽标措辞（漂移即红）。
 */
export const ONLINE_PROVIDER_LABELS: Record<OnlineProvider, string> = {
  qq: "QQ",
  netease: "网易云",
  amll: "AMLL",
  kugou: "酷狗",
};

/**
 * R144 · 近候选：自动挡阈值（75 分）下面、"值得人看一眼"的那一带（60~74）。
 * 只有身份，没有歌词正文——正文永远等人选完之后再现取。
 * R148（Q20）：`claimToken` 是服务端为这一条签发的不透明令牌，认领时把它送回去即可；
 * 取词要用的原始钥匙（`accessKey`）**从不出服务端**，所以这里没有那个字段。
 */
export interface OnlineNearCandidate {
  provider: OnlineProvider;
  sourceId: string;
  claimToken?: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  score: number;
}

/** What `POST /api/online/lyrics/match` answers (see scripts/music-server.mjs). */
export interface OnlineMatchOutcome {
  matched: boolean;
  format?: "qrc" | "lrc" | "ttml";
  text?: string;
  translation?: string;
  romanization?: string;
  provider?: OnlineProvider;
  score?: number;
  isWordByWord?: boolean;
  matchedSong?: { title?: string; artist?: string; album?: string; durationMs?: number; sourceId?: string | number };
  reason?: string;
  /** R144：这一首是**按手动认领**取的词（不是自动挡配上的），徽标据此换措辞。 */
  claimed?: boolean;
}

export interface OnlineLyricsSource {
  /** Resolves to `null` when the online capability is switched off. Never rejects the play path. */
  match(track: MusicTrack): Promise<OnlineMatchOutcome | null>;
}

export interface LoadedLyrics {
  trackId: string;
  source: LyricSourceName;
  format: LyricFormatName;
  data: LyricData;
  empty: boolean;
  /** Set when the text was refused by the entity-declaration pre-check. */
  rejected?: "entity-declaration";
  /** Network or parser failure; the UI falls back to the no-lyric animation. */
  error?: string;
  /**
   * 原始歌词文本，仅在解析成功时带上。非同步歌词（ID3 USLT）没有任何时间轴，
   * 解析不出逐行时间，舞台需要它把原文按段落显示出来，而不是误判成"没有歌词"。
   */
  text?: string;
  /** Which online service answered, so the badge can say where the text came from. */
  provider?: OnlineProvider;
  online?: { score: number; matchedSong?: OnlineMatchOutcome["matchedSong"] };
  /** 6.6：本地只有无时间轴内嵌歌词、被在线带时间轴结果替换时置真（徽标据此换措辞）。 */
  replacedLocalUntimedLyric?: boolean;
  /** R144：这份在线歌词是**按手动认领**取的（徽标要区别于自动挡配上的那些）。 */
  claimed?: boolean;
  /**
   * Only for tracks with no local lyric at all: the play path gets the local answer
   * immediately and may rebuild from the online match when it lands. Never rejects.
   */
  upgrade?: Promise<LoadedLyrics>;
}

const emptyData = (): LyricData => ({ lines: [] as unknown as LyricData["lines"] });

interface WorkerJob {
  id: number;
  text: string;
  format?: string;
  translation?: string;
  romanization?: string;
}

interface WorkerReply {
  id: number;
  data?: LyricData;
  empty?: boolean;
  rejected?: "entity-declaration";
  error?: string;
}

export interface LyricsClientOptions {
  fetchImpl?: (input: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  WorkerImpl?: () => Worker;
  /** Absent (or switching off inside `match`) keeps this a purely local pipeline. */
  online?: OnlineLyricsSource;
}

/**
 * Literal `new Worker(new URL(...))` so Vite emits a separate worker chunk;
 * assigning this through a variable constructor hides the pattern from its scanner.
 */
function createDefaultWorker(): Worker {
  return new Worker(new URL("./lyrics-worker.ts", import.meta.url), { type: "module" });
}

/**
 * Loads and parses lyrics for a track, off the animation thread when a worker is
 * available, with a main-thread fallback. Results are cached per track id.
 */
export function createLyricsClient(options: LyricsClientOptions = {}) {
  const fetchText = options.fetchImpl ?? defaultFetch;
  const cache = new Map<string, LoadedLyrics>();
  const pending = new Map<string, Promise<LoadedLyrics>>();
  let nextJobId = 1;
  let worker: Worker | null = null;
  let workerBroken = false;
  const waiting = new Map<number, (reply: WorkerReply) => void>();

  function defaultFetch(input: string) {
    return fetch(input).then((response) => ({
      ok: response.ok,
      status: response.status,
      text: () => response.text(),
    }));
  }

  function ensureWorker(): Worker | null {
    if (workerBroken) return null;
    if (worker) return worker;
    const factory = options.WorkerImpl ?? createDefaultWorker;
    if (typeof factory !== "function") {
      workerBroken = true;
      return null;
    }
    try {
      worker = factory();
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const resolve = waiting.get(event.data.id);
        if (resolve) {
          waiting.delete(event.data.id);
          resolve(event.data);
        }
      };
      worker.onerror = () => {
        // Any worker-level failure degrades this session to main-thread parsing.
        workerBroken = true;
        for (const [id, resolve] of waiting) {
          waiting.delete(id);
          resolve({ id, error: "worker failed" });
        }
      };
      return worker;
    } catch {
      workerBroken = true;
      return null;
    }
  }

  async function parseWithWorker(job: WorkerJob, format?: string): Promise<WorkerReply> {
    const active = ensureWorker();
    if (!active) {
      const result = await parseLyrics({ text: job.text, format, translation: job.translation, romanization: job.romanization });
      return { id: job.id, data: result.data, empty: result.empty, rejected: result.rejected, error: result.error };
    }
    return await new Promise<WorkerReply>((resolve) => {
      waiting.set(job.id, resolve);
      active.postMessage(job);
    });
  }

  /**
   * The single parse entry both paths share (R60): local files and online matches go through
   * the same worker call, so an online lyric cannot arrive through a second, un-audited parser.
   */
  async function parseJob(text: string, format?: string, translation?: string, romanization?: string): Promise<WorkerReply> {
    return parseWithWorker({ id: nextJobId++, text, ...(format ? { format } : {}), ...(translation ? { translation } : {}), ...(romanization ? { romanization } : {}) }, format);
  }

  const noneResult = (track: MusicTrack, error?: string): LoadedLyrics => ({
    trackId: track.id,
    source: "none",
    format: "none",
    data: emptyData(),
    empty: true,
    ...(error ? { error } : {}),
  });

  /**
   * 在线升级：本地完全没有歌词，或只有"无时间轴的内嵌纯文本"（6.6）时才走到这里。
   * 任何失败（异常、未命中、被安全预检挡下、零有效行）都兑现成"仍是原样 + 可读原因"，绝不 reject ——
   * 在线能力不许把播放与视觉卡住：无词曲目停在无词，USLT 曲目停在段落。
   * 未命中不进缓存：用户中途在设置里打开开关，下一次选曲就该生效，不必重扫曲库。
   */
  async function runOnlineUpgrade(
    track: MusicTrack,
    localReference?: MusicTrack["lyrics"],
  ): Promise<LoadedLyrics> {
    const source = options.online;
    if (!source) return noneResult(track);
    let outcome: OnlineMatchOutcome | null;
    try {
      outcome = await source.match(track);
    } catch (error) {
      return noneResult(track, `在线匹配失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!outcome?.matched || !outcome.text) return noneResult(track, outcome?.reason ?? "未找到匹配歌词");
    const reply = await parseJob(outcome.text, outcome.format, outcome.translation, outcome.romanization);
    if (reply.rejected) return noneResult(track, "在线歌词含实体声明，已拒绝");
    if (reply.error) return noneResult(track, `在线歌词解析失败：${reply.error}`);
    const data = reply.data ?? emptyData();
    if (reply.empty || !(data.lines?.length)) return noneResult(track, "在线歌词没有有效行");
    const loaded: LoadedLyrics = {
      trackId: track.id,
      source: "online",
      format: outcome.format ?? "lrc",
      data,
      empty: false,
      text: outcome.text,
      ...(outcome.provider ? { provider: outcome.provider } : {}),
      // 6.6：内嵌纯文本被带时间轴的在线结果替换，徽标要说清这是替换不是首发。
      ...(localReference ? { replacedLocalUntimedLyric: true } : {}),
      // R144：手动认领的那一条也要说得出来源方式——它与"机器自己配上的"不是一回事。
      ...(outcome.claimed ? { claimed: true } : {}),
      online: { score: outcome.score ?? 0, ...(outcome.matchedSong ? { matchedSong: outcome.matchedSong } : {}) },
    };
    cache.set(track.id, loaded);
    return loaded;
  }

  async function load(track: MusicTrack): Promise<LoadedLyrics> {
    const cached = cache.get(track.id);
    if (cached) return cached;
    const running = pending.get(track.id);
    if (running) return running;

    const request = (async (): Promise<LoadedLyrics> => {
      const reference = track.lyrics;
      // 本地一首词都没有：先把"无词"这个结果放行（播放与视觉立刻按它渲染），
      // 再把在线升级的 promise 挂在同一个结果上，由舞台在换曲守卫之后接手。
      if (!reference) {
        if (!options.online) return noneResult(track);
        return { ...noneResult(track), upgrade: runOnlineUpgrade(track) };
      }
      let text = "";
      try {
        const response = await fetchText(reference.url);
        if (!response.ok) {
          return {
            trackId: track.id,
            source: reference.source,
            format: reference.format,
            data: emptyData(),
            empty: true,
            error: `歌词读取失败（HTTP ${response.status}）`,
          };
        }
        text = await response.text();
      } catch (error) {
        return {
          trackId: track.id,
          source: reference.source,
          format: reference.format,
          data: emptyData(),
          empty: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const reply = await parseJob(text, reference.format);
      if (reply.error) {
        return {
          trackId: track.id,
          source: reference.source,
          format: reference.format,
          data: emptyData(),
          empty: true,
          error: reply.error,
        };
      }
      const loaded: LoadedLyrics = {
        trackId: track.id,
        source: reference.source,
        format: reference.format,
        data: reply.data ?? emptyData(),
        empty: reply.empty ?? (reply.data?.lines.length ?? 0) === 0,
        text,
        ...(reply.rejected ? { rejected: reply.rejected } : {}),
      };
      // 6.6：内嵌纯文本（USLT，format:'lyrics'）没有任何时间轴，它只是"唯一有的歌词"。
      // 这里**先把段落原样放行**（F1/R63 的显示不能退），再挂上在线升级：命中就原地替换成带时间轴的逐字/行级词，
      // 未命中就停在段落上。计划初稿写的是"走 noneResult 分支"，那会让段落消失，等于把 F1 改回去。
      if (reference.format === "lyrics" && options.online) {
        // 与"完全无词"同一口径：带着 pending upgrade 的结果**不进缓存**（真实取证踩过：
        // 同一首被连续加载两次时，第二次从缓存拿到的那个"没有 upgrade 的段落"会让在线结果永远到不了）。
        // 段落文本本身由 /api/lyrics 现读，代价与本地无词曲目相同；未命中也不会因此重复出网——服务端有负缓存。
        return { ...loaded, upgrade: runOnlineUpgrade(track, reference) };
      }
      cache.set(track.id, loaded);
      return loaded;
    })();

    pending.set(track.id, request);
    try {
      return await request;
    } finally {
      pending.delete(track.id);
    }
  }

  /** Drop cached results, e.g. after a library rescan changed the sidecar files. */
  function reset(): void {
    cache.clear();
  }

  function dispose(): void {
    worker?.terminate();
    worker = null;
    cache.clear();
    waiting.clear();
  }

  return { load, reset, dispose, get usingWorker(): boolean { return !!worker && !workerBroken; } };
}

export type LyricsClient = ReturnType<typeof createLyricsClient>;
