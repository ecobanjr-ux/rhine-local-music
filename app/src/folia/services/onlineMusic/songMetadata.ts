/**
 * R30 自撰 stub（本地 only）：替代上游在线元数据聚合。封面与艺人名只读曲目自身字段；
 * 封面 URL 走宿主 music-server 的 /api/artwork/:albumId（R32 同口径）。
 * 第四期在线歌词匹配落地时以真实现替换并登记。
 * 本文件为本项目自撰（AGPL-3.0-only），替代上游同名文件；见移植台账对应 R 条。
 */
import type { SongResult } from "../../types";
export interface ProviderSongMetadata {
  artists: { id?: string; name: string }[];
  coverUrl: string | null;
}
export const getProviderSongMetadata = (song: SongResult | null | undefined): ProviderSongMetadata => ({
  artists: song?.artists ?? [],
  // 封面只认宿主注入的 coverUrl（带 ?v= 缓存位，scripts/music-library.mjs:256）。
  // F3：这里曾按 album.id 拼 `/api/artwork/<id>` 兜底 —— 无封面专辑的索引里 coverUrl 本就是缺失，
  // 拼出来的 URL 必然 404（第四期封面墙实测），还让"没有封面"和"封面读失败"两种状态无法区分。
  // 现在返回 null，交给封面墙自己的占位路径处理。
  //
  // 跳④（看板 95fe081）：先认**曲目自己**那张，再退到所属专辑的。在线曲目没有本地专辑分组
  // （`album` 为 null），它的封面是宿主经 `/api/online/artwork/<token>` 代理好的同源地址；
  // 判据顺序反过来会让"同一张专辑 + 单曲另给封面"这种场合丢掉更具体的那一份。
  coverUrl: song?.coverUrl ?? song?.album?.coverUrl ?? null,
});
export const getSongCoverUrl = (song: SongResult | null | undefined): string | undefined =>
  getProviderSongMetadata(song).coverUrl ?? undefined;
export const getSongArtistLabel = (song: SongResult | null | undefined): string =>
  getProviderSongMetadata(song).artists.map((a) => a.name).filter(Boolean).join(", ");
