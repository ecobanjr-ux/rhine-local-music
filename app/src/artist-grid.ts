import type { ArtistGridFeed, SongResult } from "./folia/types";
import type { MusicTrack } from "./music-types";

/**
 * 音乐人网格的数据层（R162 · 本项目自撰，AGPL-3.0-only）。
 *
 * 移植总则说"原版有的先照搬"：`ArtistGridView` 的几何、卡片、入场动画、拖拽缩放、键盘、
 * 导航恢复全部逐字搬过来了；**不适配的是它取数那一段**（上游在这里问 omni / Navidrome /
 * 本地曲库 catalog 三处，本产品一条都没有：在线取数必须经桥子进程、第三方地址不出服务端、
 * 曲库在宿主的 Three.js 一侧）。这个文件就是那一条薄适配层——它把"宿主已经算好的东西"
 * 整理成网格要的那份描述符，自己**不出网、不读盘、不碰内核**。
 *
 * 与 ⑨（R122 在线按音乐人分组播放）的分工：
 * - ⑨ 管**数据**：把本机歌单里已匹配的在线条目按歌手聚成组、给出 slug、整组入队；
 * - 九 管**一组的浏览面**：把⑨已经有的那份条目画成六边形网格（头像 + 说明 + 热门曲目 + 专辑）。
 * 两者共用同一份原料（`/api/online/artists/<slug>` 的明细）与同一条播放通路（R114 的整份入队）。
 */

/** 网格上半区只有 10 格（`buildArtistGridCoords` 的 songCount 上限就是上游写死的那一档）。 */
export const ARTIST_GRID_TOP_SONGS = 10;
/** 条目没写专辑时的分组名：宁可给一个说得出"这里没有资料"的格子，也不按文件名编一个专辑名。 */
export const ARTIST_GRID_UNKNOWN_ALBUM = "（未标专辑）";

export interface ArtistGridTrackView {
  /** 这张曲目属于哪张专辑、专辑的封面与年份（在线条目没有年份读数 ⇒ 留空，卡片那一行自然不显示）。 */
  albumName: string;
  albumCover?: string;
  albumYear?: number;
}

export interface ArtistGridModel {
  /** 喂给岛的那一份。 */
  feed: ArtistGridFeed;
  /** 整组曲目（网格只画前 10 张卡，但「播放全部 / 加入队列」用的是这一整份 —— R114 的口径）。 */
  tracks: MusicTrack[];
  /** 专辑卡点下去播哪几首：专辑 id → 该组里属于这张专辑的曲目（按组内原顺序）。 */
  albumTracks: Map<string, MusicTrack[]>;
  /** 组里没有一条带专辑名时，专辑那一区有几张（界面要能说出"专辑区是空的，因为条目没写专辑"）。 */
  albumsWithoutName: number;
}

export interface ArtistGridSource {
  /** 在线组 = 服务端给的 slug；本地 = 歌手名的规范化键（与架子 `artist` 档同一个出处，见 music-order）。 */
  id: string;
  name: string;
  /** 说明卡上那句话，由调用方拼好（网格不许自己编一位音乐人的简介）。 */
  description: string;
  tracks: MusicTrack[];
  viewOf: (track: MusicTrack) => ArtistGridTrackView;
  toSong: (track: MusicTrack) => SongResult;
}

const albumIdOf = (index: number) => `artist-album-${index}`;

/**
 * 一份组内条目 → 网格描述符。空组返回 null：让界面说"这一组还没有可播的条目"，
 * 而不是摆一面只有头像和空白说明的网格。
 */
export function buildArtistGridModel(source: ArtistGridSource): ArtistGridModel | null {
  const tracks = Array.isArray(source.tracks) ? source.tracks : [];
  if (!tracks.length) return null;

  const order: string[] = [];
  const seen = new Map<string, { name: string; coverUrl?: string; publishedAt?: number; tracks: MusicTrack[] }>();
  let albumsWithoutName = 0;
  tracks.forEach((track) => {
    const view = source.viewOf(track);
    const name = String(view.albumName ?? "").trim();
    if (!name) albumsWithoutName += 1;
    const key = name || ARTIST_GRID_UNKNOWN_ALBUM;
    let album = seen.get(key);
    if (!album) {
      album = { name: key, tracks: [] };
      seen.set(key, album);
      order.push(key);
    }
    album.tracks.push(track);
    // 封面取这一组里第一张"真有的"：后面的条目补上了不该把先拿到的那张换掉（同 R126 的口径），
    // 也不许凭空拼一个地址（F3 那条老错）。
    if (!album.coverUrl && view.albumCover) album.coverUrl = view.albumCover;
    if (album.publishedAt === undefined && typeof view.albumYear === "number" && view.albumYear > 0)
      album.publishedAt = Date.UTC(view.albumYear, 0, 1);
  });

  const albums = order.map((key) => {
    const album = seen.get(key)!;
    return {
      id: albumIdOf(order.indexOf(key)),
      name: album.name,
      ...(album.coverUrl ? { coverUrl: album.coverUrl } : {}),
      ...(album.publishedAt === undefined ? {} : { publishedAt: album.publishedAt }),
    };
  });
  const albumTracks = new Map<string, MusicTrack[]>(
    order.map((key, index) => [albumIdOf(index), seen.get(key)!.tracks]),
  );

  const feed: ArtistGridFeed = {
    id: source.id,
    name: source.name,
    ...(albums.find((album) => album.coverUrl)?.coverUrl
      ? { cover: albums.find((album) => album.coverUrl)!.coverUrl }
      : {}),
    description: source.description,
    trackCount: tracks.length,
    albumCount: albums.length,
    songs: tracks.slice(0, ARTIST_GRID_TOP_SONGS).map(source.toSong),
    albums,
  };
  return { feed, tracks, albumTracks, albumsWithoutName };
}

/** 网格里的曲目 id → 组内下标（点卡片时按 id 回查，不信岛递回来的那个对象快照 —— R114 的第二半）。 */
export function artistGridTrackIndex(model: ArtistGridModel, songId: string): number {
  return model.tracks.findIndex((track) => track.id === songId);
}
