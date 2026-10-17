// 本项目自撰（非移植代码）。M3-a Task C：网易扫码登录在**桥内**的那一段。
//
// 为什么登录要放在桥里：网易的取码/轮询/退出都是那个包已经实现的 HTTP 路由，包在自己进程里发请求；
// 桥崩了只带走在线能力，不带走本地播放核心（桥存在的原始理由，见 online-bridge.mjs 头部）。
//
// 三条与凭据有关的形状，写代码之前先读它们（一手实测 2026-10-06，数据在 memory/folia-port-p5-run-log.md 的 Task C 探针段）：
//   ① `/login/qr/check` 的响应体在**还没人扫（code=801）的时候就已经带一段 114 字符的 cookie**
//      （那是匿名侧的 NMTID/__csrf，不是登录凭据，但形状与真凭据完全一样）。
//      ⇒ 本文件只在 `code===803` 时才把 cookie 交出去，其余四档**一个字节都不带**——
//        不是"传了也没用"，是根本不放进返回值，免得下游谁手滑转给浏览器。
//   ② 包读 cookie 有两条路：`Cookie` 请求头（server.js 解析成对象）或 `?cookie=` 查询串。
//      这里走**请求头**：查询串会进包自己的访问日志行，头不会。
//   ③ 包会往 stdout 打 `[INFO] Request Success: [eapi] /login/qr/create?key=<完整 unikey>`——
//      unikey 是登录流程的一次性句柄。父进程那边非 JSON 行一律丢弃（online-bridge-client.mjs 的 onData），
//      所以它今天进不了服务日志；这一条钉成断言，谁改成"顺手把 stdout 打进日志"就会红。
//
// 桥不落任何凭据文件（§3 的分家：网易那份在父进程），错误文案一律来自固定字符串 + error.message，
// 本文件不写 console —— 想被看见就 return reason，或由父进程决定怎么说。
import { createQqAuthHandler } from './qq-auth.mjs';
import { createKugouAuthHandler } from './kugou-auth.mjs';

/** 二维码的服务端有效期：实测上游约 180 秒失效，**早 5 秒收手**，不留"界面还亮着但已过期"那一段。 */
export const NCM_QR_TTL_MS = 175_000;
/** 登录四端都是短请求，与歌词/音源那侧同一档预算（桥内一跳，不是公网往返）。 */
const NCM_TIMEOUT_MS = 12_000;

/** 上游登录码 → 对外状态。透传数字本身无害，但前端 switch 上游语义会在改包时碎掉，所以只出这五档。 */
export const NCM_LOGIN_CODES = { 800: 'expired', 801: 'waiting', 802: 'scanned', 803: 'confirmed' };
export const AUTH_STATES = ['waiting', 'scanned', 'confirmed', 'expired', 'error'];

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** 包的 `/login/qr/key` 响应：实测形状 `{code:200, data:{code:200, unikey:str(36)}}`。 */
export function ncmQrKeyToLoginId(body) {
  const loginId = text(body?.data?.unikey ?? body?.unikey)
  if (!loginId) return { ok: false, reason: '网易没有返回登录句柄（取码第一步就没成）' }
  if (Number(body?.code ?? body?.data?.code ?? 0) !== 200) return { ok: false, reason: `网易取码返回码 ${body?.code ?? body?.data?.code}` }
  return { ok: true, loginId }
}

/** 包的 `/login/qr/create` 响应：`qrimg` 直接就是 `data:image/png;base64,…`（实测 2662 字节），不引二维码生成依赖。 */
export function ncmQrCreateToQr(body, now = Date.now()) {
  const data = body?.data ?? body
  const image = text(data?.qrimg)
  const url = text(data?.qrurl)
  if (!image.startsWith('data:image/png;base64,')) {
    return { ok: false, reason: `网易二维码响应里不是预期的图片数据（code=${body?.code}）` }
  }
  return { ok: true, qr: { image, url }, expiresAt: now + NCM_QR_TTL_MS }
}

/**
 * 包的 `/login/qr/check` 响应 → 状态。**唯一的凭据出口就是这里**，且只在 803。
 * 其余档位（含"已扫待确认"）即便上游带了 cookie 也直接丢掉——见文件头 ①。
 */
export function ncmCheckToState(body) {
  const code = Number(body?.code ?? 0)
  const state = NCM_LOGIN_CODES[code]
  if (!state) return { ok: false, state: 'error', reason: `网易登录轮询给出没见过的码 ${code || '（无码）'}` }
  if (state === 'confirmed') {
    const cookie = text(body?.cookie)
    if (!cookie) return { ok: false, state: 'error', reason: '网易说已确认，但没把凭据带回来（这一档不能算登录成功）' }
    return { ok: true, state, cookie, nickname: text(body?.nickname), avatarUrl: text(body?.avatarUrl) }
  }
  const out = { ok: true, state }
  if (state === 'expired') out.reason = '二维码已过期，请重新获取'
  return out
}

/**
 * 包的 `/login/status` 响应 → 账号信息。**昵称在 `data.profile` 里，不在 `data.account` 里**
 * （2026-10-06 真扫码第一次问账号才发现：account 的键只有 id/userName/vipType/... 没有 nickname，
 * 于是登录态那一行会是空的；profile 才有 nickname 与 avatarUrl）。
 * 没登录时 `account` 与 `profile` 都为 null ⇒ 如实回"没登录"，不许把"没登录"报成故障。
 * 有意不往外带的字段：`vipType` / `paidFee` 这些权益数字今天没有消费者，等 M3-b 用到时再加
 * （加字段要先过 §7.1 那份键名白名单，不是白送的一行）。
 */
export function ncmStatusToAccount(body) {
  const data = body?.data ?? body
  const account = data?.account ?? null
  const profile = data?.profile ?? null
  if (!account && !profile) return { ok: true, loggedIn: false }
  const source = profile ?? account
  return {
    ok: true,
    loggedIn: true,
    ...(text(source?.nickname) ? { nickname: text(source.nickname) } : {}),
    ...(text(source?.avatarUrl) ? { avatarUrl: text(source.avatarUrl) } : {}),
  }
}

/**
 * 挂登录路由。`fetchImpl` 是为离线自检开的注入口（真机上固定用桥内那份 loopbackFetch）；
 * `now` 同样注入，让"过期"这条档位能在离线判定。
 * QQ 那一路不在本文件里（它不是"打环回 HTTP server"那一形状）：这里只做 provider 分叉，
 * 具体接线见 providers/qq-auth.mjs 的文件头。
 */
export function registerAuthRoutes({ routes, backends, fetchImpl, now = () => Date.now(), emit = () => {}, qqAuthHandler, kugouAuthHandler } = {}) {
  let qq = qqAuthHandler;
  const qqRoute = (payload) => {
    if (!qq) qq = createQqAuthHandler({ emit, log: (line) => emit({ evt: 'note', line }) });
    return qq(payload);
  };
  let kugou = kugouAuthHandler;
  const kugouRoute = (payload) => {
    // 酷狗那一路不是"打环回 HTTP"，是**进程内直调包**（见 providers/kugou-auth.mjs 头部），
    // 所以它要的是 `backends.kugou` 那份句柄，而不是 fetchImpl。
    if (!kugou) kugou = createKugouAuthHandler({ backends, now, log: (line) => emit({ evt: 'note', line }) });
    return kugou(payload);
  };
  const callNcm = async (handle, path, cookie) => {
    const response = await fetchImpl(`${handle.baseUrl}${path}`, {
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(NCM_TIMEOUT_MS),
      redirect: 'error',
    })
    const raw = await response.text()
    try {
      return { status: response.status, body: JSON.parse(raw) }
    } catch {
      return { status: response.status, error: `网易后端返回的不是 JSON（HTTP ${response.status}）` }
    }
  }

  routes.set('/bridge/auth', async (payload) => {
    const provider = String(payload?.provider ?? '')
    if (provider === 'qq') return qqRoute(payload)
    if (provider === 'kugou') return kugouRoute(payload)
    if (provider !== 'netease') return { ok: false, provider, reason: provider ? `桥暂时不为 ${provider} 提供登录通道` : '缺少登录 provider' }
    const action = String(payload?.action ?? '')
    if (!['start', 'poll', 'status', 'logout'].includes(action)) return { ok: false, provider, reason: `不支持的登录动作：${action || '（空）'}` }
    const handle = backends.netease
    if (!handle || handle.state !== 'ready' || !handle.baseUrl) {
      return { ok: false, provider, reason: '网易后端未就绪（在线能力被关闭或后端正在重启）', retryable: true }
    }
    // status / logout 要带着父进程交给它的那份凭据（§3：网易那份的**所有者是父进程**，
    // 这里只是经"环回 + 每次 spawn 的令牌"这条受保护通道借用一次，桥不落盘、不回显）。
    const cookie = action === 'status' || action === 'logout' ? text(payload?.cookie) : ''
    if ((action === 'status' || action === 'logout') && !cookie) {
      return { ok: true, provider, action, loggedIn: false, reason: '本机没有网易登录态可问' }
    }
    if (action === 'start') {
      const key = await callNcm(handle, '/login/qr/key', cookie)
      if (key.error) return { ok: false, provider, action, reason: key.error, retryable: true }
      const keyed = ncmQrKeyToLoginId(key.body)
      if (!keyed.ok) return { ok: false, provider, action, reason: keyed.reason }
      const created = await callNcm(handle, `/login/qr/create?key=${encodeURIComponent(keyed.loginId)}&qrimg=true`, cookie)
      if (created.error) return { ok: false, provider, action, reason: created.error, retryable: true }
      const qr = ncmQrCreateToQr(created.body, now())
      if (!qr.ok) return { ok: false, provider, action, reason: qr.reason }
      // loginId 不外泄给浏览器也没关系：它是这一轮登录的一次性句柄，父进程内存里持有它，
      // 界面只拿到图片与过期时间（见 online-auth.mjs）。
      return { ok: true, provider, action, loginId: keyed.loginId, qr: qr.qr, expiresAt: qr.expiresAt }
    }
    if (action === 'poll') {
      // 句柄只有 poll 这一档需要：status / logout 带的是凭据，不是那一轮的一次性句柄。
      // （第一版把这道校验放在了动作分叉之前，于是"带 cookie 问账号"被当成"缺句柄"拒掉了。）
      const loginId = text(payload?.loginId)
      if (!loginId) return { ok: false, provider, action, reason: '缺少登录句柄：先调 start' }
      const checked = await callNcm(handle, `/login/qr/check?key=${encodeURIComponent(loginId)}`, cookie)
      if (checked.error) return { ok: false, provider, action, reason: checked.error, retryable: true }
      const state = ncmCheckToState(checked.body)
      return { ...state, provider, action }
    }
    if (action === 'status') {
      const asked = await callNcm(handle, '/login/status', cookie)
      if (asked.error) return { ok: false, provider, action, reason: asked.error, retryable: true }
      return { ...ncmStatusToAccount(asked.body), provider, action }
    }
    const done = await callNcm(handle, '/logout', cookie)
    if (done.error) return { ok: false, provider, action, reason: done.error, retryable: true }
    return { ok: true, provider, action, loggedOut: Number(done.body?.code ?? 0) === 200 }
  })
  return routes
}
