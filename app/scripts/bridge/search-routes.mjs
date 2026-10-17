// 本项目自撰（非移植代码）。桥的搜索通道：网易（要包里的实现与匿名令牌）+ 酷狗（任务一 · B 路线新接的第三家）。
//
// 为什么 QQ 不在这里、而酷狗在：
//   · QQ 的搜索是本项目自写的 fcg 调用，在父进程经 guardedFetch 发（与音源同一处，见 online-search.mjs）
//     ——进桥就变成包内 axios 那一套，出网审计表上看不见它打了谁；
//   · 酷狗**必须**进桥：它的搜索要**包内安卓签名**（`signatureAndroidParams` 那一份盐值与参数序），
//     在父进程重抄一遍签名就是第二个真相（R154 记的"谁都不能自己抄一份"）。审计因此记成 `backend` 那一档
//     ——含义是"酷狗这一家被叫了一次"，与 guard 那几行"我们自己去打了谁"分开列（R75 的诚实边界）。
//   · 酷狗这一跳**要登录态**：一手实测（2026-10-10）匿名只有 mid ⇒ 502 / `error_code 152`，
//     带上父进程借来的 `token`+`userid` ⇒ 200 且 `data.lists` 有条目。未登录时父进程根本不问桥（零出网）。
//
// 出桥的条目一律过一遍窄契约（providers/normalize.mjs）：第三方响应有几十个字段的边角，
// 一个都不该到前端（R78）。
import { ncmSearchToItems, kugouSearchToItems } from './providers/normalize.mjs';
import { kugouDeviceCall, kugouFailureReason } from './providers/kugou-device.mjs';
// 拆 cookie 的那一份实现在登录那一侧（R136 为 `user_detail` 造的，判据：依据变了要重看这个拆法）。
// 这里复用而不是再写一遍：两处拆 cookie 迟早会在"分号还是逗号"上分家。
import { kugouCookieToObject } from './providers/kugou-auth.mjs';

const NCM_SEARCH_TIMEOUT_MS = 12_000;
const SEARCH_LIMIT_MAX = 30;

/** 桥内一跳的 JSON 取回（与 lyric-routes 那份同形：解析失败要说"不是 JSON"，不能当成空结果）。 */
async function callNcm(handle, path, fetchImpl) {
  const response = await fetchImpl(`${handle.baseUrl}${path}`, { signal: AbortSignal.timeout(NCM_SEARCH_TIMEOUT_MS) });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, error: `网易后端返回的不是 JSON（HTTP ${response.status}）` };
  }
}

/**
 * 挂搜索路由。`fetchImpl` 是给离线自检的注入口（真机上固定用桥内那份 loopbackFetch）。
 * 分页语义按一手实测：总数在 `result.songCount`、还有没有下一页在 `result.hasmore`——
 * 两者都不是从"这一页返回了几条"推出来的（拿条目数当总数会在最后一页谎报 hasMore）。
 */
/**
 * 酷狗检索一跳（进程内直调包，设备身份与登录态都由父进程带来；桥不写任何文件）。
 * 分页按**页号 × 每页数**（一手实测响应里 `data.pagesize` / `data.page` / `data.total`），
 * 对外仍收 offset/limit —— 与歌单那一跳（R137）同一条换算口径，别让两家各切一次。
 */
async function kugouSearch(backends, payload) {
  const handle = backends?.kugou;
  if (!handle || handle.state !== 'ready' || typeof handle.invoke !== 'function') {
    return { ok: false, provider: 'kugou', reason: '酷狗后端未就绪（在线能力被关闭或后端正在重启）', retryable: true };
  }
  const keywords = String(payload?.keywords ?? '').trim().slice(0, 80);
  if (!keywords) return { ok: false, provider: 'kugou', reason: '缺少检索词', retryable: false };
  const offset = Math.max(0, Math.min(3000, Number(payload?.offset ?? 0) || 0));
  const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(payload?.limit ?? 20) || 20));
  // 凭据与设备身份是**两条通道**：`device` 里只有 guid/mid/dfid，账号那一对走 `cookie` 头
  // （父进程从分区里借出来）。这里必须自己拆一次并合进设备对象——真机抓到过漏这一步：
  // 漏了之后 cookie 里没有 token/userid，上游把这一跳当匿名请求回 502 / `error_code 152`，
  // 看起来像"酷狗检索坏了"，实际是我们没把凭据交给包（与 R153 那次"参数名没传对"同一族）。
  const session = kugouCookieToObject(payload?.cookie);
  // 与音频那一跳同一条闸门：**没有账号就不碰包**。父进程本来也不该在未登录时问这一跳，
  // 走到这里就是有人问了 ⇒ 给一句实话，并且**零 invoke**（一次匿名请求只会换来 152 与一笔无谓出网）。
  if (!session.token || !session.userid) {
    return { ok: false, provider: 'kugou', reason: '本机没有酷狗登录态：这一家要登录后才参与检索（这一跳不出网）', retryable: false };
  }
  const called = await kugouDeviceCall(handle, 'search', {
    keywords, page: Math.floor(offset / limit) + 1, pagesize: limit, type: 'song',
  }, { ...(payload?.device ?? {}), token: String(session.token ?? ''), userid: String(session.userid ?? '') });
  if (!called.ok) return { ok: false, provider: 'kugou', reason: kugouFailureReason(called, '检索'), retryable: true, device: called.device };
  const body = called.result?.body ?? called.result?.data ?? called.result ?? {};
  const items = kugouSearchToItems(body);
  if (items === null) {
    // 与网易同一条规矩：`lists` 缺席（请求没被正确接受）与"空数组"（真没结果）是两件事。
    return { ok: false, provider: 'kugou', reason: '酷狗检索响应里没有 data.lists 数组（请求没被正确接受，不是"没有结果"）', retryable: true, device: called.device };
  }
  const total = Number(body?.data?.total ?? 0) || 0;
  return {
    ok: true, provider: 'kugou', items, total,
    hasMore: total > 0 ? offset + items.length < total : items.length === limit,
    device: called.device,
  };
}

/** 桥那边抛上来的酷狗失败：只取"哪一档 HTTP"与上游错误码，不带响应体（体里可能有身份字段）。 */

export function registerSearchRoutes({ routes, backends, fetchImpl }) {
  const fetch = fetchImpl;
  routes.set('/bridge/search', async (payload) => {
    const provider = String(payload?.provider ?? '');
    // 酷狗那一跳不经环回 HTTP（进程内直调包），所以在最外层就分叉出去，别落到网易那一段的假设里。
    if (provider === 'kugou') return kugouSearch(backends, payload);
    if (provider !== 'netease') return { ok: false, provider, reason: provider ? `桥不为 ${provider} 提供搜索通道` : '缺少搜索 provider', retryable: false };
    const handle = backends.netease;
    if (!handle || handle.state !== 'ready' || !handle.baseUrl) {
      return { ok: false, provider: 'netease', reason: '网易后端未就绪', retryable: true };
    }
    const keywords = String(payload?.keywords ?? '').trim().slice(0, 80);
    if (!keywords) return { ok: false, provider: 'netease', reason: '缺少检索词', retryable: false };
    const offset = Math.max(0, Math.min(3000, Number(payload?.offset ?? 0) || 0));
    const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Number(payload?.limit ?? 20) || 20));
    const found = await callNcm(handle, `/cloudsearch?keywords=${encodeURIComponent(keywords)}&limit=${limit}&offset=${offset}&type=1`, fetch);
    if (found.error) return { ok: false, provider: 'netease', reason: found.error, retryable: true };
    const items = ncmSearchToItems(found.body);
    if (items === null) {
      // "没有 songs 字段"与"songs 是空数组"是两件事（歌词那侧立的规矩，这里同一条）：
      // 前者是请求没被正确接受，后者才是"这个检索词真的没有结果"。
      return { ok: false, provider: 'netease', reason: '网易检索响应里没有 result.songs 字段（请求没被正确接受，不是"没有结果"）', retryable: true };
    }
    const result = found.body?.result ?? found.body;
    const total = Number(result?.songCount ?? 0) || 0;
    return {
      ok: true, provider: 'netease', items,
      total,
      // 分页判据按实测来：这个 build 的 cloudsearch **不给 `hasmore`**（resultKeys 只有 songs / songCount），
      // 所以有总数时用"已取条数 < 总数"这个由接口总数推出的判断；哪天接口给了 hasmore 就直接用它的。
      hasMore: result?.hasmore !== undefined ? (result.hasmore === true || result.hasmore === 1) : offset + items.length < total,
    };
  });
  return routes;
}
