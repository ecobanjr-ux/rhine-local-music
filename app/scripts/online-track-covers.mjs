// 本项目自撰（非移植代码）。在线曲目封面的服务端注册表与取图（看板 ⑨ 范围追加）。
//
// 为什么要这一层，而不是把上游那条封面地址直接发给浏览器：
//   · **与音源同一条红线**——"第三方那条 URL 到不了浏览器"（见 `bridge/providers/normalize.mjs` 文件头）。
//     浏览器只看到 `/api/online/artwork/<token>`，token 是封面地址的短哈希，反推不出地址；
//   · 出网必须留在本站这一侧：否则设置面板那张出网审计表（"用户能看到我们打了谁"）看不见这些请求，
//     「在线封面」那张子开关也管不住它们。
//
// 三条硬规矩，都写进代码而不是只写在这里：
//   ① **本模块零写盘零读盘**：图片字节只交给曲库的 `cacheArtworkBytes` 落到 `dataDir/artwork`
//      （全仓唯一写图片的那一处）⇒ 它进 R74 的写盘白名单扫描面与 R75 的"不得裸 fetch"扫描面；
//   ② 出网只走 `guardedTrackCoverFetch`（exact 主机表、8 MiB 档、审计 kind `cover`、`redirect:'error'` 照旧）；
//   ③ **认魔数不认上游 content-type**（实测网易给的是 `image/jpg` 这种非标准值，QQ 给 `image/jpeg`），
//      判据与专辑封面那一路共用同一个 `detectImageMime`，不写第二份。
import { createHash } from 'node:crypto';
import { guardedTrackCoverFetch } from './online-guard.mjs';
import { detectImageMime } from './online-covers.mjs';
import { MAX_PLAYLIST_LINES } from './playlists.mjs';
import { MAX_FAVORITES } from './favorites.mjs';

/**
 * 留给"这一屏之外还要顺手签几张"的余量：一次搜索 20 条、墙上重取封面、手工指定那张单……
 * 它不是任何一屏的规模，只是不让那几路把主屏挤出去。
 */
export const TRACK_COVER_HEADROOM = 2048;
/**
 * 注册表上限：**按产品自己的两个限额之和给**，不再按"够几十次搜索"给。
 * 真实约束是"一屏能同时挂多少张封面"——一张整单最多 `MAX_PLAYLIST_LINES` 行，
 * 收藏视图最多 `MAX_FAVORITES` 条（`music-server.mjs` 里 `coverUrlOf` 就是本模块的 `register`），
 * 两个数各自都在自己模块里，改它们的人不必知道这里，但这里必须跟着它们走。
 * 原来那颗 600 是为搜索结果设计的，一次导入 1000 条时最早那 ~300 多张会被按插入序挤掉，
 * 表现是"服务端明明算出了封面地址、浏览器取图 404、界面画占位"（台账 R172）。
 * 超了仍按插入顺序淘汰最老的，不做无界增长。
 */
export const TRACK_COVER_REGISTRY_MAX = MAX_PLAYLIST_LINES + MAX_FAVORITES + TRACK_COVER_HEADROOM;
/** token 的形状：只认这个长度与字符集，路由先按它拒一次，省得把别的字符串带进查表。 */
export const TRACK_COVER_TOKEN_PATTERN = /^[a-f0-9]{16}$/;

/**
 * `write` 由调用方注入（真机上就是 `store.cacheArtworkBytes`）：本模块拿到字节就交出去，
 * 自己不碰文件系统——"谁在往磁盘写图片"这件事全仓只允许有一个答案。
 */
export function createOnlineTrackCoverStore({ fetcher = guardedTrackCoverFetch, write, enabled = () => true, log = () => {} } = {}) {
  const refs = Object.create(null);      // token -> 第三方封面地址
  const fetched = Object.create(null);   // token -> { path, mime }（已经落进缓存的，不再出网）
  const order = [];                      // 插入顺序，用于有界淘汰

  const tokenOf = (coverRef) => createHash('sha256').update(String(coverRef)).digest('hex').slice(0, 16);

  /** 登记一条封面地址，返回给浏览器的那条同源地址。不是 https 的进来就空手回去（没封面就画占位）。 */
  function register(coverRef) {
    // 「在线封面」那张子开关关掉 ⇒ 一个 token 都不签发，前端自然回到占位；
    // 路由那侧还有一道同样的判据（两处同一个 `enabled`，不是两份状态）。
    if (!enabled()) return '';
    const ref = String(coverRef ?? '');
    if (!/^https:\/\//i.test(ref)) return '';
    const token = tokenOf(ref);
    if (!refs[token]) {
      refs[token] = ref;
      order.push(token);
      while (order.length > TRACK_COVER_REGISTRY_MAX) {
        const old = order.shift();
        delete refs[old];
        delete fetched[old];
      }
    }
    return `/api/online/artwork/${token}`;
  }

  /** 从同源地址反推 token 并取回登记过的那条上游地址。 */
  function coverRefFor(token) {
    return TRACK_COVER_TOKEN_PATTERN.test(String(token ?? '')) ? refs[token] ?? null : null;
  }

  /**
   * 取一张在线曲目封面：命中过就直接给缓存里那份，没命中才出网一次。
   * 失败一律返回 null（界面画既有占位），**不抛**——一张封面不该把搜索结果或播放带走。
   */
  async function load(token) {
    if (!enabled()) return null;            // 关掉之后旧 token 也不该再出网
    if (fetched[token]) return fetched[token];
    const ref = coverRefFor(token);
    if (!ref) return null;
    try {
      const response = await fetcher(ref);
      if (!response?.ok) return null;
      const bytes = typeof response.bytes === 'function' ? response.bytes() : null;
      const mime = detectImageMime(bytes);
      if (!mime) return null;                       // 魔数不匹配 = 不是可显示的图，不落盘也不记成功
      const saved = await write(bytes, mime);
      if (!saved) return null;
      fetched[token] = saved;
      log(`在线曲目封面已缓存：${new URL(ref).hostname} → artwork/${saved.path.split(/[\\/]/).pop()}`);
      return saved;
    } catch (error) {
      // 被自己的白名单拦下与"上游 404"是两件不同的事，日志里分开留一句（R75 的同一口径）。
      log(`在线曲目封面取图失败：${error?.message ?? error}`);
      return null;
    }
  }

  // `enabled` 透出去是给"要不要为它多打一次搜索"这类**决策**用的（歌单匹配那侧要判），
  // 不是第二份状态——判的还是装配时传进来的那一个闭包。
  return { register, coverRefFor, load, size: () => order.length, tokenOf, enabled: () => !!enabled() };
}
