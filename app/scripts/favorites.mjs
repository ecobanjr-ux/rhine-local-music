// 本项目自撰（非移植代码）。收藏 / 喜欢（R130 · 候选 ⑤ 的剩余项）：一份本机 JSON + 一个切换出口。
//
// 三条形状上的决定，都写在这里以免后来被"顺手改掉"：
//   ① **键是内容指纹，不是曲目 id**。本地曲目的 id 是 `track-<文件路径哈希>`（music-library.mjs:499），
//      换盘符、改根目录、重命名文件夹都会让它变一次 ⇒ 收藏会整批失联。
//      指纹只取"听得出来是同一首"的那几项（曲名 / 歌手 / 专辑 / 整秒时长），
//      与歌单匹配那套 `entryKey` 同源思路（同一个 `normalized` + 同一个 `hash`，不另起一套归一）。
//   ② **条目快照一起存**。只有键的清单没法回答"这条收藏的是哪首"；快照也让将来做收藏视图时
//      能如实区分"还在曲库里"与"文件已经不在"（本轮不做视图，但别把数据写成不可解释的哈希串）。
//   ③ 写盘走 `writeJsonAtomic`（全仓唯一的 JSON 原子写），并且**读-改-写串行**：
//      连点两下收藏不该丢一次。串行链本身必须"永不卡死"——上一批踩过"引入一把永不落地的锁"，
//      这里的 `serialized` 无论前一个任务成功还是抛错都往下接（见函数内注释）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hash, normalized, writeJsonAtomic } from './music-library.mjs';
import { toOnlineTrack } from './bridge/providers/normalize.mjs';

export const FAVORITES_FILE = 'favorites.json';
export const FAVORITES_VERSION = 1;
/** 上限是"看得见的一件事"而不是静默截断：到量了报错，让用户自己清。 */
export const MAX_FAVORITES = 10000;

/**
 * 在线曲目 id 的形状（`toOnlineTrack` 那边是 `on-${provider}-${mediaId}`，这里认同一份构造）。
 * 为什么要把来源与媒体 id 分开取出来而不是直接信任清单里那串：`favorites.json` 是本机可读可改的文件，
 * 一个野值不该变成一次出网。认不出形状就是"播不了"，不是"猜一个最接近的"。
 */
const ONLINE_ID_RE = /^on-([A-Za-z0-9_-]{1,32})-([A-Za-z0-9_-]{1,64})$/;

/**
 * 收藏键 = 归一化后的「曲名 · 歌手 · 整秒时长」。`duration` 是秒（本地曲目）、
 * `durationMs` 是毫秒（在线曲目），一律折到整秒再进哈希 ⇒ 同一首歌的两种载体算出同一个键。
 *
 * **R135（Q12 批复）：专辑不参与键。** 代价如实写在界面上：极少数"同名同长但不同录音"
 * （同一首的现场版与录音室版恰好同秒数）会被并成一条。换来的是两件事：
 *   · 本地曲目对象身上没有 `album` 字段（专辑在专辑对象上），从前本地身份的专辑是空的
 *     ⇒ 同一首歌的本地与在线成了两条（真机量到的，见 R132 §一.2）；
 *   · 一份"用户能自己读"的清单，键的口径越少一维就越不容易在两处漂移。
 */
export function favoriteKeyOf(track) {
  const milliseconds = track?.durationMs != null ? Number(track.durationMs) : Number(track?.duration ?? 0) * 1000;
  const seconds = Number.isFinite(milliseconds) ? Math.round(milliseconds / 1000) : 0;
  return hash([
    normalized(track?.title), normalized(track?.artist), seconds,
  ].join('\0'));
}

/**
 * 迁移前的键（带专辑那一维）。**只服务于那一次可回放的迁移**，别再拿它算新键——
 * 留着它是因为旧条目要能被认出来：`item.key === 旧键(快照)` 才说明"这条没迁过"。
 */
export function legacyFavoriteKeyOf(track) {
  const milliseconds = track?.durationMs != null ? Number(track.durationMs) : Number(track?.duration ?? 0) * 1000;
  const seconds = Number.isFinite(milliseconds) ? Math.round(milliseconds / 1000) : 0;
  return hash([
    normalized(track?.title), normalized(track?.artist), normalized(track?.album ?? ''), seconds,
  ].join('\0'));
}

/**
 * 一次性键迁移（R135 · Q12）。三条讲究：
 *   ① **受身份保护**：只有"存的键 == 用旧公式从这条快照算出来的键"才动手；
 *      认不出的键（手改过的、来源不明的）原样留着并单独报出来，不猜。
 *   ② **不许静默合并**：新键撞车时留 `addedAt` 更早的那条，被丢的那条逐条进 `collisions`
 *      （界面/日志要说得出"并掉了哪两条"）。
 *   ③ **可回放**：迁完之后每条的旧键 == 新键，再跑一次什么都不改（不写盘、报告全零）。
 * 纯函数：读盘与写盘在 `createFavoritesStore.migrate()` 那一侧。
 */
export function migrateFavoriteKeys(items = []) {
  const report = { migrated: 0, collisions: [], unknown: [], items: [] };
  const byKey = new Map();
  for (const item of (Array.isArray(items) ? items : [])) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key ?? '');
    const legacy = legacyFavoriteKeyOf(item);
    const next = favoriteKeyOf(item);
    let migratedKey = key;
    if (key === legacy && key !== next) {
      migratedKey = next;                       // 认得出是旧条目 ⇒ 换成新键
      report.migrated += 1;
    } else if (key !== next && key !== legacy) {
      report.unknown.push({ key, title: String(item.title ?? '') });   // 认不出：原样留着
    }
    const kept = { ...item, key: migratedKey };
    const previous = byKey.get(migratedKey);
    if (!previous) {
      byKey.set(migratedKey, kept);
      continue;
    }
    // 撞车：留 addedAt 更早的那条（那是用户第一次收藏的时刻），另一条进报告。
    const keepPrevious = (Number(previous.addedAt) || 0) <= (Number(kept.addedAt) || 0);
    const winner = keepPrevious ? previous : kept;
    const loser = keepPrevious ? kept : previous;
    byKey.set(migratedKey, winner);
    report.collisions.push({
      key: migratedKey,
      kept: { title: winner.title, addedAt: Number(winner.addedAt) || 0 },
      dropped: { title: loser.title, addedAt: Number(loser.addedAt) || 0 },
    });
  }
  report.items = [...byKey.values()];
  return report;
}

/** 收藏时留下的说明性快照（专辑只作说明，不参与键；`coverRef` 见下面 Q11 那段注释）。 */
function snapshotOf(track) {
  return {
    title: String(track?.title ?? ''), artist: String(track?.artist ?? ''),
    ...(track?.album ? { album: String(track.album) } : {}),
    durationMs: Math.round(Number(track?.durationMs ?? Number(track?.duration ?? 0) * 1000) || 0),
    sourceKind: track?.sourceKind === 'online' ? 'online' : 'local',
    trackId: String(track?.id ?? ''),
    // Q11（批复）：在线条目把**服务端反解出来的**那条第三方封面地址存进来，
    // 与歌单 sidecar 同口径（本机数据文件、只有服务端读得到、发给浏览器前一律换成同源 token）。
    // 前端送来的 `coverUrl` 是不可信的字符串：这里只接受"注册表里真的能反解出来"的那一条。
    ...(track?.coverRef ? { coverRef: String(track.coverRef) } : {}),
  };
}

/**
 * 收藏清单 → 界面读得懂的一份视图（R132 · 收藏列表视图）。
 * 纯函数：曲库那份平铺曲目由调用方给（路由从 `store.snapshot()` 拿），所以自检能在离线直接喂夹具。
 *
 * 三条"不许说谎"的判据，都是这一格存在的理由：
 *   ① 本地条目**按指纹回曲库查**：查到才叫可播，查不到要明写「文件已不在曲库」——
 *      既不许静默把它藏掉（用户会以为收藏丢了），也不许画成能播（点了没反应更糟）。
 *   ② 在线条目只认 `on-<来源>-<媒体 id>` 这一种形状，并且**由服务端签发同源播放地址**
 *      （`toOnlineTrack` 是那一个出处：音源白名单、参数编码、`mm` 那一段全在那儿判）。
 *      前端拿到的还是同一份窄契约，跟搜索结果一模一样 ⇒ 收藏不是第二条播放通路。
 *   ③ 封面：本地行走既有的 `/api/artwork/<专辑 id>`（快照里没有就是 `undefined`，界面画占位）；
 *      在线行走 R135（Q11）存下来的 `coverRef` ⇒ 由调用方注入的 `coverUrlOf` 换成**同源 token 地址**
 *      （注册表里没有 / 「在线封面」子开关关掉 ⇒ 空串，界面画占位）。
 *      两条合起来仍然守着同一条老判据（F3）：**发给浏览器的地址要么是既有的同源地址，要么是空，
 *      绝不按 id 造一个会 404 的**。第三方那条 URL 从这一层起就不往外走。
 */
export function favoriteView({ items = [], tracks = [], limit = MAX_FAVORITES, coverUrlOf = () => "" } = {}) {
  // 指纹 → 曲目。每次请求现算，不缓存：曲库重扫之后指纹对应的 id 可能整体换掉（R130 用指纹而不用 id 的原因）。
  const index = new Map();
  for (const track of tracks) {
    if (!track || typeof track !== 'object') continue;
    const key = favoriteKeyOf(track);
    if (!index.has(key)) index.set(key, track);   // 同一指纹命中多首（同一张碟的两个副本）：留第一首，清单里不重复出现
  }
  const rows = (Array.isArray(items) ? items : []).map((item) => {
    const base = {
      key: String(item?.key ?? ''),
      addedAt: Number(item?.addedAt ?? 0) || 0,
      title: String(item?.title ?? ''),
      artist: String(item?.artist ?? ''),
      album: String(item?.album ?? ''),
      durationMs: Number(item?.durationMs ?? 0) || 0,
      sourceKind: item?.sourceKind === 'online' ? 'online' : 'local',
    };
    /**
     * Q14 批复：徽标显示的是**这条收藏实际存在的载体集合**，不是"当初从哪儿收的"。
     * 两个载体的判据都是现算的、与播放无关（所以列表不会随正在播的那首发跳）：
     *   · 本地 = 指纹在曲库里查得到（`index` 就是为这件事建的）；
     *   · 在线 = 清单里那条身份确实写着"来源 + 媒体 id"（`toOnlineTrack` 认的形状）。
     * 同一首歌用本地播过一次、又用在线收藏过 ⇒ 这里就是两枚（R135 并条之后真机暴露的那一格：
     * 从前徽标跟着快照走，于是"我明明本地也有"这件事在界面上是隐形的）。
     */
    const hasOnlineId = ONLINE_ID_RE.test(String(item?.trackId ?? ''));
    const inLibrary = index.has(base.key);
    const carriers = [
      inLibrary ? 'local' : null,
      hasOnlineId ? 'online' : null,
    ].filter(Boolean);
    if (base.sourceKind === 'online') {
      const matched = ONLINE_ID_RE.exec(String(item?.trackId ?? ''));
      if (!matched) return { ...base, carriers, playable: false, reason: '这条在线身份不认识（清单里没写来源与媒体 id）' };
      const online = toOnlineTrack({
        provider: matched[1], mediaId: matched[2],
        title: base.title, artist: base.artist, album: base.album, durationMs: base.durationMs,
      });
      // `toOnlineTrack` 返回 null 只有一种原因：来源不在音源白名单里。那句实话要传给界面。
      if (!online) return { ...base, carriers, playable: false, reason: `不支持的音源：${matched[1]}` };
      // Q11：收藏时存下来的 coverRef 换成同源 token 地址。拿不到就是空串（界面画占位），不猜。
      const coverUrl = String(item?.coverRef ? coverUrlOf(item.coverRef) : "");
      return { ...base, carriers, playable: true, online: { ...online, coverUrl } };
    }
    const found = index.get(base.key);
    if (!found) return { ...base, carriers, playable: false, inLibrary: false, reason: '文件已不在曲库' };
    return { ...base, carriers, playable: true, inLibrary: true, trackId: String(found.id ?? ''), albumId: String(found.albumId ?? '') };
  });
  const playable = rows.filter((row) => row.playable).length;
  return { total: rows.length, playable, missing: rows.length - playable, limit, items: rows };
}

/**
 * `limit` 是可注入的上限（自检要用小数字才能把"到量报错"与"报错之后链还在跑"都走一遍，
 * 真机上限 10000 条靠写满来验证等于写一个 145 秒的自检）。
 */
export function createFavoritesStore({ dataDir, limit = MAX_FAVORITES } = {}) {
  const cap = Number(limit) > 0 ? Number(limit) : MAX_FAVORITES;
  const file = () => path.join(String(dataDir), FAVORITES_FILE);
  /** 读-改-写的串行链。前一个任务成不成功都要接上下一个，否则一次抛错就把这条链永久卡死。 */
  let chain = Promise.resolve();
  const serialized = (task) => {
    const run = chain.then(task, task);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  /** 坏了 / 版本不认识 / 形状不对 ⇒ 当没有，重建而不是崩（与 sidecar 同一条处置）。 */
  async function read() {
    const empty = { version: FAVORITES_VERSION, items: [] };
    let text;
    try {
      text = await fs.readFile(file(), 'utf8');
    } catch {
      return empty;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return empty;
    }
    if (!parsed || !Array.isArray(parsed.items)) return empty;
    if (parsed.version !== FAVORITES_VERSION) return empty;
    return { version: FAVORITES_VERSION, items: parsed.items.filter((item) => item && typeof item.key === 'string') };
  }

  async function list() {
    return (await read()).items;
  }

  async function has(track) {
    const key = favoriteKeyOf(track);
    return (await read()).items.some((item) => item.key === key);
  }

  /** 收藏 / 取消收藏。返回的是**操作之后**的事实（liked + 总数），界面按它更新，不自己猜。 */
  async function toggle(track) {
    return serialized(async () => {
      const key = favoriteKeyOf(track);
      const data = await read();
      const at = data.items.findIndex((item) => item.key === key);
      const liked = at === -1;
      if (liked) {
        if (data.items.length >= cap) throw new Error(`收藏已达上限 ${cap} 条：先清一些再收藏`);
        data.items.push({ key, addedAt: Date.now(), ...snapshotOf(track) });
      } else {
        data.items.splice(at, 1);
      }
      data.updatedAt = Date.now();
      await writeJsonAtomic(file(), data);
      return { liked, key, count: data.items.length };
    });
  }

  /**
   * 一次性键迁移（R135 · Q12）。走同一条串行链（不能与 toggle 并发跑，否则两边都在读旧文件）；
   * 没东西可改就不写盘 ⇒ **可回放**：启动时每次都可以调，第二次报告全零且不落盘。
   * 报告原样交回调用方，由服务端写进日志——"并掉了哪两条"必须是看得见的，不许静默合并。
   */
  async function migrate() {
    return serialized(async () => {
      const data = await read();
      const report = migrateFavoriteKeys(data.items);
      const changed = report.migrated > 0 || report.collisions.length > 0;
      if (!changed) return { ...report, wrote: false };
      await writeJsonAtomic(file(), { version: FAVORITES_VERSION, items: report.items, updatedAt: Date.now() });
      return { ...report, wrote: true };
    });
  }

  return { file, list, has, toggle, migrate };
}
