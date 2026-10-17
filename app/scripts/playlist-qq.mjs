// 本项目自撰（非移植代码）。QQ 公开歌单的父进程通道（R138）——与歌词/搜索/音源同一处口径。
//
// 为什么不在桥里：桥只装网易与酷狗两个包后端；QQ 这一家的每一笔都是本项目自写的请求，
// 经 `guardedFetch` 出去才进得出网审计（R83/R86 那条撤回包 require 的决定至今成立，
// `check-music-bridge.mjs` 里钉着"QQ 通道只走自写 fcg + guardedFetch：包不得被桥 require"）。
//
// 三条一手实测（2026-10-09，三轮探针跑的就是这条出网层；**用户给的分享链接只取其中的数字 id，
// 链接原文与 hosteuin/uid 依隐私红线不进仓库任何文件**）：
//   ① 数据只在 `c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg`（200 / 2,405,719B / 整张单一次给完）。
//      表内原有的 `u.y.qq.com` 到不了这条：同路径 404，`music.srfDissInfo.aiDissInfo` 一族
//      两种 comm 身份 × 九种参数组合**全部 `code:40000`**，真单与不存在的 id 回同一个码
//      ⇒ 这同时纠正 R137 当时的归因（那句"40000 = 这张单不存在"是误诊）。
//   ② **必须带 `Referer: https://y.qq.com/`**：不带时 46 字节 `{"code":0,"subcode":1,"msg":"invalid referer"}`。
//      这一条是"看起来离线可测、其实只有真机能告诉你"的那种——缺了它每次导入都得到"歌单是空的"。
//   ③ 分页：`song_begin` **认**（实测 begin=100 → 从第 100 条起给 1434 条），
//      而 `num` / `offset` / `limit` **不认**（照样给到末尾）⇒ 这一家没法按页切小，
//      只能一次拿整张单再在本地切。所以这里留**一格按 id 的缓存**：导入是 detail + tracks 两次调用，
//      不缓存就会把同一份 2.4MB 下载两遍（出网审计上会多笔，用户也能等得更久）。
//      缓存只买"少一笔出网"，不买新鲜度：TTL 60 秒，过期自然重取。
//
// "读不到"的三种形状实测各异，翻译也分开（都不许落成"歌单是空的"）：
//   · 不存在的 id → `code:10`、`cdnum:0`、**没有 cdlist**；
//   · `disstid=1` 这类老 id → `code:-1`、`cdnum:0`；
//   · 我们的请求本身被校验挡下 → `code:0` + `subcode:1` + `msg`。
import { guardedFetch, PLAYLIST_HOSTS, MAX_PLAYLIST_BODY_BYTES, ONLINE_PLAYLIST_TIMEOUT_MS } from './online-guard.mjs';
import { qqPlaylistToMeta, qqSonglistToItems } from './bridge/providers/playlist.mjs';
import { PLAYLIST_MAX_TRACKS } from './bridge/playlist-routes.mjs';

export const QQ_PLAYLIST_URL = 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg';
/** 这个端点认的固定参数（实测逐个试过；`onlysong=0` 才给 `songlist`，`onlysong=1` 时 cdlist 是空的）。 */
export const QQ_PLAYLIST_QUERY = 'type=1&json=1&utf8=1&onlysong=0&new_format=1&format=json&outCharset=utf-8';
/** QQ 一页最多给这么多条：这一家一次给整张单，页大小由我们的导入上限决定，不是接口给的。 */
export const QQ_PAGE_LIMIT = PLAYLIST_MAX_TRACKS;
const QQ_PLAYLIST_HEADERS = { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' };
const QQ_CACHE_TTL_MS = 60_000;

/** id → 查询串。只收 1~20 位数字（与网易那条同判据），别的形状在这里就拒掉，不拿去问接口。 */
export function qqPlaylistQueryFor(id) {
  const clean = String(id ?? '').trim();
  if (!/^\d{1,20}$/.test(clean)) return null;
  return `${QQ_PLAYLIST_URL}?${QQ_PLAYLIST_QUERY}&disstid=${clean}`;
}

/** 建一个 QQ 歌单门面。`fetcher` 是给离线自检的注入口；真机上固定用全仓唯一出网点 `guardedFetch`。 */
export function createQqPlaylistSource({
  fetcher = guardedFetch,
  timeoutMs = ONLINE_PLAYLIST_TIMEOUT_MS,
  now = () => Date.now(),
  ttlMs = QQ_CACHE_TTL_MS,
} = {}) {
  let cache = null;                        // { id, at, body }：一格，按 id 命中

  /** 取整张单的响应。返回 `{body}` 或 `{reason, retryable}`——失败在这里就是失败，不返回半截对象。 */
  const load = async (id) => {
    if (cache && cache.id === id && now() - cache.at < ttlMs) return { body: cache.body };
    const url = qqPlaylistQueryFor(id);
    if (!url) return { reason: 'QQ 歌单 id 必须是数字', retryable: false };
    let response;
    try {
      response = await fetcher(url, {
        headers: QQ_PLAYLIST_HEADERS, hosts: PLAYLIST_HOSTS, kind: 'playlist',
        timeoutMs, maxBytes: MAX_PLAYLIST_BODY_BYTES,
      });
    } catch (error) {
      // 被安全层拦下（ONLINE_TARGET_REJECTED）与超时都归"通道这一跳没成"，可重试——
      // 但理由要说得出是哪一类，否则用户只能看到"失败了"。
      const label = String(error?.message ?? error);
      return { reason: `QQ 歌单请求没有发出去或没有回来：${label.slice(0, 120)}`, retryable: true };
    }
    if (!response?.ok) return { reason: `QQ 歌单接口 HTTP ${response?.status ?? '无应答'}`, retryable: true };
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { reason: `QQ 歌单后端返回的不是 JSON（HTTP ${response.status}）`, retryable: true };
    }
    const code = Number(body?.code ?? 0);
    const subcode = Number(body?.subcode ?? 0);
    // 我们的请求被上游的校验挡下（实测缺 Referer 时 `subcode:1 / msg:"invalid referer"`）。
    // 这不是"歌单不存在"，也不是重试能解决的事——是我们这一侧的请求形状错了，说清楚。
    if (code === 0 && subcode !== 0 && !Array.isArray(body?.cdlist)) {
      return { reason: `QQ 没有接受这次歌单请求（subcode ${subcode}${body?.msg ? `：${String(body.msg).slice(0, 60)}` : ''}；这是请求形状的问题，不是这张单不存在）`, retryable: false };
    }
    if (code !== 0 || Number(body?.cdnum ?? 0) === 0 || !Array.isArray(body?.cdlist) || !body.cdlist.length) {
      return { reason: `这张 QQ 歌单不存在或不公开（对 id ${id} 返回 code ${code}、cdnum ${Number(body?.cdnum ?? 0)}）`, retryable: false };
    }
    // id 回显校验：`disstid` 实测是**字符串**，所以两边都转文本再比。
    // 回显不一致意味着我们拿到的不是问的那张单（这一家历史上没观察到错配，但把"导入别人的单"这种表现挡在落盘之前更便宜）。
    const echo = String(body.cdlist[0]?.disstid ?? '').trim();
    if (echo && echo !== String(id)) {
      return { reason: `QQ 回来的歌单 id（${echo.slice(0, 20)}）与请求的（${String(id).slice(0, 20)}）不一致，没有落盘`, retryable: false };
    }
    cache = { id: String(id), at: now(), body };
    return { body };
  };

  /**
   * 与桥 `/bridge/playlist` 同一条契约（`{ok, provider, action, ...}`）——
   * 导入器因此只有一条通路（R114 那课的"合并成一条通路"在这里同样成立）。
   */
  const call = async (payload = {}) => {
    const provider = 'qq';
    const id = String(payload?.id ?? '').trim();
    const action = String(payload?.action ?? 'detail');
    const found = await load(id);
    if (found.reason) return { ok: false, provider, action, reason: found.reason, retryable: found.retryable === true };

    if (action === 'detail') {
      const meta = qqPlaylistToMeta(found.body);
      if (!meta) return { ok: false, provider, action, reason: 'QQ 歌单响应里没有 cdlist 首行（请求没被正确接受，不是"歌单是空的"）', retryable: true };
      return { ok: true, provider, action, ...meta };
    }
    if (action === 'tracks') {
      const offset = Math.max(0, Number(payload?.offset ?? 0) || 0);
      const limit = Math.max(1, Math.min(QQ_PAGE_LIMIT, Number(payload?.limit ?? QQ_PAGE_LIMIT) || QQ_PAGE_LIMIT));
      const items = qqSonglistToItems(found.body?.cdlist?.[0]?.songlist);
      if (items === null) {
        return { ok: false, provider, action, reason: 'QQ 歌单响应里没有 songlist 数组（请求没被正确接受，不是"歌单是空的"）', retryable: true };
      }
      // 接口不认页大小（实测）⇒ 本地切这一刀。回吐的 `limit` 是**这一刀真正用的页大小**（问出去的数
      // 先夹到 QQ_PAGE_LIMIT），与网易/酷狗同一口径：回吐成"这页实际几条"会让导入器把"到底了"
      // 判成"页没满"，白多问一次。
      const page = items.slice(offset, offset + limit);
      return {
        ok: true, provider, action, items: page,
        offset, limit, total: items.length, maxTracks: PLAYLIST_MAX_TRACKS,
      };
    }
    return { ok: false, provider, action, reason: `未知的歌单动作：${action || '（空）'}`, retryable: false };
  };

  return { call, clearCache: () => { cache = null; } };
}
