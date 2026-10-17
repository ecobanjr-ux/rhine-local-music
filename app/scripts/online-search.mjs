// 本项目自撰（非移植代码）。在线搜索的编排层（父进程侧）：多源并发 → 逐源失败隔离 → 去重合并 → 窄契约出口。
//
// 分工与歌词/音源一致（R86 ①）：网易经桥，QQ 在这里自写 fcg + guardedFetch。
// 为什么 QQ 必须在这里而不是桥里：包内是 axios，绕开安全层 ⇒ 出网审计表看不见它打了谁。
//
// 一手实测（2026-10-05，`t7-qq-total.mjs`）：QQ 的 `DoSearchForQQMusicLite` 响应体里**没有任何总数字段**
// （keys 只有 direct_group/head/item_*/showMore/singer/…，`showMore` 在真有第二页时也仍是 0），
// 但翻页本身有效（第 1、2 页拿到的 mid 完全不同）。所以 QQ 这一档：
//   · `total` 如实报 null（"不知道"），不拿条目数编一个；
//   · `hasMore` 只能由"这一页拿满了"推出来，并且**在代码里写明它是推断**——
//     与网易那一档形成对照：网易的 `result.songCount` / `result.hasmore` 是接口直接给的，不需要推。
import { guardedFetch, ONLINE_SEARCH_TIMEOUT_MS } from './online-guard.mjs';
import { qqSearchToItems, toOnlineTrack, itemKey } from './bridge/providers/normalize.mjs';

const QQ_FCG = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
// comm 与歌词通道同一份（实测：换成网页端 comm 时搜索返 0 条，见 Task 6 取证表最后一行）。
const QQ_COMM = {
  ct: 11, cv: '1003006', v: '1003006', os_ver: '15', phonetype: '24122RKC7C',
  rom: 'Redmi/miro/miro:15/AE3A.240806.005/OS2.0.102.0.VOMCNXM:user/release-keys',
  tmeAppID: 'qqmusiclight', nettype: 'NETWORK_WIFI', udid: '0', uid: '0',
};
const QQ_HEADERS = { 'Content-Type': 'application/json', Cookie: 'tmeLoginType=-1;', 'User-Agent': 'okhttp/3.14.9' };

/**
 * 今天参与的搜索源（顺序即展示顺序）。
 * 2026-10-10（任务一 · R154）起多一家**酷狗**，但它有一个前置条件：一手实测（同一天）
 * 匿名只有 mid ⇒ 502 / `error_code 152`，带上登录态才 200。所以本机没有酷狗登录态时
 * 这一站**根本不出网**（父进程连桥都不问），只在 perSource 里留一句实话的原因——
 * 与"查了但没结果"和"查了但坏了"是三种不同的事实，界面分开显示。
 */
export const SEARCH_PROVIDERS = Object.freeze(['netease', 'qq', 'kugou']);
export const SEARCH_QUERY_MAX = 80;
export const SEARCH_LIMIT_MAX = 30;
export const SEARCH_OFFSET_MAX = 3000;

/** 参数把关（纯函数）：路由与自检都走这一份，避免"改了路由忘了改判据"。 */
export function normalizeSearchRequest(value) {
  const query = String(value?.query ?? '').trim().slice(0, SEARCH_QUERY_MAX);
  if (!query) return { error: '缺少检索词' };
  const offset = Number(value?.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > SEARCH_OFFSET_MAX) return { error: `offset 必须是 0 到 ${SEARCH_OFFSET_MAX} 的整数` };
  const limit = Number(value?.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) return { error: `limit 必须是 1 到 ${SEARCH_LIMIT_MAX} 的整数` };
  const provider = value?.provider === undefined || value.provider === null ? null : String(value.provider);
  if (provider !== null && !SEARCH_PROVIDERS.includes(provider)) return { error: `不支持的搜索源：${provider}` };
  return { query, offset, limit, provider };
}

/**
 * 建一个搜索器。`bridge` / `fetcher` 都可注入 ⇒ 这一层的全部行为（含"单源失败不拖垮整次"）
 * 都能在离线自检里判定，真机那一半只出现在取证里。
 */
export function createOnlineSearcher({ bridge, fetcher = guardedFetch, timeoutMs = ONLINE_SEARCH_TIMEOUT_MS, covers = null, kugouSession = null, saveKugouDevice = null } = {}) {
  const searchQq = async ({ query, offset, limit }) => {
    // QQ 这套接口按"页"分页而不是按"条"，所以 offset 只能折算成页号；除不尽时如实从该页开头取。
    const page = Math.floor(offset / limit) + 1;
    const response = await fetcher(QQ_FCG, {
      method: 'POST', headers: QQ_HEADERS, kind: 'search', timeoutMs,
      body: JSON.stringify({
        comm: QQ_COMM,
        request: {
          method: 'DoSearchForQQMusicLite', module: 'music.search.SearchCgiService',
          param: {
            search_id: String(Date.now()), remoteplace: 'search.android.keyboard',
            query, search_type: 0, num_per_page: limit, page_num: page,
            highlight: 0, nqc_flag: 0, page_id: 1, grp: 1,
          },
        },
      }),
    });
    if (!response.ok) return { ok: false, provider: 'qq', reason: `QQ 检索接口 HTTP ${response.status}` };
    const payload = response.json();
    if (payload?.request?.code !== 0) return { ok: false, provider: 'qq', reason: `QQ 检索返回码 ${payload?.request?.code ?? '未知'}` };
    const body = payload?.request?.data?.body;
    const items = qqSearchToItems(body?.item_song);
    if (items === null) return { ok: false, provider: 'qq', reason: 'QQ 检索响应里没有 item_song 数组（请求没被正确接受，不是"没有结果"）', retryable: true };
    return {
      ok: true, provider: 'qq', items,
      total: null,                                  // 实测：这个接口不给总数，不拿条目数编一个
      hasMore: items.length === limit,              // 推断值（理由见文件头），只用于"还要不要再给下一页"
    };
  };

  const searchNetease = async ({ query, offset, limit }) => {
    if (!bridge?.call) return { ok: false, provider: 'netease', reason: 'bridge-off', retryable: false };
    const result = await bridge.call('/bridge/search', { provider: 'netease', keywords: query, offset, limit });
    if (!result?.ok) return { ok: false, provider: 'netease', reason: result?.reason ?? '桥没有回检索结果', retryable: result?.retryable ?? true };
    return { ok: true, provider: 'netease', items: result.items ?? [], total: Number(result.total ?? 0) || 0, hasMore: result.hasMore === true };
  };

  /**
   * 酷狗那一站（R154 · 任务一）。**先问"有没有登录态"，没有就一个包都不出**：
   * 一手实测匿名只有 mid 会撞 502/152，那一跳除了多一次出网与一行噪音什么也换不来。
   * 有登录态才经桥（包内那份安卓签名不由我们重抄，理由见 `bridge/search-routes.mjs` 头部）。
   */
  const searchKugou = async ({ query, offset, limit }) => {
    const session = kugouSession ? await kugouSession().catch(() => null) : null;
    if (!session?.cookie || !session?.device?.guid) {
      return { ok: false, provider: 'kugou', items: [], reason: '本机没有酷狗登录态：这一家要登录后才参与检索与播放（这一站零出网）' };
    }
    if (!bridge?.call) return { ok: false, provider: 'kugou', reason: 'bridge-off', retryable: false };
    const result = await bridge.call('/bridge/search', { provider: 'kugou', keywords: query, offset, limit, device: session.device, cookie: session.cookie });
    if (!result?.ok) return { ok: false, provider: 'kugou', reason: result?.reason ?? '桥没有回酷狗检索结果', retryable: result?.retryable ?? true };
    // 桥回报它实际用的那份身份（mid 是包内 `calculateMid` 第一次算出来的）；存不下来不影响这一页的结果。
    if (result.device && saveKugouDevice) await Promise.resolve(saveKugouDevice(result.device)).catch(() => {});
    return { ok: true, provider: 'kugou', items: result.items ?? [], total: Number(result.total ?? 0) || 0, hasMore: result.hasMore === true };
  };

  /** 多源并发 → 逐源失败隔离 → 跨源去重 → 丢掉拼不出音源的条目。两个出口共用这一份，只差最后换不换形状。 */
  const mergeSources = makeMergeSources({ searchQq, searchNetease, searchKugou, usable: (item) => Boolean(toOnlineTrack(item)) });

  return {
    async search(value) {
      const merged = await mergeSources(value);
      if (!merged) return invalidSearchResult(value);
      // 封面：上游那条 URL 只进服务端注册表，发给浏览器的永远是同源地址（与音源同一条红线）。
      // 注册表没注入（自检、或关掉「在线封面」那一档）就不带这个字段 ⇒ 前端照旧画占位，不是报错。
      const items = merged.entries.map((item) => {
        const track = toOnlineTrack(item);
        if (covers && item.coverRef) {
          const coverUrl = covers.register(item.coverRef);
          if (coverUrl) track.coverUrl = coverUrl;
        }
        return track;
      });
      return { ...merged.shape, items };
    },
    /**
     * **服务端内部**用的那一份：返回桥归一后的内部条目（带 `coverRef` 与 `mediaMid`）。
     * 为什么单开一个出口（看板 95fe081 跳①）：`search()` 出去的是发给浏览器的契约形状，
     * 第三方封面地址在那一步就被换掉了；而歌单匹配要把地址**存进 sidecar**（服务端数据文件）
     * 供以后按条目签发——拿着换过的地址没法再签。
     * 顺带对齐的是 `mediaMid`：从前匹配器把"已经发给过前端的形状"再喂回 `toOnlineTrack`，
     * QQ 的次 id 在那一步被丢掉，拼出来的中转地址少了 `mm` 段（本轮真机侧才发现，见 run log）。
     */
    async searchEntries(value) {
      const merged = await mergeSources(value);
      if (!merged) return invalidSearchResult(value);
      return { ...merged.shape, items: merged.entries };
    },
  };
}

/** 请求本身不合法（400 那一档）：与"合法但没结果"分开，客户端要能分开说。 */
const invalidSearchResult = (value) => ({
  ok: false, invalid: true, error: normalizeSearchRequest(value).error ?? '检索请求不合法', items: [], perSource: [],
});

function makeMergeSources({ searchQq, searchNetease, searchKugou, usable }) {
  const runners = { netease: searchNetease, qq: searchQq, kugou: searchKugou };
  return async function mergeSources(value) {
    const request = normalizeSearchRequest(value);
    if (request.error) return null;
    const wanted = request.provider ? [request.provider] : SEARCH_PROVIDERS;
    const calls = wanted.map((provider) => (runners[provider] ?? (() => Promise.resolve({ ok: false, provider, reason: `没有 ${provider} 这一站的检索实现` })))(request)
      // 单源失败不许拖垮整次：任何抛出（桥没起来、DNS 失败、超时、响应形状不对）都在这里收成一条原因。
      .catch((error) => ({ ok: false, provider, reason: error?.message ?? String(error), retryable: true })));
    const settled = await Promise.all(calls);
    const perSource = settled.map((result) => ({
      provider: result.provider, ok: result.ok === true, count: result.items?.length ?? 0,
      ...(result.reason ? { reason: String(result.reason).slice(0, 200) } : {}),
    }));
    const seen = new Set();
    const entries = [];
    for (const result of settled) {
      for (const item of result.items ?? []) {
        if (!usable(item)) continue;               // 拼不出音源的条目一开始就不进任何出口
        const key = itemKey(item);
        if (seen.has(key)) continue;              // 同一首歌两个源都有 ⇒ 只留排在前那个
        seen.add(key);
        entries.push(item);
      }
    }
    const totals = settled.filter((result) => Number.isFinite(result.total));
    const anyOk = perSource.some((entry) => entry.ok);
    return {
      entries,
      shape: {
        ok: anyOk,
        ...(anyOk ? {} : { error: settled.map((r) => r.reason).filter(Boolean).join('；') || '所有在线源都没有应答' }),
        total: totals.length ? totals.reduce((sum, r) => sum + r.total, 0) : null,
        hasMore: settled.some((result) => result.hasMore === true),
        nextOffset: request.offset + request.limit,
        perSource,
        query: request.query,
      },
    };
  };
}
