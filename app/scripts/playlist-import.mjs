// 本项目自撰（非移植代码）。粘贴导入 v1：把"用户粘贴的东西"变成 Task 8 那张文本歌单（Task 10）。
//
// 三认（用户给的可能是链接、可能是纯 id、也可能直接是一段歌名+歌手）：
//   ① `https://music.163.com/playlist?id=17429985859`（含 `#/playlist?id=` 与 `si=` 尾巴这些变体）
//   ② `17429985859`
//   ③ `恋人 - 李荣浩\n黑马 - 李荣浩`（走 Task 8 的解析器，一条网都不出）
// R137 把 ① 与 ② 扩到三家：**认平台靠域名**（music.163.com / y.qq.com / kugou.com），
// 认 id 靠各家的形状（网易是数字、酷狗是 `collection_a_b_c_d`、QQ 是数字），认不出来给一句可读的拒绝。
// R138 把 QQ 那一家从"认得但拒导"接通：字段名量到了（一条真实公开歌单），解析与出网通道见 `playlist-qq.mjs`。
// 同批还把酷狗**手机分享的 `gcid_` 形态**分清：认得出来，但接口只认 `global_collection_id`，
// 而 gcid_ 那段推不出它（一手试过六种拼法全读不到）⇒ 那种链接给的是"为什么读不到"，不是"认不出"。
// R158（任务五）把这一条从"拒"改成"能导首屏"：走的不是曲目接口而是**手机分享页本身**（SSR，
// HTML 里注着 `window.$output`），拿得到首屏十首与整单总数，拿不到整单（那一族里 collection id 是空串）
// ⇒ 回执与文件注释都必须说"共 N 条、只取到首屏 M 条"，不许让它看起来像"这张单只有 M 首"。
//
// 两个上限是**两件事**（Q16 定案：各管各的，别混）：
//   · `PLAYLIST_MAX_TRACKS = 1000`（`IMPORT_MAX_TRACKS` 就是它）= **一次导入最多取多少条曲目**，
//     从上游 omni.ts:291 继承的硬顶，到了顶必须把"共 N 条只导入前 1000 条"报出来；
//   · `MAX_PLAYLIST_LINES = 2000`（`playlists.mjs`）= **歌单文本文件最多写多少行**，
//     管的是磁盘上那个文件的大小（含注释与分组行），与"从平台取几条"无关。
// 导入那一路先被 1000 挡住，所以正常情况永远撞不到 2000；两个数同时出现在这里是为了不再被当成一个。
//
// 两条与"诚实"直接有关的形状：
//   · **分页以 detail 的总数为准**（网易 `trackCount`、酷狗 `count`），不照 `items.length === limit` 猜
//     （Task 0 U7 实测：limit=200 对 173 条的歌单返回 173 条、第二页 0 条，恰好等长时那条启发式会误判）；
//   · **1000 条上限是我们从上游 omni.ts:291 继承的，不是接口给的** ⇒ 到了顶就必须把
//     "共 N 条，只导入前 1000 条"显式报出来（V9），不许静默少一截。
// 来历写回头注释（`# <平台>-playlist <id> imported <ISO>`）：用户事后打开文件能看出这张单从哪来。
import { PLAYLIST_MAX_TRACKS, PLAYLIST_PAGE_LIMIT } from './bridge/playlist-routes.mjs';
import { parsePlaylistText, serializePlaylist, slugOf, provenanceComment } from './playlists.mjs';
// R158（任务五）：手机分享页那一路的**形状判据**（同一个常量，两边不各写一份正则）。
// 只 import 这一格正则，不 import 它的取页函数 ⇒ 导入器自己不出网，出网仍只在 `playlist-kugou-share.mjs` 那一处。
import { KUGOU_SHARE_TOKEN } from './playlist-kugou-share.mjs';

const NETEASE_LINK_HOSTS = new Set(['music.163.com', 'music.163.com.cn', '163cn.app']);
/**
 * 这张表**只是"认用户贴进来的链接"**，不是出网白名单（出网那一层见 `online-guard.mjs` 的 `PLAYLIST_HOSTS`，
 * 那里一个名字都要实测换来）。R138 补 `i2.y.qq.com`：手机微信里分享出来的 QQ 歌单就是这条主机
 * （`/n3/other/pages/details/playlist.html?...&id=<数字>`），桌面端是 `y.qq.com/n/ryqq/playlist/<数字>`。
 * 只补实测量到的那一个名字，不顺手加 `*.y.qq.com`。
 */
const QQ_LINK_HOSTS = new Set(['y.qq.com', 'i.y.qq.com', 'i2.y.qq.com', 'musicteam.qq.com', 'quantumult.app']);
const KUGOU_LINK_HOSTS = new Set(['kugou.com', 'www.kugou.com', 'm.kugou.com', 'songlist.kugou.com', 'list.kugou.com',
  // 短链 302 之后落在那台主机的分享页上（一手实测 2026-10-10）。**认链接 ≠ 出网白名单**：
  // 我们从不对它发请求（只从链接文本里读 id），所以它不进 `online-guard.mjs` 的任何一张表。
  'activity.kugou.com']);
/**
 * 酷狗"口令短链"的主机（R155 · 任务二，一手实测）：`https://t1.kugou.com/<token>` 回 **302**，
 * `Location` 里带着 `global_specialid=collection_3_2502594575_2_0` —— 那正是本文件认的那个 id 空间。
 * 所以这一条链的"解析"只有一次一跳的代价：**读 Location、从里面取 id，绝不请求 Location 指向的主机**。
 */
const KUGOU_SHORTLINK_HOSTS = new Set(['t1.kugou.com']);
/** 酷狗的 global_collection_id 形状（一手样本两种，见 `bridge/playlist-routes.mjs` 头部）。 */
const KUGOU_ID = /collection_\d{1,4}_\d{1,20}_\d{1,20}_\d{1,4}/;

/**
 * 从短链 302 的 `Location` 里取歌单 id（纯函数，离线可判）。
 * 两条讲究：① **只认 id 那一段**，整条地址不外传（它是上游给的第三方 URL，出服务端就等于开了一个
 * "让浏览器自己去打它"的口子，与封面/音源同一条红线）；② 认不出来就说认不出来，
 * 不拿 `specialid=-2147483648` 那种哨兵值凑数（一手实测：短链里 `specialid` 就是这个负数，
 * 而 R137 早已量过 specialid 推不出 global_collection_id）。
 */
export function kugouCollectionIdFromTarget(target) {
  const text = String(target ?? '');
  const direct = KUGOU_ID.exec(text);
  if (direct) return { ok: true, id: direct[0] };
  let param = '';
  try {
    param = decodeURIComponent(new URL(text.startsWith('http') ? text : `https://${text}`).searchParams.get('global_specialid') ?? '');
  } catch { param = '' }
  return KUGOU_ID.test(param) ? { ok: true, id: KUGOU_ID.exec(param)[0] } : { ok: false, reason: '那条短链转过去的地址里没有酷狗歌单 id（global_specialid 缺席或形状不对）' };
}
/**
 * 每家一次问多少条。酷狗的页大小由桥那一侧夹到 200，这里就按 200 走，两边同一个数不是巧合；
 * QQ 那一家的接口**不认页大小**（实测 `num`/`offset`/`limit` 全部忽略、一次给整张单）⇒ 这里按导入上限问，
 * 本地切一刀，一次出网拿完（见 `playlist-qq.mjs` 头部第 ③ 条）。
 */
const PAGE_LIMIT_BY_PROVIDER = { netease: PLAYLIST_PAGE_LIMIT, kugou: 200, qq: PLAYLIST_MAX_TRACKS };
const PROVIDER_NAMES = { netease: '网易', qq: 'QQ', kugou: '酷狗' };

/**
 * 判断粘贴进来的是哪一种。返回 `{kind:'netease-id'|'kugou-id'|'qq-id'|'text'|'empty'|'unknown', ...}`，
 * 不抛——"认不出来"是一个要显示给用户看的结论，不是一次异常。
 */
export function parseImportInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { kind: 'empty', error: '先粘贴一点东西：网易 / QQ / 酷狗的歌单链接、歌单 id，或者一段"歌名 - 歌手"。' };
  }
  // 酷狗的 id 自带前缀，一眼认得（纯 id 与链接里嵌着都算）
  const kugou = KUGOU_ID.exec(text);
  if (kugou) return { kind: 'kugou-id', provider: 'kugou', id: kugou[0] };
  // 也有人只把手机分享那一段 token 贴过来（没有链接外壳）：R158 起这一条能导首屏，走同一扇门
  if (KUGOU_SHARE_TOKEN.test(text)) return { kind: 'kugou-share', provider: 'kugou', token: text };
  // 纯数字（允许首尾空白）：这一家历史上只有网易给数字 id，保持原行为不动
  if (/^\d{1,20}$/.test(text)) return { kind: 'netease-id', provider: 'netease', id: text };
  // 链接：按**域名**认平台，再从查询串或路径里捞 id
  for (const candidate of text.split(/\s+/)) {
    if (!/^https?:\/\//i.test(candidate) && !/\.(163\.com|qq\.com|kugou\.com)/i.test(candidate)) continue;
    let host = '';
    try { host = new URL(candidate.startsWith('http') ? candidate : `https://${candidate}`).host.toLowerCase(); } catch { host = '' }
    const queryId = /[?&](?:id|disstid|songlistid|global_collection_id)=([^&#\s]+)/i.exec(candidate)?.[1];
    const pathId = /(?:playlist|songlist|pl)\/([\w-]{1,60})/i.exec(candidate)?.[1];
    const id = decodeURIComponent(queryId ?? pathId ?? '');
    if (QQ_LINK_HOSTS.has(host)) {
      return /^\d{1,20}$/.test(id)
        ? { kind: 'qq-id', provider: 'qq', id }
        : { kind: 'unknown', error: `认不出这条 QQ 歌单链接里的歌单 id（拿到的是「${(id || '空').slice(0, 40)}」）。`
          + '桌面端形如 https://y.qq.com/n/ryqq/playlist/<数字>，手机分享形如 https://i2.y.qq.com/…playlist.html?id=<数字>。' };
    }
    if (KUGOU_SHORTLINK_HOSTS.has(host)) {
      // 短链本身不含 id（`t1.kugou.com/<一段不透明 token>`）⇒ 交给导入器去问一跳。
      // 这里**不**顺手把 token 当 id 用：它既不是 collection_ 也不是数字，猜出来的只会是一句假话。
      const token = /^https?:\/\/t1\.kugou\.com\/([A-Za-z0-9]{4,32})\/?$/i.exec(candidate)?.[1] ?? '';
      return token
        ? { kind: 'kugou-shortlink', provider: 'kugou', url: `https://t1.kugou.com/${token}` }
        : { kind: 'unknown', error: '酷狗短链的形状认得（https://t1.kugou.com/xxxxxx），但这条链接里那段路径不像短链令牌，没有去问它。' };
    }
    if (KUGOU_LINK_HOSTS.has(host)) {
      // 两种读不到的形态分开说（R137 / R138 各一手量过一种）：
      // ① 手机分享的 `songlist/gcid_<token>/`：**R158 起这一条能导首屏**（走分享页那条 SSR 路，
      //    见 `playlist-kugou-share.mjs`）。为什么不是"接口认 gcid"：它仍然不认——
      //    六种反推 global_collection_id 的拼法全部读不到（R137/R138 一手量过），
      //    换的是**取数据的页**：分享页自己把首屏十首歌注在 HTML 里。
      if (/^gcid_[\w-]{4,60}$/.test(id)) {
        return { kind: 'kugou-share', provider: 'kugou', token: id };
      }
      // ② 分享链接里最常见的 `specialid=`（R137 量）：同样推不出 global_collection_id（三种反推形式都读不到）。
      return {
        kind: 'unknown',
        error: '酷狗的歌单链接本机读不到：这一家的曲目接口要 global_collection_id（形如 collection_1_1341266283_964007_0），'
          + '而分享链接里通常只有 specialid，本机推不出前者（试过三种反推形式都读不到，不猜）。'
          + '把 collection_ 开头的那个 id 直接贴过来就能导。',
      };
    }
    if (!host || NETEASE_LINK_HOSTS.has(host)) {
      if (/^\d{1,20}$/.test(id)) return { kind: 'netease-id', provider: 'netease', id };
    }
  }
  // 都不是：交给文本解析器，能读出条目就算文本形
  const parsed = parsePlaylistText(text);
  if (parsed.items.length) return { kind: 'text', parsed, text };
  return {
    kind: 'unknown',
    error: '认不出这张歌单：可以是网易 / QQ / 酷狗的分享链接（酷狗手机分享那条只给首屏）、'
      + '网易或 QQ 的数字歌单 id、酷狗 collection_ 开头的歌单 id，或每行写成"歌名 - 歌手"的文本。',
    warnings: parsed.warnings.slice(0, 5),
  };
}

/** 歌单名 → 合法 slug。名字里常有竖线/emoji/全角符号，slug 不放行 ⇒ 给一个稳定的兜底名（带上平台名）。 */
export function importSlug(name, id, provider = 'netease') {
  const cleaned = String(name ?? '')
    .replace(/[｜|·:：/\\]+/g, ' ')
    .replace(/[^\w\u4e00-\u9fa5 -]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
  try {
    return slugOf(cleaned || `${PROVIDER_NAMES[provider] ?? provider}歌单-${id}`);
  } catch {
    return slugOf(`${PROVIDER_NAMES[provider] ?? provider}歌单-${id}`.slice(0, 40));
  }
}

/**
 * 建一个导入器。`bridge`（网易与酷狗经它）/ `qq`（QQ 那一条自写的出网通道，见 `playlist-qq.mjs`）
 * 与 `store`（Task 8 实体）都可注入 ⇒ 三认、分页、截断可见这些判断全部能离线判定。
 */
/**
 * R220 · 上游曲目行 → 可写进 sidecar 的**来源身份**行。
 * 字段名全部取自那三份一手量过的映射（网易 `id` / QQ `mid` + `file.media_mid` / 酷狗 `hash`|`audio_id`，
 * 见 `bridge/providers/playlist.mjs`）——**没有 id 的行直接不收**：曲名 + 歌手不是身份（任务书红线）。
 * 带着 `title/artist/album/durationMs` 只是为了让写侧用**既有的条目指纹** `entryKey` 对齐行，不另起一套键。
 */
export function identitiesOf(provider, items) {
  return (items ?? []).map((item) => ({
    provider: String(item?.provider ?? provider ?? ''),
    mediaId: String(item?.mediaId ?? '').trim(),
    ...(String(item?.mediaMid ?? '').trim() ? { mediaMid: String(item.mediaMid).trim() } : {}),
    // R226：行封面跟着身份走同一批（上游没给封面的行**不带这一格**，而不是带一个空串——
    // 带空串下去会被读成"上游确认没有"，而身份路只是"没拿到"，两者不许互相顶掉）。
    ...(String(item?.coverRef ?? '').trim() ? { coverRef: String(item.coverRef).trim() } : {}),
    title: item?.title, artist: item?.artist, album: item?.album, durationMs: item?.durationMs,
  })).filter((row) => row.mediaId && row.title);
}

export function createPlaylistImporter({ bridge, store, qq = null, share = null, now = () => new Date(), resolveShortLink = null } = {}) {
  /**
   * 每家把"问歌单"这一件事收成一个函数：QQ 不经桥（桥里没有它的后端，出网要走得到审计的那一层），
   * 其余两家经桥。**两条通道给的是同一条契约**（`{ok, provider, action, ...}` + tracks 的 `items/offset/limit`），
   * 所以下面这一整段导入逻辑只有一条通路——R114 那一课（两条通路各自演进，最后一条坏了没人知道）。
   */
  const playlistTransport = (provider) => (provider === 'qq'
    ? (qq?.call ? (payload) => qq.call(payload) : null)
    : (bridge?.call ? (payload) => bridge.call('/bridge/playlist', payload) : null));

  /**
   * 分页取一张账号/公开歌单的曲目（R220 抽出来成一个共用出口：导入用它，"补一次来源身份"也用它）。
   * 三条一手实测的形状一条没动：页大小以**桥回吐的那个数**为准（它会夹小）、总数以 detail 的 trackCount 为准、
   * 上限 1000 条截断要如实标。
   */
  async function collect(provider, id) {
    const call = playlistTransport(provider);
    if (!call) return { ok: false, reason: 'bridge-off' };
    const pageLimit = PAGE_LIMIT_BY_PROVIDER[provider] ?? PLAYLIST_PAGE_LIMIT;
    const detail = await call({ provider, action: 'detail', id });
    if (!detail?.ok) return { ok: false, reason: detail?.reason ?? '拿不到歌单详情' };
    const total = Number(detail.trackCount ?? 0) || 0;
    // 截断与否由**已知的总数**判定，不靠"推到某页发现满了"——后者会晚一页才发现（真机实测多问了
    // 一次 1000/500 才承认截断），既多花一笔出网又把 truncated 的成因写成了一件碰运气的事。
    const truncated = total > PLAYLIST_MAX_TRACKS;
    const items = [];
    let offset = 0;
    // 以 trackCount 为目标收尾；页内不足或累计够了就停（不用 length===limit 猜）。
    for (let page = 0; page < 20; page += 1) {
      const remaining = total ? Math.max(0, total - offset) : PLAYLIST_MAX_TRACKS;
      const want = Math.min(pageLimit, Math.max(0, Math.min(remaining, PLAYLIST_MAX_TRACKS - items.length)) || pageLimit);
      if (want <= 0 || items.length >= PLAYLIST_MAX_TRACKS) break;
      const found = await call({ provider, action: 'tracks', id, offset, limit: want });
      if (!found?.ok) return { ok: false, reason: found?.reason ?? '拿不到歌单曲目' };
      const batch = found.items ?? [];
      if (!batch.length) break;                          // 页里一条都没有：接口到底了
      const room = PLAYLIST_MAX_TRACKS - items.length;
      items.push(...(batch.length > room ? batch.slice(0, room) : batch));
      offset += batch.length;
      // "这一页满没满"要和**桥实际用的那一页大小**比，不是和我们问出去的数比：
      // 桥会把 limit 夹小（酷狗那一路夹到 200，而我们可能问 500），拿问出去的数判会永远判成"没满"，
      // 于是第一页之后就直接收尾——少一截还不报，是这类分页最坏的一种错。
      const pageSize = Number(found.limit ?? want) || batch.length;
      if (items.length >= PLAYLIST_MAX_TRACKS || (total && offset >= total) || batch.length < pageSize) break;
    }
    return { ok: true, items, total, truncated, name: detail.name ?? '' };
  }

  async function importOnline(provider, id, { name } = {}) {
    const loaded = await collect(provider, id);
    if (!loaded.ok) return { ok: false, reason: loaded.reason ?? '拿不到歌单曲目' };
    const { items, total, truncated } = loaded;
    const slug = importSlug(name ?? loaded.name, id, provider);
    const text = serializePlaylist({
      name: name || loaded.name || `${PROVIDER_NAMES[provider] ?? provider}歌单 ${id}`,
      items: items.map((item) => ({ title: item.title, artist: item.artist, album: item.album, durationMs: item.durationMs })),
    }).replace('# Rhine 歌单 v1\n',
      // 来历那一行由 `playlists.mjs` 的写侧助手给（R156）：**格式只有一处定义**——
      // 同平台优先要读它，读写各写一份迟早会在分隔符或大小写上分家。
      `# Rhine 歌单 v1\n${provenanceComment(provider, id, now().toISOString())}\n${truncated ? `# truncated 共 ${total} 条，只导入前 ${PLAYLIST_MAX_TRACKS} 条\n` : ''}`);
    const saved = await store.write(slug, text);
    // **总数与"文件里真的有几条"之差必须说出来**（真机量到的两层丢失：一张 47 条的酷狗单
    // 映射出 41 条（6 条上游给了空曲名），落盘后读回只有 40 条（有一条专辑名里带着这个格式的竖线））。
    // 差值一律按 `saved.items.length` 算——那才是磁盘上真正存在的行数；
    // 拿映射阶段的条数算就会出现"已导入 40 条：上游报 47 条，落成 41 条"这种自相矛盾的一句话。
    const written = saved.items.length;
    const dropped = total > written && !truncated ? total - written : 0;
    const warnings = [...saved.warnings];
    if (!written) warnings.push({ line: 0, reason: '这张歌单没有可导入的曲目（可能是空的、私有的或需要登录）' });
    if (dropped) {
      warnings.push({ line: 0, reason: written < items.length
        ? `上游报 ${total} 条：${total - items.length} 条没有曲名，${items.length - written} 条内容里有这个格式装不下的字符`
        : `上游报 ${total} 条：${dropped} 条没有曲名或形状不认识，没有落进来` });
    }
    return {
      ok: true, source: `${provider}-id`, provider, id: saved.id, name: saved.name, items: written,
      total, truncated, dropped,
      // R220：把这一批**上游给过的曲目身份**一起交出去（provider + mediaId [+ mediaMid]）——
      // 由路由写进 sidecar（派生数据），文本正文一个字都不加（批复：不动 `.playlist.txt` 的格式）。
      identities: identitiesOf(provider, items),
      warning: truncated ? `共 ${total} 条，只导入前 ${PLAYLIST_MAX_TRACKS} 条（这个上限是本工具继承的，不是接口给的）`
        : dropped ? `上游报 ${total} 条，${dropped} 条没能导进来` : undefined,
      warnings,
    };
  }

  /**
   * 酷狗"口令短链"那一跳（R155）。三条边界：
   *   · **只问一跳、只读 Location**：`resolveShortLink` 是装配层给的窄门面（内部是
   *     `guardedShortLinkFetch`），本模块拿不到 fetcher，也就没法拿那条外部地址再去请求；
   *   · **落盘的来历只写歌单 id**：短链 302 里同时带着歌单主的 `u=<数字>`（一手实测），
   *     那是别人的身份线索 ⇒ 不写进文件、不进回执、不进日志（与 R138 那条"分享参数不进仓库"同一条线）；
   *   · 在线能力关着 / 没装这个门面 ⇒ 一句实话，不悄悄当成文本导入。
   */
  async function importKugouShortLink(url, { name } = {}) {
    if (typeof resolveShortLink !== 'function') {
      return { ok: false, error: '这张酷狗短链要先问一跳才知道指向哪张歌单，而本机现在不做这一跳（在线能力关着时不解析外部链接）。' };
    }
    let location = '';
    try {
      location = String(await resolveShortLink(url) ?? '');
    } catch (error) {
      return { ok: false, error: `酷狗短链没问通：${String(error?.message ?? error).slice(0, 120)}` };
    }
    if (!location) return { ok: false, error: '酷狗短链没有回跳转地址（上游既没给 Location，也没在链接里带歌单 id）' };
    const parsed = kugouCollectionIdFromTarget(location);
    if (!parsed.ok) return { ok: false, error: parsed.reason };
    const imported = await importOnline('kugou', parsed.id, { name });
    // 回执里说清"从短链认出的这张单"，但**不重复那条地址**：用户要知道的是导了哪张，不是我们打了谁。
    return imported.ok ? { ...imported, source: 'kugou-shortlink', resolvedFrom: parsed.id } : imported;
  }

  /**
   * 酷狗手机分享页（R158）：**只给首屏**，所以这一条的"少了多少"必须自己说清楚。
   * 与 `importOnline` 的三点不同，逐条都是事实不是风格：
   *   · 数据来自 HTML 里那段 SSR 注入的 JSON，不是曲目接口 ⇒ 没有分页可言（`count` 是整单总数，
   *     实测 898，而我们拿到 10 条）；
   *   · `truncated` 这一格**留给 1000 条那个上限**（Q16 定案：两个数各管各的），这里用 `firstScreen`
   *     说另一件事——"这一族链接根本拿不到整单"，与"我们主动截了前 1000 条"不是一回事；
   *   · 来历注释写的是那段 `gcid_` token（跟着文件走的那份事实就是"从这条分享来的"）。
   */
  async function importKugouShare(token, { name } = {}) {
    if (!share) return { ok: false, error: '本机现在不读酷狗手机分享页（在线能力关着时不出网）。要导整单，把 collection_ 开头那个歌单 id 贴过来。' };
    const loaded = await share.load(token);
    if (!loaded.ok) return { ok: false, error: loaded.reason };
    const items = loaded.items ?? [];
    const total = Number(loaded.count ?? 0) || 0;
    const slug = importSlug(name || loaded.name, token);
    const header = `# Rhine 歌单 v1\n${provenanceComment('kugou', loaded.token ?? token, now().toISOString())}\n`;
    const shortfall = total > items.length
      ? `# 首屏 ${items.length} 条（这张单共 ${total} 条：手机分享链接只注了首屏，整单要 global_collection_id，而这一族链接里它是空串）\n`
      : '';
    const text = serializePlaylist({
      name: name || loaded.name || `酷狗分享歌单 ${token}`,
      items: items.map((item) => ({ title: item.title, artist: item.artist, album: item.album, durationMs: item.durationMs })),
    }).replace('# Rhine 歌单 v1\n', header + shortfall);
    const saved = await store.write(slug, text);
    const written = saved.items.length;
    const warnings = [...saved.warnings];
    if (!written) warnings.push({ line: 0, reason: '分享页首屏没有可导入的曲目（可能是空单、私有的，或上游改了页面模板）' });
    if (total > written) {
      warnings.push({ line: 0, reason: `这张单共 ${total} 条，本机只取到 ${written} 条（分享页给的就是首屏，不是我们截的）` });
    }
    return {
      ok: true, source: 'kugou-share', provider: 'kugou', id: saved.id, name: saved.name, items: written,
      total, truncated: false, firstScreen: total > written, dropped: 0,
      warning: total > written
        ? `已导入首屏 ${written} 条：这张单共 ${total} 条，手机分享链接读不到整单（要整单请把 collection_ 开头那个 id 贴过来）`
        : undefined,
      warnings,
    };
  }

  return {
    collect,
    /** R220 · 上游曲目行 → 可写进 sidecar 的"来源身份"行（身份字段名取自那三份映射，**没有 id 的行不收**）。 */
    identitiesOf,
    async import({ text, name } = {}) {
      const input = parseImportInput(text);
      if (input.kind === 'empty' || input.kind === 'unknown') {
        return { ok: false, error: input.error, ...(input.warnings?.length ? { warnings: input.warnings } : {}) };
      }
      if (input.kind === 'kugou-shortlink') return await importKugouShortLink(input.url, { name });
      if (input.kind === 'kugou-share') return await importKugouShare(input.token, { name });
      if (input.kind === 'text') {
        const parsed = input.parsed;
        const slug = importSlug(name ?? parsed.name, 'text');
        const saved = await store.write(slug, serializePlaylist({ name: name || parsed.name || '粘贴的歌单', items: parsed.items, warnings: parsed.warnings }));
        return {
          ok: true, source: 'text', id: saved.id, name: saved.name, items: saved.items.length,
          total: saved.items.length, truncated: false, warnings: saved.warnings,
        };
      }
      return await importOnline(input.provider ?? 'netease', input.id, { name });
    },
  };
}

export const IMPORT_MAX_TRACKS = PLAYLIST_MAX_TRACKS;
