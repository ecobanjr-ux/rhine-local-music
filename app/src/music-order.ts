import type { MusicAlbum } from "./music-types";

export type MusicSortMode = "genre" | "artist" | "album";
/**
 * 专辑架的"铺哪几列"轴（6.6 从 MusicSortMode 里拆出来）。
 * 拆之前 sortMode 一个参数同时决定排序与分列；拆之后两者可以正交组合（如"按标题排序 + 按歌手铺列"）。
 * 与 MusicSortMode 放在一起：同一组概念，且 data.ts 已经从这里导入排序类型。
 */
export type MusicShelfLayout = "genre" | "artist" | "album";

const collator = new Intl.Collator("zh-CN-u-co-pinyin", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
});
const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN");
const stableCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Formatting differences share a column without rewriting artist metadata. */
export const musicArtistKey = (album: MusicAlbum) => normalize(album.artist);

/** Return a new view order, retaining each album and its original metadata. */
export function orderMusicAlbums(albums: readonly MusicAlbum[], mode: MusicSortMode = "genre") {
  const ordered = [...albums];
  if (mode === "genre") return ordered;
  return ordered.sort((a, b) => {
    if (mode === "artist") {
      const artistA = musicArtistKey(a), artistB = musicArtistKey(b);
      // Keep distinct artist keys contiguous even when locale collation treats
      // their spellings as equivalent; album IDs resolve equivalent titles.
      const artist = collator.compare(artistA, artistB) || stableCompare(artistA, artistB);
      if (artist) return artist;
    }
    return collator.compare(normalize(a.title), normalize(b.title)) || stableCompare(a.id, b.id);
  });
}
