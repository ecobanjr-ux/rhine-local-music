// 本项目自撰（非移植代码）。歌单面板（Task 11）：列表 / 详情 / 匹配状态 / 整单播放 / 导出文本。
//
// 三条与"这张单子内不内行"直接有关的形状：
//   ① 状态徽标只有三档：`已匹配 · 来源` / `未匹配（原因）` / `未查`。
//      "未查"与"未匹配"必须分得开——前者是没点过匹配，后者是查过没配上，两者的下一步动作不一样。
//      抬头那行与徽标共用 isMatchedMiss 这一个判据：口径分家会在同一屏写出"5 条全是未查、
//      抬头却说未匹配 5 条"（真机截图 43 抓到的就是这个）。
//   ② 整单播放**跳过未匹配并计数**："这张 20 条里 3 条没配上"必须说出来，不能静默少 3 首
//      （服务端 /tracks 的 unmatched 就是"总数 − 已匹配"，播放那行直接用它报跳过数）。
//   ③ 导出就是下载那份**用户能自己编辑的文本**（可携带性是需求原文）：
//      不导 JSON、不导内部 id，导出的文件粘回来还能读（Task 8 的可逆性）。
import type { OnlineSearchItem } from "./online-search.ts";
import { ONLINE_PROVIDER_LABELS, type OnlineProvider } from "./lyrics-client.ts";
import { coverImage } from "./html.ts";

export interface PlaylistSummary {
  id: string;
  name: string;
  items: number;
  warnings: number;
  updatedAt: number;
}

export interface PlaylistEntryView {
  entry: { title: string; artist: string; album?: string; durationMs?: number };
  matched: boolean;
  track?: OnlineSearchItem;
  score?: number;
  // `inline` = 条目自带在线身份（从搜索结果直接加进来的），不来自搜索匹配也不来自 sidecar。
  // R220 `identity` = 这一行用的是**列/导入账号歌单时就拿到的来源身份**（同样没经过搜索），
  // 两者的区别要分得开：前者是用户手工加进来的那一首、后者是这张单自己的来历。
  source: "cache" | "none" | "inline" | "identity";
  reason?: string;
  /** 这一条在文件里的行号（R127 手工指定要"只改目标行"）。老服务端没给就是 null ⇒ 不给那颗按钮。 */
  line: number | null;
  /** 当时那一行的原文，写回时做对照；`line` 为 null 时也是空串。 */
  lineText: string;
  /**
   * R146：这张封面图是**另一家**给的时候，那里写着它的来源；正路（匹配那一首自己带图）是空。
   * 它只影响徽标文案，不参与匹配、播放与任何判据。
   */
  coverFrom?: string | null;
  /**
   * R150（Q18）：这一条是「匹配时优先已登录音源」**改选**出来的（开关开着、登录源那首与全局最高分
   * 相差在边距内）。`over` 是让位那一首的**读数**（来源 / 曲名 / 歌手 / 分数），不是结论词。
   * 没改选时两格都不存在（缺省关闭 ⇒ 服务端那份缓存里根本不会有），徽标与今天逐字一样。
   */
  preferred?: boolean;
  /**
   * R156（任务三）：改选这一条的是哪一条规则。`same-platform` = 按这张单的来历注释
   * （`# qq-playlist …`）优先了同一家；`logged-in` = 按"这台机器已登录"优先了那一家。
   * 服务端两条都会写；**老记录没有这一格**，读侧回落到 `logged-in`（那批数据写入时只有那一条规则）。
   */
  preferredBy?: "same-platform" | "logged-in";
  over?: { provider?: string; title?: string; artist?: string; score?: number } | null;
}

/** 「手工指定」的目标：行号 + 当时看到的那一行原文（写回时做对照，对不上就不写）。 */
export interface PlaylistPickTarget {
  playlistId: string;
  line: number;
  expect: string;
  title: string;
  artist: string;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  items: PlaylistEntryView[];
  matched: number;
  unmatched: number;
  /**
   * R198：这张歌单的展示封面（服务端按 sidecar 的 `displayCoverRef` 签出的**同源** token 地址）。
   * 空/缺 = 还没有（架子那格画程序化拼贴）⇒ 详情里就不显示「恢复程序化封面」那颗按钮。
   */
  displayCoverUrl?: string;
  /**
   * R220：这张单的来历（`# kugou-playlist <id> imported …`）。有它才有「补一次来源身份」那颗按钮 ——
   * 没有来历注释的单（自己写的文本）补不了，按钮就不出现，而不是点下去给一句失败。
   */
  sourceProvenance?: { provider: string; id: string } | null;
}

export const PLAYLIST_BADGE = "已匹配";
export const PLAYLIST_UNCHECKED = "未查";

/** 查过没配上才算"未匹配"（服务端在 sidecar 里留了痕）；没查过的算"未查"。徽标与整单计数共用这一个判据。 */
export function isMatchedMiss(item: PlaylistEntryView): boolean {
  return !item.matched && (item.source === "cache" || Boolean(item.reason));
}

/** 单条的状态徽标。三档，不合并——合并就等于把"还没查过"说成"查了没有"。 */
/** 来源的中文名（歌单这一侧的写法；歌词面那条徽标用的是 lyrics-client 里的共享表）。 */
/**
 * 名字读**那张共享表**（`ONLINE_PROVIDER_LABELS`，歌词徽标与设置面板联网声明用的同一份）。
 * 原先这里自己写了一个三元表达式，只认网易云与 QQ 两档 ⇒ 酷狗的行会露出内部名 `kugou`
 * （R146 的「封面来自 X」与 R150 的「让位」两句都走这一格，第五期把源扩到四家时就该改了）。
 * 表里没有的名字照原样显示：未知时宁可给原始值，也不替它编一个中文名。
 */
const providerName = (value?: string) => {
  if (!value) return "未知来源";
  return Object.hasOwn(ONLINE_PROVIDER_LABELS, value)
    ? ONLINE_PROVIDER_LABELS[value as OnlineProvider]
    : value;
};

export function entryBadge(item: PlaylistEntryView): string {
  if (item.matched && item.track) {
    // R220：这一行走的是**来源身份**（列/导入账号歌单那一步上游就给了 id），没有搜索、也就没有分数。
    // 必须与"靠搜索匹配上的那一首"分开说——混成一种说法，用户就看不出这张单为什么不用重搜了。
    if (item.source === "identity") return `${PLAYLIST_BADGE} · ${providerName(item.track.provider)}（来源身份）`;
    // R146：图是另一家给的时候要说出来——是"匹配那一首没给封面地址才借的图"，
    // 不说的会让人以为这家根本没有这张图的版本，也就不会去点「重取封面」。
    const borrowed = item.coverFrom && item.coverFrom !== item.track.provider
      ? ` · 封面来自 ${providerName(item.coverFrom)}` : "";
    return `${PLAYLIST_BADGE} · ${providerName(item.track.provider)}${item.score ? ` ${item.score}分` : ""}${borrowed}${yieldedLabel(item)}`;
  }
  if (isMatchedMiss(item)) return `未匹配（${item.reason ?? "原因未给出"}）`;
  return PLAYLIST_UNCHECKED;
}

/**
 * 「让位」那一句（R150 · Q18）：偏好改选过的那一行要说得清"本来有一首分更高的让给了登录源"，
 * 否则用户看到的是一次**没有依据的降级**（79 分而不是 82 分），而它恰恰是最该被看见的那一格。
 * 三个条件缺一不可：确实改选了、让位那一首认得出来源、而且它**不是**这一行自己
 * （同一来源谈不上让位——那是 `sameIdentity` 那条正路，写出来就是一句谎话）。
 */
export function yieldedLabel(item: PlaylistEntryView): string {
  const over = item.preferred ? item.over : null;
  if (!over?.provider || !item.track || over.provider === item.track.provider) return "";
  const score = typeof over.score === "number" ? ` ${over.score} 分` : "";
  // R156（任务三）：两条偏好叠着走，徽标必须说得出**是哪一条**改选的——
  // "同平台"讲的是这张单的来历，"登录源"讲的是这台机器的权益，混成一句用户就分不出该关哪一条。
  // 老缓存记录里没有 `preferredBy` 那一格 ⇒ 回落到"登录源优先"（它写入时只有那一条规则，不算猜）。
  const rule = item.preferredBy === "same-platform" ? "同平台优先" : "登录源优先";
  return ` · ${rule}（${providerName(over.provider)}${score}那首已让位）`;
}

/** 秒 → "m:ss"；0/未知给 "--:--"（在线结果常不带时长，网易匿名档就常见 0）。 */
export function playlistClock(durationMs: number): string {
  const total = Math.round((Number(durationMs) || 0) / 1000);
  if (total <= 0) return "--:--";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string,
  );

/** 列表页：每单显示"条目数 · 已匹配数 · 更新时间"，外加新建与粘贴导入两个入口。 */
/**
 * R159（任务六）· 账号歌单：只读的一期。三家的状态分开写，QQ 那一格不是"坏了"而是"没量到"——
 * 这句话必须让用户看见，否则他会以为是我们不肯做。
 */
export const ACCOUNT_PLAYLIST_PROVIDERS = [
  { id: "netease", label: "网易云音乐", available: true },
  { id: "kugou", label: "酷狗音乐", available: true },
  { id: "qq", label: "QQ 音乐", available: false },
] as const;

export interface AccountPlaylistRow {
  provider: string;
  id: string;
  /**
   * R182：写侧用的号（"加进来"那颗按钮带的就是它）。酷狗读侧用 `global_collection_id`、写侧要 `listid`，
   * 两个号不同；网易同号。缺省回落 `id`（老缓存 / 万一上游没给这一格 ⇒ 由服务端那道数字闸如实拒掉）。
   */
  writeId?: string;
  name: string;
  /**
   * 这张账号歌单的条数。**`null` = 上游没给这一格**（与"上游给了 0"是两件事，R188/Q65 之前
   * 那句 `trackCount > 0 ? … : "条数未知"` 把"已知 0"也写成了未知）。
   */
  trackCount: number | null;
}

/**
 * R165（任务十一）：此刻可以往账号歌单里加的那一首在线曲目。
 * 来源与那一行不同家时按钮要**禁用并说清为什么**——把网易的曲目 id 塞进酷狗的歌单形状完全合法，
 * 而"平台大概会拒"不是我们的护栏（与 R159 同一立场）。
 */
export interface AccountPlaylistAddable {
  provider: string;
  trackId: string;
  label: string;
}

export function accountPlaylistMarkup(rows: AccountPlaylistRow[], addable: AccountPlaylistAddable | null = null): string {
  if (!rows.length) return `<div class="no-results">这张账号里没有歌单（是真的没有，不是没列出来）。</div>`;
  return rows.map((row) => {
    const sameHome = Boolean(addable && addable.provider === row.provider);
    const why = addable
      ? `正在播的这首来自${providerName(addable.provider)}，与这一家不是同一家`
      : "先播一首在线曲目，才能往账号歌单里加";
    const addButton = sameHome
      ? `<button class="text-button" data-action="account-playlist-add" data-provider="${esc(row.provider)}"` +
        ` data-account-id="${esc(row.writeId ?? row.id)}" data-account-name="${esc(row.name)}"` +
        ` data-track-id="${esc(addable?.trackId ?? "")}" data-track-name="${esc(addable?.label ?? "")}">把这首加进来 ↗</button>`
      : `<button class="text-button" disabled title="${esc(why)}">把这首加进来</button>`;
    // R188（Q65）：`trackCount === null` 是"上游没给这一格"，0 是"上游给了 0"——两件事不能都写成"未知"。
    const countLabel = Number.isFinite(row.trackCount) ? `${row.trackCount} 条 · ` : "条数未知 · ";
    // R187（Q64）：两颗按钮包进一个 flex 容器。原先它们是 `.album-result` 的第 3、4 个子节点，
    // 会被塞进给「歌单 / ↗」留的 35px / 14px 两列 ⇒ 每颗按钮一个字一行竖排（真机截图可见）。
    return `<div class="album-result playlist-row account-playlist-row">` +
      `<span class="result-cover"></span><span class="result-copy"><strong>${esc(row.name)}</strong>` +
      `<small>${countLabel}${esc(providerName(row.provider))} · <code>${esc(row.id)}</code></small></span>` +
      `<span class="account-playlist-actions">` +
      `<button class="text-button" data-action="account-playlist-import" data-provider="${esc(row.provider)}"` +
      ` data-account-id="${esc(row.id)}" data-account-name="${esc(row.name)}">导入为文本 ↗</button>${addButton}</span></div>`;
  }).join("");
}

export function listMarkup(playlists: PlaylistSummary[], dirLabel?: string): string {
  const rows = playlists.map((playlist) =>
    `<button class="album-result playlist-row" data-playlist="${esc(playlist.id)}" aria-label="打开歌单 ${esc(playlist.name)}">` +
    `<span class="result-cover"></span><span class="result-copy"><strong>${esc(playlist.name)}</strong>` +
    `<small>${playlist.items} 条${playlist.warnings ? ` · ${playlist.warnings} 行没读懂` : ""} · ${esc(playlistUpdatedAt(playlist.updatedAt))}</small></span>` +
    `<em>歌单</em><i>↗</i></button>`);
  // 抬头那句要指着**真正在用的那个文件夹**说（F3 之后它可以被用户改走，写死"数据目录/playlists"就成了假话）。
  const where = dirLabel ? `（<code>${esc(dirLabel)}</code>）` : "（数据目录/playlists）";
  return `<p class="panel-intro">歌单是<b>本机上的纯文本文件</b>${where}，` +
    `可以用任何编辑器改，改完不用重启。每行写成 <code>歌名 - 歌手</code>，可选 <code>| 专辑 | 时长</code>。</p>` +
    `<div class="panel-actions"><button class="primary-button" data-action="playlist-import">粘贴歌单链接导入 ↗</button>` +
    `<button data-action="playlist-new">新建空歌单</button></div>` +
    `<div id="playlist-import-box" hidden></div>` +
    (rows.length ? `<div id="playlist-list">${rows.join("")}</div>`
      : `<div class="no-results">还没有歌单。点上面两个入口之一开始。</div>`) +
    // R159（任务六）· 账号歌单：只读的一期。列出来之后动作是"导入为文本"——
    // 播放与匹配都走本机那张文本歌单已有的那条路（R114：一条通路；开第二条迟早有一处漏）。
    // R165（任务十一）· 写侧第一次开：只开"把一首加进我自己的歌单"这一条，
    // **不建单、不改单、不删单**（删这件事请回平台上做，我们不提供第二条能毁掉你东西的路径）。
    `<hr class="panel-rule"><p class="panel-intro"><b>账号歌单</b>：登录后可以列出你自己账号里的歌单，` +
    `选一张导入成本机的文本歌单——播放、匹配、封面都走上面那条已有的路。` +
    `也可以<b>把正在播的那一首在线曲目加进你自己的一张歌单</b>（这是写操作，点下去会再确认一次；` +
    `这里<b>只加不删</b>，也不建单、不改单）。</p>` +
    `<div class="panel-actions">` +
    ACCOUNT_PLAYLIST_PROVIDERS.map((entry) => entry.available
      ? `<button data-action="account-playlist-list" data-provider="${entry.id}">列${entry.label}的歌单</button>`
      : `<button disabled title="本机还没量到这一家的列表端点（不猜）">${entry.label}：暂不支持</button>`).join("") +
    `</div><div id="account-playlist-box" hidden></div>` +
    `<p id="account-playlist-status" class="scan-status" role="status" aria-live="polite"></p>`;
}

function playlistUpdatedAt(milliseconds: number): string {
  const time = Number(milliseconds);
  if (!Number.isFinite(time) || time <= 0) return "未知时间";
  return new Date(time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * 详情页：条目表 + 三个动作。
 * `matchedLabel` 是"匹配 4/5"这种同时显示已匹配数与总数的写法——只报一个数会让人以为整单都能播。
 */
export function detailMarkup(detail: PlaylistDetail): string {
  const matchedLabel = `匹配 ${detail.matched}/${detail.items.length}`;
  // 抬头那行跟徽标共用 isMatchedMiss：一条都没查过时只能说"未查"，说成"未匹配"就是把"没做过"报成"做失败了"。
  const misses = detail.items.filter(isMatchedMiss).length;
  const unchecked = detail.items.length - detail.matched - misses;
  const tally = [misses ? `未匹配 ${misses} 条` : "", unchecked ? `未查 ${unchecked} 条` : ""]
    .filter(Boolean).join(" · ");
  const rows = detail.items.map((item, index) => {
    // 动作全部装进一个 wrapper：这一格是网格里的一列，两颗按钮直接并排放就会撑出第五列
    //（真机截图 86-1 里「手工指定」被挤到下一行、左对齐在曲名下面 —— 看着像另一条条目）。
    const actions = item.matched && item.track
      ? `<button class="text-button" data-action="playlist-play-entry" data-entry="${index}" aria-label="播放 ${esc(item.entry.title)}">试听</button>`
      : // 「重搜」是再问一次自动匹配，「手工指定」是"我自己来认这一首"——两件事，两颗按钮，都留给未匹配的行。
        // 只有拿得到行号（`line`）时才给后者：没有行号就做不到"只改目标行"，宁可不给按钮也不猜。
        `<button class="text-button" data-action="playlist-match-entry" data-entry="${index}" aria-label="重新匹配 ${esc(item.entry.title)}">重搜</button>` +
        (item.line
          ? `<button class="text-button" data-action="playlist-pick-open" data-entry="${index}" aria-label="手工指定 ${esc(item.entry.title)} 对应的那一首">手工指定</button>`
          : "");
    return `<div class="playlist-entry" data-playlist-entry="${index}">` +
    `<span class="playlist-entry-cover">${coverImage(item.track?.coverUrl ?? "", `${item.entry.title}封面`)}</span>` +
    `<span class="playlist-entry-copy"><strong>${esc(item.entry.title)}</strong>` +
    `<small>${esc(item.entry.artist)}${item.entry.album ? ` · ${esc(item.entry.album)}` : ""}</small></span>` +
    `<span class="playlist-entry-clock">${playlistClock(item.entry.durationMs ?? 0)}</span>` +
    `<span class="playlist-entry-badge${item.matched ? " matched" : ""}">${esc(entryBadge(item))}</span>` +
    `<span class="playlist-entry-actions">${actions}</span>` +
    `</div>`;
  });
  return `<p class="panel-intro">${esc(detail.name)} · ${matchedLabel}${tally ? ` · ${tally}` : ""}</p>` +
    `<div class="panel-actions">` +
    `<button class="primary-button" data-action="playlist-match-all">联网匹配整单 ↗</button>` +
    `<button data-action="playlist-play-all" ${detail.matched ? "" : "disabled"}>播放已匹配的 ${detail.matched} 条</button>` +
    // R198：展示封面是"点播放之后自动选的"；不想让它当封面就删掉那一格（架子回到程序化拼贴）。
    (detail.displayCoverUrl
      ? `<button data-action="playlist-cover-clear" aria-label="把这张歌单的封面恢复成程序化拼贴">恢复程序化封面</button>`
      : "") +
    // R220：老歌单（导入时还没存身份的那些）补一次来源身份 —— 按文件头的来历重新列一次那张账号单，
    // 只写 sidecar，正文一个字都不动。没有来历注释的单不给这颗按钮（服务端也会同样实话，但按钮不该骗人）。
    (detail.sourceProvenance
      ? `<button data-action="playlist-fill-identity" aria-label="按这张单的来历重新列一次账号歌单，把每行的来源身份补进缓存">补一次来源身份 ↗</button>`
      : "") +
    `<button data-action="playlist-export">导出为文本歌单</button>` +
    `<button data-action="playlist-delete" class="text-button">删除这张歌单</button>` +
    `</div>` +
    `<p id="playlist-status" class="scan-status" role="status" aria-live="polite"></p>` +
    (rows.length ? `<div id="playlist-entries">${rows.join("")}</div>` : `<div class="no-results">这张歌单还是空的。</div>`);
}

/**
 * ⑨ 在线音乐人组的面板：成员列表 + 「播放全部」。
 * 与歌单详情同款样式，但**没有**"联网匹配整单 / 导出 / 删除"那三颗——这一组的成员是别处来的，
 * 在这里给匹配入口会让人以为能"把这组匹配上"，而它本来就是从已匹配的条目聚出来的。
 * 抬头那句必须说清数据从哪来（"来自本机 N 张歌单里已匹配的在线条目"），
 * 否则它看起来像平台给的歌手页，而我们对平台侧一无所取。
 */
export function artistMarkup(detail: {
  name: string;
  playlists: string[];
  items: { id: string; title: string; artist: string; album?: string; durationMs: number; coverUrl?: string }[];
}): string {
  const from = detail.playlists.length
    ? `来自本机 ${detail.playlists.length} 张歌单里已匹配的在线条目（${esc(detail.playlists.slice(0, 3).join("、"))}${detail.playlists.length > 3 ? " 等" : ""}）`
    : "来自本机歌单里已匹配的在线条目";
  const rows = detail.items.map((item, index) =>
    // `artist-entry` 这一类是必须的：`.playlist-entry` 的四列网格第一位留给曲名，
    // 多了封面格就会把曲名挤成 40px 宽（真机截图里"纵横四 / 海"断成两行就是这么来的）。
    `<div class="playlist-entry artist-entry" data-artist-entry="${index}">` +
    `<span class="playlist-entry-cover">${coverImage(item.coverUrl ?? "", `${item.title}封面`)}</span>` +
    `<span class="playlist-entry-copy"><strong>${esc(item.title)}</strong>` +
    `<small>${esc(item.artist)}${item.album ? ` · ${esc(item.album)}` : ""}</small></span>` +
    `<span class="playlist-entry-clock">${playlistClock(item.durationMs ?? 0)}</span>` +
    `<button class="text-button" data-action="artist-play-entry" data-entry="${index}" aria-label="播放 ${esc(item.title)}">试听</button>` +
    `</div>`).join("");
  return `<p class="panel-intro">${esc(detail.name)} · ${detail.items.length} 首 · ${from}</p>` +
    `<div class="panel-actions">` +
    `<button class="primary-button" data-action="artist-play-all" ${detail.items.length ? "" : "disabled"}>播放全部 ${detail.items.length} 条</button>` +
    // R162（任务九）：⑨ 管数据（聚组、整组入队），这一颗打开的是"一组的浏览面"——
    // 原版那面六边形网格，画的是这一份已经取回来的明细，一次额外的网都不出。
    `<button class="text-button" data-action="artist-grid-view" ${detail.items.length ? "" : "disabled"}>网格视图</button>` +
    `</div>` +
    `<p id="artist-status" class="scan-status" role="status" aria-live="polite"></p>` +
    (detail.items.length ? `<div id="artist-entries">${rows}</div>` : `<div class="no-results">这位音乐人在本机歌单里还没有已匹配的在线条目。</div>`);
}

/** 粘贴导入的响应（服务端 playlist-import.mjs 的那份结论）。 */
export interface PlaylistImportResult {
  ok: boolean;
  /** `<平台>-id`（netease / kugou / qq）或 text —— R137 之后不止网易一家，这里不许写死一个字面量。 */
  source: string;
  provider?: string;
  id: string;
  name: string;
  items: number;
  total: number;
  truncated: boolean;
  /** R158（任务五）· 酷狗手机分享页：**只取到首屏**不是"我们截断了"。
   *  这一格必须自己走一支——`truncated` 与 `dropped` 都是 false 时，界面原来那句会把"共 898 条"吞掉。 */
  firstScreen?: boolean;
  /** 上游报了 N 条、实际落进来少于 N 条且不是因为截断（例如某条没有曲名）⇒ 这个数必须说出来。 */
  dropped?: number;
  warning?: string;
  /** R220：导入这一步顺手写进 sidecar 的来源身份统计（写失败时 `failed:true`，那句实话要出现在回执里）。 */
  sourceIdentities?: { filled: number; unfilled: number; total: number; failed?: boolean };
  warnings?: { line: number; reason: string }[];
}

/** 导出用的文件名：与磁盘上那张文本歌单同名，粘回来还能读。 */
export function exportFileName(id: string): string {
  return `${id}.playlist.txt`;
}

/**
 * "加入歌单"的选择器（F2：搜索结果加进歌单）。
 * 现存的每一张都是一个按钮——不做成下拉是刻意的：歌单名可能很长、还要同时看到每单条数，
 * 而"新建一张并加入"必须和"加进已有的"并排出现，否则零歌单的用户点第一个按钮只会撞墙。
 */
export function addToPlaylistMarkup(playlists: PlaylistSummary[], entry: { title: string }): string {
  const rows = playlists.map((playlist) =>
    `<button class="text-button" data-action="playlist-add-to" data-playlist="${esc(playlist.id)}" aria-label="把 ${esc(entry.title)} 加进 ${esc(playlist.name)}">加进「${esc(playlist.name)}」（${playlist.items} 条）</button>`).join("");
  return `<div class="playlist-chooser" data-role="playlist-chooser">` +
    `<span class="playlist-chooser-label">把「${esc(entry.title)}」加进哪张歌单？</span>${rows}` +
    `<span class="playlist-chooser-new"><input id="playlist-add-new" type="text" placeholder="新歌单名" aria-label="新歌单名字">` +
    `<button data-action="playlist-add-create">新建并加入</button></span>` +
    `<button class="text-button" data-action="playlist-add-cancel">取消</button></div>`;
}

/**
 * 「手工指定」进行中的那条说明（R127 · 方案 B），挂在检索结果上面。
 * 为什么要把"会写回文件"写在脸上：这一条与"加入歌单"最大的区别就是它**改用户那份文本**，
 * 悄悄改与不告诉用户是同一件事。行号、原文那一行、只改一行、会留 `.backup`，四件都在这里说清。
 */
export function pickBannerMarkup(target: PlaylistPickTarget, name: string): string {
  return `<div class="playlist-pick-banner" data-ponder="playlist-pick-banner">` +
    `<span>手工指定：正在为 <b>${esc(name)}</b> 的 <b>第 ${target.line} 行</b>「${esc(target.title)} - ${esc(target.artist)}」挑一首。` +
    `选中之后<b>只替换那一行</b>（其余各行、<code>#</code> 注释与 <code>[album]</code> 分组原样不动），写回前会留一份 <code>.backup</code>。</span>` +
    `<button class="text-button" data-action="playlist-pick-cancel">取消</button></div>`;
}

/** 检索结果每一行在"手工指定"模式下多出来的那颗：把这一条写进目标行。 */
export function pickRowMarkup(index: number, item: { title: string; artist: string }): string {
  return `<button class="text-button online-pick" data-action="playlist-pick-run" data-online-index="${index}" ` +
    `aria-label="用 ${esc(item.title)} 替换那一行">指定这一条</button>`;
}
