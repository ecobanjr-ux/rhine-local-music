import content from "../content/archives.json" with { type: "json" };
import type { MusicAlbum, MusicGenre, MusicTrack } from "./music-types";
import { musicArtistKey, orderMusicAlbums, type MusicShelfLayout, type MusicSortMode } from "./music-order.ts";
export { orderMusicAlbums, type MusicShelfLayout, type MusicSortMode } from "./music-order.ts";

export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  album?: MusicAlbum;
  /** 6.6「按专辑」布局：一行是一首曲目；其他布局下留空。 */
  track?: MusicTrack;
  /** 封面底部标签带的文字（"第 N 首 · 曲名"）；没有就不画。 */
  label?: string;
  /** 同一张专辑的所有曲目行共享这一个封面身份（专辑 id）。 */
  coverKey?: string;
}

export let records: ArchiveRecord[] = content.records;
export let categories = ["全部档案", ...content.categories];
export let archiveColumns = content.columns;
/** 与 archiveColumns 等长的稳定键：显示名可以重复（同名专辑），列记忆与折叠都按这个键走。 */
export let archiveColumnKeys: string[] = [...content.columns];
export let musicLibrary = false;
export let slotStride = 32;
let filesByColumn = archiveColumns.map((name) => records.flatMap((record, index) => record.category === name ? [index] : []));

/**
 * ⑧ 伪专辑（文本歌单上架）的保留分组键与显示名。
 * 它**不是**一个流派：`rawGenres`、MusicBrainz 那条链、曲库快照都不认识它，
 * 伪造一个 genreId 会让"按流派统计"这件事从此对不上账（分类计数、专辑筛选都读它）。
 * 所以只在架子的分组轴与分类列表上按这个键给一个名字，其余两档（按音乐人 / 每列一张）零特例。
 */
export const PLAYLIST_GROUP_ID = "playlist:";
export const PLAYLIST_GROUP_NAME = "歌单";
/**
 * ⑨ 第二个保留分组：在线音乐人组。与「歌单」同一套讲究——它**不是**一个流派，
 * 伪造 genreId 会让按流派统计对不上账；只在分组轴与分类列表上按这个键给一个名字。
 */
export const ONLINE_ARTIST_GROUP_ID = "artist:";
export const ONLINE_ARTIST_GROUP_NAME = "在线音乐人";
/** 架上与详情面板共用这一对 id 换算：`playlist:<slug>` 就是"点开这张歌单"的路由凭据。 */
export const playlistAlbumId = (slug: string) => `${PLAYLIST_GROUP_ID}${slug}`;
export const playlistSlugOf = (id: string) => (id.startsWith(PLAYLIST_GROUP_ID) ? id.slice(PLAYLIST_GROUP_ID.length) : "");
/** ⑨ 同理：`artist:<slug>` 是"点开这个音乐人组"的路由凭据（走面板，不开 3D 详情面）。 */
export const artistAlbumId = (slug: string) => `${ONLINE_ARTIST_GROUP_ID}${slug}`;
export const artistSlugOf = (id: string) => (id.startsWith(ONLINE_ARTIST_GROUP_ID) ? id.slice(ONLINE_ARTIST_GROUP_ID.length) : "");
/** 架子那一行的"分类"名：伪专辑走保留名，真实专辑仍按流派表算。 */
function shelfCategory(names: Map<string, string>, album: MusicAlbum) {
  if (album.kind === "playlist") return PLAYLIST_GROUP_NAME;
  if (album.kind === "artist") return ONLINE_ARTIST_GROUP_NAME;
  return names.get(album.genreId) ?? album.genreId ?? "未分类";
}
/** 说明位：歌单要说"歌单 · N 首（M 首未匹配）"，与详情面板的三档徽标同一口径，不另造一套计数话。
 *  导出给侧栏那行文字复用：同一句话在两处各拼一遍迟早会漂（一处说 3 首一处说 5 首）。 */
export function shelfClearance(album: MusicAlbum) {
  if (album.kind === "artist") {
    const counts = album.shelfCounts ?? { items: 0, matched: 0, unmatched: 0 };
    return `在线音乐人 · ${counts.items} 首`;
  }
  if (album.kind !== "playlist") return album.offline ? "音乐库离线" : `${album.tracks.length} 首歌曲`;
  const counts = album.shelfCounts ?? { items: 0, matched: 0, unmatched: 0 };
  return `歌单 · ${counts.items} 首${counts.unmatched > 0 ? `（${counts.unmatched} 首未匹配）` : ""}`;
}

/** Replace the view model atomically; audio files and their metadata stay intact. */
export function setMusicAlbums(
  albums: MusicAlbum[],
  genres: MusicGenre[] = [],
  sortMode: MusicSortMode = "genre",
  shelfLayout: MusicShelfLayout = sortMode,
) {
  musicLibrary = true;
  const ordered = orderMusicAlbums(albums, sortMode);          // 排序轴：只重排，不分列
  const usedGenres = new Set(ordered.map((album) => album.genreId));
  const names = new Map(genres.map((genre) => [genre.id, genre.name]));
  const genreIds = [...genres.map((genre) => genre.id).filter((id) => usedGenres.has(id)), ...usedGenres].filter((id, index, all) => all.indexOf(id) === index);
  // 两个保留分组（⑧ 歌单 / ⑨ 在线音乐人）都走同一张对照表：再加一个保留组只改这一处，
  // 不必在三个地方各补一个三元表达式（那正是"分类计数对不上账"开始漂的地方）。
  const reservedNames = new Map<string, string>([
    [PLAYLIST_GROUP_ID, PLAYLIST_GROUP_NAME],
    [ONLINE_ARTIST_GROUP_ID, ONLINE_ARTIST_GROUP_NAME],
  ]);
  const genreNames = genreIds.map((id) => reservedNames.get(id) ?? names.get(id) ?? id ?? "未分类");
  categories = ["全部专辑", ...genreNames];
  records = ordered.map((album) => ({
    id: album.id, title: album.title, en: album.artist, department: album.artist,
    category: shelfCategory(names, album),
    date: album.year ? String(album.year) : "年份未知", lead: album.artist,
    clearance: shelfClearance(album),
    abstract: album.folder, findings: album.rawGenres,
    source: album.online?.sourceUrl ?? "本地音乐库", album,
  }));
  archiveColumns = [];
  archiveColumnKeys = [];
  filesByColumn = [];
  if (shelfLayout === "artist") {
    const artists = new Map<string, { name: string; files: number[] }>();
    ordered.forEach((album, index) => {
      const key = musicArtistKey(album);
      let group = artists.get(key);
      if (!group) {
        group = { name: album.artist.trim().replace(/\s+/g, " ") || "未知歌手", files: [] };
        artists.set(key, group);
      }
      group.files.push(index);
    });
    const groups = [...artists.entries()];
    archiveColumns = groups.map(([, group]) => group.name);
    archiveColumnKeys = groups.map(([key]) => key);            // musicArtistKey 天然唯一，且与显示名解耦
    filesByColumn = groups.map(([, group]) => group.files);
  } else if (shelfLayout === "album") {
    // 每列一张专辑，列内一行一首曲目：整列铺同一张封面（coverKey 共享身份），
    // 靠封面底部的标签带（"第 N 首 · 曲名"）区分行 —— 用户 2026-10-04 定案 ①-a。
    const rows: ArchiveRecord[] = [];
    const laneOf: number[] = [];
    ordered.forEach((item, albumIndex) => {
      const tracks: (MusicTrack | undefined)[] = item.tracks.length ? item.tracks : [undefined];
      tracks.forEach((track, position) => {
        rows.push({
          id: track ? `${item.id}#${track.id}` : item.id,
          title: track ? track.title : item.title,
          en: item.artist, department: item.artist,
          category: shelfCategory(names, item),
          date: item.year ? String(item.year) : "年份未知",
          lead: item.artist,
          clearance: track ? `第 ${position + 1} 首` : shelfClearance(item),
          abstract: item.folder, findings: item.rawGenres,
          source: item.online?.sourceUrl ?? "本地音乐库",
          album: item,
          coverKey: item.id,
          ...(track ? { track, label: `第 ${position + 1} 首 · ${track.title}` } : {}),
        });
        laneOf.push(albumIndex);
      });
    });
    records = rows;
    archiveColumns = ordered.map((item) => item.title);
    archiveColumnKeys = ordered.map((item) => item.id);
    filesByColumn = ordered.map((_, lane) =>
      laneOf.map((value, index) => (value === lane ? index : -1)).filter((index) => index >= 0),
    );
  } else {
    archiveColumns = genreNames;
    // Use stable genre IDs even when custom genres share a display name.
    archiveColumnKeys = genreIds;
    filesByColumn = genreIds.map((id) => ordered.flatMap((album, index) => album.genreId === id ? [index] : []));
  }
  slotStride = Math.max(32, ...filesByColumn.map((files) => files.length + 12));
}

export function columnFiles(lane: number) {
  return filesByColumn[lane] ?? [];
}
export function fileLocation(index: number) {
  const lane = Math.max(0, filesByColumn.findIndex((files) => files.includes(index)));
  const row = 12 + Math.max(0, columnFiles(lane).indexOf(index));
  return { lane, row, slot: lane * slotStride + row };
}
export function fileAtSlot(slot: number) {
  const files = columnFiles(Math.floor(slot / slotStride));
  return files[Math.max(0, Math.min(files.length - 1, (slot % slotStride) - 12))] ?? -1;
}
