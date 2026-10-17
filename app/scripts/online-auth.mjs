// 本项目自撰（非移植代码）。M3-a Task C：扫码登录在**父进程**这一侧的状态机。
//
// 职责边界（设计稿 §3 的"凭据持有侧分两家"）：
//   · 网易那份 cookie 的**所有者是父进程**：从桥拿回来之后立刻进 jar 落盘（0600，见 online-session.mjs），
//     内存里也不长期留一份——`pending` 里只有那一轮的一次性登录句柄，用完即弃；
//   · 浏览器侧永远拿不到凭据：本文件返回的形状里只有 state / expiresAt / 二维码图片 / 可读原因；
//   · 上游的登录码（800/801/802/803）**不透传**：数字本身无害，但透传会让前端去 switch 上游语义，日后改包就碎。
//     对外只有 waiting | scanned | confirmed | expired | error 五档 + 一句 reason。
//
// 时序事实按实测写死（数据在 memory/folia-port-p5-run-log.md 的 Task C 探针段；R215 反转了其中一条）：
//   · 二维码 TTL 由桥在 start 时算出（175 秒），但那只是**本机显示时长**：R215 实测（2026-10-13，两个实例）
//     用户"手机显示成功"之后会话还要 **94~116 秒**才落盘 ⇒ 本地到点并不等于上游那一轮结束。
//     **不许再拿本地计时判终止**：到点后继续问上游（界面那侧转低频续问），
//     真正的终态只认上游返回（expired / error 且不可重试）或用户取消。
//   · 轮询节奏 2000ms，且**上一轮 settle 之后才排下一轮**（排程在界面侧做，见 Task E；
//     这里只提供"一次一问"的无状态接口，服务端不藏定时器——藏了就多一处要清理、要证明清干净了的句柄）。
import { AUTH_STATES, NCM_QR_TTL_MS } from './bridge/providers/auth.mjs'
import { cookieHeaderFor, jarFromCookieString } from './online-session.mjs'

/**
 * 前端轮询节奏：**按家给**，不是一个全局数。
 * 这一档现在是**保守选择**，不是实测结论——原来写在这里的"限流"归因已作废（R153）：
 * 那批 502/`error_code:20010` 的真凶是我们自己把 `login_qr_check` 的参数名传错（包读 `params.key`），
 * 而"同一张码前 60 问全 200、之后 120 问全 502"这组读数与"参数一直错"**不能同时成立**
 * （参数错该每次都错），原始探针已删、无法复核 ⇒ 那半段**存疑**。
 * 保留 5 秒的理由只剩两条，都不依赖上面那个归因：① 少打一半以上请求对上游更温和；
 * ② 量出来的码有效期 300 秒内仍有三十几次机会看到"已确认"，2 秒节奏买不到额外收益。
 * 网易与 QQ 那两档 2 秒是 M3-a 就在跑的既有节奏，不跟着动。
 */
export const AUTH_POLL_MS = 2000
export const AUTH_POLL_MS_BY_PROVIDER = { netease: 2000, qq: 2000, kugou: 5000 }
export { AUTH_STATES, NCM_QR_TTL_MS }
/**
 * 两个 provider 的凭据形状**不一样**，这是实测出来的，不是设计偏好：
 *   · netease — 桥打自己起的环回后端，确认态的 cookie 在**响应体**里 ⇒ 父进程拿到的是明文 cookie 串，
 *     进 jar 落盘（online-session 的 `write`）；
 *   · qq — 包只有 `/serverless` 与 `/mqtt` 两个合法子路径，会话是**密封串** ⇒ 父进程拿到的是不透明密文
 *     （`writeSealed`），外加一份密封密钥（`secretFor`）。桥那一侧的 relay 只见临时登录态，看不见凭据。
 */
export const AUTH_PROVIDERS = ['netease', 'kugou', 'qq']
const LABEL = { netease: '网易', kugou: '酷狗', qq: 'QQ' }

/**
 * `bridge` 要的是桥客户端那份 `call(route, payload)`；`session` 是 online-session 的实例。
 * 两个都是注入件：离线自检用假桥 + 假会话，真机上由 music-server 装配。
 */
export function createOnlineAuth({ bridge, session, log = (line) => console.log(line) } = {}) {
  /** provider → `{ loginId, expiresAt, state }`。只存这一轮登录的句柄，不存任何凭据。 */
  const pending = new Map()

  const fail = (reason) => ({ state: 'error', reason })

  /** QQ 那一路每次调用都要带上密封密钥（包没它就回 501）；网易不需要，别多此一举。 */
  const payloadFor = async (provider, base) => {
    if (provider !== 'qq') return base
    const { secret } = await session.secretFor('qq')
    return { ...base, secret }
  }

  const start = async (provider = 'netease') => {
    if (!AUTH_PROVIDERS.includes(provider)) return fail(`这一版没有 ${provider} 的扫码通道`)
    const result = await bridge.call('/bridge/auth', await payloadFor(provider, { action: 'start', provider }))
    if (!result?.ok) return fail(result?.reason ?? '桥没有应答登录请求')
    if (typeof result.loginId !== 'string' || !result.loginId) return fail('桥没给回登录句柄')
    pending.set(provider, { loginId: result.loginId, expiresAt: Number(result.expiresAt) || 0, state: 'waiting' })
    // 日志里不许出现 loginId（它是这一轮登录的一次性句柄），只说"生成了、本机显示多久"。
    // R215：这 175 秒从此只是**显示时长**，不再是"有效期"（确认可能迟到；到点后仍会问上游）。
    log(`${LABEL[provider]}登录二维码已生成（本机显示 ${Math.max(0, Math.round(((Number(result.expiresAt) || 0) - Date.now()) / 1000))} 秒；手机确认可能延迟一两分钟）`)
    return { state: 'waiting', expiresAt: result.expiresAt, qr: result.qr }
  }

  const poll = async (provider = 'netease') => {
    const slot = pending.get(provider)
    if (!slot) return fail('没有进行中的扫码登录：先获取二维码')
    // R215：这里从前有一条"本地计时到点 ⇒ 删句柄 + 回 expired（未再询问上游）"的终止闸。实测推翻它：
    // 手机确认可能迟 1.5~2 分钟才可见（两个实例：94 秒 / 116 秒），本地 175 秒到点就停问
    // ⇒ 确认晚于本地到期的那些**永远看不到**（除重开一轮）。现在无条件问上游，终止只认它的终态。
    const result = await bridge.call('/bridge/auth', await payloadFor(provider, { action: 'poll', provider, loginId: slot.loginId }))
    if (!result?.ok) {
      // 桥说"可重试"时**不清这一轮的句柄**：QQ 的长连接坏一次、酷狗的状态查询失败一次，
      // 都可能是"过一会儿再问就好"（这一格与上面那个已作废的"限流"归因无关，它只看 `retryable`）。
      // `retryable` 必须**原样带出去**：界面靠它区分"这张码还有救"与"作废了"，
      // 吞掉这个标记就等于把一张还能扫的码当废码丢掉（真机上就是这么发现的）。
      if (result.retryable) return { ...fail(`${result.reason ?? '桥没有应答登录轮询'}（可稍后重试，二维码仍然有效）`), retryable: true }
      pending.delete(provider)
      return fail(result?.reason ?? '桥没有应答登录轮询')
    }
    if (!AUTH_STATES.includes(result.state)) {
      pending.delete(provider)
      return fail(`桥报回一个不在档内的登录状态：${String(result.state).slice(0, 20)}`)
    }
    slot.state = result.state
    if (result.state === 'confirmed') {
      // 凭据只在这两行里落地，日志与返回值都不带它。三家的形状**不一样**（见 AUTH_PROVIDERS 的注释）：
      // QQ 是不透明密封串 → sealed 记录；网易与酷狗都是明文 cookie 串 → jar（酷狗那份是 `token` + `userid` 两对）。
      if (provider === 'qq') await session.writeSealed('qq', result.session);
      else {
        // 任务七查到的那一格：`write()` 遇到空 jar 会**当退出处理**（"空 jar 等于退出，不留一份空凭据装样子"），
        // 于是这一句"登录态已保存"就成了假话——文件不但没写，反而被删了。所以按返回结果分两句说。
        const saved = await session.write(provider, jarFromCookieString(result.cookie));
        pending.delete(provider)
        log(saved?.entries
          ? `${LABEL[provider]}登录态已保存（来源：会话文件）`
          : `${LABEL[provider]}这一轮报的是登录成功，但响应里没有解析得出会话（本机没有留存凭据，此前的那份已按"空即退出"清掉）`)
        return { state: 'confirmed' }
      }
      pending.delete(provider)
      log(`${LABEL[provider]}登录态已保存（来源：会话文件）`)
      return { state: 'confirmed' }
    }
    if (result.state === 'expired') pending.delete(provider)
    return { state: result.state, ...(result.reason ? { reason: result.reason } : {}) }
  }

  /** 对外的登录状态：键名白名单在 session.describe() 那一层已经守住，这里只再加"进行中的那些轮"。 */
  const status = async () => {
    const described = await session.describe()
    const running = AUTH_PROVIDERS
      .map((provider) => {
        const slot = pending.get(provider)
        return slot ? { provider, state: slot.state, expiresAt: slot.expiresAt } : null
      })
      .filter(Boolean)
    // `pending` 从"一个对象"变成"一个数组"：三家可以同时在扫（各一张码），
    // 单值形状会在第二家开始登录时把第一家的状态悄悄盖掉。
    // `pollMsBy` 是给界面的**每家各一档**节奏（为什么给两档见 `AUTH_POLL_MS_BY_PROVIDER` 上面那段——
    // 那里同时记着"限流"归因为什么已作废）；
    // `pollMs` 保留是旧契约的默认值，两者并存比"改一个键名"要稳。
    return { providers: described.providers, pending: running, pollMsBy: AUTH_POLL_MS_BY_PROVIDER }
  }

  /**
   * 退出：**本机那份一定删**，上游登出成不成功只影响"要不要在 reason 里说一句"。
   * 反过来说不删本机那份、把上游失败当成"退不出去"，用户就被困在一个关不掉的登录态里。
   * 返回的不是二维码那套状态机（那是"进行中的一次登录"），而是一次动作的结果。
   */
  const logout = async (provider = 'netease') => {
    if (!AUTH_PROVIDERS.includes(provider)) return { ok: false, reason: `这一版没有 ${provider} 的登录通道` }
    pending.delete(provider)
    let upstream
    /** 桥明说"这一档我根本不出网"时的那句原话（酷狗那一路）：它不是失败，但必须被说出来。 */
    let noUpstream = ''
    if (provider === 'qq') {
      // 2026-10-07 读码纠正（R108）：`/logout` **在** serverless 的路由表里（`dist/src/serverless/index.js:310`），
      // R105 那句"包没有登出端点"是错的——当时只看 `/login/channels` advertise 的那几项，没读路由表。
      // 但它在这种会话模式下**撤销不了已经签发的 token**：包的 `revoke()` 是文档化的 no-op，
      // 那一跳做的是丢弃桥侧还在扫的那一轮 + 给同源调用方回一条过期 cookie。所以两步都要，且顺序不能反：
      //   ① 打一次上游（告知 + 清掉在扫的那一轮），它坏了不拦本机那一步；
      //   ② 删本机那一份——**真正结束这次登录的是这一步**。
      const { session: token, source } = await session.readSealed('qq')
      if (source === 'file' && token) {
        const result = await bridge.call('/bridge/auth', await payloadFor('qq', { action: 'logout', provider: 'qq', token }))
        if (!result?.ok) upstream = result?.reason ?? '桥没有应答登出请求'
      }
      const removed = await session.remove('qq')
      if (!removed.removed && !removed.alreadyGone) return { ok: false, reason: `本机登录态没删掉：${removed.reason}`, provider }
      log(`QQ 已退出登录${upstream ? `（上游那一步没确认：${upstream}）` : ''}：本机那份密封会话已删除`)
      return {
        ok: true, signedOut: true, provider,
        ...(upstream
          ? { reason: `上游登出未确认：${upstream}；本机登录态已删除` }
          // 不写成"上游已经把会话撤销了"：那种模式下没有服务端可撤销的东西，实话是本机丢弃了它。
          : { reason: '本机登录态已清除；这种会话模式下上游没有可撤销的东西，令牌留着也会在到期后自废' }),
      }
    }
    const { jar, source } = await session.read(provider)
    const cookie = cookieHeaderFor(jar)
    if (source !== 'none' && cookie) {
      const result = await bridge.call('/bridge/auth', { action: 'logout', provider, cookie })
      // `upstream:false` 是桥在说"这一档没有上游可通知"（酷狗包 v1.6.0 没有登出模块）。
      // 这不是失败，但也**不许**被界面转成"已通知上游"：原话从这里传出去。
      if (result?.upstream === false) noUpstream = result?.reason ?? '这一家没有上游登出接口：只清了本机会话'
      else if (!result?.ok) upstream = result?.reason ?? '桥没有应答登出请求'
    }
    const removed = await session.remove(provider)
    if (!removed.removed && !removed.alreadyGone) {
      return { ok: false, reason: `本机登录态没删掉：${removed.reason}`, provider }
    }
    log(`${LABEL[provider]}已退出登录${upstream ? `（上游登出没确认：${upstream}）` : ''}`)
    // 两句互斥：一家要么"有上游可通知但没通知成"，要么"结构上没有上游这一跳"。
    const reason = noUpstream ? `${noUpstream}；本机登录态已删除` : upstream ? `上游登出未确认：${upstream}` : ''
    return { ok: true, signedOut: true, provider, ...(reason ? { reason } : {}) }
  }

  /** 已登录时问一次账号（`/login/status`）：凭据由父进程交给桥借用一次，回过来只有昵称与头像。 */
  const account = async (provider = 'netease') => {
    if (provider === 'qq') {
      // 这个运行时是**无状态 sealed**：包不写盘，会话就是父进程存着的那段 token，
      // 每次鉴权请求由桥用 `x-qq-session` 头带回去（见 providers/qq-auth.mjs 头部）。
      // 所以"有没有登录"读本机那份密封文件，"是谁"才出网问一次。
      const { session: token, source } = await session.readSealed('qq');
      if (!(source === 'file' && token)) return { loggedIn: false };
      const result = await bridge.call('/bridge/auth', await payloadFor('qq', { action: 'account', provider: 'qq', token }));
      if (!result?.ok) return { loggedIn: false, reason: result?.reason ?? '桥没有应答账号请求' };
      return {
        loggedIn: result.loggedIn === true,
        ...(result.nickname ? { nickname: result.nickname } : {}),
        ...(result.avatarUrl ? { avatarUrl: result.avatarUrl } : {}),
      };
    }
    const { jar } = await session.read(provider)
    const cookie = cookieHeaderFor(jar)
    if (!cookie) return { loggedIn: false }
    const result = await bridge.call('/bridge/auth', { action: 'status', provider, cookie })
    if (!result?.ok) return { loggedIn: false, reason: result?.reason ?? '桥没有应答账号请求' }
    // 键名白名单在桥那一侧的映射函数里已经把过一道（QQ 是 profile 字段白名单、酷狗是四样），
    // 这里再挑一次是第二道：**父进程不转发包回的对象**，只把它认识的几样文本往外传。
    return {
      loggedIn: result.loggedIn === true,
      ...(result.nickname ? { nickname: result.nickname } : {}),
      ...(result.avatarUrl ? { avatarUrl: result.avatarUrl } : {}),
      ...(result.vipLabel ? { vipLabel: result.vipLabel } : {}),
      ...(result.vipTier ? { vipTier: result.vipTier } : {}),
    }
  }

  return { start, poll, status, logout, account, pendingSize: () => pending.size }
}
