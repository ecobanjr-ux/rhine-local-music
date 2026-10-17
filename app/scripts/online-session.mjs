// 本项目自撰（非移植代码）。第五期 M3-a Task B：cookie jar 与凭据边界（设计稿 §5 + §7 的兜底层）。
//
// 这个文件是**全仓唯一**会往磁盘写登录凭据的地方，所以它的边界比功能更重要，四条是硬的：
//   ① 写目标只有 `dataDir/online-session/` 一种（R74 的判据按"写盘调用形状"认，所以这里的调用
//      一律引用 `sessionFile` / `temporary` 这两个既有允许集里的名字，不放宽判据、不加豁免）；
//   ② **父进程只认领网易那一份**：QQ 的会话由桥内的包自己加密写（§3 的分家），这里连读都不读，
//      只按文件名 stat 一下"有没有"——读了内容就等于把凭据搬进父进程，多一处要守的地方；
//   ③ 不产生 `.backup`：备份等于把凭据多留一份，与"可回滚"的收益不成比例（歌单文件要备份是因为
//      那是用户资产，凭据不是）；退出就是删文件，删不掉要给可读原因，不许静默留着；
//   ④ 日志只说**来源种类**（环境变量 / 会话文件 / 匿名），永远不说内容；错误文本进日志前过 `redact`。
//
// Windows 上 0600 是"尽力"不是保证（POSIX mode 只映射只读位）：这里如实打一行"不保证"，
// 不假装拿到了没拿到的保证。设计稿 §5.4 的第 2 条风险， mitigation 是"数据目录可以指到用户自己
// 控制的位置"（F3 已交付）+ 文档写明别放共享盘。
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'

/** 会话分区目录名。它不是"用户可指定的路径"——这一层没有那个口子。 */
export const SESSION_DIR_NAME = 'online-session'
/**
 * 网易凭据所在的环境变量名。名字**拼出来写**：设计稿 §7.5 的命名约束——禁词原文只进文档与
 * 记忆日志，源码里读 env 的那一处用拼名，且注释里也不写原文（把禁词写进注释等于教后来人"这里可以写"）。
 */
export const NETEASE_ENV_KEY = 'NETEASE' + '_COOKIE'
/**
 * 分区里可能出现的三个文件。**父进程只认领 netease**：后两个是给桥内那个包用的落点，
 * 这里知道路径只为 stat 与"把路径注入给桥"，任何读写都拒绝。
 */
const SESSION_FILES = {
  netease: 'netease.json',
  /**
   * 酷狗那份与网易**同一形状**（父进程持有的 cookie 对：`token` + `userid`），不是 QQ 那种密封串：
   * 包在进程内直调时读的就是 `params.cookie.token / .userid`（一手读 `module/user_detail.js:2-3`），
   * 所以凭据的所有者仍然是父进程，桥每次借用、不落盘。
   */
  kugou: 'kugou.json',
  qq: 'qq-auth.json',
  'qq-device': 'qq-device.json',
  /**
   * QQ 的**密封密钥**（不是凭据）。Task D 实测：`/serverless` 那条路上包自己不往磁盘写任何东西
   * （会话与设备状态都密封在 `unikey` 里），唯一需要存活的秘密就是这个密钥——
   * 没有它，包对登录路由直接回 501，而且重启即丢全部登录（包自己的注释明写"密钥绝不自动生成"）。
   */
  'qq-secret': 'qq-session-key.json',
  /**
   * 酷狗的**设备身份**（R154 · 任务一）。为什么单开一个文件而不是并进 `kugou.json`：
   * 那份是"这个账号是谁"（token/userid，扫码来的），这份是"这台机器报的是什么身份"（guid/mid/dfid）。
   * 两件事混在一个文件里，将来"退出登录"就不得不连设备身份一起删（那不是账号数据），
   * 而"换一台机器重扫"又会把旧的 guid 留下。分开各管各的生命周期。
   * **今天这份里没有 dfid**：一手实测证明 `song_url` 只要显式带"空 dfid"（上游读成 `-`）就给整首地址，
   * `register_dev` 那一跳默认不调（开关见 `config.json` 的 `kugouDeviceIdentity`，缺省 false）。
   */
  'kugou-device': 'kugou-device.json',
}
/** 包读的那个环境变量的名字（拼名写，与 NETEASE_ENV_KEY 同一条纪律：禁词原文只进文档与记忆日志）。 */
export const QQ_SECRET_ENV_KEY = 'QQ_SESSION' + '_SECRET'
const PARENT_OWNED = ['netease', 'kugou']
const PROVIDER_LABEL = { netease: '网易', kugou: '酷狗', qq: 'QQ' }

/** 从一条 `Set-Cookie` 里取名字与属性段（属性按 `;` 切，`Expires` 自己带逗号所以不能按逗号切）。 */
const splitEntry = (entry) => {
  const parts = String(entry ?? '').split(';').map((part) => part.trim())
  const pair = parts[0] ?? ''
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attributes: parts.slice(1) }
}

/** 上游用 `Max-Age<=0` 或一个过去的 `Expires` 表达"删掉它"——那是删除指令，不是"存一个 0"。 */
const isDeletion = (attributes) => {
  for (const attribute of attributes) {
    const lower = attribute.toLowerCase()
    if (lower.startsWith('max-age=')) {
      const seconds = Number(lower.slice('max-age='.length))
      if (Number.isFinite(seconds) && seconds <= 0) return true
    }
    if (lower.startsWith('expires=')) {
      const at = Date.parse(attribute.slice('expires='.length))
      if (Number.isNaN(at) || at <= Date.now()) return true
    }
  }
  return false
}

/**
 * jar 的合并语义（§5.3）：同名新值胜出、`Domain/Path` 原样保留、删除指令删条目、坏条目忽略。
 * **返回新对象**：写盘失败时调用方手里那份旧的仍然是干净的。
 * 不做的事：不解析 `SameSite`、不做跨域作用域判断——我们只把它原样回传给同一家接口。
 */
export function mergeSetCookie(jar, setCookie) {
  const next = { ...(jar ?? {}) }
  for (const raw of setCookie ?? []) {
    const parsed = splitEntry(raw)
    if (!parsed) continue
    if (isDeletion(parsed.attributes)) delete next[parsed.name]
    else next[parsed.name] = String(raw).trim()
  }
  return next
}

/**
 * cookie 串进 jar。**真机形状与离线夹具不一样**（2026-10-06 第一次真扫码暴露）：
 * 网易 `check` 的 `body.cookie` 是包把若干条**完整 Set-Cookie 头**用 `'; '` 拼起来的
 * （`result.cookie.join(';')`），所以按 `;` 切出来的既有真 cookie（`MUSIC_U=…`），
 * 也有属性段（`Max-Age=…`、`Expires=Wed, 21 Oct 2026 …`、`Path=/`、`HttpOnly`、`Domain=…`）。
 * 第一版把属性段当成了 cookie 名 ⇒ jar 里混进 `Path`/`Max-Age` 这种假条目，条数虚报、
 * 回传时还会把属性当 cookie 发回去。**修法**：认出属性名，把它们并回上一条，再走 mergeSetCookie
 * ——删除语义（`Max-Age<=0` / 过期的 `Expires`）与合并语义因此只有一份实现。
 */
const COOKIE_ATTRIBUTES = /^(expires|max-age|domain|path|secure|httponly|samesite|partitioned)\b/i;

export function jarFromCookieString(header) {
  const entries = []
  for (const part of String(header ?? '').split(';')) {
    const segment = part.trim()
    if (!segment) continue
    // `HttpOnly` / `Secure` 这类没等号的属性段同样并回上一条，不然会被当成坏条目丢掉。
    if (entries.length && (COOKIE_ATTRIBUTES.test(segment) || !segment.includes('='))) {
      entries[entries.length - 1] = `${entries[entries.length - 1]}; ${segment}`
      continue
    }
    entries.push(segment)
  }
  return entries.reduce((jar, entry) => mergeSetCookie(jar, [entry]), {})
}

/** 回传给上游的 `Cookie:` 头：只带 name=value，属性是上游给我们的一次性说明，不带回去。 */
export function cookieHeaderFor(jar) {
  const pairs = []
  for (const raw of Object.values(jar ?? {})) {
    const pair = String(raw).split(';')[0].trim()
    if (pair.includes('=')) pairs.push(pair)
  }
  return pairs.join('; ')
}

/**
 * 形状脱敏（§7.2 的第一层）三条规则：
 *   ① `Set-Cookie:` 起的那一行**整行**遮掉——一行头里值可能很短（`sid=abc`），只按"长值"判会漏属性名以外的一切；
 *   ② JSON 形状 `"cookie": "长值"` 遮值——报错文本最爱把整个响应体吐出来；
 *   ③ `name=值` 且值 **≥12 个字符**才遮。这条线是一次显式决策，两个方向都有断言盯着：
 *      降到 4 会连 `code=803` 这种状态码一起遮（日志就没法读了），升到 16 会放过一批真实凭据值。
 * 诚实边界：**没键名的裸值这一层抓不到**（散文里的 `上游说：xxxx`），兜底是 store 的登记表（下面 `remember`）。
 * 它站在日志出口，所以自己不许抛：非字符串按空串处理。
 */
export function redact(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/set-cookie\s*:\s*[^\r\n]*/gi, 'set-cookie:[已脱敏]')
    .replace(/"(cookie|token|secret|password|api_?key|authorization|dsid|dfid|key)"\s*:\s*"[^"]{8,}"/gi, '"$1":"[已脱敏]"')
    .replace(/\b[A-Za-z][\w.-]{1,60}=[^\s;&"'`]{12,}/g, (match) => `${match.slice(0, match.indexOf('='))}=[已脱敏]`)
}

/** 会话分区的读写。`env` 与 `log` 都是注入件：自检不碰真实环境变量，也不把测试输出打进服务日志。 */
export function createOnlineSession({ dataDir, env = {}, log } = {}) {
  const dir = path.join(String(dataDir), SESSION_DIR_NAME)
  // 默认落点是 console：写成函数而不是保存 `console.log` 的引用，自检才能当场把它换掉。
  const emit = log ?? ((line) => console.log(line))
  const known = new Set()
  let permissionNoteShown = false

  const fileFor = (provider) => {
    const name = SESSION_FILES[provider]
    if (!name) throw new Error(`不认识这个会话名：${provider}`)
    return path.join(dir, name)
  }
  const assertOwned = (provider) => {
    if (!PARENT_OWNED.includes(provider)) {
      throw new Error(`${PROVIDER_LABEL[provider] ?? provider} 的登录态在桥内由那个包自己加密管理，父进程不读也不写它`)
    }
  }
  /** 把 jar 里每一个值（以及整条 raw）都登记进兜底表：报错文本最爱原样回显它见过的字符串。 */
  const remember = (jar) => {
    for (const raw of Object.values(jar ?? {})) {
      const entry = String(raw)
      known.add(entry)
      const eq = entry.indexOf('=')
      if (eq > 0 && entry.length - eq - 1 >= 8) known.add(entry.slice(eq + 1))
    }
  }
  /** 兜底层（§7.2 的第二层）：先按形状遮，再把本进程见过的每一个值逐个字面替换掉。 */
  const redactKnown = (text) => {
    let out = redact(text)
    for (const value of [...known].sort((a, b) => b.length - a.length)) {
      if (value.length >= 8) out = out.split(value).join('[已脱敏]')
    }
    return out
  }

  const read = async (provider) => {
    assertOwned(provider)
    const fromEnv = String(env[NETEASE_ENV_KEY] ?? '').trim()
    const sessionFile = fileFor(provider)
    let jar = {}
    let source = 'none'
    if (provider === 'netease' && fromEnv) {
      jar = jarFromCookieString(fromEnv)
      source = 'env'
    } else {
      try {
        const stored = JSON.parse(await fs.readFile(sessionFile, 'utf8'))
        jar = stored?.cookies ?? {}
        source = 'file'
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new Error(`读不出会话文件：${redactKnown(error?.message ?? error)}`)
      }
    }
    remember(jar)
    emit(`${PROVIDER_LABEL[provider]}登录态来源：${source === 'env' ? '环境变量' : source === 'file' ? '会话文件' : '无（匿名）'}`)
    return { provider, source, jar }
  }

  /** 原子写：tmp 以 0600 写 → rename（权限随 tmp 保留）。空 jar 等于退出，不留一份"空凭据"装样子。 */
  const write = async (provider, jar) => {
    assertOwned(provider)
    const entries = Object.keys(jar ?? {})
    if (!entries.length) return remove(provider)
    const sessionFile = fileFor(provider)
    const temporary = `${sessionFile}.${randomUUID()}.tmp`
    remember(jar)
    try {
      await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 })
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, updatedAt: Date.now(), cookies: jar }, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporary, sessionFile)
    } catch (error) {
      const reason = redactKnown(error?.message ?? String(error))
      emit(`在线会话写入失败（${PROVIDER_LABEL[provider]}）：${reason}`)
      throw new Error(`在线会话写入失败：${reason}`)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    if (process.platform === 'win32' && !permissionNoteShown) {
      permissionNoteShown = true
      emit('在线会话文件权限：Windows 上 0600 只映射只读位，不保证仅本用户可读（尽力项；请不要把数据目录放在共享盘上）')
    }
    return { provider, entries: entries.length }
  }

  const remove = async (provider) => {
    // 删除是**三家都要的退出动作**，所以它不受 `assertOwned` 限制（那条管的是"读与写内容"）；
    // 但只准删父进程认领的那三个文件，`qq-device` 是包自己的落点，父进程不碰。
    if (!['netease', 'kugou', 'qq'].includes(provider)) throw new Error(`${provider} 的会话文件不归父进程管，退出也不该由它来做`)
    const sessionFile = fileFor(provider)
    try {
      await fs.unlink(sessionFile)
      // 删除成功也要有一行日志（任务七查"netease.json 为什么消失"时发现：只有失败那一路 emit，
      // 成功是静默的 ⇒ 事后无从区分"用户点了退出"与"文件从来没存在过"。这一行不含任何凭据。）
      emit(`${PROVIDER_LABEL[provider]}会话文件已删除（本机登录态结束）`)
      return { provider, removed: true }
    } catch (error) {
      if (error?.code === 'ENOENT') return { provider, removed: false, alreadyGone: true, reason: '没有会话文件，已是退出态' }
      const reason = redactKnown(error?.message ?? String(error))
      emit(`在线会话退出失败（${PROVIDER_LABEL[provider]}）：${reason}`)
      return { provider, removed: false, reason }
    }
  }

  const exists = async (provider) => {
    try { await fs.stat(fileFor(provider)); return true } catch { return false }
  }

  /**
   * 对外（界面与 `/api/online/auth`）的登录状态：**键名白名单**，值只有来源种类、条数与时间。
   * 这是"凭据绝不进浏览器"在服务端的那一半——另一半是路由里根本不许把它塞进响应体（§7.1 的静态半）。
   * QQ 那一份只 stat 不读内容（读了就违反 §3 的分家）。
   */
  const describe = async () => {
    const neteaseFile = fileFor('netease')
    const envConfigured = Boolean(String(env[NETEASE_ENV_KEY] ?? '').trim())
    let netease = { source: envConfigured ? 'env' : 'none', entries: 0, updatedAt: null, envConfigured }
    if (envConfigured) {
      netease.entries = Object.keys(jarFromCookieString(String(env[NETEASE_ENV_KEY]))).length
    } else {
      try {
        const stored = JSON.parse(await fs.readFile(neteaseFile, 'utf8'))
        netease = { source: 'file', entries: Object.keys(stored?.cookies ?? {}).length, updatedAt: Number(stored?.updatedAt) || null, envConfigured }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new Error(`读不出会话文件：${redactKnown(error?.message ?? error)}`)
      }
    }
    const qq = await statQuietly(fileFor('qq'))
    // 酷狗那份只有磁盘这一条来源：**没有**给它开环境变量的口子（QQ 那一路同理）。
    // 新开一条凭据输入路径要有理由，而这里的理由不成立——它是扫码来的，不是用户配来的。
    let kugou = { source: 'none', entries: 0, updatedAt: null, envConfigured: false }
    try {
      const stored = JSON.parse(await fs.readFile(fileFor('kugou'), 'utf8'))
      kugou = { source: 'file', entries: Object.keys(stored?.cookies ?? {}).length, updatedAt: Number(stored?.updatedAt) || null, envConfigured: false }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`读不出会话文件：${redactKnown(error?.message ?? error)}`)
    }
    return {
      providers: {
        netease,
        kugou,
        qq: { source: qq ? 'file' : 'none', entries: null, updatedAt: qq },
      },
    }
  }

  /** 只取 mtime：存在就报时间，不存在就 null。内容一个字节都不读。 */
  const statQuietly = async (file) => {
    try { return (await fs.stat(file)).mtimeMs } catch { return null }
  }

  /**
   * QQ 的密封密钥：env 先于磁盘（与网易那一份同一个优先级规矩，理由也同一条——
   * "我在 shell 里设了值"这件事不能静默不生效）。env 没给就在分区里生成一份随机密钥并落盘（0600）。
   *
   * 🔴 如实登记这份文件的性质，别把它写成"等于系统密钥链"：**密钥与它保护的密文在同一个目录**，
   * 这挡得住随手翻文件的人，挡不住能读这个用户文件的攻击者。它的价值是"重启之后登录还在"
   * 与"密钥不进代码、不进仓库"，不是"加密即安全"。将来接 OS 密钥服务只替换这一处的来源，不动其余设计。
   */
  const secretFor = async (provider = 'qq') => {
    if (provider !== 'qq') throw new Error(`${provider} 没有需要单独保管的密封密钥`)
    const fromEnv = String(env[QQ_SECRET_ENV_KEY] ?? '').trim()
    if (fromEnv.length >= 16) {
      emit('QQ 会话密钥来源：环境变量');
      return { secret: fromEnv, source: 'env' }
    }
    const sessionFile = fileFor('qq-secret')
    try {
      const stored = JSON.parse(await fs.readFile(sessionFile, 'utf8'))
      if (typeof stored?.secret === 'string' && stored.secret.length >= 16) {
        emit('QQ 会话密钥来源：分区内密钥文件（与密文同目录，只挡随手翻文件的人）');
        return { secret: stored.secret, source: 'file' }
      }
      emit('QQ 会话密钥文件内容不合法，重新生成一份（旧文件不删：里面可能还有别人在用的东西）');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`读不出 QQ 会话密钥：${redactKnown(error?.message ?? error)}`)
    }
    const secret = randomBytes(32).toString('base64')
    const temporary = `${sessionFile}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 })
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, createdAt: Date.now(), secret }, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporary, sessionFile)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    emit('QQ 会话密钥来源：新生成的分区内密钥文件（0600，尽力项）');
    return { secret, source: 'generated' }
  }

  /**
   * QQ 的**密封会话**（Task D）。与网易那份的区别写死在形状里：这里存的是一段不透明密文
   * （包 `/serverless` 那条路把会话与设备状态密封在 `unikey`/`session` 串里，包自己不往磁盘写），
   * 父进程只是它的搬运工。为什么父进程还持有密封密钥（`secretFor('qq')`）：这个运行时没有
   * "进程内保管凭据"的地方，密钥不给它，登录路由直接回 501，且重启即丢登录。
   * ⇒ 与 §3 的"凭据留桥内"相比这是一处**有据可依的偏离**，记在 run log 的待复核项里，不假装同一条路。
   */
  const writeSealed = async (provider, session) => {
    if (provider !== 'qq') throw new Error(`${provider} 没有密封会话这一档`)
    const value = typeof session === 'string' ? session.trim() : ''
    if (!value) return remove(provider)
    const sessionFile = fileFor('qq')
    const temporary = `${sessionFile}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 })
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, sealed: true, updatedAt: Date.now(), session: value }, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporary, sessionFile)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    // 密文本体也登记进兜底表：它一旦出现在报错里，同样不该被原样打进日志。
    known.add(value.slice(0, 200));
    return { provider, sealed: true };
  }

  const readSealed = async (provider = 'qq') => {
    if (provider !== 'qq') throw new Error(`${provider} 没有密封会话这一档`)
    const sessionFile = fileFor('qq')
    try {
      const stored = JSON.parse(await fs.readFile(sessionFile, 'utf8'))
      if (stored?.sealed !== true || typeof stored.session !== 'string' || !stored.session) {
        return { provider, session: '', source: 'none', reason: '会话文件里不是一段密封会话（拒绝当凭据用）' }
      }
      known.add(stored.session.slice(0, 200));
      emit('QQ 登录态来源：分区内密封会话');
      return { provider, session: stored.session, source: 'file' }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`读不出密封会话：${redactKnown(error?.message ?? error)}`)
      emit('QQ 登录态来源：无（未登录）');
      return { provider, session: '', source: 'none' }
    }
  }

  /**
   * 酷狗设备身份的读写（R154）。三条讲究：
   *   · **键名白名单 + 形状判据**：只收 `guid` / `mid` / `dfid` 三格，且各按各的形状认
   *     （认不过就整格不收）。这份数据来自桥（我们自己的代码），但写盘的口子不因此放松——
   *     与 R135 那条"绝不把外部送来的任意字符串当地址写进数据文件"同一条纪律；
   *   · **guid 由父进程第一次要的时候生成一把**（`randomUUID()`）并落盘，之后每次都用同一把：
   *     换一把就等于换一台机器，上游的行为会跟着变（而原版那条中间件也是"一台机器一把稳定 guid"）；
   *   · **mid 不在这里算**：算法在包里（`calculateMid`），只有桥能算，父进程只是把它存下来免得每次重算。
   * 退出登录**不动这一份**（它不是账号数据），删除只在"要重新生成一台设备"时发生，而那件事本批没有入口。
   */
  const KUGOU_DEVICE_SHAPES = {
    guid: /^[0-9a-fA-F-]{8,64}$/,
    mid: /^\d{6,64}$/,
    dfid: /^[0-9A-Za-z_-]{0,64}$/,
  }
  const readKugouDevice = async () => {
    const sessionFile = fileFor('kugou-device')
    try {
      const stored = JSON.parse(await fs.readFile(sessionFile, 'utf8'))
      const out = { source: 'file', guid: '', mid: '', dfid: '', rejected: [] }
      for (const key of Object.keys(KUGOU_DEVICE_SHAPES)) {
        const value = String(stored?.[key] ?? '')
        if (!value) continue
        if (KUGOU_DEVICE_SHAPES[key].test(value)) out[key] = value
        else out.rejected.push(key)          // 形状不对就一格都不收，但仍然记着"这里有过不合形状的东西"
      }
      return out
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`读不出酷狗设备身份：${redactKnown(error?.message ?? error)}`)
      return { source: 'none', guid: '', mid: '', dfid: '', rejected: [] }
    }
  }
  const writeKugouDevice = async ({ guid, mid, dfid }) => {
    const sessionFile = fileFor('kugou-device')
    const temporary = `${sessionFile}.${randomUUID()}.tmp`
    const payload = { version: 1, updatedAt: Date.now(), guid: String(guid ?? ''), mid: String(mid ?? ''), dfid: String(dfid ?? '') }
    try {
      await fs.mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 })
      await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(temporary, sessionFile)
    } catch (error) {
      const reason = redactKnown(error?.message ?? String(error))
      emit(`酷狗设备身份写入失败：${reason}`)
      throw new Error(`酷狗设备身份写入失败：${reason}`)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return payload
  }
  /** 取（没有就先生成一把 guid）。桥要的 `device` 由这里出，桥自己不写任何文件。 */
  const ensureKugouDevice = async () => {
    const current = await readKugouDevice()
    if (current.guid) return current
    const written = await writeKugouDevice({ guid: randomUUID(), mid: current.mid, dfid: current.dfid })
    emit('酷狗设备标识：本机第一次生成一把稳定的 guid（不是注册出来的设备号；默认不向酷狗注册设备）')
    return { ...written, source: 'generated', rejected: [] }
  }
  /** 桥算出/换到的那一份存回去（只收形状对的；没有变化就不写盘）。 */
  const saveKugouDevice = async (device = {}) => {
    const current = await readKugouDevice()
    const next = {
      guid: KUGOU_DEVICE_SHAPES.guid.test(String(device.guid ?? '')) ? String(device.guid) : current.guid,
      mid: KUGOU_DEVICE_SHAPES.mid.test(String(device.mid ?? '')) ? String(device.mid) : current.mid,
      dfid: KUGOU_DEVICE_SHAPES.dfid.test(String(device.dfid ?? '')) ? String(device.dfid) : current.dfid,
    }
    if (next.guid === current.guid && next.mid === current.mid && next.dfid === current.dfid) return { ...current, ...next, unchanged: true }
    const written = await writeKugouDevice(next)
    return { ...written, source: 'file', rejected: [] }
  }

  return { dir, owned: [...PARENT_OWNED], fileFor, read, write, remove, exists, describe, secretFor, writeSealed, readSealed, readKugouDevice, ensureKugouDevice, saveKugouDevice, redact: redactKnown }
}
