// 本项目自撰（非移植代码）。歌单逐条在线匹配 + 旁挂缓存（R76）。
//
// 这份数据是**派生数据**：可丢、可重建、绝不回写用户文本。三条推论都做成了断言：
//   ① 匹配之后 `<slug>.playlist.txt` 逐字节不变（连 mtime 都不动）——结果只进 `<slug>.matches.json`；
//   ② 删掉 sidecar 无害：歌单照常读、照常播，再点一次匹配逐条重建出同样的结果；
//   ③ 改名/删除连带 sidecar 一起走（`PlaylistStore` 那三个后缀一次搬），不留孤儿。
// 关联是**纯函数**算出来的（`store.matchFileOf(id)` = 同目录 + 同基名 + 固定后缀），
// 没有索引文件、没有内存映射表——那样一旦用户手工动过文件就找不回来了。
//
// 打分口径与歌词匹配同源：阈值 75 用同一个常量，`(Live)` 等版本标记参与打分（定案 a 不变），
// 归一与哈希直接复用曲库那一份（另写一套就会有两处真源，两边慢慢漂开）。
import { promises as fs } from 'node:fs';
import { hash, normalized, writeJsonAtomic } from './music-library.mjs';
import { toOnlineTrack } from './bridge/providers/normalize.mjs';
import { AUTO_MATCH_MIN_SCORE, calculateMatchScoreDetails } from './online-match-score.mjs';
// R156（任务三）：来历注释的读侧与写侧共用 `playlists.mjs` 那一份格式定义（不在这里再写一遍正则）。
import { readPlaylistProvenance } from './playlists.mjs';

export const MATCH_TTL_MS = 30 * 24 * 3600 * 1000;      // 命中 30 天：平台目录会变，过期后允许重搜
export const MISS_TTL_MS = 3600 * 1000;                  // 未命中只冷 1 小时：新上传的歌不该被锁一整天
/**
 * 封面重问窗口（R125）：`coverTried` 只买 7 天，不买永久。
 * 两个理由：① 搜索结果会随时间漂，今天没封面的那条明天平台上就有了；
 * ② 这一戳从前是"异常也盖"的（一次性回填 + 无容错 ⇒ 本机 5 条永久静默），
 *   就算判据修好了，把误盖的戳留成永久记录也是第二层错误。
 */
export const COVER_RETRY_MS = 7 * 24 * 3600 * 1000;
export const MATCH_MIN_SCORE = AUTO_MATCH_MIN_SCORE;     // 与歌词匹配同一个常量（阈值 75，定案 a）
export const MATCH_SIDECAR_VERSION = 1;
/**
 * R146（任务九）· 缺封面时"另一家同一首"回落的时长容差（毫秒）。
 * 与 R140 那条窄规则同一个量级：3 秒之内算同一首录音，差更多就是不确定的另一版。
 */
export const COVER_FALLBACK_DURATION_TOLERANCE_MS = 3_000;

/**
 * R146 · 回落判据（纯函数，离线可判）。四条全成立才采纳：
 *   ① 来源与匹配那一首**不同**（同来源走 `sameIdentity` 那条正路）；
 *   ② 曲名与歌手**归一后逐字相等**（不是"相似"，是相等）；
 *   ③ 两边时长都知道且相差 ≤ 3 秒（任一方缺时长 ⇒ 少一维证据 ⇒ 不采纳）；
 *   ④ 这一条自己带封面地址。
 *
 * 为什么图片可以回落、歌词不行：配错的封面是"看得见但不毁数据"，而且它**不改匹配本身**
 * （`track.provider/mediaId` 一个字都不动，改的只有 `coverRef`）；歌词配错会让整段字幕跟着错，
 * 那条线仍然只由阈值 75 与人工认领守着。采纳时把来源写进 `coverFromProvider`，界面据此说清图是谁给的。
 */
export function coverFallbackOk(entry, item, track) {
  if (!item?.coverRef || !track?.provider) return false;
  if (String(item.provider) === String(track.provider)) return false;
  const sameText = (a, b) => { const x = normalized(a), y = normalized(b); return Boolean(x) && x === y };
  if (!sameText(item.title, entry?.title) || !sameText(item.artist, entry?.artist)) return false;
  const a = Number(item.durationMs ?? 0), b = Number(entry?.durationMs ?? 0);
  if (!(a > 0 && b > 0)) return false;
  return Math.abs(a - b) <= COVER_FALLBACK_DURATION_TOLERANCE_MS;
}
const SEARCH_LIMIT = 10;                                 // 每条候选取前 10 个打分

/**
 * 条目指纹：只含**影响匹配结果**的那几项。
 * 专辑为空与不写专辑是同一个条目（不产生两个键）；改注释、改空行、调整顺序都不作废任何条目——
 * 这正是"编辑一条只重搜一条"能成立的原因。
 */
export function entryKey(item) {
  return hash([normalized(item?.title), normalized(item?.artist), String(item?.durationMs ?? ''), normalized(item?.album ?? '')].join('\0'));
}

/**
 * Task 7 契约条目 → 打分函数要的 result 形状（`{name, artists[], album{name}}`）。
 * 这里只做字段改名，不引入任何上游原始字段：契约之外的东西从桥到这一步都进不来（R78）。
 */
const asSearchable = (item) => ({
  name: item.title,
  artists: item.artist ? [{ name: item.artist }] : [],
  album: { name: item.album ?? '' },
  durationMs: item.durationMs ?? 0,
});

/**
 * 建一个匹配器。`search` / `store` / `now` 全部可注入 ⇒ 六条硬要求都能在离线判定，
 * 出网次数就是数 `search` 被调用几次（比读日志可靠）。
 * `covers`（看板 95fe081 跳②）＝ 在线曲目封面的注册表：sidecar 里存的是**第三方地址**（服务端数据，
 * 永不出前端），出给前端的每一首都在这里换成同源代理 URL；不传或子开关关掉 ⇒ `coverUrl` 恒空串。
 */
/**
 * R143（任务四）· 「匹配时优先已登录音源」的**选择规则**（纯函数，离线可判）。
 *
 * 这是**有边距的偏好**，不是硬过滤：
 *   · 全局最高分那一条照常是缺省选择；
 *   · 只有当「开关开着」+「至少一家已登录」+「已登录源里最高分**自己也过阈值**」三条齐备，
 *     且它与全局最高分相差 ≤ `margin` 分时，才改选已登录那一源；
 *   · 超出边距仍取全局最高分（宁可少一点权益，也不为了"优先登录源"去配一首更像别人歌的）。
 * 关键的一条：**这个开关永远不能把一条不过阈值的候选抬成匹配**——它只在都过线的候选之间挑。
 *
 * @param scored 已按分数降序排的候选（`{item, score}`，`item.provider` 是音源名）
 */
export const LOGGED_IN_PREFERENCE_MARGIN = 10;
/**
 * R156（任务三）：把"有边距的偏好"从一条扩成**两条，叠着走**，优先序是指令定的：
 *   **① 同平台 → ② 已登录源 → ③ 全局最高分**。
 * 三步共用**同一个** `margin`（10 分）与同一条底线：**永不过阈值的候选不被抬成匹配**、
 * **超出边距一律不改选**（宁可少一点权益/少一点"同源"，也不为了偏好配一首更像别人歌的）。
 *
 * 两条规则的关系要写清（这是本件唯一容易想错的地方）：
 *   · 同平台看的是**这张单的来历**（`# qq-playlist …`），它回答"哪一家最可能是原版本"；
 *   · 已登录源看的是**这台机器的权益**，它回答"哪一家更可能播得出整首"；
 *   · 二者**不是一回事**：同平台那一家没登录时，第一步可能把结果换成一首**播不了**的
 *     （QQ 分享单最常见）。这不是 bug 而是这两条目标的真实冲突 ⇒ 交给用户选：
 *     缺省按指令开（用户明确要"某平台的单优先该平台"），设置里一句话写清代价，可关。
 *     记 **Q34**（验收侧若更看重"能播"，可改成缺省关或"仅当该平台已登录才生效"，一行的事）。
 *
 * @param scored 已按分数降序排的候选（`{item, score}`，`item.provider` 是音源名）
 */
export function pickMatchCandidate(scored, {
  loggedInProviders = [], preferLoggedIn = false, platformProvider = '', preferSamePlatform = false,
  minScore = MATCH_MIN_SCORE, margin = LOGGED_IN_PREFERENCE_MARGIN,
} = {}) {
  const globalBest = scored?.[0] ?? null;
  if (!globalBest) return { pick: null, preferred: false };
  /** 一条候选能不能被"偏好"抬上来：自己也过阈值、不是全局最高分本身、与它相差 ≤ margin。 */
  const eligibleSwap = (entry) => Boolean(entry) && entry !== globalBest && entry.score >= minScore && globalBest.score - entry.score <= margin;
  if (preferSamePlatform === true && platformProvider) {
    const same = scored.find((entry) => entry?.item?.provider === platformProvider);
    if (eligibleSwap(same)) return { pick: same, preferred: true, preferredBy: 'same-platform', over: globalBest };
  }
  if (preferLoggedIn === true && Array.isArray(loggedInProviders) && loggedInProviders.length) {
    const loggedInBest = scored.find((entry) => loggedInProviders.includes(entry?.item?.provider));
    if (eligibleSwap(loggedInBest)) return { pick: loggedInBest, preferred: true, preferredBy: 'logged-in', over: globalBest };
    // 这两句是给"为什么没改选"留的读数，不参与结论（界面只读 `preferred`/`preferredBy`/`over`）。
    if (loggedInBest && loggedInBest.score >= minScore && globalBest.score - loggedInBest.score > margin) {
      return { pick: globalBest, preferred: false, beyondMargin: true };
    }
  }
  return { pick: globalBest, preferred: false };
}

/**
 * R156（任务三）：把装配处那份「偏好门面」抽成一个可注入的工厂。
 *
 * 为什么抽出来：这段逻辑原先直接写在 `music-server.mjs` 的装配里，于是它最重要的三条性质
 * 只能靠**读源码文本**判（变异验证 P16 因此没咬——把早退那一档的 `preferSamePlatform` 删掉，
 * 没有任何测试会红，可"登录开关关着 ⇒ 同平台那条也跟着失效"正是要防的事）。
 * 三条性质现在各有一条行为断言：
 *   ① `preferLoggedInSource` 关着 ⇒ **一次都不问会话**（不摸凭据文件，行为与"没有这个功能时"逐字一致）；
 *   ② 关着那一档仍把 `preferSamePlatform` 带出去（两条开关**各管各的**，不许捆在一起）；
 *   ③ 开着的集合 = `playableProviders` ∩ 真有会话的家（名单只有一个出处，不在这里抄第二份）。
 */
export function createMatchPreference({ readConfig, describeSessions, playableProviders = [] } = {}) {
  return async function preference() {
    const config = readConfig?.() ?? {};
    const preferSamePlatform = config.preferSamePlatformSource === true;
    if (config.preferLoggedInSource !== true) return { enabled: false, providers: [], preferSamePlatform };
    const view = await describeSessions()
    const providers = playableProviders.filter((entry) => view?.providers?.[entry]?.source !== 'none')
    return { enabled: true, providers, preferSamePlatform }
  };
}

export function createPlaylistMatcher({ store, search, covers = null, now = () => Date.now(), limit = SEARCH_LIMIT, preference = null } = {}) {
  /** 读 sidecar。坏了 / 版本不认识 / 名字对不上 ⇒ 当没有，重建而不是崩。 */
  async function readSidecar(id) {
    const empty = { version: MATCH_SIDECAR_VERSION, playlist: id, entries: {} };
    let parsed
    try {
      const text = await fs.readFile(store.matchFileOf(id), 'utf8').catch(() => null);
      if (text === null) return empty;
      parsed = JSON.parse(text);
    } catch {
      return empty;                                       // 连路径都不合法（slug 不过关）也当没有
    }
    if (!parsed || typeof parsed !== 'object') return empty;
    if (parsed.version !== MATCH_SIDECAR_VERSION || parsed.playlist !== id) return empty;
    if (!parsed.entries || typeof parsed.entries !== 'object') return { ...empty };
    // 一次性迁移（R125）：修复之前那一版的补图是 `.catch(() => { coverTried = true })`，
    // 而那一版**只在有结论时才落 coverCheckedAt** ⇒
    // "盖了 coverTried、既没有 coverRef、也没有 coverCheckedAt"这副面孔只可能来自一次没有容错的失败
    // （本机那 5 条就是这么被永久判死的）。一律清掉，让它们重问一次。
    // 判据里带上 coverCheckedAt 是关键：修复之后 coverTried 必然与它同时出现，
    // 于是这条迁移既不误伤新戳，也不会每次读都把刚落的戳擦掉（那就成了第二个真相）。
    // 只改内存里这一份、不顺手写盘：读路由不该产生写入；下一次真补图时会连带把盘对上。
    for (const record of Object.values(parsed.entries)) {
      if (record && typeof record === 'object'
        && record.coverTried === true && !record.coverRef && !record.coverCheckedAt) delete record.coverTried;
    }
    // R198：展示封面那一格要**原样带出来**。这个函数是"重建对象"而不是"返回 parsed"，
    // 漏带的表现就是"写进去了、读回来没有"（本批自检抓到的正是这个：`tracks()` 永远签不出 token）。
    return {
      version: MATCH_SIDECAR_VERSION, playlist: id, updatedAt: parsed.updatedAt, entries: parsed.entries,
      ...(typeof parsed.displayCoverRef === 'string' && parsed.displayCoverRef ? { displayCoverRef: parsed.displayCoverRef } : {}),
    };
  }

  const freshEnough = (record) => record && now() - Number(record.at ?? 0) < (record.ok ? MATCH_TTL_MS : MISS_TTL_MS);

  /**
   * 封面子开关开着、这条记录是命中、既没存过封面也没被"问过且确实没有"判进冷却 ⇒ 值得为它多打一次搜索。
   * `coverTried` 这一戳是**出网上限**的关键：没有它，每次整单匹配都会替这些条目白跑一遍网络。
   * 但它只买 7 天（`COVER_RETRY_MS`）：见上面那条常量的两个理由。
   */
  const coverWanted = (record) => Boolean(covers?.enabled?.())
    && Boolean(record?.ok && record.track)
    && !record.coverRef
    && (!record.coverTried || now() - Number(record.coverCheckedAt ?? 0) >= COVER_RETRY_MS);

  /** 同一首的判据：来源与媒体 id 逐字相同。为了拿张图把用户看到的匹配换掉是不可接受的。 */
  const sameIdentity = (item, track) => Boolean(item)
    && String(item.provider ?? '') === String(track?.provider ?? '')
    && String(item.mediaId ?? '') === String(track?.mediaId ?? '');

  /**
   * 旧 sidecar（R116 之前生成的）里没有 `coverRef` ⇒ 封面墙永远缺图。这里给"命中但缺封面"补一次重查：
   *   · 只有搜回来的还是同一首（来源 + 媒体 id 逐字相同）才采纳它的封面——搜索结果会随时间漂，
   *     补图不许顺手改匹配（与"宁可无词不错配"同一条判据）；
   *   · **只有"这次搜索本身成功、且同一首里确实没有封面"才落 `coverTried`**（R125）：
   *     `ok:false` 是所有源都没应答（桥没起来 / 超时 / DNS），那是一次**没有结论**的尝试，
   *     落戳就等于把一次网络抖动判成永久事实；抛出同理，由调用方接住且不落任何东西；
   *   · 落戳也不是永久：`COVER_RETRY_MS` 之后会再问一次；
   *   · 只在封面子开关开着时才做（关掉 ⇒ 一条请求都不该为封面出）。
   * 代价按条目计：一轮整单匹配里，缺封面的已匹配条目各多一次搜索，
   * 之后要么有 coverRef、要么有 coverTried + coverCheckedAt（冷却 7 天）。
   */
  async function refillCoverRef(entry, record) {
    const found = await search({ query: [entry.title, entry.artist].filter(Boolean).join(' '), offset: 0, limit });
    if (found?.ok !== true) return;                     // 没有结论 ⇒ 一个戳都不落，下轮重问
    const items = found?.items ?? [];
    const hit = items.find((item) => sameIdentity(item, record.track) && item.coverRef);
    if (hit) {
      record.coverRef = hit.coverRef;
      delete record.coverFromProvider;                    // 正路拿到了就不留"借图"标记，免得两处说法不一
    } else {
      // R146：这一首在自己那家没有封面地址 ⇒ 采纳"另一家同一首"的图（四条判据见 `coverFallbackOk`），
      // 并把来源记进 `coverFromProvider` —— 界面要说得出这张图不是匹配那一首自己给的。
      const borrowed = items.find((item) => coverFallbackOk(entry, item, record.track));
      if (borrowed) {
        record.coverRef = borrowed.coverRef;
        record.coverFromProvider = String(borrowed.provider);
      } else record.coverTried = true;
    }
    record.coverCheckedAt = now();
  }

  /**
   * 跳②（看板 95fe081）：出给前端的曲目只带**同源代理地址**。
   * `coverRef`（第三方 URL）留在 sidecar 里，注册表按它签发 token；子开关关掉或注册表没接
   * ⇒ 保持 `track.coverUrl` 原样（空串），前端画既有占位（不造一个会 404 的 URL，与 F3 同一条判据）。
   * 这里返回的是**新对象**：sidecar 那份 `track` 是缓存里的东西，就地改会把"发出去的地址"写回磁盘。
   */
  function withCoverUrl(record) {
    const track = record.track;
    if (!covers?.enabled?.() || !record.coverRef) return track;
    const url = covers.register(record.coverRef);
    return url ? { ...track, coverUrl: url } : track;
  }

  /**
   * 条目**自带在线身份**（F2：从搜索结果直接加进来的那些，文本第 4 段 `on:<来源>:<媒体 id>[:<次 id>]`）
   * ⇒ 不需要搜索，也不需要进 sidecar。两处都要认这一档：
   * ① 身份已经在用户的文本文件里，再抄一份进 sidecar 就是同一份数据的两个真相（文件改了缓存还留着旧的）；
   * ② 整单匹配不许为它出网——"这条我早就知道是哪一首了"却还要去问一遍，是白打的一笔。
   * 来源不认识（比如手工写了个 `on:kg:`）时返回 null ⇒ 退回搜索那一路，比直接判死更可用。
   */
  function inlineTrack(entry) {
    if (!entry?.online) return null;
    return toOnlineTrack({
      provider: entry.online.provider, mediaId: entry.online.mediaId, mediaMid: entry.online.mediaMid,
      title: entry.title, artist: entry.artist, album: entry.album, durationMs: entry.durationMs, quality: '自动',
    });
  }

  /**
   * R220 · 来源身份那一档：这一行**来自哪家、是哪个 id** 是"列/导入账号歌单"那一步就从上游拿到的事实
   * （酷狗 `hash`、网易 `id`、QQ `mid` —— 字段名见 `providers/playlist.mjs` 那三份映射，都是一手量过的）。
   * 从前这一步把 id 丢了，于是"明明来自酷狗的单"还要靠搜索重认一遍歌，认不出的就落到别家（用户那份 400 行的实况）。
   * 只认**齐全的形状**：provider 在三家之内 + mediaId 非空 ⇒ 用；否则返回 null，退回今天的搜索匹配。
   * 身份存在 sidecar（派生数据），**不写进 `.playlist.txt` 正文**（正文是用户可编辑的资产，逐字节不动）。
   */
  const SOURCE_IDENTITY_PROVIDERS = new Set(['netease', 'qq', 'kugou']);
  function identityTrack(entry, record) {
    const provider = String(record?.sourceProvider ?? '');
    const mediaId = String(record?.sourceMediaId ?? '').trim();
    if (!SOURCE_IDENTITY_PROVIDERS.has(provider) || !mediaId) return null;
    return toOnlineTrack({
      provider, mediaId, mediaMid: String(record?.sourceMediaMid ?? ''),
      title: entry.title, artist: entry.artist, album: entry.album, durationMs: entry.durationMs, quality: '自动',
    });
  }

  /** 写回一条匹配结果时**不许**顺手清掉那三格来源身份（它们是另一条通路拿到的事实，与搜索结果并存）。 */
  function keepSourceIdentity(result, previous) {
    if (!previous?.sourceProvider || !previous?.sourceMediaId) return result;
    return {
      ...result,
      sourceProvider: String(previous.sourceProvider),
      sourceMediaId: String(previous.sourceMediaId),
      ...(previous.sourceMediaMid ? { sourceMediaMid: String(previous.sourceMediaMid) } : {}),
      ...(previous.sourceAt ? { sourceAt: previous.sourceAt } : {}),
    };
  }

  /**
   * 匹配一条。`sidecar` 由 `matchAll` 传进来（整单只读一次、只写一次）；
   * 单独调用时自己读自己写。
   * **只有一层缓存**：就是磁盘上那份 sidecar。原先这里还有一层进程内 Map，
   * 结果是"matchAll 走新对象、matchEntry 走旧对象"两种可见性——同一份数据的两个真相，
   * 一旦哪边漏了失效就会表现为"删了文件它还在缓存里"这类查不出来的事。
   */
  async function matchEntry(id, entry, { sidecar: providedSidecar, platformProvider } = {}) {
    const key = entryKey(entry);
    const inline = inlineTrack(entry);
    if (inline) return { ok: true, at: now(), track: inline, cached: 'inline', key };
    const ownSidecar = providedSidecar ?? await readSidecar(id);
    const stored = ownSidecar.entries[key];
    // R220：这一行有**来源身份** ⇒ 一次搜索都不打（本件的目的就是跳过"靠搜索重认歌"那一步）。
    // 身份不认识（provider 不在三家内 / id 空）时 `identityTrack` 给 null ⇒ 退回今天的搜索路径。
    const byIdentity = identityTrack(entry, stored);
    if (byIdentity) return { ok: true, at: now(), track: byIdentity, cached: 'identity', key };
    if (stored && freshEnough(stored)) {
      // 命中即返回是这条路由的常态（一次搜索都不打）。唯一的例外是"命中但 sidecar 里没有封面"——
      // 那是 R116 之前生成的旧缓存，不补就永远缺图（看板 95fe081 边界 b）。补过就有 coverRef 或 coverTried，
      // 之后仍然是一命中就返回，不会每轮都多打一次。
      let refilled = false;
      if (coverWanted(stored)) {
        // 抛出**不盖戳**（R125）：从前这里是 `.catch(() => { stored.coverTried = true; })`，
        // 一次抖动就把这条永久判成"问过、没有"——本机 5 条无封面就是这么来的。
        // 不盖戳的代价是下轮再问一次，那正是要的容错；出网上限仍由 coverTried + 7 天窗口兜住。
        await refillCoverRef(entry, stored).catch(() => undefined);
        refilled = true;
      }
      if (refilled && !providedSidecar) await writeJsonAtomic(store.matchFileOf(id), ownSidecar);
      return { ...stored, cached: stored.ok ? 'hit' : 'miss', key, ...(refilled ? { searched: true } : {}) };
    }
    // 查询串带专辑：专辑参与打分，缺了就少一维证据（曲名相同、专辑不同的翻唱最容易在这里错配）。
    const found = await search({ query: [entry.title, entry.artist].filter(Boolean).join(' '), offset: 0, limit });
    const scored = (found?.items ?? []).map((item) => ({
      item, score: calculateMatchScoreDetails({
        title: String(entry.title ?? ''), artist: String(entry.artist ?? ''),
        album: String(entry.album ?? ''), durationMs: Number(entry.durationMs ?? 0),
      }, asSearchable(item)).score,
    })).sort((a, b) => b.score - a.score);
    // R143：有边距的偏好（规则本体是上面那个纯函数，这里只负责把"哪些源已登录"问出来）。
    // 没接 `preference` ⇒ 完全不问、行为与今天逐字一致（开关关着时也不去 stat 会话文件）。
    const wanted = preference ? await preference() : null;
    // R156（任务三）：这张单的来历平台。`matchAll` 会一次读好传进来（一张 1000 条的单不该为每条
    // 去重读一遍文件）；只有"重搜这一条"那种单条入口才自己读一次。读不到 = null = 这一档不参与。
    let platform = platformProvider;
    if (platform === undefined) {
      const playlist = await store.get(id);
      platform = readPlaylistProvenance(playlist?.text ?? '')?.provider ?? '';
    }
    const picked = pickMatchCandidate(scored, {
      preferLoggedIn: wanted?.enabled === true,
      loggedInProviders: wanted?.providers ?? [],
      preferSamePlatform: wanted?.preferSamePlatform === true,
      platformProvider: platform ?? '',
      minScore: MATCH_MIN_SCORE,
    });
    const best = picked.pick;
    // R150（Q18）：偏好**真的改选了** ⇒ 把"让位的那一条"的读数一起落进 sidecar。
    // 存读数（来源 / 曲名 / 歌手 / 分数）不存结论词——结论由界面给，与 `reason` 那一格同一口径。
    // 不存 `coverRef`：那是第三方图片地址，跟着这条读数出服务端就破了 R116 那条红线；
    // 也不存 `mediaId`：界面要说清"谁让位了"用不到它，少一格就少一格能漂的东西。
    const yielded = picked.preferred && picked.over?.item
      ? {
        provider: String(picked.over.item.provider ?? ''),
        title: String(picked.over.item.title ?? ''),
        artist: String(picked.over.item.artist ?? ''),
        score: Number(picked.over.score ?? 0),
      }
      : null;
    const result = best && best.score >= MATCH_MIN_SCORE
      // `coverRef` 是第三方图片地址，只有这份服务端数据文件里允许存它（跳①，看板 95fe081）：
      // `track` 那份是发给前端的形状，`coverUrl` 一律由 tracks() 现算成同源代理地址，
      // 这条 URL 一步都不出服务端——与音源同一条红线（R116）。
      ? { ok: true, at: now(), score: best.score, track: toOnlineTrack(best.item), coverRef: String(best.item?.coverRef ?? ''),
        // R156：`preferred` 保持布尔（R150 的 sidecar 与界面判据不变），`preferredBy` 只说"是哪一条规则改选的"。
        // 老记录里没有这一格 ⇒ 界面回落到"登录源优先"那句（与它当初被写入时的语义一致，不追改）。
        ...(yielded ? { preferred: true, preferredBy: picked.preferredBy === 'same-platform' ? 'same-platform' : 'logged-in', over: yielded } : {}) }
      // reason 里只放**读数**，结论词由界面给（徽标是"未匹配（…）"）——两边都写结论就成了
      // "未匹配（未匹配到（最高分 62，阈值 75））"，截图 44 上那一行就是这么啰嗦的。
      : { ok: false, at: now(), reason: `最高分 ${best?.score ?? 0}，低于阈值 ${MATCH_MIN_SCORE}` };
    // 命中与未命中都留痕：未命中不留痕的话，每次整单播放都会把同一首查不到的歌再问一遍。
    // R220：写回搜索结果时**保留那三格来源身份**（它们是"列/导入账号歌单"拿到的事实，与搜索结果并存；
    // 清掉就等于用户补过一次的身份又被一次搜索抹了）。
    ownSidecar.entries[key] = keepSourceIdentity(result, ownSidecar.entries[key]);
    ownSidecar.updatedAt = now();
    if (!providedSidecar) await writeJsonAtomic(store.matchFileOf(id), ownSidecar);   // 唯一的写盘目标（R74）
    return { ...result, key, searched: true };
  }

  /** 整单：**顺序**跑（并发打第三方接口只会更快被限流），sidecar 读一次、写一次。 */
  async function matchAll(id) {
    const playlist = await store.get(id);
    if (!playlist) return { total: 0, matched: 0, failed: [], results: [], missing: true };
    const sidecar = await readSidecar(id);
    const results = [];
    const failed = [];
    let searches = 0;
    // R156：来历读一次就够（一张 1000 条的单逐条重读文件是没有必要的代价），传进每一条。
    const platformProvider = readPlaylistProvenance(playlist.text ?? '')?.provider ?? '';
    for (const entry of playlist.items) {
      const got = await matchEntry(id, entry, { sidecar, platformProvider });
      if (got.searched) searches += 1;
      results.push(got);
      if (!got.ok) failed.push({ entry, reason: got.reason });      // 单条失败不中断整单
    }
    // R198：重新匹配过之后，展示封面跟着"第一条有封面的条目"走 —— **只在已经设过的时候跟随**
    //（用户没点过播放不给他凭空加一格；用户点过「恢复程序化封面」删掉了字段，也不再自己长回来）。
    const hadDisplay = Boolean(String(sidecar.displayCoverRef ?? ''));
    if (hadDisplay) {
      const nextDisplay = displayCoverFrom(playlist, sidecar);
      if (nextDisplay !== String(sidecar.displayCoverRef ?? '')) {
        if (nextDisplay) sidecar.displayCoverRef = nextDisplay; else delete sidecar.displayCoverRef;
      }
    }
    // 只有真搜过才写盘：全走缓存时连文件 mtime 都不该动（否则"我什么都没做它却变了"会变成常态）。
    if (searches) await writeJsonAtomic(store.matchFileOf(id), sidecar);
    return {
      total: playlist.items.length,
      matched: results.filter((result) => result.ok).length,
      failed, results, searches,
    };
  }

  /** 整单播放用的队列视图：命中给可播曲目，未命中如实标出来（不能静默少几首）。 */
  async function tracks(id) {
    const playlist = await store.get(id);
    if (!playlist) return null;
    const sidecar = await readSidecar(id);
    const items = [];
    let unmatched = 0;
    const rawLines = String(playlist.text ?? '').split(/\r?\n/);
    for (const [position, entry] of playlist.items.entries()) {
      // `line` = 这一条在文件里的行号，`lineText` = 当时那一行的原文（R127 手工指定）。
      // 原文要一起出去：写回时拿它做对照（compare-and-swap），"只改目标行"才有把握——
      // 只有行号的话，用户在别处动过文件就会改错行。
      const line = playlist.entryLines?.[position] ?? null;
      const lineText = line ? rawLines[line - 1] ?? '' : '';
      // 自带身份的条目先走这条：不读 sidecar、不出网，直接给出可播的在线曲目。
      const inline = inlineTrack(entry);
      if (inline) { items.push({ entry, matched: true, track: inline, source: 'inline', line, lineText }); continue }
      const record = sidecar.entries[entryKey(entry)];
      // R220：有来源身份的这一行**不走搜索**，徽标也要说得出这条不同的路（`source:'identity'`）；
      // 之前搜出来缓存过的封面继续用（`coverRef` 那格与身份并存，不互相覆盖）。
      const byIdentity = identityTrack(entry, record);
      if (byIdentity) {
        items.push({ entry, matched: true, track: withCoverUrl({ track: byIdentity, coverRef: record?.coverRef }),
          source: 'identity', line, lineText });
        continue;
      }
      if (record?.ok && record.track) {
        // R146：`coverFrom` 只在"图是另一家给的"时非空（正路自己给图时 sidecar 里没有这一格）。
        // R150：`preferred`/`over` 同理，只在"这次是偏好改选的"时非空——界面据此说得出"谁让位了"，
        // 没有这一格时那一行与今天逐字一样（缺省关闭时 sidecar 里根本不会有这两格）。
        items.push({ entry, matched: true, track: withCoverUrl(record), score: record.score, source: 'cache',
          coverFrom: record.coverFromProvider ?? null, line, lineText,
          ...(record.preferred && record.over ? { preferred: true, preferredBy: record.preferredBy ?? 'logged-in', over: record.over } : {}) });
      }
      else {
        unmatched += 1;
        // 没查过的条目**不给 reason**：徽标靠"有没有留痕"区分"未查"与"未匹配"，
        // 在这里替它编一句"尚未匹配"就会把两档合成一档（真机截图 43 抓到的正是这个）。
        items.push({ entry, matched: false, source: record ? 'cache' : 'none', line, lineText, ...(record?.reason ? { reason: record.reason } : {}) });
      }
    }
    // R198：展示封面（有 `displayCoverRef` 才签）—— 与曲目封面同一条 token 路、同一张主机白名单，
    // **响应里只出同源地址**（第三方 URL 不出服务端）。没有这一格时与今天逐字一样。
    const displayRef = String(sidecar.displayCoverRef ?? '');
    const displayCoverUrl = displayRef && covers?.enabled?.() ? (covers.register(displayRef) ?? '') : '';
    // R220：来历（有才给）——界面用它决定「补一次来源身份」那颗按钮出不出现。
    // 读的是文件头那行注释（同平台优先读的也是它），不是另存一份事实。
    const provenance = readPlaylistProvenance(String(playlist.text ?? ''));
    return {
      id: playlist.id, name: playlist.name, items, matched: items.length - unmatched, unmatched, displayCoverUrl,
      sourceProvenance: provenance?.provider && provenance?.id ? { provider: provenance.provider, id: provenance.id } : null,
    };
  }

  /**
   * 墙上「重取封面」（R126 · 方案 A）补到图之后，把它写回**所有引用到这一首的 sidecar 记录**。
   * 为什么不写"当前这张歌单"：队列条目身上不带"我来自哪张歌单"（R114 之后队列就是内核的一份曲目数组），
   * 在宿主里再记一份来源就是第二个真相；而 sidecar 是**派生数据**（可丢、可重建、绝不回写用户文本），
   * 从一条已逐字核验的身份补它一格封面，碰不到任何用户写过的东西。
   * 代价说清：一次点击读 N 张 sidecar（N = 歌单张数，本机 2），**只有真补到才写盘**。
   */
  async function rememberCover({ provider, mediaId, coverRef, coverFrom = null } = {}) {
    const ref = String(coverRef ?? '');
    if (!/^https:\/\//i.test(ref)) return { updated: 0, reason: '没有可登记的封面地址' };
    const playlists = await store.list().catch(() => []);
    let updated = 0;
    for (const playlist of playlists) {
      const sidecar = await readSidecar(playlist.id);
      let touched = 0;
      for (const record of Object.values(sidecar.entries)) {
        if (!record || typeof record !== 'object') continue;
        const track = record.track;
        if (!track || track.provider !== provider || String(track.mediaId) !== String(mediaId)) continue;
        if (record.coverRef === ref) continue;
        record.coverRef = ref;
        // R146：图是另一家给的时候记一笔来源；正路自己给图就把这一格摘掉，不留半截说法。
        if (coverFrom && String(coverFrom) !== String(provider)) record.coverFromProvider = String(coverFrom);
        else delete record.coverFromProvider;
        // 两个戳成对清掉：留着半对（coverCheckedAt 单独在）读起来像"刚问过且没结果"，
        // 而这一条现在是有结果的。R125 的迁移判据就是被这种"半对面孔"坑过一次，别再留一份。
        delete record.coverTried;
        delete record.coverCheckedAt;
        touched += 1;
      }
      if (touched) {
        sidecar.updatedAt = now();
        await writeJsonAtomic(store.matchFileOf(playlist.id), sidecar);
        updated += touched;
      }
    }
    return { updated };
  }

  /**
   * R198：这张歌单的**展示封面**该用哪一条 —— 已匹配条目里**第一条有 `coverRef` 的**。
   * 顺序就是歌单条目序（可预测、可解释：用户按文件里的顺序看，第一首有图的就当封面）。
   * 一条都没有 ⇒ 空串（调用方把字段删掉，回退程序化色块，不留空壳）。
   */
  function displayCoverFrom(playlist, sidecar) {
    for (const entry of playlist?.items ?? []) {
      const record = sidecar?.entries?.[entryKey(entry)];
      if (record?.coverRef) return String(record.coverRef);
    }
    return '';
  }

  /**
   * 点「播放已匹配的 N 条」之后给这张歌单选展示封面（R198）。
   * 写进 sidecar 的新字段 `displayCoverRef` —— 与既有 `coverRef` **同一套纪律**：
   * 第三方地址只活在这份服务端数据文件里，响应里只出同源 token 地址（`tracks()` 那一格）。
   * **只在值真变了才写盘**（与 `matchAll` 的"只有真搜过才写盘"同一条纪律：不制造 mtime 噪音）。
   * `clear: true` = 用户在详情面板点了「恢复程序化封面」⇒ 删字段（就是回退，不留空壳）。
   */
  async function setDisplayCover(id, { clear = false } = {}) {
    const playlist = await store.get(id);
    if (!playlist) return { missing: true, ref: '' };
    const sidecar = await readSidecar(id);
    const before = String(sidecar.displayCoverRef ?? '');
    const next = clear ? '' : displayCoverFrom(playlist, sidecar);
    if (next === before) return { missing: false, ref: next, changed: false };
    if (next) sidecar.displayCoverRef = next;
    else delete sidecar.displayCoverRef;
    sidecar.updatedAt = now();
    await writeJsonAtomic(store.matchFileOf(id), sidecar);
    return { missing: false, ref: next, changed: true };
  }

  /**
   * R220 · 把"列 / 导入账号歌单"那一步拿到的**来源身份**写进 sidecar（`.playlist.txt` 正文逐字节不动）。
   * 对齐只用既有的条目指纹 `entryKey`（曲名 + 歌手 + 时长 + 专辑的归一哈希）——
   * **对不上的行一律不写**：不拿"曲名 + 歌手"当身份，也不猜任何 id（任务书红线；写侧 sanitize 过的行
   * 例如专辑名里有半角竖线，就会落在"没补到"那一档，报告里如实数出来）。
   * 一行都没补到 ⇒ 一个字节都不写盘（不该留下"看起来动过"的痕迹）。
   */
  async function applySourceIdentities(id, rows = []) {
    const playlist = await store.get(id);
    if (!playlist) return { missing: true, filled: 0, unfilled: 0, total: 0 };
    const total = (playlist.items ?? []).length;
    // 两份键：**完整条目指纹**（含时长）与"去掉时长"的那一份。为什么要后者：
    // 文本里的时长是按秒写回去的（`4:17`），上游给的毫秒值有零头时逐字回对不上 ⇒
    // 只用完整指纹会让一整批行"看起来没补到"，而它们其实一模一样的歌。
    // 但去时长以后**撞成多行的（同一首歌的两个版本）一律不写** —— 那种时候猜一次就可能播错歌。
    const exact = new Map();
    const loose = new Map();
    const ambiguous = new Set();
    for (const row of rows ?? []) {
      const provider = String(row?.provider ?? '');
      const mediaId = String(row?.mediaId ?? '').trim();
      if (!provider || !mediaId) continue;
      const identity = { provider, mediaId, mediaMid: String(row?.mediaMid ?? '') };
      // R226：上游这行**带了行封面**才跟着走（`identitiesOf` 已经把没给的行做成"这个键不出现"）。
      const coverRef = String(row?.coverRef ?? '').trim();
      if (/^https:\/\//i.test(coverRef)) identity.coverRef = coverRef;
      exact.set(entryKey(row), identity);
      const looseKey = entryKey({ ...row, durationMs: '' });
      if (loose.has(looseKey)) ambiguous.add(looseKey);
      else loose.set(looseKey, identity);
    }
    // 去时长这一档的歧义**两侧都要数**：上游两行撞一起是一首歌给两个 id，文本两行撞一起是两个版本
    // 只认得同一个"曲名+歌手"——后者更危险（一份身份会被写进两行，表现是"补到了"其实播错歌）。
    const entryLooseCount = new Map();
    for (const entry of playlist.items ?? []) {
      const looseKey = entryKey({ ...entry, durationMs: '' });
      entryLooseCount.set(looseKey, (entryLooseCount.get(looseKey) ?? 0) + 1);
    }
    const sidecar = await readSidecar(id);
    let filled = 0;
    let covers = 0;
    let covered = 0;
    for (const entry of playlist.items ?? []) {
      const key = entryKey(entry);
      const looseKey = entryKey({ ...entry, durationMs: '' });
      const looseUsable = !ambiguous.has(looseKey) && (entryLooseCount.get(looseKey) ?? 0) < 2;
      const identity = exact.get(key) ?? (looseUsable ? loose.get(looseKey) : null);
      if (!identity) continue;
      const record = sidecar.entries[key] ?? {};
      record.sourceProvider = identity.provider;
      record.sourceMediaId = identity.mediaId;
      if (identity.mediaMid) record.sourceMediaMid = identity.mediaMid;
      else delete record.sourceMediaMid;
      record.sourceAt = now();
      // R226 · P2 那半格：身份与封面**同一次写盘**（分开写就会出现"徽标说是来源身份、封面整列空"这副样子）。
      // 三条纪律：① **上游没给封面的行不硬造**（`identity.coverRef` 不存在就一格都不动）；
      // ② **已有的非空 coverRef 不覆盖**（搜索路与借图路填过的就是同一张碟的图，来回改盘会让每次"补身份"都重写一遍）；
      // ③ 写进自己这一家给的图时把「借图」标记与两个补图戳**成对摘掉**（留着半套就又是 R125 那副"看起来问过且没结果"的面孔）。
      if (identity.coverRef && !record.coverRef) {
        record.coverRef = identity.coverRef;
        delete record.coverFromProvider;
        delete record.coverTried;
        delete record.coverCheckedAt;
        covers += 1;
      }
      if (record.coverRef) covered += 1;
      sidecar.entries[key] = record;
      filled += 1;
    }
    if (!filled) return { missing: false, filled: 0, unfilled: total, total, covers: 0, coverless: 0 };
    sidecar.updatedAt = now();
    await writeJsonAtomic(store.matchFileOf(id), sidecar);
    // `covers` = 这一批**新补上封面**的行数；`coverless` = 补了身份但**仍然没有封面**的行数
    // （上游这行没给，或像酷狗那样给的是收不进白名单的模板 ⇒ 界面照旧画占位，不硬造）。
    return { missing: false, filled, unfilled: total - filled, total, covers, coverless: filled - covered };
  }

  return { matchEntry, matchAll, readSidecar, tracks, rememberCover, setDisplayCover, applySourceIdentities, store };
}
