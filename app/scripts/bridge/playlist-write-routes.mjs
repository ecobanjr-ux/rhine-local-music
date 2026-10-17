/**
 * 任务十一 · 加歌到账号歌单（写侧路由，本项目自撰，AGPL-3.0-only）。
 *
 * 四条红线就写在这个文件里，每一条都有断言钉着（`check-music-playlist-write.mjs`）：
 * 1. **只加不删**：这一家一家的 `op` 全部写死成"加"，桥里**不存在**任何删除分支；
 *    上游包确实有 `del` 那一档（网易 `playlist_tracks.js` 的 `query.op`、酷狗没有删除模块），
 *    我们不把它接出来 —— 少一条通路就少一次误操作，删这件事请用户自己去平台上做。
 * 2. **只写用户自己的账号**：凭据只从父进程那一份本机分区来（R97），桥**不接受**任何随请求来的 cookie/token；
 *    目标歌单 id 必须是"这台机器刚才自己列出来的那些"里的一个（父进程那侧再验一次形状）。
 * 3. **失败如实报**：认不出的形状一律 `ok:false` + 一句人话 + `retryable`，不许把"我们没量到"写成"平台拒绝"。
 * 4. **没有登录态就一次网都不出**：网易没有 cookie ⇒ 零 fetch；酷狗没有会话 ⇒ 零 invoke
 *    （与 R159 列账号歌单同一道闸，同一份理由）。
 */

/** 网易：`module/playlist_tracks.js` 的路由是 `/playlist/tracks`，参数 `op` / `pid` / `tracks`（逗号分隔的数字 id）。 */
import { kugouCookieToObject } from './providers/kugou-auth.mjs';
import { kugouDeviceCall, kugouFailureReason } from './providers/kugou-device.mjs';

const NETEASE_ADD_PATH = '/playlist/tracks';
/** 酷狗：`module/playlist_tracks_add.js`（`/cloudlist.service/v6/add_song`），走 android 签名 ⇒ 必须过 `kugouDeviceCall`。 */
export const KUGOU_ADD_OPERATION = 'playlist_tracks_add';
const NCM_WRITE_TIMEOUT_MS = 15_000;
/** 一次最多加进去几条：写侧的批量要小（误操作的影响面与上游限流都按小的一档设计）。 */
export const WRITE_MAX_TRACKS = 20;

const digits = (value) => String(value ?? '').trim();

/**
 * 网易那一路的查询串。**只**认数字曲目 id，且 `op` 写死 `add`。
 * 返回 null = 这一笔根本不该发出去（调用方要给出原因，不许发一个空请求去"试试"）。
 */
export function neteaseAddQuery({ playlistId, mediaIds }) {
  const pid = digits(playlistId);
  if (!/^\d{1,20}$/.test(pid)) return null;
  const ids = (Array.isArray(mediaIds) ? mediaIds : []).map(digits).filter((id) => /^\d{1,20}$/.test(id)).slice(0, WRITE_MAX_TRACKS);
  if (!ids.length) return null;
  return { path: `${NETEASE_ADD_PATH}?op=add&pid=${encodeURIComponent(pid)}&tracks=${encodeURIComponent(ids.join(','))}`, sent: ids.length, skipped: mediaIds.length - ids.length };
}

/**
 * 酷狗那一路的入参。`playlist_tracks_add` 的 `data` 是 `"曲名|hash|专辑id|mixsongid"` 用逗号拼起来的串，
 * 曲名里带逗号或竖线会把这一格撑成两格 ⇒ 带分隔符的那几条**直接不加**并说清几条被跳过（宁少不加错）。
 */
export function kugouAddParams({ playlistId, songs }) {
  const listid = digits(playlistId);
  if (!/^\d{1,20}$/.test(listid)) return null;
  const items = (Array.isArray(songs) ? songs : []).filter((song) => {
    const hash = digits(song?.hash);
    const name = digits(song?.name);
    return /^[0-9A-Za-z]{10,40}$/.test(hash) && name && !/[|,]/.test(name);
  }).slice(0, WRITE_MAX_TRACKS);
  if (!items.length) return null;
  const data = items.map((song) => `${digits(song.name)}|${digits(song.hash)}|0|0`).join(',');
  return { operation: KUGOU_ADD_OPERATION, params: { listid, data }, sent: items.length, skipped: songs.length - items.length };
}

/** 桥拿到的可能是上游后端那一层**封套**：网易的 `module/playlist_tracks.js` 会包成 `{status,body,cookie}`，
 *  酷狗的 `createRequest` 一律产出 `{status,body,cookie,headers}`。真正的结果都在 `.body`。
 *  这两层差别在真机上才第一次照出来 —— R182 的离线夹具喂的是裸 body，**两层都能吃**才不会下次再栽。 */
const unwrapWriteBody = (payload) =>
  (payload && typeof payload === 'object' && payload.body && typeof payload.body === 'object' ? payload.body : payload);

/**
 * 网易写侧的回执。**R182 真机量到两种形状**（此前一条都没量到，判据是保守猜的）：
 * · 加进去一首新的 = `{ trackIds:"[29122838]", code:200, count:290, cloudCount:0 }` ⇒ **成功码是 200**（不是 0）；
 * · 重复加同一首 = `{ message:"歌单内歌曲重复", code:502 }` ⇒ 不是失败也不是"再试一次就好"，是"它已经在里面了"。
 * 认不出（连 `code` 都没有，例如封套那一层被直接喂进来）⇒ `ok:false` + `retryable:true`：
 * 旧版这里有 `status===200 && body.code===undefined ⇒ ok:true` 那一格，等于把**没量到的形状当成成功**，
 * 正好破了本文件的第 3 条红线（真机上重复加一首会被它报成"已加好"）。
 */
export function interpretNcmWrite(payload, status) {
  const body = unwrapWriteBody(payload);
  const raw = body?.code;
  const code = raw === undefined || raw === null ? Number.NaN : Number(raw);
  if (code === 200 || code === 0) return { ok: true };
  const note = String(body?.msg ?? body?.message ?? '').trim() || `code ${Number.isNaN(code) ? '（回执里没有）' : code}`;
  if (code === 502 && /重复/.test(note)) {
    return { ok: false, reason: `网易说这首歌已经在这张歌单里了：${note}`, retryable: false };
  }
  // 301/401/403 那几档在网易侧是"登录态过期 / 需要重新登录"，不是"这首歌不能加"。
  const sessionish = code === 301 || code === 401 || code === 403 || /登录|login/i.test(note);
  if (sessionish) return { ok: false, reason: `网易说这台机器没登录（或登录态过期）：${note}`, retryable: true };
  if (Number.isNaN(code)) {
    return { ok: false, reason: `网易的回执认不出（既没有 code，HTTP ${status}）——这一笔收没收下我们说不准，去平台上确认一下`, retryable: true };
  }
  return { ok: false, reason: `网易没接受这次添加：${note}`, retryable: false };
}

/**
 * 酷狗写侧的回执。**R182 真机量到成功形状**：
 * `{ status:200, body:{ data:{ count:1, list_ver:2, listid:2, … }, status:1, error_code:0 } }`
 * （外层是包的 `createRequest` 封套，内层 `body` 才是上游结果）。
 * **关键一格：内层 `status` 是 `1` 不是 `0`** —— 旧实现读的是 `status`，于是把成功读成失败；
 * 成功与否只看 `error_code`（缺省那格也回 0）。认不出（没有 error_code）⇒ 一样不谎报成功。
 */
export function interpretKugouWrite(payload) {
  const body = unwrapWriteBody(payload);
  const raw = body?.error_code ?? body?.err_code;
  const errorCode = raw === undefined || raw === null ? Number.NaN : Number(raw);
  if (errorCode === 0) return { ok: true };
  const note = String(body?.error_msg ?? body?.msg ?? body?.message ?? '').trim() || `error_code ${Number.isNaN(errorCode) ? '（回执里没有）' : errorCode}`;
  // 20001/20002 那一族在酷狗侧是 token 问题（一手读包内其他模块的错误面看到的同一族码）。
  const sessionish = errorCode === 20001 || errorCode === 20002 || errorCode === 20016;
  if (sessionish) return { ok: false, reason: `酷狗说这份登录态不能用（${note}）——重新扫码登录后再试`, retryable: true };
  if (Number.isNaN(errorCode)) {
    return { ok: false, reason: '酷狗的回执认不出（没有 error_code）——这一笔收没收下我们说不准，去平台上确认一下', retryable: true };
  }
  return { ok: false, reason: `酷狗没接受这次添加：${note}`, retryable: false };
}

/**
 * 挂写侧路由。`fetchImpl` 是给离线自检的注入口（真机上固定用桥内那份 loopbackFetch）；
 * 酷狗那一路不需要注入口——它走的是包内那份进程内直调，由 `kugouDeviceCall` 包着（与 R159 同一条）。
 */
export function registerPlaylistWriteRoutes({ routes, backends, fetchImpl }) {
  routes.set('/bridge/playlist-write', async (payload) => {
    const provider = String(payload?.provider ?? '');
    const playlistId = digits(payload?.playlistId);
    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    if (provider === 'qq') {
      // QQ 的包只 require 了 `/serverless` 与 `/mqtt` 两个子路径（R107/R108），写侧一条都没量到 ⇒ 不猜。
      return { ok: false, provider, reason: 'QQ 的"加歌到账号歌单"本机还没量到端点（不猜、不试第二种）', retryable: false };
    }
    if (provider !== 'netease' && provider !== 'kugou') {
      return { ok: false, provider, reason: provider ? `桥不为 ${provider} 提供写侧通道` : '缺少 provider', retryable: false };
    }
    if (!tracks.length) return { ok: false, provider, reason: '没有要加的曲目（一次都不发）', retryable: false };

    if (provider === 'netease') {
      const handle = backends.netease;
      if (!handle || handle.state !== 'ready' || !handle.baseUrl) {
        return { ok: false, provider, reason: '网易后端未就绪', retryable: true };
      }
      const cookie = String(payload?.cookie ?? '');
      if (!cookie) return { ok: false, provider, reason: '本机没有网易登录态：没有"我的歌单"可写（这一跳不出网）', retryable: false };
      const query = neteaseAddQuery({ playlistId, mediaIds: tracks.map((song) => song?.mediaId) });
      if (!query) return { ok: false, provider, reason: '网易的歌单 id 或曲目 id 不是数字（一次都不发）', retryable: false };
      let response;
      try {
        response = await fetchImpl(`${handle.baseUrl}${query.path}`, {
          signal: AbortSignal.timeout(NCM_WRITE_TIMEOUT_MS),
          headers: { cookie },
        });
      } catch (error) {
        return { ok: false, provider, reason: `网易写侧请求失败：${error instanceof Error ? error.message : String(error)}`, retryable: true };
      }
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch {
        return { ok: false, provider, reason: `网易写侧回的不是 JSON（HTTP ${response.status}）`, retryable: true };
      }
      const read = interpretNcmWrite(body, response.status);
      return { ...read, provider, action: 'add', sent: query.sent, skipped: query.skipped, ...(read.ok ? {} : { reason: read.reason }) };
    }

    // 酷狗：没有会话就不准备工作区里那份设备身份（与 R159 同一道闸，同一份理由）
    const session = kugouCookieToObject(payload?.cookie);
    if (!session.token || !session.userid) {
      return { ok: false, provider, reason: '本机没有酷狗登录态：没有"我的歌单"可写（这一跳一次网都不出）', retryable: false };
    }
    const params = kugouAddParams({ playlistId, songs: tracks.map((song) => ({ name: song?.name, hash: song?.mediaId })) });
    if (!params) {
      return { ok: false, provider, reason: '酷狗要的是数字歌单 id + 32 位哈希的曲目，且曲名里不能带竖线或逗号（一次都不发）', retryable: false };
    }
    const handle = backends.kugou;
    if (!handle || typeof handle.invoke !== 'function') {
      return { ok: false, provider, reason: '酷狗后端未就绪（写侧一次都不发）', retryable: true };
    }
    // 与列歌单/搜索/取址同一个包衣：安卓签名 + `mid`/`dfid` 由 `kugouDeviceCall` 那一份准备，
    // 要求设备校验时**缺省不注册**（AGENTS.md 那条例外保留但默认关，R154）。
    const called = await kugouDeviceCall(handle, params.operation, { listid: params.params.listid, data: params.params.data },
      { ...(payload?.device ?? {}), token: String(session.token ?? ''), userid: String(session.userid ?? '') });
    if (!called.ok) {
      return { ok: false, provider, action: 'add', reason: kugouFailureReason(called, '加歌到账号歌单'), retryable: true };
    }
    // 整份 `called.result` 交给解释器：它自己会剥从包的 `createRequest` 封套（`{status,body,cookie,headers}`）
    // —— 在这一行先剥的话，将来封套形状一变又是一处要跟着改的地方。
    const read = interpretKugouWrite(called.result);
    return { ...read, provider, action: 'add', sent: params.sent, skipped: params.skipped };
  });
  return routes;
}
