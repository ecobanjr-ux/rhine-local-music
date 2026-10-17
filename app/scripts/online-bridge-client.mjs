// 本项目自撰（非移植代码）。桥子进程生命周期的**唯一持有者**（Task 4~14 一律经 call() 走桥，不许自己 spawn）。
//
// 三条设计决定了这个文件的存在方式：
//   ① 关着零暴露：四张子开关全关时根本不 spawn —— 没有子进程、没有端口、没有出网面，phase='off'。
//   ② 崩溃隔离：桥死了只影响在线功能。call() 永不抛异常，只回 { ok:false, reason }，
//      播放链拿到这个结果就该继续用本地歌词/本地音频，绝不因为后端没了而卡住。
//   ③ 退避有上限：连续失败最多重启 3 次（1s/2s/4s）就停在 'unavailable'。
//      非官方接口失效多半不是瞬时故障，无限重启等于无限刷进程；计数只在"全关再打开"后重置。
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BACKOFF_MS = [1000, 2000, 4000]
const GRACEFUL_MS = 1500        // 等子进程自己退的时间；超时才 kill（Windows 上就是 TerminateProcess）
const READY_MS = 30_000         // 三个第三方包都要 require 一遍：真实 boot 取证里 ready 之前有一段静默期
const DEAD_PROBE_MS = 200       // "没就绪时子进程是不是已经死了"的判定窗口
const SETTLED = new Set(['ready', 'degraded', 'unavailable', 'off'])
const ONLINE_KEYS = ['lyrics', 'search', 'streaming', 'covers']
const BRIDGE_ENTRY = fileURLToPath(new URL('./bridge/online-bridge.mjs', import.meta.url))

export function createBridgeClient({
  getConfig, dataDir, log = () => {}, onAudit = () => {}, onNote = () => {},
  spawnOverride, bridgeEntry = BRIDGE_ENTRY, backoffMs = BACKOFF_MS, readyMs = READY_MS,
} = {}) {
  // 构造时就要求 getter：传 `config` 对象进来看着也能跑，但 store.updateConfig() 换的是整个对象，
  // 于是客户端从此读的是旧开关——这条在真实机器上被现场抓到过一次（全关之后 status 仍报后端齐全）。
  if (typeof getConfig !== 'function') throw new Error('createBridgeClient 必须拿 getConfig（开关表的实时读取口）')
  // 令牌每个客户端一把（= 每次 spawn 出来的新进程各不同），只经 env 传入：
  // Windows 上 argv 可被同机任意进程枚举，命令行里不能出现凭据。
  const token = crypto.randomBytes(24).toString('hex')
  let child = null
  let port = 0
  let phase = 'off'
  let backends = []
  let unauthorized = 0
  let restarts = 0
  let lastError = null
  let readySettle = null
  let supervisor = null
  let supervisorGeneration = -1
  let generation = 0
  let stopping = false
  let waiters = []

  // 用 getter 而不是快照：updateConfig() 会**整个替换** store.config 对象，
  // 抓引用会让客户端一直看到旧开关（改判成"用户已经关了"或"还开着"都不对）。
  const switchesOn = () => {
    const online = getConfig?.()?.online
    return ONLINE_KEYS.some((key) => online?.[key] !== false)
  }
  const anyOn = () => switchesOn()
  // 桥只起两个包后端。QQ 不在其中（R83 的 2026-10-05 撤回）：包根没有 serverless dispatcher，
  // 而本期 QQ 的搜索/歌词/匿名音源都走自写 fcg + guardedFetch——那才进得出网审计，也不用多开一个回环端口。
  const hosts = () => anyOn() ? ['netease', 'kugou'] : []

  /** phase 的每次变化都要叫醒 ensure() 的等待者，否则调用方只能干等 readyMs 超时。 */
  function setPhase(next) {
    phase = next
    const pending = waiters
    waiters = []
    for (const settle of pending) settle()
  }

  function settleReady(outcome) {
    const waiter = readySettle
    readySettle = null
    waiter?.(outcome)
  }

  /** 就绪等待：同一时刻只有一个 waiter。ready 事件与进程退出都要能结掉它，否则调用方挂在超时上。 */
  function waitReady() {
    return new Promise((resolve) => {
      let settled = false
      const done = (outcome) => { if (settled) return; settled = true; clearTimeout(timer); resolve(outcome) }
      const timer = setTimeout(() => done({ ok: false, reason: `桥 ${readyMs}ms 内没就绪` }), readyMs)
      readySettle = done
    })
  }

  /** 等到一个"可以答复调用方"的阶段：就绪 / 降级 / 放弃 / 关掉，或 readyMs 到点。 */
  function waitSettled() {
    if (SETTLED.has(phase)) return Promise.resolve(phase)
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiters = waiters.filter((w) => w.resolve !== resolve); resolve(phase) }, readyMs)
      const settle = () => { clearTimeout(timer); resolve(phase) }
      settle.resolve = resolve
      waiters.push(settle)
    })
  }

  const clearChild = () => {
    child = null
    port = 0
    settleReady({ ok: false, reason: lastError ?? '桥进程已退出' })
  }

  /** 后端表里的 reason 只在该后端真的失败时才有；不带 reason 的条目别写成 `{reason: undefined}`。 */
  const backendEntry = ({ id, state, reason }) => ({ id, state, ...(reason ? { reason } : {}) })

  function onData(chunk) {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue
      let evt
      try { evt = JSON.parse(line) } catch { continue }        // 包自己的横幅输出不是 JSON，直接丢
      if (evt.evt === 'ready') {
        port = evt.aggregate?.port ?? 0
        backends = (evt.backends ?? []).map(backendEntry)
        setPhase(backends.some((b) => b.state === 'error') ? 'degraded' : 'ready')
        settleReady({ ok: true })
      } else if (evt.evt === 'backend') {
        const entry = { id: evt.id, state: evt.state, reason: evt.reason }
        backends = backends.some((b) => b.id === evt.id) ? backends.map((b) => (b.id === evt.id ? backendEntry(evt) : b)) : [...backends, backendEntry(evt)]
        if (evt.state === 'error') { if (port) setPhase('degraded') }
        else if (evt.state === 'ready' && backends.every((b) => b.state === 'ready') && port) setPhase('ready')
      } else if (evt.evt === 'audit') {
        onAudit(evt)                                            // Task 3 只做转发；Task 4 接进 online-audit 环
      } else if (evt.evt === 'note') {
        // 桥内的人话备注（例如"QQ 的长连接没建立起来"）。父进程决定怎么说——脱敏在调用方做，
        // 因为**知道凭据值的是父进程那一份 session**，桥不知道。
        onNote(String(evt.line ?? ''))
      } else if (evt.evt === 'fatal') {
        lastError = evt.reason
      }
    }
  }

  const delay = (ms, value) => new Promise((resolve) => { setTimeout(() => resolve(value), ms) })

  async function spawnOnce() {
    let handle
    try {
      handle = spawnOverride ? spawnOverride(token, hosts()) : spawn(process.execPath, [bridgeEntry], {
        env: { ...process.env, ONLINE_BRIDGE_TOKEN: token, ONLINE_BRIDGE_HOSTS: hosts().join(',') },
        // cwd 锚在数据目录：包依赖里有人在 import 时从 cwd 读 .env（实测 dotenvx 打了
        // "injected env (0) from .env"）⇒ 不能让"往工作目录扔个 .env"成为改变后端行为的通道。
        cwd: dataDir ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
      })
    } catch (error) {
      return { ok: false, reason: `桥启动失败：${error?.message ?? error}` }
    }
    child = handle
    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', onData)
    handle.stderr?.setEncoding('utf8')
    // 后端的日志只转进服务日志：不落盘、不进仓库（包会把歌词与曲目名打进横幅）。
    handle.stderr?.on('data', (chunk) => log(`[bridge] ${String(chunk).trimEnd()}`))
    handle.on?.('error', (error) => { lastError = `桥进程错误：${error?.message ?? error}` })
    // exitPromise 必须在 await 就绪**之前**建好：就绪与退出是竞争关系，桥若在这中间死掉，
    // 晚一步的 once('exit') 就永远等不到，监管协程会卡在已死的句柄上。
    const exitPromise = new Promise((resolve) => handle.once?.('exit', (code, signal) => resolve(signal ? `信号 ${signal}` : `code=${code}`)))
    const ready = await waitReady()
    if (!ready.ok) {
      // 没等到就绪时子进程可能还活着（卡在某个包的 require 里）。必须确认它真没了才继续退避，
      // 否则几轮下来会攒出一串半死的桥进程。
      if ((await Promise.race([exitPromise, delay(DEAD_PROBE_MS, 'alive')])) === 'alive') {
        try { handle.kill() } catch { /* 正在退 */ }
        await Promise.race([exitPromise, delay(GRACEFUL_MS, 'alive')])
      }
      return { ok: false, reason: ready.reason ?? lastError ?? '桥未就绪' }
    }
    // 就绪后补读一次状态：ready 事件里的后端表还是初始态，端口与非法访问计数以实际为准。
    await refreshStatus().catch(() => {})
    return { ok: true, exit: exitPromise }
  }

  /** 只打环回；route 由本项目常量表给出，payload 已是 JSON。异常一律抛给调用方处理（call 会兜住）。 */
  async function request(route, payload, timeoutMs) {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-online-token': token },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.json()
  }

  async function refreshStatus() {
    if (!child || !port) return
    const body = await request('/bridge/status', undefined, 3000)
    if (body && typeof body === 'object') {
      unauthorized = body.unauthorized ?? unauthorized
      port = body.port ?? port
      if (Array.isArray(body.backends)) backends = body.backends.map(({ id, state, reason }) => ({ id, state, reason }))
    }
  }

  async function supervise(myGeneration) {
    while (anyOn() && !stopping && myGeneration === generation) {
      setPhase('starting')
      const started = await spawnOnce()
      if (myGeneration !== generation) return          // 关停或重开已经接管，这个协程不许再改状态
      if (started.ok) {
        const exitReason = await started.exit
        if (myGeneration !== generation) return
        clearChild()
        if (!anyOn() || stopping) { setPhase('off'); return }
        lastError = `桥进程退出（${exitReason}）`
        log(`在线后端进程退出（${exitReason}），本地播放不受影响。`)
      } else {
        clearChild()
        if (!anyOn() || stopping) { setPhase('off'); return }
        lastError = started.reason
      }
      if (restarts >= backoffMs.length) {
        setPhase('unavailable')
        log(`${lastError}：自动重启已达 ${backoffMs.length} 次上限，停止拉起。需要恢复请在音乐库面板里把在线能力关掉再打开。`)
        return
      }
      const wait = backoffMs[restarts]
      restarts += 1
      await delay(wait)
    }
    if (myGeneration === generation && !anyOn()) setPhase('off')
  }

  /** 幂等：把监管协程踢起来，并等到一个可答复的阶段。返回值是当时的 phase 字符串。 */
  async function ensure() {
    if (!anyOn()) { setPhase('off'); restarts = 0; return phase }
    if (phase === 'unavailable') return phase                 // 已达上限就不再自动拉起（见顶部③）
    if (!child && !supervisor) {
      stopping = false
      const myGeneration = generation
      supervisor = supervise(myGeneration).finally(() => { if (myGeneration === generation) supervisor = null })
    }
    return waitSettled()
  }

  async function call(route, payload = {}) {
    if (!anyOn()) return { ok: false, reason: 'bridge-off' }
    await ensure()
    if (!child || !port) return { ok: false, reason: lastError ?? '桥不可用' }
    try {
      const body = await request(route, payload, payload.timeoutMs ?? 12_000)
      return body && typeof body === 'object' ? body : { ok: false, reason: '桥返回的不是 JSON' }
    } catch (error) {
      // 永不把异常抛回播放链：桥没应答 = 这一次在线能力没有，本地照常。
      return { ok: false, reason: `桥无响应：${error?.message ?? error}` }
    }
  }

  async function shutdown() {
    stopping = true
    // 代际 +1：此刻起旧监管协程不许再改动任何状态（它可能正卡在 await 子进程退出上）。
    // 早先用 `await supervisor` 等它退出，碰上"子进程死了但不报 exit"就永远等不到 ⇒ 整个关停挂死；
    // 而不清 supervisor，紧随其后的 ensure() 会以为"还在起桥"而跳过启动，phase 永远停在 off。
    generation += 1
    supervisor = null
    const target = child
    if (!target) { setPhase('off'); return { forced: false } }
    const gone = new Promise((resolve) => target.once?.('exit', () => resolve(true)))
    try { target.channel?.postMessage({ cmd: 'shutdown', token }) } catch { /* IPC 断了就走 kill 那条 */ }
    try { target.stdin?.end() } catch { /* 管道断了也会触发子进程自己的看门狗 */ }
    let forced = false
    if (!(await Promise.race([gone, delay(GRACEFUL_MS, false)]))) {
      try { target.kill() } catch { /* 已经没了 */ }
      await Promise.race([gone, delay(GRACEFUL_MS, false)])
      forced = true
    }
    child = null
    port = 0
    backends = []
    setPhase('off')
    return { forced }
  }

  return {
    status: () => ({ phase, port, backends, unauthorized, restarts, lastError, hosts: hosts() }),
    call,
    ensure,
    shutdown,
    refreshStatus,
    childCount: () => (child ? 1 : 0),
    restarts: () => restarts,
    ready: () => ensure(),
    // 自检注入点：真实杀进程赌时序不稳定，测试直接叫停当前子进程并留一个原因。
    killChildForTest: (why) => { lastError = why; child?.kill() },
  }
}
