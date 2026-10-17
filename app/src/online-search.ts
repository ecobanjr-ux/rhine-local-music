// 本项目自撰（非移植代码）。在线搜索的前端侧：契约条目的类型、转成内核曲目、以及"点击即播放"。
//
// 三条与契约直接有关的形状（R78 / R86）：
//   ① 前端拿到的每条结果只有服务端契约那 10 个字段，`audioUrl` 是**同源代理地址**——
//      第三方那条带签名的 CDN URL 从不出服务端，所以这里也不可能把它转给别人；
//   ② 契约里时长是**毫秒**，内核与界面用的是**秒**（本地曲目 `duration` 就是秒），
//      这一跳必须显式换算，不能让某个地方按毫秒当秒用（那会显示成"6000 分钟"）；
//   ③ 在线曲目**点击即播放**：它不在本地曲库里，"定位到某张专辑"对它没有意义。
//      本地结果的定位语义（data-search-track）与这条用不同属性，不复用（复用了会把在线点击变成"找不到专辑"）。
import type { MusicTrack } from "./music-types.ts";

/** 服务端窄契约的条目形状（`bridge/providers/normalize.mjs` 的 ONLINE_TRACK_FIELDS）。 */
export interface OnlineSearchItem {
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
  /** 同源封面地址（`/api/online/artwork/<token>`）。空串或缺字段 = 没有封面，界面画占位。 */
  coverUrl?: string;
}

export interface OnlineSourceStatus {
  provider: string;
  ok: boolean;
  count: number;
  reason?: string;
}

export interface OnlineSearchResponse {
  ok: boolean;
  items: OnlineSearchItem[];
  total: number | null;
  hasMore: boolean;
  nextOffset: number;
  perSource: OnlineSourceStatus[];
  query?: string;
  error?: string;
}

export const ONLINE_PROVIDER_NAMES: Record<string, string> = {
  netease: "网易云",
  qq: "QQ 音乐",
  kugou: "酷狗",
};

/** 契约条目 → 内核要的 MusicTrack。`albumId` 固定 "online"：在线结果不属于任何本地专辑。 */
export function toMusicTrack(item: OnlineSearchItem): MusicTrack {
  return {
    id: item.id,
    albumId: "online",
    title: item.title,
    artist: item.artist,
    duration: item.durationMs / 1000,
    // format 取的是音源容器名（网易 mp3 / QQ 视档而定），拿不到时按 mp3 报：
    // 它只影响界面标注与错误文案，不参与在线曲目的可播判定（见 music-player 的 unsupported 分支）。
    format: "MP3",
    browserPlayable: true,
    audioUrl: item.audioUrl,
    relativePath: "",
    sourceKind: "online",
    provider: item.provider,
    // 封面：只搬同源代理地址（服务端已经把第三方 URL 换成 token 了）。空串就不带这个字段，
    // 界面据此画既有占位——**不造一个会 404 的 URL**（F3 那条老错的同一判据）。
    ...(item.coverUrl ? { coverUrl: item.coverUrl } : {}),
    // 专辑带在曲目上：歌词匹配拿它当一维证据（见 MusicTrack.album）
    ...(item.album ? { album: item.album } : {}),
  };
}

/**
 * 播放一条在线曲目：用 `play(id, [track])` 的**单首队列**形态，不去动本地队列。
 * 为什么不是 setQueue：那会把用户正在听的本地专辑整条换掉，而点一条搜索结果不该有这个副作用。
 * 代价是在线试听时上一首/下一首没有邻居——界面在结果行上直接标"试听"，不假装是完整队列。
 */
export function playOnlineTrack(player: { play: (id: string, tracks?: readonly MusicTrack[]) => Promise<void> }, track: MusicTrack): Promise<void> {
  return player.play(track.id, [track]);
}

/**
 * 歌单条目 → 内核队列。两件事必须**一起**算出来，否则界面要么播错歌要么报错数：
 *   · 只有 `matched` 且带 `track` 的条目进队列（未匹配的没有可播地址）；
 *   · 同时留下"队列第 k 格来自歌单第几条"——`data-entry` 说的是**条目下标**，而起点要在**过滤后的队列**里找。
 *     有未匹配条目时两者不等长，拿条目下标去索引过滤后的数组就会播错歌（实机那条 bug 的第二半）。
 * `entries` 用平行数组而不是 Map：调用方只需要 `indexOf`，少一种容器也少一处生命周期。
 */
export interface PlaylistEntryLike {
  matched?: boolean;
  track?: OnlineSearchItem | null;
}

export function playlistQueue(items: readonly PlaylistEntryLike[]): { tracks: MusicTrack[]; entries: number[] } {
  const tracks: MusicTrack[] = [];
  const entries: number[] = [];
  items.forEach((item, at) => {
    if (!item.matched || !item.track) return;
    entries.push(at);
    tracks.push(toMusicTrack(item.track));
  });
  return { tracks, entries };
}

/** 发一次在线检索。`post` 可注入 ⇒ 自检能离线判定，不必真的出网。 */
export async function requestOnlineSearch(
  query: string,
  options: { offset?: number; limit?: number; provider?: string } = {},
  post: (url: string, body: unknown) => Promise<OnlineSearchResponse> = defaultPost,
): Promise<OnlineSearchResponse> {
  const body = {
    query,
    offset: options.offset ?? 0,
    limit: options.limit ?? 20,
    ...(options.provider ? { provider: options.provider } : {}),
  };
  const response = await post("/api/online/search", body);
  // 服务端坏到连形状都没有时也要给界面一个可判的空结果，而不是让调用方去 catch undefined。
  return {
    ok: response?.ok === true,
    items: Array.isArray(response?.items) ? response.items : [],
    total: Number.isFinite(response?.total) ? response.total : null,
    hasMore: response?.hasMore === true,
    nextOffset: Number(response?.nextOffset ?? body.offset + body.limit),
    perSource: Array.isArray(response?.perSource) ? response.perSource : [],
    query,
    ...(response?.error ? { error: String(response.error) } : {}),
  };
}

async function defaultPost(url: string, body: unknown): Promise<OnlineSearchResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(data?.error ?? `在线搜索失败（HTTP ${response.status}）`));
  return (data ?? {}) as OnlineSearchResponse;
}

/** 秒 → "m:ss"；0 或未知时给 "--:--"（在线结果有时不带时长，网易匿名档就常见 0）。 */
export function formatDuration(seconds: number): string {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return "--:--";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * 逐源状态的界面一句话。这里的原则是**坏了就说坏**：
 * 只报"共 N 条"会把一个坏掉的源藏起来，用户以为搜过了而其实没有。
 */
export function perSourceSummary(perSource: OnlineSourceStatus[]): string {
  if (!perSource.length) return "尚未发起在线检索";
  return perSource
    .map((entry) => {
      const name = ONLINE_PROVIDER_NAMES[entry.provider] ?? entry.provider;
      if (entry.ok) return `${name} ${entry.count} 条`;
      return `${name} 不可用（${entry.reason ?? "未给出原因"}）`;
    })
    .join(" · ");
}
