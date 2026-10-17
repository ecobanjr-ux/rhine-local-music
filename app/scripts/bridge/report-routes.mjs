// 本项目自撰（非移植代码）。桥的播放上报通道（R161 · 夜间主批任务八）。
//
// 先说清"报什么"（隐私口径由这一处代码承担，界面上那段话就是照它写的）：
//   · 只报给**这一首本来就是从它那儿来的那一家**（在线曲目才有上报这件事；本地文件一条都不发）；
//   · 载荷只有三样：**平台自己的曲目标识 + 收听到第几秒 + 一次动作名**——
//     曲名/歌手/专辑文本不发（平台按 id 自己知道，多发一份就是多一处能对上"你在听什么"的证据），
//     本地文件路径、曲库结构、整条队列、播放列表全貌都不发；
//   · 只在**那一家已登录**时发：没登录就没有"我的听歌记录"这回事，发出去是一笔无主请求；
//   · 缺省关（`playReporting` 在父进程那一侧判，桥这一层不再抄一遍同一判据）。
//
// 两家的形状都是**一手读包源码**读来的（不是量到的——量它要登录，用户不在场）：
//   · 网易 `module/scrobble.js`：`{id, sourceid, time}`，包内部发**两笔** `/api/feedback/weblog`
//     （`startplay` 进"最近播放" + `play` 涨"听歌排行"），并会往 cookie 里注入 `os=osx`；
//   · 酷狗 `module/playhistory_upload.js`：`{mxid, time, pc}` + `token/userid`，
//     走 `encryptType:'android'` ⇒ 与搜索/取址同一层设备签名（`kugouDeviceCall`，默认不注册设备）。
// ⇒ 两家的成功/失败形状**都没真机量到**，所以这里的失败一律给"通道没成 + 原样带的码"，
//    并且**可重试**：认不出的码不判死（R154 那条同一条立场）。上报失败永远不影响播放——
//    那是父进程那一层的纪律（这一层只负责"如实回"）。
import { kugouCookieToObject } from './providers/kugou-auth.mjs';
import { kugouDeviceCall, kugouFailureReason } from './providers/kugou-device.mjs';

const NCM_REPORT_TIMEOUT_MS = 12_000;

async function callNcm(handle, path, body, fetchImpl, cookie) {
  const response = await fetchImpl(`${handle.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NCM_REPORT_TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, error: `网易后端返回的不是 JSON（HTTP ${response.status}）` };
  }
}

/** 上报载荷的**唯一**收口：三样之外一格都不许带（多带一格就多一处"你在听什么"的证据）。 */
export function reportPayloadOf(payload) {
  const mediaId = String(payload?.mediaId ?? '').trim();
  const positionSec = Math.max(0, Math.min(24 * 60 * 60, Math.floor(Number(payload?.positionSec ?? 0) || 0)));
  const sourceId = String(payload?.sourceId ?? mediaId).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId)) return null;
  return { mediaId, sourceId: /^[A-Za-z0-9_-]{1,64}$/.test(sourceId) ? sourceId : mediaId, positionSec };
}

/** 挂上报路由。`fetchImpl` 是给离线自检的注入口（真机上固定用桥内那份 loopbackFetch）。 */
export function registerReportRoutes({ routes, backends, fetchImpl }) {
  const fetch = fetchImpl;
  routes.set('/bridge/report', async (payload) => {
    const provider = String(payload?.provider ?? '');
    const body = reportPayloadOf(payload);
    if (!body) return { ok: false, provider, reason: '上报要的是平台自己的曲目标识（字母数字下划线短横，1~64 位）——形状不对，这一跳不出网', retryable: false };
    if (provider === 'netease') {
      const handle = backends?.netease;
      if (!handle || handle.state !== 'ready' || !handle.baseUrl) {
        return { ok: false, provider, reason: '网易后端未就绪', retryable: true };
      }
      const cookie = String(payload?.cookie ?? '').trim();
      // 与酷狗同一道闸：**没有登录态就一次都不问**（网易这个包没 cookie 也会照发出去一笔无主请求，
      // 而"我在听这首"报给一个没登录的会话本来就没有归属可言）。
      if (!cookie) {
        return { ok: false, provider, reason: '本机没有网易登录态：没有"我的听歌记录"可上报（这一跳不出网）', retryable: false };
      }
      // 网易的包把 `query.cookie` 当参数用（还要往里注入 os=osx），所以这里**既**发请求头
      // （环回那一跳的日志里不留它）**也**按包的入参给一份（它就是这么读登录态的）。
      const found = await callNcm(handle, '/scrobble', { id: body.mediaId, sourceid: body.sourceId, time: body.positionSec, cookie }, fetch, cookie);
      if (found.error) return { ok: false, provider, reason: found.error, retryable: true };
      const code = Number(found.body?.code ?? found.status ?? 200);
      if (code !== 200) return { ok: false, provider, reason: `网易上报没有成（code ${code}）`, retryable: true };
      return { ok: true, provider, action: 'report', mediaId: body.mediaId, reportedSeconds: body.positionSec };
    }
    if (provider === 'kugou') {
      const handle = backends?.kugou;
      if (!handle || handle.state !== 'ready' || typeof handle.invoke !== 'function') {
        return { ok: false, provider, reason: '酷狗后端未就绪', retryable: true };
      }
      const session = kugouCookieToObject(payload?.cookie);
      if (!session.token || !session.userid) {
        return { ok: false, provider, reason: '本机没有酷狗登录态：没有"我的听歌记录"可上报（这一跳不出网）', retryable: false };
      }
      const called = await kugouDeviceCall(handle, 'playhistory_upload',
        { mxid: body.mediaId, time: Math.floor(Date.now() / 1000), pc: 1 },
        { ...(payload?.device ?? {}), token: String(session.token ?? ''), userid: String(session.userid ?? '') });
      if (!called.ok) return { ok: false, provider, reason: kugouFailureReason(called, '播放上报'), retryable: true, device: called.device };
      const result = called.result?.body ?? called.result ?? {};
      const code = Number(result?.error_code ?? result?.status ?? 0);
      if (code && code !== 1) return { ok: false, provider, reason: `酷狗上报没有成（错误码 ${code}）`, retryable: true };
      return { ok: true, provider, action: 'report', mediaId: body.mediaId, reportedSeconds: body.positionSec };
    }
    // QQ：包的路由表里**没有**播放上报这一条（R108 那次读表读全过一遍），
    // 所以这一家不是"暂不支持"而是"没有这条通道"——两种说法在界面上要分开。
    return { ok: false, provider, reason: `${provider || '这家'} 的播放上报通道本机没有：桥里没有这一条，不猜端点`, retryable: false };
  });
}
