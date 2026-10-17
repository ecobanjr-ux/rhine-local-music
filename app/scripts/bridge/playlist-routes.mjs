// 本项目自撰（非移植代码）。桥的歌单通道：网易（Task 10）与酷狗（R137）的公开歌单详情与曲目。
//
// 网易只用两个端点，都是 Task 0 + 今天实测过的：
//   · `/playlist/detail?id=`            → 元信息（名字、trackCount、封面）
//   · `/playlist/track/all?id=&limit=&offset=` → 曲目（内部是 detail 拿 trackIds 再切片问 song/detail）
// **`/playlist/tracks` 在本 build 是 404**（模块不存在，实测 `{"code":404,"msg":"Not Found"}`）⇒ 不试第二次。
//
// 分页判据按 Task 0 U7 的实测结论：以 `detail.playlist.trackCount` 为目标总数，
// **不许照 `items.length === limit` 猜还有没有下一页**——limit=200 对 173 条的歌单返回 173 条、
// 第二页 0 条；恰好等长时那条启发式会误判。页内不足或累计够了才收尾。
//
// 酷狗那一路（R137）走的是**进程内直调包**（`backends.kugou.invoke`），不是环回 HTTP，且三处与网易不同：
//   · id 空间不同：要的是 `global_collection_id`（形如 `collection_1_1341266283_964007_0`），
//     **search 给的 `specialid` 不认**（一手实测：拿 specialid 去问 detail 回空、去问 track_all 回 502/20010，
//     并且试过用 `collection_<type>_<作者 userid>_<specialid>_0` 反推三种 type 全部读不到 ⇒ 不猜）；
//   · 分页是**页号 × 每页数**（`begin_idx=(page-1)*pagesize`）而不是 offset/limit；对外仍收 offset/limit，
//     在这一跳换算并把**实际用的页大小**回吐给调用方（回吐错了，调用方会按"页没满"提前收尾，少一截还不报）；
//   · "读不到"没有 404：私有 / 被删 / 未发布都是 200 + 行内标记（`is_pri / is_drop / status / is_publish`），
//     由 `kugouDetailReadability` 逐条翻译，与"这张单真的是空的"分开说。
import { ncmDetailToMeta, ncmSongsToItems, kugouDetailToMeta, kugouSongsToItems, accountPlaylistsToItems } from './providers/playlist.mjs';
// R159（任务六）：账号歌单那两跳复用搜索/取址同一套凭据与设备身份入口（桥不落盘也不读盘）。
import { kugouCookieToObject } from './providers/kugou-auth.mjs';
import { kugouDeviceCall, kugouFailureReason } from './providers/kugou-device.mjs';

const NCM_PLAYLIST_TIMEOUT_MS = 15_000;
const TRACKS_PAGE_LIMIT = 500;
const MAX_TRACKS = 1000;          // 继承自上游 omni.ts:291 的硬顶，不是接口给的 ⇒ 截断必须显式报出去
/** 酷狗一次问一页：实测 pagesize=200/300 都能一次给满 127 条的那张单，取 200 与网易同源同档、也留足余量。 */
const KUGOU_PAGE_LIMIT = 200;
/** 酷狗 id 的形状（一手样本两种：`collection_3_1863870844_4_0` / `collection_1_1341266283_964007_0`）。 */
export const KUGOU_PLAYLIST_ID = /^collection_\d{1,4}_\d{1,20}_\d{1,20}_\d{1,4}$/;

/**
 * 网易那一跳。`cookie` 是 R159 加的（账号歌单要登录态）：**只走请求头**——
 * 这个包也认 `?cookie=`，但查询串会进包自己的访问日志行（M3-a Task C 同一处置）。
 * 公开歌单那两跳（detail / tracks）不传它，行为与今天逐字一致。
 */
async function callNcm(handle, path, fetchImpl, cookie = '') {
  const response = await fetchImpl(`${handle.baseUrl}${path}`, {
    signal: AbortSignal.timeout(NCM_PLAYLIST_TIMEOUT_MS),
    ...(cookie ? { headers: { cookie } } : {}),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, error: `网易后端返回的不是 JSON（HTTP ${response.status}）` };
  }
}

/**
 * 酷狗那一路的两个动作。与网易同一条对外契约（`{ok, provider, action, ...}` + tracks 的 `items/offset/limit`），
 * 差别都消化在这里：id 形状、页号换算、"读不到"的标记翻译。
 * `invoke` 是桥内那份进程内直调（见 `backends/kugou.mjs`），包把失败**抛成对象**（`{status:502, body:{error_code}}`），
 * 所以每一跳都要 catch——不 catch 的话一次上游 502 会把整条桥路由打成"桥没应答"。
 */
async function kugouPlaylist(backends, payload) {
  const handle = backends?.kugou;
  if (!handle || handle.state !== 'ready' || typeof handle.invoke !== 'function') {
    return { ok: false, provider: 'kugou', reason: '酷狗后端未就绪（在线能力被关闭或后端正在重启）', retryable: true };
  }
  // R159（任务六）：`mine` 不要 id（列的是"这台机器登录的那个账号自己的"单），所以它必须在 id 闸**之前**。
  if (String(payload?.action ?? '') === 'mine') return kugouMine(handle, payload);
  const id = String(payload?.id ?? '').trim();
  if (!KUGOU_PLAYLIST_ID.test(id)) {
    // 两种读不到的 id 形态都在这里被挡下，且**零出网**（不是拿去问了才知道读不到）：
    // `specialid`（R137 量：detail 回空、track_all 502/20010，三种反推都不成立）与
    // 手机分享的 `gcid_<token>`（R138 量：接口不认它本身，由 token 反推的六种拼法也全部读不到，
    // 而同进程里拿一张已知的 collection_ 单做对照是好的 ⇒ 不是通道坏）。
    const looksGcid = /^gcid_[\w-]{4,60}$/.test(id);
    return {
      ok: false, provider: 'kugou', retryable: false,
      reason: looksGcid
        ? '酷狗手机分享的 gcid_ 形态本机读不到：接口只认 global_collection_id（形如 collection_1_1341266283_964007_0），'
          + '而 gcid_ 那段推不出它（试过 base36 全量 / 低 32 位 / 前后半段 × type 1、3 六种拼法，均读不到；不猜）'
        : '酷狗歌单要的是 global_collection_id（形如 collection_1_1341266283_964007_0）；'
          + '分享链接里只有 specialid 时本机推不出这个 id（三种反推形式实测都读不到，不猜）',
    };
  }
  const action = String(payload?.action ?? 'detail');
  const grab = async (operation, params) => {
    try {
      const result = await handle.invoke(operation, params);
      return { body: result?.body ?? result?.data ?? result ?? {} };
    } catch (error) {
      return { error: `${error?.status ? `HTTP ${error.status}` : ''} ${error?.body?.error_code ? `错误码 ${error.body.error_code}` : ''} ${error?.body?.errmsg ?? error?.message ?? ''}`.trim(), code: error?.body?.error_code ?? null };
    }
  };

  if (action === 'detail') {
    const found = await grab('playlist_detail', { ids: id });
    if (found.error) {
      // 30227 实测就是"这张单不存在"（bogus id 精确命中）；其余按通道故障处理，可重试。
      if (found.code === 30227) return { ok: false, provider: 'kugou', reason: `这张酷狗歌单不存在或不公开（上游错误码 30227）`, retryable: false };
      return { ok: false, provider: 'kugou', reason: `酷狗歌单详情请求失败：${found.error}`, retryable: true };
    }
    const row = Array.isArray(found.body?.data) ? found.body.data[0] : found.body?.data?.lists?.[0];
    const meta = kugouDetailToMeta(row);
    if (!meta.ok) return { ok: false, provider: 'kugou', reason: meta.reason, retryable: false };
    return { ok: true, provider: 'kugou', action, ...meta };
  }

  if (action === 'tracks') {
    const offset = Math.max(0, Number(payload?.offset ?? 0) || 0);
    const limit = Math.max(1, Math.min(KUGOU_PAGE_LIMIT, Number(payload?.limit ?? KUGOU_PAGE_LIMIT) || KUGOU_PAGE_LIMIT));
    // 包只认页号（`begin_idx = (page-1)*pagesize`），offset 与页边界不齐时**向下取整到整页**：
    // 宁可重复问半页（导入侧按顺序拼，重复条目由调用方收尾），也不能悄悄跳过半页。
    const page = Math.floor(offset / limit) + 1;
    const aligned = (page - 1) * limit;
    const found = await grab('playlist_track_all', { id, page, pagesize: limit });
    if (found.error) {
      if (found.code === 20010) return { ok: false, provider: 'kugou', reason: `这张酷狗歌单取不到曲目（上游错误码 20010：get other list file fail）`, retryable: false };
      return { ok: false, provider: 'kugou', reason: `酷狗歌单曲目请求失败：${found.error}`, retryable: true };
    }
    const data = found.body?.data ?? {};
    const items = kugouSongsToItems(data.songs);
    if (items === null) {
      return { ok: false, provider: 'kugou', reason: '酷狗歌单响应里没有 songs 数组（请求没被正确接受，不是"歌单是空的"）', retryable: true };
    }
    return {
      ok: true, provider: 'kugou', action, items,
      offset: aligned, limit, page, total: Number(data.count ?? 0) || 0, maxTracks: MAX_TRACKS,
    };
  }

  return { ok: false, provider: 'kugou', reason: `未知的歌单动作：${action || '（空）'}` };
}

/**
 * 酷狗账号歌单（R159）。三条纪律：
 *   · **没有登录态就零 `invoke`**（与搜索、取址同一形状：这一条不出网，理由说得出来）；
 *   · 走 `kugouDeviceCall` 那个包衣：这一家的安卓签名端点**可能**回 20028（要验证），
 *     那条备用路由由用户拍板保留但**缺省关**（AGENTS.md 例外条目），所以这里默认就是"问一次，
 *     要验证就如实报"——不悄悄伪造设备身份；
 *   · 映射后的字段白名单在 `accountPlaylistsToItems`：`global_collection_id` 是唯一能用的 id
 *     （R137 实测 `specialid` 与 `gcid_` 都导不出曲目），认不出的行**跳过并报出来**，不猜。
 */
async function kugouMine(handle, payload) {
  const session = kugouCookieToObject(payload?.cookie);
  if (!session.token || !session.userid) {
    return { ok: false, provider: 'kugou', reason: '本机没有酷狗登录态：账号歌单要登录后才列得出来（这一跳不出网）', retryable: false };
  }
  const page = Math.max(1, Number(payload?.page ?? 1) || 1);
  const pagesize = Math.max(1, Math.min(50, Number(payload?.pagesize ?? 30) || 30));
  const called = await kugouDeviceCall(handle, 'user_playlist',
    { page, pagesize },
    { ...(payload?.device ?? {}), token: String(session.token ?? ''), userid: String(session.userid ?? '') });
  if (!called.ok) {
    return { ok: false, provider: 'kugou', reason: kugouFailureReason(called, '账号歌单'), retryable: true, device: called.device };
  }
  // 与搜索那一跳同一个取体形状（包有时把响应挂在 body、有时直接给 data）：两处不各写一套假设。
  const body = called.result?.body ?? called.result?.data ?? called.result ?? {};
  const mapped = accountPlaylistsToItems(body, 'kugou');
  if (!mapped.ok) return { ok: false, provider: 'kugou', reason: `酷狗账号歌单：${mapped.reason}`, retryable: false };
  return { ok: true, provider: 'kugou', action: 'mine', page, pagesize, ...mapped };
}

/**
 * 网易账号歌单（R159）。两步都在桥内：先 `/user/account` 拿 uid（**uid 不外传**，父进程不需要知道），
 * 再 `/user/playlist?uid=`。cookie 只走请求头（与 M3-a 那条"查询串会进包的访问日志"同一处置）。
 *
 * R182（任务一）：路径是 `/user/account` 不是 `/account` —— 这个包把 `module/` 下的文件名按
 * "去 `.js` → 下划线转斜杠"挂成路由（`server.js:73-81`），`module/user_account.js` 挂的就是
 * `/user/account`（上游 `/api/nuser/account/get`）。写错名字时 Express 回**404 的 HTML**
 * ⇒ 这一跳 `JSON.parse` 失败 ⇒ 界面只说"网易后端返回的不是 JSON（HTTP 404）"，
 * 而根因是一个字。离线夹具喂的是假 fetch，永远照不出这个 404。
 * 真机量到的形状（R182 真登录态）：`{ code:200, account:{ id:<9位> … }, profile:{ userId:<9位> … } }`
 * —— uid 在 `account.id`，包**没有**再嵌一层 body。
 */
async function ncmMine(handle, payload, fetchImpl) {
  const cookie = String(payload?.cookie ?? '').trim();
  if (!cookie) return { ok: false, provider: 'netease', reason: '本机没有网易登录态：账号歌单要登录后才列得出来（这一跳不出网）', retryable: false };
  const who = await callNcm(handle, '/user/account', fetchImpl, cookie);
  if (who.error) return { ok: false, provider: 'netease', reason: `网易账号信息请求失败：${who.error}`, retryable: true };
  const uid = String(who.body?.account?.id ?? '').trim();
  if (!/^\d{1,20}$/.test(uid)) {
    return { ok: false, provider: 'netease', reason: '网易说这台机器没登录（/user/account 没有 account.id）——先去音乐库面板里重新扫码，再列账号歌单', retryable: false };
  }
  const limit = Math.max(1, Math.min(50, Number(payload?.limit ?? 30) || 30));
  const offset = Math.max(0, Number(payload?.offset ?? 0) || 0);
  const found = await callNcm(handle, `/user/playlist?uid=${encodeURIComponent(uid)}&limit=${limit}&offset=${offset}`, fetchImpl, cookie);
  if (found.error) return { ok: false, provider: 'netease', reason: `网易账号歌单请求失败：${found.error}`, retryable: true };
  const mapped = accountPlaylistsToItems(found.body, 'netease');
  if (!mapped.ok) return { ok: false, provider: 'netease', reason: `网易账号歌单：${mapped.reason}`, retryable: false };
  return { ok: true, provider: 'netease', action: 'mine', limit, offset, ...mapped };
}

/** 挂歌单路由。`fetchImpl` 是给离线自检的注入口（真机上固定用桥内那份 loopbackFetch）。 */
export function registerPlaylistRoutes({ routes, backends, fetchImpl }) {
  const fetch = fetchImpl;
  routes.set('/bridge/playlist', async (payload) => {
    const provider = String(payload?.provider ?? '');
    if (provider === 'kugou') return kugouPlaylist(backends, payload);
    if (provider !== 'netease') return { ok: false, provider, reason: provider ? `桥不为 ${provider} 提供歌单通道` : '缺少歌单 provider', retryable: false };
    const handle = backends.netease;
    if (!handle || handle.state !== 'ready' || !handle.baseUrl) {
      return { ok: false, provider: 'netease', reason: '网易后端未就绪', retryable: true };
    }
    // R159：`mine` 不要 id ⇒ 必须在下面那道"歌单 id 必须是数字"之前分出去
    if (String(payload?.action ?? '') === 'mine') return ncmMine(handle, payload, fetch);
    const id = String(payload?.id ?? '').trim();
    if (!/^\d{1,20}$/.test(id)) return { ok: false, provider: 'netease', reason: '歌单 id 必须是数字', retryable: false };
    const action = String(payload?.action ?? 'detail');

    if (action === 'detail') {
      const found = await callNcm(handle, `/playlist/detail?id=${encodeURIComponent(id)}`, fetch);
      if (found.error) return { ok: false, provider: 'netease', reason: found.error, retryable: true };
      // 不存在的 id：网易直接回 `{"code":404}`（实测 id=999999999999999），没有 playlist 字段。
      // 这一句把"404"翻译成人话——否则用户看到的是一句内部形状描述。
      if (Number(found.body?.code ?? 200) === 404) {
        return { ok: false, provider: 'netease', reason: `这张歌单不存在或不公开（网易对 id ${id} 返回 404）`, retryable: false };
      }
      const meta = ncmDetailToMeta(found.body);
      if (!meta) return { ok: false, provider: 'netease', reason: '网易歌单详情里没有 playlist 字段（请求没被正确接受，不是"歌单是空的"）', retryable: true };
      // 私有/被删的歌单：detail 会给 playlist 但 trackCount 为 0 且 status 非 0 —— 如实报，不报成"空歌单"
      const raw = found.body?.playlist ?? {};
      if (Number(raw.status ?? 0) !== 0 && meta.trackCount === 0) {
        return { ok: false, provider: 'netease', reason: `这张歌单不可读（网易返回状态 ${raw.status}；可能是私有、已删除或需要登录）`, retryable: false };
      }
      return { ok: true, provider: 'netease', action, ...meta };
    }

    if (action === 'tracks') {
      const offset = Math.max(0, Number(payload?.offset ?? 0) || 0);
      const limit = Math.max(1, Math.min(TRACKS_PAGE_LIMIT, Number(payload?.limit ?? TRACKS_PAGE_LIMIT) || TRACKS_PAGE_LIMIT));
      const found = await callNcm(handle, `/playlist/track/all?id=${encodeURIComponent(id)}&limit=${limit}&offset=${offset}`, fetch);
      if (found.error) return { ok: false, provider: 'netease', reason: found.error, retryable: true };
      const items = ncmSongsToItems(found.body?.songs);
      if (items === null) return { ok: false, provider: 'netease', reason: '网易歌单响应里没有 songs 数组（请求没被正确接受，不是"歌单是空的"）', retryable: true };
      return { ok: true, provider: 'netease', action, items, offset, limit, maxTracks: MAX_TRACKS };
    }

    return { ok: false, provider: 'netease', reason: `未知的歌单动作：${action || '（空）'}` };
  });
  return routes;
}

export const PLAYLIST_PAGE_LIMIT = TRACKS_PAGE_LIMIT;
export const PLAYLIST_MAX_TRACKS = MAX_TRACKS;
