// 本项目自撰（非移植代码）。酷狗**设备身份**那一格（任务一 · B 路线，台账 R154，2026-10-10 用户拍板）。
//
// **本批实测之后最重要的一条**：这条授权**今天用不上**。`register_dev` 在本仓仍然是零调用，
// 因为一手量测证明酷狗要的不是"注册过的设备号"，而是"**别塞一个随机设备号**"：
//   · `song_url` 不给 `dfid` ⇒ 包自己塞 `randomString(24)`（一手读 `module/song_url.js` 最后一行）⇒ **HTTP 502**；
//   · `song_url` 显式给 `dfid: ''` ⇒ `util/request.js:72` 那句 `|| '-'` 把它折成 **`dfid=-`** ⇒ **200 / status:1 / priv_status:1 / url 给整首**；
//   · `song_url` 给注册出来的真 dfid ⇒ 同样 200。
//   ⇒ 三者里唯一不能用的恰好是"包默认那个随机值"。所以正解是**我们显式带 `'-'`**
//   （原版匿名搜索那条也是 `dfid: '-'`，一手读 `kugouTransport.ts:212`），零伪装、零注册。
// `register_dev` 因此只作为**一条被批准但默认关着的备用路**留着：只有上游真的回"需要设备校验"
// （原版 `:70` 的 `error_code 20028` 或消息含「本次请求需要验证」）**且**设置里那个开关打开时才会走，
// 调用点唯一就在本文件的 `registerOnce`（判据数整个 `scripts` 目录里 `invoke('register_dev'` 的出现次数）。
//
// 这一份干三件事：
//   ① 用**包内那一份** `calculateMid` 从 guid 算出 mid（不重写算法——原版就是这么算的）；
//   ② 把 `{guid, mid, dfid, token, userid}` 拼成包要的 cookie 形状（一手读 `util/request.js:72-74`：
//      `dfid` 与 `KUGOU_API_MID` 都从 cookie 里取，缺了就是随机值与字符串 `"undefined"`）；
//   ③ 万一真撞上"需要设备校验"：按**原版的序列**清旧 dfid → 注册一次 → 只重试一次。
//
// 为什么必须有这一层（架构不适配的那一处，不是签名算法）：原版把 KuGouMusicApi **当本地 HTTP 服务跑**，
// 包的 `server.js:257-268` 那条 Express 中间件会 `ensureCookie('KUGOU_API_MID'|'KUGOU_API_GUID'|…)`；
// 本站是**进程内直调**（`bridge/backends/kugou.mjs`），那条中间件根本不在路径上 ⇒ 这两个值没人造。
//
// 其余一手实测（2026-10-10 夜间探针，数据在 `memory/night-main-thirteen-run-log.md` §任务一.3）：
//   · `search`：**登录态 + mid** 就 200（`data.lists` 10 条）；只有 mid（匿名）⇒ 502 / `error_code 152`；
//     只有 mid + 随机 dfid（仍匿名）⇒ 还是 152 ⇒ **dfid 不解锁匿名搜索，登录才是那一格**。
//   · CDN 主机：`fsandroid.kugou.com`（实测只用这一条，备份那条不进表），上游给的是 **http**，
//     实测**同主机 https 同一份文件**（Range 0-4095 ⇒ 206 + `content-range: bytes 0-4095/<整首字节>`）
//     ⇒ 与网易/QQ 同一条老规矩：升 https 再走守卫，**不为音频放开明文**。
//
// 红线（一条都没动，且这一份把"不许越权"写成判据）：
//   · **只用 `priv_status:1` 那一档**（实测：`status:1` + `priv_status:1` ⇒ `url` 是**整首**文件；
//     `priv_status:0` 那一档即便回了 `url`，它指的是"文件是整首、可播范围由 `hash_offset` 标出"的形态
//     ⇒ 拿整首来播就是绕过平台权益，一律不用，见 `kugouSongUrlToSource`）。
//   · **从不发 `free_part`**：实测那一档 `priv_status` 仍是 0、只是多给一段偏移 ⇒ 不是我们要走的路。
//   · 音频字节零落盘；凭据不进日志不进响应体；`guid`/`mid`（以及万一用过的 `dfid`）由**父进程**持有
//     （R97 口径），桥每次借用、自己不落盘。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** `register_dev` 回来的 dfid 形状（实测 24 位字母数字）；认不出这个形状就当他没注册成功。 */
const DFID_SHAPE = /^[0-9A-Za-z_-]{8,64}$/;
/** 酷狗的曲目身份是 32 位十六进制 hash（实测 `FileHash` 长度 32；上游两种大小写都收，这里统一小写）。 */
export const KUGOU_HASH_SHAPE = /^[0-9a-fA-F]{32}$/;
/**
 * 我们默认带给上游的 dfid：**空串**。它经 `util/request.js:72` 的 `|| '-'` 折成 `dfid=-`，
 * 实测这一档 `song_url` 给 200 与整首地址；而**不填**时包会塞一个随机 24 位串，那一档实测 502。
 * 这是一个有意的选择，不是漏写：宁可带"明确没有设备号"，也不带"伪造一个设备号"。
 */
export const KUGOU_DFID_NONE = '';

/**
 * 需要设备校验的判据，**逐字照原版** `kugouTransport.ts:70`：`error_code 20028` 或消息含「本次请求需要验证」。
 * 本站实测**没有出现过 20028**（出现过 152=缺参数、20018=权益不足，两回事），
 * 所以这一格由夹具验证、真机未触发，如实记在执行日志里——不是"顺手写的兜底"。
 */
export function kugouNeedsDeviceVerification(errorOrBody) {
  const body = errorOrBody?.body?.data ?? errorOrBody?.body ?? errorOrBody?.data ?? errorOrBody ?? {};
  const code = Number(body?.errcode ?? body?.error_code);
  const message = String(body?.error ?? body?.error_msg ?? body?.msg ?? '');
  return code === 20028 || message.includes('本次请求需要验证');
}

/**
 * guid → mid。**用包内那一份 `calculateMid`**：它是"把 md5 十六进制串按 16 进制逐位加成一个大整数"那种算法，
 * 自己抄一遍迟早会漂（本站已经两次为"照抄一个常量/算法"付过代价：PNG 魔数 R123、参数名 R153）。
 * 包拿不到（离线自检不加载依赖树）时返回空串，调用方按"这一家今天不可用"处理，**不猜一个数**。
 * `loadCalculateMid` 是这一格的**注入口**（与 `guardedFetch` 的 `lookup`、桥的 `fetchImpl` 同一惯例）：
 * 没有它，"包拿不到"那一条分支在自检里永远跑不到——而"永远跑不到的分支"最容易藏一句
 * "顺手 return 一个假值"（本批第一次变异就没咬到它，见执行日志 §任务一.5）。
 */
export function kugouMidFromGuid(guid, loadCalculateMid = () => require('kugoumusicapi/util/util').calculateMid) {
  const text = String(guid ?? '').trim();
  if (!text) return '';
  try {
    return String(loadCalculateMid()(text) ?? '');
  } catch {
    return '';
  }
}

/**
 * 拼包要的 cookie 对象。四条各管各的缺席语义：
 *   · `dfid` 是**唯一"没值也要带"的**（带空串 ⇒ 上游读成 `-`）；少带它包就自己造一个随机号，实测那一档 502；
 *   · `mid` / `token` / `userid` 没有就不带（带的含义是"这台机器/这个账号登录了"，编一个反而更坏）。
 */
export function buildKugouCookie({ mid, dfid = KUGOU_DFID_NONE, token, userid } = {}) {
  const cookie = { dfid: String(dfid ?? '') };
  if (mid) cookie.KUGOU_API_MID = String(mid);
  if (token) cookie.token = String(token);
  if (userid) cookie.userid = String(userid);
  return cookie;
}

/** `register_dev` 的响应 → 新的 dfid（实测在 `data.dfid`，长度 24；包同时把它 push 进 `cookie` 数组）。 */
export function kugouRegisterToDfid(result) {
  const body = result?.body ?? result ?? {};
  const dfid = String(body?.data?.dfid ?? '');
  if (!DFID_SHAPE.test(dfid)) return { ok: false, reason: '酷狗设备注册没有回可认的设备标识（dfid 形状不对）' };
  return { ok: true, dfid };
}

/**
 * `song_url` 的响应 → 内部形状。**两道闸都在这里，且都是量出来的事实**：
 *   ① `status === 1`（实测 200 但 `status:2` 那一档是"没给文件"）；
 *   ② `priv_status === 1` —— **这一道是"不绕过权益"的兑现**：`priv_status:0` 那一档上游照样回了 `url`，
 *      但那是"整首文件 + `hash_offset` 标出可播片段"的形态，拿整首来播就是替用户越权。
 * `url` 实测是**两条 http 地址的数组**（多台 CDN 同一份文件）。R218 起：`url` 仍给第一条（兼容），
 * 但**候选表整份带出去**（`urls`）——上游按曲目给不同 CDN，其中一部分只有明文主机；
 * 挑哪台由父进程按它的出口白名单定（`online-audio-source.mjs` 的 `pickHttpsAudioUrl`：
 * 白名单就是"实测 https 可用"的主机表）。桥不知道也不该知道那张表——两处各存一份就是第二个真相。
 * 升 https 与主机白名单仍由父进程那一层做（头部 ③：白名单不收在出口处等于没收）。
 */
export function kugouSongUrlToSource(body) {
  const payload = Array.isArray(body?.data) ? body.data[0] : (body?.data ?? body ?? {});
  const status = String(payload?.status ?? body?.status ?? '');
  const priv = String(payload?.priv_status ?? body?.priv_status ?? '');
  const rawUrls = Array.isArray(payload?.url) ? payload.url : (Array.isArray(body?.url) ? body.url : []);
  const urls = rawUrls.map((entry) => String(typeof entry === 'string' ? entry : entry?.url ?? '').trim()).filter(Boolean);
  if (status === '1' && priv === '1' && urls.length) {
    return {
      ok: true,
      url: urls[0],
      urls: [...urls],
      kind: String(payload?.extName ?? 'mp3').toLowerCase(),
      size: Number(payload?.fileSize ?? 0) || 0,
      durationSec: Number(payload?.timeLength ?? 0) || 0,
      bitrate: Number(payload?.bitRate ?? 0) || 0,
      // 取到地址这一档实测就是整首（Range 一跳的 content-range 总长与 fileSize 逐位相等）。
      scope: 'full',
    };
  }
  if (urls.length) {
    // 走到这一格说明上游给了地址但过不了权益那道闸——这句必须说清是**权益**，不是"通道坏了"。
    return { ok: false, unavailable: true, denied: true, reason: '酷狗这个账号没有这首歌的完整播放权益（本机不拿片段冒充整首）' };
  }
  const code = Number(body?.error_code ?? payload?.error_code ?? 0);
  if (code === 20018) return { ok: false, unavailable: true, reason: '酷狗说这首本机账号播不了（上游错误码 20018：权益不足）' };
  if (status === '2') return { ok: false, noUrl: true, unavailable: true, reason: '酷狗没有回这首歌的可播文件（需要登录，或该账号没有它的播放权益）' };
  return { ok: false, reason: `酷狗音源响应里没有可播地址（status:${status || '空'} · priv_status:${priv || '空'}）` };
}

/**
 * **全仓唯一一处 `register_dev` 调用**。三层夹着：配置开关、`operation !== 'register_dev'`（原版 `:400`
 * 同一条守卫，防递归）、以及"只有真撞上 20028 才走"。imei/uuid 由包自己从 `cookie.KUGOU_API_GUID` 回落
 * （一手读 `module/register_dev.js`），所以我们只给 guid，代码里不出现 IMEI 一类字面量。
 */
async function registerOnce(handle, { guid, mid, token, userid }) {
  try {
    const result = await handle.invoke('register_dev', {
      cookie: { ...buildKugouCookie({ mid, token, userid }), KUGOU_API_GUID: guid },
      ...(userid ? { userid } : {}),
      ...(token ? { token } : {}),
    });
    return kugouRegisterToDfid(result);
  } catch (error) {
    return { ok: false, reason: `酷狗设备注册这一跳没成（上游 ${error?.status ?? '没应答'}）`, error };
  }
}

/**
 * 带设备身份的一跳。`device = {guid, mid?, dfid?, token?, userid?, deviceIdentity?}`。
 * 返回的 `device` 是"这一跳实际用到的那一份"（mid 可能是这里第一次算出来的），
 * 父进程拿它落盘 —— 桥自己不写任何文件。
 */
export async function kugouDeviceCall(handle, operation, params = {}, device = {}) {
  const guid = String(device.guid ?? '');
  const mid = String(device.mid ?? '') || kugouMidFromGuid(guid);
  const base = { guid, mid, dfid: String(device.dfid ?? KUGOU_DFID_NONE), token: String(device.token ?? ''), userid: String(device.userid ?? '') };
  const call = (dfid) => handle.invoke(operation, { ...params, cookie: buildKugouCookie({ ...base, dfid }) }).then(
    (result) => ({ threw: false, result }),
    (error) => ({ threw: true, error }),
  );
  const attempt = await call(base.dfid);
  // 没成也照样把"用到哪一份身份"回报：mid 可能是这一跳才算出来的（第一次没有落盘过）。
  if (!attempt.threw) return { ok: true, result: attempt.result, device: base };
  if (!kugouNeedsDeviceVerification(attempt.error)) return { ok: false, failed: attempt.error, device: base };
  if (operation === 'register_dev') return { ok: false, failed: attempt.error, device: base, reason: '设备注册本身就要校验，不再递归重试' };
  if (device.deviceIdentity !== true) {
    return { ok: false, failed: attempt.error, device: base,
      reason: '这一跳上游要求设备校验，而本机的酷狗设备身份开关是关着的（默认关：本机不伪装设备指纹）' };
  }
  const registered = await registerOnce(handle, base);
  if (!registered.ok) return { ok: false, failed: attempt.error, device: base, reason: registered.reason };
  const next = { ...base, dfid: registered.dfid };
  const retried = await call(registered.dfid);
  if (retried.threw) return { ok: false, failed: retried.error, device: next, rotated: true };
  return { ok: true, result: retried.result, device: next, rotated: true };
}

/**
 * 把 `kugouDeviceCall` 的失败回报翻成人话。R159 起有**两个消费者**（检索与账号歌单），
 * 所以从 `search-routes.mjs` 里搬到这里来 —— 两处各写一遍迟早会在"错误码放不放在句子里"上分家。
 * `what` 只影响那一句的主语，不影响判据：认不出的码一律不判死（由调用方决定重试性）。
 */
export function kugouFailureReason(called, what = '这一跳') {
  if (called?.reason) return String(called.reason);
  const error = called?.failed ?? {};
  const status = error?.status ?? null;
  const code = error?.body?.error_code ?? error?.body?.data?.error_code ?? null;
  return `酷狗${what}没有成${status ? `（HTTP ${status}）` : ''}${code ? ` · 上游错误码 ${code}` : ''}`;
}
