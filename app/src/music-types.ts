/** JSON contract shared by the local music service and the visual interface. */
/** One lyric source for a track; absent when the track has no lyrics at all. */
export interface MusicTrackLyrics {
  /** A same-basename .lrc/.ttml file beats an embedded tag; both are local and need no network. */
  source: "embedded" | "sidecar";
  /** "lrc" is line-timed, "ttml" is word-timed, "lyrics" is unsynchronized plain text. */
  format: "lrc" | "ttml" | "lyrics";
  /** Same-origin text endpoint, e.g. "/api/lyrics/track-…". */
  url: string;
}

export interface MusicTrack {
  id: string;
  albumId: string;
  title: string;
  artist: string;
  trackNumber?: number;
  discNumber?: number;
  duration: number;
  format: string;
  codec?: string;
  bitsPerSample?: number;
  sampleRate?: number;
  bitrate?: number;
  numberOfChannels?: number;
  lossless?: boolean;
  browserPlayable: boolean;
  audioUrl: string;
  /**
   * 在线曲目的封面：**只可能是同源地址**（`/api/online/artwork/<token>`），第三方那条 URL 从不出服务端，
   * 与 `audioUrl` 走的是同一条代理红线（看板 ⑨ 追加）。本地曲目不用这个字段——它的封面走 `album.coverUrl`。
   * 没有封面时是空串或缺字段，界面画既有占位，不造一个会 404 的 URL（F3 那条老错的同一判据）。
   */
  coverUrl?: string;
  /**
   * 曲目来源（第五期 Task 6）。缺省 = 本地：曲库快照里今天的条目都不带这个字段，
   * 加了必填会把本地播放整条链子拖去改一遍，而在线曲目是少数派。
   * 它存在的意义不只是"显示个标签"：播放内核的不可播判定与失败文案都按它分叉——
   * 在线曲目没有本地扩展名，那套按 format / DSF / browserPlayable 的判据对它没有意义。
   */
  sourceKind?: "local" | "online";
  /** 在线曲目的来源标识（netease / qq / …），只在 sourceKind === "online" 时有值。 */
  provider?: string;
  /**
   * 在线曲目自带的专辑名。本地曲目的专辑走分组（`albumId` → 专辑标题），不放这儿；
   * 在线曲目没有分组可查，而专辑是歌词打分的一维证据（同名不同专辑的翻唱最容易在这里错配），
   * 所以把它带在曲目上（F4：在线曲目接通歌词）。
   */
  album?: string;
  lyrics?: MusicTrackLyrics;
  relativePath: string;
}

export interface MusicProducer {
  name: string;
  role: string;
  source: "local" | "MusicBrainz" | "manual";
  trackTitle?: string;
  url?: string;
}

export interface MusicAlbum {
  id: string;
  title: string;
  artist: string;
  year?: number;
  discCount?: number;
  description?: string;
  descriptionSource?: {
    name: string;
    url: string;
    checkedAt?: string;
    license?: string;
  };
  localNote?: string;
  introduction?: {
    status: "unqueried" | "matched" | "not-found" | "uncertain" | "error";
    checkedAt?: string;
    error?: string;
    candidateUrl?: string;
  };
  genreId: string;
  rawGenres: string[];
  folder: string;
  coverUrl?: string;
  tracks: MusicTrack[];
  producers: MusicProducer[];
  offline: boolean;
  online?: {
    status: "unqueried" | "matched" | "uncertain" | "not-found" | "error";
    releaseId?: string;
    releaseGroupId?: string;
    checkedAt?: string;
    sourceUrl?: string;
    error?: string;
    descriptionStatus?: "available" | "not-found" | "error";
    descriptionError?: string;
  };
  /**
   * ⑧ 伪专辑：这张"专辑"其实是一张文本歌单（`playlist`）或一个在线音乐人组（`artist`）。
   * 架上的说明位、封面画法、点开后的去向都按它分叉。
   * 只有前端在装配视图模型时才会写它——服务端的曲库快照里永远没有这个字段。
   */
  kind?: "playlist" | "artist";
  /** 歌单的行数（`items`）与没匹配上的条数（`unmatched`）：架上要说"歌单 · N 首（M 首未匹配）"。 */
  shelfCounts?: { items: number; matched: number; unmatched: number };
  /**
   * 拼贴封面的**文本**原料（前四条成员的标题/歌手）。
   * 它不是封面 URL：在线条目的字段白名单今天刻意不带图，所以架上的格子是按这些文本算出的
   * 程序化色块——不冒充真封面，也不新增出网面（F3 那条"别按 id 造 artwork URL"同样适用）。
   */
  coverSeeds?: { title: string; artist: string }[];
}

/** ⑧ `/api/playlists/shelf` 的一行（服务端算好的架上原料）。 */
export interface MusicPlaylistShelfRow {
  id: string;
  name: string;
  items: number;
  matched: number;
  unmatched: number;
  /** 出现最多的那位音乐人（并列按首次出现定）；一条都没匹配上时为空串。 */
  artist: string;
  /** 拼贴色块原料（没有真封面时用它画）。 */
  coverSeeds: { title: string; artist: string }[];
  /**
   * R198：这张歌单的**展示封面**（服务端按 sidecar 的 `displayCoverRef` 签出的**同源** token 地址）。
   * 空串 = 没有（架上那格照旧画程序化拼贴）。点「播放已匹配的 N 条」之后服务端才会给它选一张。
   */
  coverUrl?: string;
}

export interface MusicPlaylistShelf {
  playlists: MusicPlaylistShelfRow[];
  /** ⑨ 在线音乐人组（架上那一列的原料，**不含曲目明细**：点开才取）。 */
  artists: MusicOnlineArtistShelfRow[];
  /** 超出上限没铺出来的组数（与 `omitted` 同一类实话，不许悄悄截断）。 */
  artistsOmitted: number;
  artistsLimit: number;
  /** 超出架上上限没铺出来的张数（这些只在歌单面板里可见）。 */
  omitted: number;
  /** 读坏了的张数（用户手改文件导致）：要能在界面上说一句实话。 */
  broken: number;
  limit: number;
}

/** ⑨ 一个在线音乐人在架上的那一行：条数 + 来自几张歌单 + 拼贴色块的文本原料。 */
export interface MusicOnlineArtistShelfRow {
  slug: string;
  name: string;
  items: number;
  playlists: number;
  coverSeeds: { title: string; artist: string }[];
}

/**
 * ⑨ 组内一条在线曲目：形状就是服务端 `ONLINE_TRACK_FIELDS` 那一份（`bridge/providers/normalize.mjs`），
 * 与 `OnlineSearchItem` 同构（TS 是结构类型，两边字段一致就能互传）。
 * 这里重列一份是为了让**契约文件**自己说清 `/api/online/artists/<slug>` 出去的东西；
 * 生产侧只有一处真源，改那边时这条会因字段不匹配而编译期报错。
 */
export interface MusicOnlineArtistTrack {
  album: string;
  artist: string;
  audioUrl: string;
  durationMs: number;
  id: string;
  mediaId: string;
  provider: string;
  quality: string;
  sourceKind: "online";
  title: string;
  /** 同源封面地址（看板 95fe081 之后由服务端签发）。空串或缺字段 = 没有封面，界面画占位。 */
  coverUrl?: string;
}

/** ⑨ 点开某个音乐人组取到的明细（服务端 `/api/online/artists/<slug>`）。 */
export interface MusicOnlineArtistDetail {
  id: string;
  name: string;
  /** 这些条目来自哪几张歌单（歌单名，不是 id——要说人话）。 */
  playlists: string[];
  items: MusicOnlineArtistTrack[];
}

export interface MusicGenre {
  id: string;
  name: string;
  aliases?: string[];
  albumCount?: number;
}

export interface GenreRules {
  version: 1;
  genres: MusicGenre[];
  albumOverrides: Record<string, string>;
}

export interface LibraryRoot {
  path: string;
  status: "online" | "offline" | "unscanned";
  error?: string;
}

export interface MusicLibrary {
  version: 1;
  albums: MusicAlbum[];
  genres: MusicGenre[];
  roots: LibraryRoot[];
  scan: {
    running: boolean;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    skipped?: string;
  };
  onlineEnabled: boolean;
  /** 在线歌词匹配开关（第四期）。2026-10-04 定案：联网功能默认打开 ⇒ 缺省即开启，
   *  服务端 init() 只把"明确的 false"读成关闭，意外值落回默认。 */
  onlineLyrics?: { enabled: boolean };
  /**
   * R77 那四张子开关（第五期）。服务端 snapshot() 里它是 ONLINE_DEFAULTS 与磁盘配置的合并结果，
   * 所以三个字段都可能缺省 —— 读取侧一律按 `!== false`（默认开）判，不写 `=== true`。
   * 上面的 onlineLyrics 是它的**镜像**（旧面板字段），真源只有这一张表。
   */
  online?: {
    lyrics?: boolean;
    search?: boolean;
    streaming?: boolean;
    covers?: boolean;
  };
  enrich?: {
    running: boolean;
    completed: number;
    total: number;
    error?: string;
    skipped?: string;
  };
  introductions?: {
    running: boolean;
    completed: number;
    total: number;
    updated: number;
    notFound: number;
    failed: number;
    currentAlbum?: string;
    error?: string;
  };
  /** 封面补全那一轮（M3-c）：进度与逐档计数都在服务端算，界面只回读，不自己再数一遍。 */
  covers?: {
    running: boolean;
    completed: number;
    total: number;
    matched: number;
    notFound: number;
    failed: number;
    currentAlbum?: string;
    skipped?: string;
    error?: string;
  };
  /** 歌单目录（F3）：`playlistDir` 是当前真正在用的绝对路径，`playlistDirDefault` 是没配置时的默认。 */
  playlistDir?: string;
  playlistDirDefault?: string;
}
