// 本项目自撰（非移植代码）。收藏列表视图（R132 · 把 R130 那条功能闭环）。
//
// 数据来自 `GET /api/favorites/view`：清单 + 服务端现算的指纹索引，所以"在不在曲库、能不能播"
// 是服务端一句话的事实，而不是界面自己猜（指纹算法住在本机一处，前端再算一遍就是第二个真相）。
//
// 三条形状：
//   ① **灰显 + 明写原因**，不静默隐藏也不画成可播：本地条目查不到就是「文件已不在曲库」，
//      在线身份认不出就是那句实话。藏起来会让用户以为收藏丢了，画成可播会让点击变成静默无果。
//   ② 整行可点 = **以这份收藏列表为队列起播**（R114 那条：全量入队、回执读内核队列的实际条数），
//      不是"单曲队列"——收藏列表就是一张单子，从第 k 行起播之后 ↑↓ 应该有邻居。
//   ③ 封面两个来源，都不是界面自己造的：本地行用**它所在专辑**的既有 `/api/artwork/<专辑 id>`
//      （快照里没有就不传，由 `coverImage` 画占位）；在线行用服务端拿收藏时存下的 `coverRef`
//      换回来的同源 token 地址（R135/Q11；没存过或「在线封面」子开关关着就是空串，同样画占位）。
//      绝不按 id 造一个会 404 的地址（F3 那条老判据），第三方那条 URL 也从不出服务端。
import type { OnlineSearchItem } from "./online-search.ts";
import { coverImage, escapeHtml as esc } from "./html.ts";

/**
 * 毫秒 → "m:ss"；0 或未知给 "--:--"。
 * 这是**第三份**同规则的实现（另两份：`online-search.ts` 的 `formatDuration` 按秒、
 * `playlists-ui.ts` 的 `playlistClock` 按毫秒）。单位口径不一致是这两份各活在自己面板里的历史结果，
 * 合并它们得先定"界面统一按秒还是按毫秒"，不在本批顺手做（顺手做会牵动两个面板的断言）。
 */
export function favoriteClock(durationMs: number): string {
  const total = Math.round((Number(durationMs) || 0) / 1000);
  if (total <= 0) return "--:--";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface FavoriteRow {
  key: string;
  addedAt: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  sourceKind: "local" | "online";
  /**
   * Q14 批复：这条收藏**实际存在的载体集合**（本地 / 在线各自一枚，都有就两枚）。
   * 它由服务端按"指纹在不在曲库 + 清单里写没写在线身份"现算，**与正在播的那首无关**——
   * 列表因此不会随着播放跳来跳去（那是 Q14 里用户点名要避免的那种表现）。
   */
  carriers?: Array<"local" | "online">;
  playable: boolean;
  reason?: string;
  /** 只有本地行有这一项（在线条目不谈"在不在曲库"）；false = 文件已不在曲库。 */
  inLibrary?: boolean;
  trackId?: string;
  albumId?: string;
  /** 在线行的窄契约条目（同源 `audioUrl` 由服务端签发，与搜索结果同一形状）。 */
  online?: OnlineSearchItem;
}

export interface FavoritesView {
  total: number;
  playable: number;
  missing: number;
  limit: number;
  items: FavoriteRow[];
}

/**
 * 一行的状态说法：播不了 ⇒ 服务端给的那句实话；能播 ⇒ **这条收藏实际存在的载体集合**。
 * 载体集合是"本地/在线各自一枚、都有就两枚"（Q14 批复），判据全部来自服务端现算的 `carriers`，
 * 界面不自造第四种解释，也**不跟随正在播的那首**（不跟才不会随播放跳动）。
 *
 * 为什么不是「已收藏」：这一屏上每一条都是收藏，写"已收藏"等于没写；
 * 而"这条在哪几种载体上存在"恰好是唯一一处用户要看的区别（有真封面的是本地那张碟，♪ 的是在线）。
 */
export function favoriteBadge(row: FavoriteRow): string {
  if (!row.playable) return row.reason ? row.reason : "暂时播不了";
  const carriers = Array.isArray(row.carriers) && row.carriers.length
    ? row.carriers
    : [row.sourceKind === "online" ? "online" : "local"];
  return carriers.map((carrier) => (carrier === "online" ? "在线" : "本地")).join(" · ");
}

/**
 * 收藏面板的整块 markup。`coverOf` 由调用方给（它才知道专辑 → 封面这条映射），
 * 这个模块因此是纯函数：Node 里喂夹具就能测，不必起浏览器。
 */
export function favoritesMarkup(view: FavoritesView, options: { coverOf: (row: FavoriteRow) => string } = { coverOf: () => "" }): string {
  const rows = view.items.map((row, index) => {
    const actions = `<button class="text-button" data-action="favorite-remove" data-favorite-index="${index}"`
      + ` aria-label="取消收藏 ${esc(row.title)}">取消收藏</button>`;
    // 整行可点：行本身带 `data-action="favorite-play"`，而委托用的是 `closest("[data-action]")`
    // ⇒ 点在"取消收藏"上时命中的是那颗按钮（更内层的显式动作），不会被行吃掉（R121 那条通则的形状）。
    // 播不了的两处都**不给**这个属性：点了没反应比不给点击更糟，而徽标已经写明为什么播不了。
    const play = row.playable ? ` data-action="favorite-play" data-favorite-index="${index}"` : "";
    const open = row.playable
      ? `<div class="favorite-entry"${play}>`
      : `<div class="favorite-entry is-gone">`;
    // 徽标：载体集合各占一枚（Q14「本地/在线各自标、都有就两枚」）。
    // **两枚必须装在同一格里**：那一行是 5 列网格（`music.css:1170`），直接吐两个 span 会多出一列，
    // 表现是整行错位而 rect 断言照样全绿（R129 那一课）。所以外面只留**一个** `.favorite-entry-badge`，
    // 里面用 `<em>` 做每一枚——格子数因此还是 5，"格子数 = CSS 列数"那条老判据一个字都不用改。
    // 少了 `carriers` 的旧响应退回单选（文本仍由 `favoriteBadge` 一处决定，界面不另算一套）。
    const badges = row.playable && Array.isArray(row.carriers) && row.carriers.length ? row.carriers : null;
    const badge = badges
      ? `<span class="favorite-entry-badge ready">${badges.map((carrier) => `<em>${carrier === "online" ? "在线" : "本地"}</em>`).join("")}</span>`
      : `<span class="favorite-entry-badge${row.playable ? " ready" : ""}">${esc(favoriteBadge(row))}</span>`;
    return open
      + `<span class="favorite-entry-cover">${coverImage(options.coverOf(row), `${row.title}封面`)}</span>`
      + `<span class="favorite-entry-copy">`
      + `<button class="favorite-open"${play}${row.playable ? "" : ' disabled aria-disabled="true"'}`
      + ` aria-label="播放 ${esc(row.title)}">`
      + `<strong>${esc(row.title)}</strong>`
      + `<small>${esc(row.artist)}${row.album ? ` · ${esc(row.album)}` : ""}</small></button></span>`
      + `<span class="favorite-entry-clock">${favoriteClock(row.durationMs)}</span>`
      + badge
      + `<span class="favorite-entry-actions">${actions}</span>`
      + `</div>`;
  });
  const intro = [    `共 ${view.total} 条`,
    `可播 ${view.playable} 条`,
    view.missing ? `${view.missing} 条播不了` : "",
    `上限 ${view.limit} 条`,
  ].filter(Boolean).join(" · ");
  // 「按什么认」必须与 `favoriteKeyOf` 实际吃进去的字段一致（R135/Q12 之后专辑不再参与键）。
  // 代价也写在这句里：极少数"同名同长但不同录音"会被并成一条——不写这一句就是只报好处。
  return `<p class="panel-intro">${esc(intro)}。收藏只写在本机文件里，不上传；`
    + `按「曲名 · 歌手 · 时长」认，挪动文件夹或重扫之后仍然认得，同一首歌的本地与在线是一条收藏`
    + `（代价：极少数同名同长但不同录音的会被并成一条）。</p>`
    + `<div class="panel-actions">`
    + `<button class="primary-button" data-action="favorite-play-all" ${view.playable ? "" : "disabled"}>`
    + `播放全部（${view.playable} 条可播）</button></div>`
    + `<p id="favorite-status" class="scan-status" role="status" aria-live="polite"></p>`
    + (rows.length
      ? `<div id="favorite-entries">${rows.join("")}</div>`
      : `<div class="no-results">还没有收藏。播放一首歌，点传输区那颗心（或封面墙动作行那颗「喜欢」）就有了。</div>`);
}
