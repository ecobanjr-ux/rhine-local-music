// 本项目自撰（非移植代码）。酷狗扫码登录在**桥内**这一侧（R136 · 三家登录的第二家）。
//
// 为什么单独一个文件而不是并进 `auth.mjs`：网易那一路的形状是"打自己起的环回 HTTP server"，
// 酷狗是"进程内直调包导出的模块函数"（见 `backends/kugou.mjs` 头部），两者只共享 provider 分叉那一个入口。
//
// 一手实测（2026-10-08 夜，一次性探针 `kugou-qr-probe`，跑在产品同一条路上，数据在执行日志 §二）：
//   · `login_qr_key({})` → `{status:200, body:{data:{qrcode:str(36), qrcode_img:'data:image/png;base64,…',
//     status:1, error_code:0}, cookie:[], headers:{}}}` —— **这一步就已经回吐二维码图**，
//     与看板给的三步链有出入：`login_qr_create` 不再是"有没有图"的必要一跳。三步仍都走（按指令），
//     但**图的来源按实测排**：优先本地 `create` 那张（它编码的是我们确定知道的 h5 URL），
//     拿不到才回落到上游那张。
//   · `login_qr_create({key, qrimg:true})` 是**纯本地**的（包内直接 `qrcode.toDataURL`，零出网），
//     参数名是 `key` 而不是 `qrcode`（与 check 那一步不同名，实测过）。
//   · `login_qr_check({qrcode})` → `data.status`：0 过期 / 1 待扫码 / 2 待确认 / 4 已授权；
//     4 那一档包会把 `token=` 与 `userid=` push 进响应的 cookie 数组，`data` 里也有这两个字段。
//   · `login_qr_key` **会 502**（实测第二次调用即 `error_code:20010`，包把它作为 reject 抛出）
//     ⇒ 这一档的失败一律 `retryable:true`，不许把一次上游抖动说成"登录失败"。
//
// 三条红线，逐条有断言：
//   ① 凭据（token / userid）**不在桥内落盘**：桥只在 confirmed 那一次把它交给父进程，
//      之后每次问账号都由父进程从 `online-session` 的分区里借出来带进来（与网易同一条模型）；
//   ② 昵称 / 头像 / VIP 档位**之外**的字段一个都不出桥 —— 照 QQ 那一课（R112：`profile.info.nick` 嵌在两格里，
//      而 `info` 里挂着 `phone/email/school/registerIP`）：这一路把"只透传白名单"写成逐条断言；
//   ③ **这一条链上不出 `register_dev`**：扫码登录这三跳（key/create/check）一次都不注册。
//      2026-10-10 用户批准了"设备身份"这一格（R154），但**例外只开到音频那一格**，
//      而一手实测显示连音频那一格今天也不需要动用它（显式带空 dfid 就给整首地址）⇒
//      全仓 `register_dev` 的调用点仍恰好一处、且默认关着（判据在 `check-music-bridge.mjs` 与
//      `check-music-auth-flow.mjs` 各自钉自己那半：这一份钉"登录链零调用"，那份钉"全仓唯一调用点"）。
import { AUTH_STATES } from './auth.mjs'

/** 上游那一档数字 → 对外那五档。**数字一律不透传**（与网易同一条纪律：前端不许 switch 上游语义）。 */
export const KUGOU_LOGIN_CODES = { 0: 'expired', 1: 'waiting', 2: 'scanned', 4: 'confirmed' }

/**
 * 二维码有效期的**本地兜底**：300 秒。这个数不是"上游多久失效"，而是"我们一手量到至少这么久还在 waiting"
 * （2026-10-08：一张码以 5 秒节奏问了 60 次、跨 300 秒，全部 HTTP 200 且 `data.status:1`，没见到 0）。
 * 真正的过期由上游报（`status:0` ⇒ 映射成 expired），本地这一格只负责"别再无限问下去"。
 * 为什么不用网易那个 175 秒：那是网易的实测值，照抄过来会对酷狗说一句假话——"已过期"而它其实还能扫。
 */
export const KUGOU_QR_TTL_MS = 300_000

/** confirmed 那一档包回吐的两枚凭据名（父进程把它们存进 jar，桥自己不落盘）。 */
export const KUGOU_CREDENTIAL_NAMES = Object.freeze(['token', 'userid'])

/**
 * 包在失败时抛的是**一个普通对象**（实测：`{status:502, body:{data:{error_code:20010}}, cookie:[], headers:{}}`），
 * 不是 Error ⇒ `error.message` 是 undefined，直接拼进字符串会得到 `[object Object]` 这种没人看得懂的文案。
 * 这里只取"哪一档 HTTP"与"上游的错误码"，**不带上响应体**（响应体里可能有用户身份字段）。
 */
export function kugouErrorText(error) {
  const status = error?.status ?? error?.response?.status ?? null
  const code = error?.body?.data?.error_code ?? error?.body?.error_code ?? null
  const message = typeof error?.message === 'string' && error.message ? error.message : ''
  const parts = [status ? `HTTP ${status}` : '', code ? `错误码 ${code}` : '', message]
  const line = parts.filter(Boolean).join(' · ')
  return line || '请求没有应答'
}

const text = (value) => String(value ?? '').trim()

/** 包在进程内直调时的响应信封（与 `lyric-routes.mjs` 那两处同一个拆法，不另写一份）。 */
export function kugouEnvelope(result) {
  return result?.body ?? result?.data ?? result ?? {}
}

/**
 * `cookie` 字符串 → 包要的那个对象形状。
 * 包在 server 模式下由 Express 中间件解析 cookie，**进程内直调没有那一层**
 * （一手读 `module/user_detail.js:2-3`：它取的是 `params.cookie.token`，一个对象），所以这一跳我们自己拆。
 */
export function kugouCookieToObject(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()) } catch { out[name] = part.slice(eq + 1).trim() }
  }
  return out
}

/** `login_qr_key` → 那一轮的一次性句柄 + 上游自带的那张图。 */
export function kugouQrKeyToLogin(body, now = Date.now()) {
  const data = body?.data ?? body ?? {}
  const loginId = text(data.qrcode ?? data.key)
  if (!loginId) return { ok: false, reason: '酷狗没有回二维码句柄' }
  const image = String(data.qrcode_img ?? '')
  return { ok: true, loginId, image: image.startsWith('data:image/png;base64,') ? image : '', expiresAt: now + KUGOU_QR_TTL_MS }
}

/** `login_qr_create`（纯本地那一步）→ 我们该显示的那张图与它编码的那条 URL。 */
export function kugouQrCreateToQr(body) {
  const data = body?.data ?? body ?? {}
  const image = String(data.base64 ?? '')
  const url = String(data.url ?? '')
  return {
    ok: image.startsWith('data:image/png;base64,') || !!url,
    image: image.startsWith('data:image/png;base64,') ? image : '',
    // 只认这一条前缀：别的域名的"登录 URL"一律当没有（它不该出现在界面上，更不该被当成可信跳转）。
    url: /^https:\/\/h5\.kugou\.com\/apps\/loginQRCode\//.test(url) ? url : '',
  }
}

/** `login_qr_check` → 对外状态；只有 confirmed 那一档才把凭据拼成 cookie 串交给父进程。 */
export function kugouCheckToState(body) {
  const data = body?.data ?? body ?? {}
  const code = Number(data.status ?? -1)
  const state = KUGOU_LOGIN_CODES[code]
  if (!state) return { ok: false, reason: `酷狗回了不在档内的登录状态码：${code}` }
  if (!AUTH_STATES.includes(state)) return { ok: false, reason: `状态档不认识：${state}` }
  if (state !== 'confirmed') return { ok: true, state }
  // 其余四档一个凭据字节都不带（与网易那条同形）：即便上游在"还没人扫"时就回过匿名 cookie，
  // 从这一层出去的唯一凭据来源就是 confirmed。
  const token = text(data.token)
  const userid = text(data.userid)
  if (!token || !userid) return { ok: false, reason: '酷狗报已授权，但没回 token 或 userid' }
  return { ok: true, state, cookie: `token=${encodeURIComponent(token)};userid=${encodeURIComponent(userid)}` }
}

/**
 * 账号信息：**只白名单四样**（昵称 / 头像 / VIP 档位名 / VIP 类型），其余一律不透传。
 * 为什么从几条路径里挑：包与上游的嵌套在这一版**还没有一手样本**（要等扫码窗口），
 * 但挑哪几条路径与放出去哪几个名字都是白名单——不在名单里的字段（phone / email / school /
 * registerIP / 任何身份类）无论挂在哪一层都到不了返回值。**多读几层不等于多给。**
 */
export function kugouDetailToAccount(detailBody, vipBody) {
  const detail = detailBody?.data ?? detailBody ?? {}
  const info = detail?.info ?? detail ?? {}
  const vip = vipBody?.data ?? vipBody ?? {}
  const pick = (...values) => {
    for (const value of values) { const s = text(value); if (s) return s }
    return ''
  }
  const avatar = pick(info?.avatar, info?.header_url, info?.icon, detail?.avatar, vip?.vip_icon, vip?.s_vip_icon)
  const httpsAvatar = avatar.replace(/^http:/i, 'https:')
  const label = pick(vip?.vip_name, vip?.svip_name, info?.vip_info?.name, detail?.vip_info?.name)
  const tier = pick(vip?.vip_type, vip?.svip, info?.vip_info?.type)
  return {
    ok: true,
    loggedIn: true,
    nickname: pick(info?.nickname, info?.nick, detail?.nickname, vip?.nickname),
    ...(httpsAvatar.startsWith('https://') ? { avatarUrl: httpsAvatar } : {}),
    ...(label ? { vipLabel: label } : {}),
    ...(tier ? { vipTier: tier } : {}),
  }
}

/**
 * `handler(payload)`：payload 来自父进程（`{action, provider, loginId?, cookie?}`）。
 * `backends.kugou` 没起来时一律 `retryable:true` —— 那是"桥正在重启"，不是"登录失败"。
 */
export function createKugouAuthHandler({ backends, now = () => Date.now(), log = () => {} } = {}) {
  const backend = () => {
    const handle = backends?.kugou
    return handle && handle.state === 'ready' && typeof handle.invoke === 'function' ? handle : null
  }
  const fail = (reason, extra = {}) => ({ ok: false, provider: 'kugou', reason, ...extra })

  return async (payload = {}) => {
    const action = text(payload?.action)
    const handle = backend()
    if (!handle) return fail('酷狗后端未就绪（在线能力被关闭或后端正在重启）', { retryable: true })
    if (!['start', 'poll', 'status', 'logout'].includes(action)) return fail(`不支持的登录动作：${action || '（空）'}`)

    if (action === 'logout') {
      // 红线 ③ 的另一半：包 v1.6.0 **没有登出模块**（一手核实：`module/` 目录里 `grep -i logout` 为空。
      // 这一条与 QQ 那次的教训相反 —— R108 是我看了 advertise 清单没读路由表，所以这次直接数文件）。
      // ⇒ 这一档**一次网都不出**，只把"没有上游可通知"这句实话报回去；真正结束登录的是父进程删本机那份。
      return { ok: true, provider: 'kugou', action, upstream: false, reason: '酷狗包 v1.6.0 没有登出接口：这一步不出网，只清本机会话' }
    }

    if (action === 'start') {
      let keyed
      try { keyed = kugouEnvelope(await handle.invoke('login_qr_key', {})) } catch (error) {
        // 实测上游会 502（error_code 20010）：那是抖动，不是"这台机器不能登录"。
        return fail(`酷狗二维码请求失败：${kugouErrorText(error)}`, { retryable: true })
      }
      const key = kugouQrKeyToLogin(keyed, now())
      if (!key.ok) return fail(key.reason)
      let created = { ok: false, image: '', url: '' }
      try {
        created = kugouQrCreateToQr(kugouEnvelope(await handle.invoke('login_qr_create', { key: key.loginId, qrimg: true })))
      } catch (error) {
        log(`酷狗本地二维码生成失败，回落到上游那张：${kugouErrorText(error)}`)
      }
      const image = created.image || key.image
      if (!image) return fail('酷狗没有回可显示的二维码图片')
      return {
        ok: true, provider: 'kugou', action, loginId: key.loginId, expiresAt: key.expiresAt,
        qr: { image, ...(created.url ? { url: created.url } : {}) },
      }
    }

    const loginId = text(payload?.loginId)
    if (action === 'poll') {
      if (!loginId) return fail('缺少登录句柄：先调 start', { action })
      let checked
      try {
        // 参数名是**读包源码定的**，不是猜的：`module/login_qr_check.js` 里是
        // `params: { ..., qrcode: params?.key }` —— 它取 **`params.key`**，再把它映射成上游查询串里的 `qrcode`。
        // 从前这里传 `{ qrcode: loginId }` ⇒ 包读到 `params.key === undefined` ⇒ 上游收到 `qrcode=undefined`
        // ⇒ 恒 HTTP 502 / `error_code:20010`，被误判成"酷狗要求设备注册"（R139 那一格，2026-10-10 已推翻）。
        // 两个名字都带：`key` 是包真正读的那一个；`qrcode` 与上游参考实现（folia-major kugouProvider.checkQr）
        // 逐字一致，且这个模块自己构造上游查询串、不会把 `params.qrcode` 透出去 ⇒ 带着无害。
        checked = kugouEnvelope(await handle.invoke('login_qr_check', { key: loginId, qrcode: loginId }))
      } catch (error) {
        return fail(`酷狗二维码状态查询失败：${kugouErrorText(error)}`, { action, retryable: true })
      }
      const state = kugouCheckToState(checked)
      if (!state.ok) return fail(state.reason, { action })
      return { ...state, provider: 'kugou', action }
    }

    // status（问账号）要凭据：由父进程从分区里借出来带进来，桥自己不存也不读盘。
    const cookie = text(payload?.cookie)
    if (!cookie) return { ok: true, provider: 'kugou', action, loggedIn: false, reason: '本机没有酷狗登录态可问' }
    const asObject = kugouCookieToObject(cookie)
    if (!asObject.token || !asObject.userid) return fail('本机那份酷狗登录态缺少 token 或 userid', { action })
    let detail
    try {
      detail = kugouEnvelope(await handle.invoke('user_detail', { cookie: asObject, token: asObject.token, userid: asObject.userid }))
    } catch (error) {
      return fail(`酷狗账号信息请求失败：${kugouErrorText(error)}`, { action, retryable: true })
    }
    let vip = {}
    try {
      vip = kugouEnvelope(await handle.invoke('user_vip_detail', { cookie: asObject }))
    } catch (error) {
      // VIP 那一档问不到不该把"是谁"也吞掉：昵称与头像照旧回，档位缺席就是缺席。
      log(`酷狗 VIP 信息请求失败（不影响昵称与头像）：${kugouErrorText(error)}`)
    }
    return { ...kugouDetailToAccount(detail, vip), provider: 'kugou', action }
  }
}
