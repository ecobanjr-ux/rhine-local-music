import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { MusicLibraryStore, safeRootList, ONLINE_DEFAULTS, ONLINE_SWITCHES } from './music-library.mjs'
import { createOnlineLyricMatcher, onlineLyricQueryFrom, lyricIdentityFingerprint } from './online-lyrics.mjs'
import { createLyricClaims, claimEntryFrom, createClaimTokenRegistry, CLAIM_TOKEN_PATTERN } from './lyric-claims.mjs'
import { createBridgeClient } from './online-bridge-client.mjs'
import { recordEgress, auditSnapshot, resetAudit } from './online-audit.mjs'
import { guardedStreamFetch, guardedShortLinkFetch, sanitizeEgressReasons } from './online-guard.mjs'
import { createAudioSourceResolver, audioSourceMime, AUDIO_PROVIDERS, onlineAudioIdentityFrom } from './online-audio-source.mjs'
import { createOnlineSearcher } from './online-search.mjs'
import { appendEntriesToText, artistShelfRow, onlineArtistGroups, parsePlaylistText, playlistShelfRow, readPlaylistProvenance, replaceEntryInText, serializePlaylist, SHELF_PLAYLIST_LIMIT, slugOf } from './playlists.mjs'
import { identityFromStreamUrl, onlineIdentityPair } from './bridge/providers/normalize.mjs'
import { createPlaylistMatcher, createMatchPreference, coverFallbackOk } from './playlist-match.mjs'
import { createPlaylistImporter } from './playlist-import.mjs'
import { createQqPlaylistSource } from './playlist-qq.mjs'
import { createKugouShareSource } from './playlist-kugou-share.mjs'
import { createPlayReporter, onlineReportTargetOf } from './online-report.mjs'
// R165（任务十一）：账号歌单写侧那道"只认这台机器刚列出来过的 id"的闸。
import { createIssuedPlaylistRegistry } from './playlist-write-registry.mjs'
import { createOnlineSession, cookieHeaderFor } from './online-session.mjs'
import { createOnlineAuth, AUTH_POLL_MS, AUTH_PROVIDERS } from './online-auth.mjs'
import { createOnlineCoverProvider } from './online-covers.mjs'
import { createOnlineTrackCoverStore, TRACK_COVER_TOKEN_PATTERN } from './online-track-covers.mjs'
import { createFavoritesStore, favoriteKeyOf, favoriteView, MAX_FAVORITES } from './favorites.mjs'

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.lrc': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.ttml': 'application/ttml+xml; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  // `reason` / `error` 两格过一遍出网文案归一层（P0：内部标识符曾原样透到界面）。
  // 放在唯一的响应出口而不是各路由各写一遍：漏一处就等于没做，而下一处新增的转发出网原因
  // 没人会想起来再补一次。其余键与出网审计那些行逐字不动。
  response.end(JSON.stringify(sanitizeEgressReasons(data)))
}

/**
 * 桥转发的两类出网记录并进同一张表（R75 的补偿）。两条的来源不同，所以**按行自带的 via 分叉**：
 *   · `via='backend'`：桥调用第三方库的那一跳。库内部再发什么我们包不住，但"被叫了几次、
 *     每次多久、成没成"摊得开；host 是该路由报回的 provider 标识，缺省归到 online-bridge。
 *   · `via='guard'`：桥自己经 guardedFetch 发的（Task D 的 QQ 登录就是这一类，sink 见 online-bridge.mjs）。
 *     这些行在桥那边已经归一化过，父进程**一个字都不许改写**——把一次 429 改写成 200
 *     就是把审计做成广告（设计稿 §4.2 在 Task A 登记的那处"稿子与实际不符"，Task D 补上）。
 * 单独导出是为了让这两条分叉能被离线自检直接打到（不导出就只能起一个真桥，那就退化成静态断言）。
 */
export function recordBridgeAudit(event, record = recordEgress) {
  if (event?.via === 'guard') {
    record({ host: event.host, kind: event.kind, status: event.status, bytes: event.bytes, ms: event.ms, via: 'guard' })
    return
  }
  record({ host: event.host ?? 'online-bridge', kind: event.kind ?? 'bridge', status: event.ok ? 200 : 0, bytes: event.bytes ?? 0, ms: event.ms ?? 0, via: 'backend' })
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error('请使用 application/json 请求体'), { status: 415 })
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > 128 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 请求体必须是对象')
  return value
}

/** Returns null for no Range; false for invalid or unsatisfiable single ranges. */
export function parseRange(header, size) {
  if (header === undefined) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false
    end = Math.min(end, size - 1)
  }
  return { start, end }
}

async function serveFile(request, response, descriptor, { cache = 'no-cache' } = {}) {
  const [actualPath, actualRoot] = await Promise.all([fs.realpath(descriptor.path), fs.realpath(descriptor.allowedRoot)])
  const relative = path.relative(actualRoot, actualPath)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('文件已移出配置的音乐目录'), { status: 403 })
  const stat = await fs.stat(actualPath)
  if (!stat.isFile()) throw Object.assign(new Error('文件不存在'), { status: 404 })
  const range = parseRange(request.headers.range, stat.size)
  const headers = {
    'Content-Type': descriptor.mime ?? MIME[path.extname(actualPath).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes', 'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(), 'X-Content-Type-Options': 'nosniff',
  }
  if (range === false) {
    response.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 })
    response.end()
    return
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    headers['Content-Length'] = range.end - range.start + 1
  } else headers['Content-Length'] = stat.size
  response.writeHead(range ? 206 : 200, headers)
  if (request.method === 'HEAD' || stat.size === 0) return response.end()
  const stream = createReadStream(actualPath, range ?? {})
  stream.on('error', () => response.destroy())
  response.on('close', () => stream.destroy())
  stream.pipe(response)
}

export async function createMusicServer({
  dataDir = process.env.MUSIC_DATA_DIR ?? path.join(PROJECT_DIR, '..', 'music-data-v3'),
  distDir = path.join(PROJECT_DIR, 'dist'),
  defaultRoots = process.env.MUSIC_ROOTS ? process.env.MUSIC_ROOTS.split(path.delimiter).filter(Boolean) : [],
  store: providedStore,
  autoScan = true,
  // 自检注入点：路由层测试传假匹配器，避免为了验证挂点而真的解析 DNS。
  onlineLyricsMatcher: providedMatcher,
  // 自检注入点（R144）：歌词认领记录。不给就是真机那份（`<dataDir>/lyric-claims.json`）。
  lyricClaims: providedLyricClaims,
  // 自检注入点（R148 · Q20）：近候选的认领令牌注册表（内存，零写盘）。
  lyricClaimTokens: providedLyricClaimTokens,
  // 自检注入点（第五期 Task 3）：桥客户端可换成假的，这样"崩溃隔离 / 关着零 spawn"能在离线自检里判定，
  // 不必靠真的杀进程赌时序。生产路径不传 ⇒ 用 store.config 建一个真的。
  bridgeClient: providedBridge,
  // 自检注入点（第五期 Task 6）：音源取址与上游串流各留一个口子——前者省掉真出网，
  // 后者让 Range 的四种回法（206 单段 / suffix / 上游 200 整段 / 416）能在离线判定。
  onlineAudioSource: providedAudioSource,
  onlineStreamFetcher: providedStreamFetcher,
  // 自检注入点（第五期 Task 7）：假搜索器，用来离线判定"单源失败不拖垮整次"与窄契约。
  onlineSearcher: providedSearcher,
  // 自检注入点（第五期 Task 9）：假匹配器，用来离线判定"第二次不再出网"。
  playlistMatcher: providedPlaylistMatcher,
  // 自检注入点（第五期 Task 10）：假导入器，用来离线判定"三认"与"截断可见"。
  playlistImporter: providedImporter,
  // 自检注入点（R161 · 任务八）：假上报器，用来离线判定"缺省关时零请求"那四条隐私判据。
  playReporter: providedPlayReporter,
  // 自检注入点（M3-a Task C）：登录态的落盘面与状态机各留一个口子——
  // 前者让"凭据只进会话分区"能在一次性临时目录里真写一遍再验残留，后者让扫码的五个档位能离线走完。
  onlineSession: providedSession,
  onlineAuth: providedAuth,
  // 自检注入点（M3-c）：假封面提供者。它同时是"离线自检一个包都不发"的口子，
  // 也是"没有在线模块的部署"的正常形态（没有提供者 ⇒ 补图整轮跳过，不抛）。
  coverProvider: providedCoverProvider,
  // 自检注入点（看板 ⑨）：假的"在线曲目封面"注册表。不给就是真机那份（出网走 guardedTrackCoverFetch）。
  trackCoverProvider: providedTrackCovers,
  // 自检注入点（R130）：收藏存储。不给就是真机那份（`<dataDir>/favorites.json`）。
  favorites: providedFavorites,
} = {}) {
  // 在线封面补全（M3-c）在这里装配：曲库**不 import** online-covers（那边反过来 import 曲库的
  // `normalized`，import 只能有一个方向），所以提供者由装配层注进构造函数。
  const onlineCovers = providedCoverProvider ?? createOnlineCoverProvider({ log: (line) => console.log(line) })
  const store = providedStore ?? await new MusicLibraryStore({ dataDir, defaultRoots, coverProvider: onlineCovers }).init()
  // R130 收藏：必须排在 `store` 之后 —— 写在 `store` 声明之前会撞 TDZ
  // （M3-b 已被同一形状咬过一次：回调在注册那一刻同步跑，而声明还在下面）。
  const favorites = providedFavorites ?? createFavoritesStore({ dataDir: store.dataDir })
  // R135（Q12）：启动时跑一次键迁移（专辑不再参与键）。这一步是**可回放**的——第二次跑报告全零且不写盘，
  // 所以每次启动都可以调；报告写进服务日志：并掉了哪两条必须看得见，不许静默合并。
  // 注入的假 store 可以没有这个方法（自检里用不到），所以按"有就跑"处理。
  if (typeof favorites.migrate === 'function') {
    const moved = await Promise.resolve(favorites.migrate()).catch((error) => ({ error: String(error?.message ?? error) }))
    if (moved?.migrated || moved?.collisions?.length || moved?.unknown?.length || moved?.error) {
      console.log(`收藏键迁移：改写 ${moved.migrated ?? 0} 条 · 并掉 ${moved.collisions?.length ?? 0} 条 · 认不出 ${moved.unknown?.length ?? 0} 条${moved.error ? ` · 出错：${moved.error}` : ''}`)
      for (const one of moved.collisions ?? []) {
        console.log(`  并掉：《${one?.dropped?.title}》(addedAt ${one?.dropped?.addedAt}) → 留《${one?.kept?.title}》(addedAt ${one?.kept?.addedAt})`)
      }
      for (const one of moved.unknown ?? []) console.log(`  认不出的键，原样留着：《${one?.title}》`)
    }
  }
  // M3-a Task C：登录态文件先建——它是"谁知道凭据值"的那一方，所以桥的两条转发口（audit / note）
  // 都要在构造时就能引用它。session 的 dataDir 与曲库同一个根，于是它写盘的目标天然落在
  // R74 的既有判据里（`sessionFile` / `temporary` 两个调用形状），不放宽白名单。
  const onlineSession = providedSession ?? createOnlineSession({ dataDir: store.dataDir, env: process.env, log: (line) => console.log(line) })
  // 开关判定 → 方法判定 → 请求体校验 → 才可能碰桥：这条次序沿用 R61，新增的在线路由都排在最前面，
  // 保证"关着零暴露"（既不 spawn 子进程，也不因为读了请求体而改变行为）。
  const bridge = providedBridge ?? createBridgeClient({
    // 必须是 getter：`store.updateConfig()` 是**整个替换** store.config 对象，抓引用会让客户端一直读
    // 建服务那一刻的旧开关——真实机器上实测：四张开关全关之后 status 仍报后端齐全、还可能把桥再拉起来。
    getConfig: () => store.config,
    dataDir: store.dataDir,
    log: (line) => console.log(line),
    onAudit: (event) => recordBridgeAudit(event),
    // 桥内的人话备注（"QQ 的长连接没建立起来"一类）进服务日志前过一层脱敏：
    // 桥不知道凭据长什么样，知道的是上面那份 session——所以脱敏必须在父进程这一侧做。
    onNote: (line) => console.log(onlineSession.redact(line)),
  })
  // 匹配器要拿到桥：网易与酷狗两档经它（Task 5）。放在桥之后构造，且只在生产路径建真匹配器——
  // 自检传 onlineLyricsMatcher 注入件时不会碰桥。
  const onlineLyricsMatcher = providedMatcher ?? createOnlineLyricMatcher({ bridge })
  // R144 · 歌词「手动认领」：单独一份本机 JSON（只存身份，绝不存歌词正文），
  // 自动挡的阈值 / 正负缓存 / 逐字优先一个字都不动。
  const onlineLyricClaims = providedLyricClaims ?? createLyricClaims({ dataDir: store.dataDir, log: (line) => console.log(line) })
  /**
   * 一首先查认领、再走自动挡。**两条路只这一处**（在路由里各写一遍就会有一处漏改）。
   *
   * 认领取不到词时（上游把这首歌删了、令牌过期）不写死在认领这一条上：如实带一句 `claimFailed`，
   * 再回落到自动挡重新问一次——立场与 R108 音源回落同一条：**不许"因为人判过反而没词"**。
   */
  const lyricAnswerFor = async (song, { retry = false } = {}) => {
    const claim = typeof onlineLyricsMatcher.fetchClaimed === 'function'
      ? await onlineLyricClaims.get(lyricIdentityFingerprint(song))
      : null                                                   // 注入的假匹配器没有这一格 ⇒ 按"没有认领"走
    if (!claim) return await onlineLyricsMatcher.match(song, { force: retry })
    const claimed = await onlineLyricsMatcher.fetchClaimed(song, claim)
    if (claimed?.matched) return { ...claimed, claim }
    const fallback = await onlineLyricsMatcher.match(song, { force: true })
    return { ...fallback, claim, claimFailed: claimed?.reason ?? '认领的那一首没有取到歌词' }
  }
  // R148（Q20）· 近候选里的 `accessKey` 是"能取那首歌歌词的每首令牌"，不该出现在浏览器与 DOM 里。
  // 出网口不变、判据不变，只在**发给浏览器之前**把它换成不透明 token（与封面 R116 同构）。
  const onlineLyricClaimTokens = providedLyricClaimTokens ?? createClaimTokenRegistry()
  /**
   * 服务端内部形状 → 发给浏览器的形状。两件事：
   *   ① 每条近候选签一个 `claimToken`，并把 `accessKey` 从对象里去掉（**不是置空，是不带这个键**）；
   *   ② 已存在的那条认领记录同样剥掉 `accessKey`（它存在磁盘上就够用了，界面只需要知道"是哪一首"）。
   * 这一层是这条链上唯一的出口转换，别在路由里各写一遍。
   */
  const publicLyricAnswer = (answer) => ({
    ...answer,
    ...Array.isArray(answer?.near)
      ? { near: answer.near.map(({ accessKey, ...rest }) => ({ ...rest, claimToken: onlineLyricClaimTokens.issue({ accessKey, ...rest }) })) }   // eslint-disable-line no-unused-vars
      : {},
    ...(answer?.claim ? { claim: (({ accessKey, ...rest }) => rest)(answer.claim) } : {}),   // eslint-disable-line no-unused-vars
  })
  // 音源取址（Task 6）：网易经桥、QQ 经 guardedFetch 自写 fcg、酷狗如实拒绝。取到的签名 URL 只在内存缓存。
  // M3-b：带上登录态——登录态从会话分区读（没有就是匿名），缓存键里有它的短摘要，
  // 所以"登录后还吃匿名 30 秒地址"这件事在结构上就不成立。
  // R108：两家的形状不同。网易是一段 cookie 头；QQ 是"密封 token + 解封用的密钥"两样，
  // 且**只有本机已经有 QQ 会话时才去要密钥**——`secretFor` 在没有的那一档会新生成一份并落盘，
  // 让"随手播一首 QQ 歌"顺手写出一个密钥文件是不该发生的副作用（登录时才需要它）。
  // R159（任务六）：账号歌单与取址要的是**同一份凭据** ⇒ 抽成一个函数，两个消费者都调它。
  // （原先这份写在 audioSource 的选项里；出现第二个消费者就是抽出来的时候，不是抄第二份的时候。）
  const credentialsFor = async (provider) => {
    // R154（任务一）：酷狗除了账号那对 cookie，还要**设备身份**一起带（一手实测：`song_url` 要
    // 登录态 + mid + 显式的空 dfid 三者齐了才给整首地址；少任何一样都不是"降级"而是"取不到"）。
    // guid/mid 由父进程持有（`online-session` 的酷狗分区），桥每次借用、自己不落盘（R97 口径不变）。
    if (provider === 'kugou') {
      const cookie = cookieHeaderFor((await onlineSession.read('kugou')).jar)
      // **没有登录态就不去备那把 guid**：真机量到"列一次账号歌单"就在数据目录写下了 kugou-device.json，
      // 而这一问根本不出网——没登录时留一个设备身份文件是"随手一问就产生副作用"
      // （与 R108 对 QQ 密钥文件那条同一立场：只有真要鉴权的那一跳才去要密钥）。
      if (!cookie) return { cookie: '' }
      const device = await onlineSession.ensureKugouDevice()
      return { cookie, device: { guid: device.guid, mid: device.mid, dfid: device.dfid, deviceIdentity: store.config.kugouDeviceIdentity === true } }
    }
    if (provider !== 'qq') return { cookie: cookieHeaderFor((await onlineSession.read(provider)).jar) }
    const sealed = await onlineSession.readSealed('qq')
    if (!sealed.session) return {}
    return { token: sealed.session, secret: (await onlineSession.secretFor('qq')).secret }
  }
  const audioSource = providedAudioSource ?? createAudioSourceResolver({
    bridge,
    credentialsFor,
    saveKugouDevice: (device) => onlineSession.saveKugouDevice(device),
    // R141 回落用的检索口：取**服务端内部那一份**（`searchEntries`），因为 QQ 候选要 `mediaMid`
    // 才解得出地址（R119 那一课的同一个坑：拿发给前端的形状再喂回去会少字段）。
    // 闭包引用下面才声明的 onlineSearcher 是安全的：这里只记下函数，真正调用发生在请求里。
    search: (query) => onlineSearcher.searchEntries(query),
  })
  const streamUpstream = providedStreamFetcher ?? guardedStreamFetch
  // R161（任务八）· 播放上报：**缺省关**，四条隐私判据在 `online-report.mjs` 里（关着 / 只报在线曲目 /
  // 听满 30 秒 / 一轮只报一次）。这一层不落任何盘——这台机器上**不建播放历史文件**，
  // 那正是本件最不该顺手造出来的东西；每次上报（成或败）只往服务日志写一行。
  const playReporter = providedPlayReporter ?? createPlayReporter({
    bridge,
    credentialsFor,
    log: (line) => console.log(line),
  })
  // R165（任务十一）· 账号歌单写侧那道闸的登记表：**只在内存**、带 TTL、重启就要重新列一次。
  // 它存在的理由是"只往用户自己的账号里写"这条红线不能只靠 id 形状挡（别人的公开歌单形状完全合法）。
  const issuedAccountPlaylists = createIssuedPlaylistRegistry()
  // 在线搜索（Task 7）：多源并发 + 逐源失败隔离。注入件让"单源坏了其余照常"能在离线判定。
  // 在线曲目封面（看板 ⑨ 追加）：注册表 + 取图。写盘仍然只有曲库那一个出处，
  // 所以这里注入的是 store.cacheArtworkBytes，本模块自己零写盘（R74 扫描面判的就是这件事）。
  const onlineTrackCovers = providedTrackCovers ?? createOnlineTrackCoverStore({
    write: (bytes, mime) => store.cacheArtworkBytes(bytes, mime),
    enabled: () => store.config.online?.covers === true,
    log: (line) => console.log(line),
  })

  const onlineSearcher = providedSearcher ?? createOnlineSearcher({
    bridge, covers: onlineTrackCovers,
    // R154：酷狗那一站的门面（没登录态时它在**出网之前**就停下）。设备身份与凭据都从同一处读，
    // 不在搜索层再开一份来源——两处读凭据迟早会漂（与 R101 的"登录态只有一个出处"同一条理由）。
    kugouSession: async () => {
      const cookie = cookieHeaderFor((await onlineSession.read('kugou')).jar)
      if (!cookie) return null
      const device = await onlineSession.ensureKugouDevice()
      return { cookie, device: { guid: device.guid, mid: device.mid, dfid: device.dfid, deviceIdentity: store.config.kugouDeviceIdentity === true } }
    },
  })
  /**
   * R135（Q11）：收藏清单里那条第三方封面地址**只在服务端这一侧**。两个方向的换算都收在这两行里：
   *   · 进来（收藏那一刻）：浏览器只可能给我们同源 `/api/online/artwork/<token>`，
   *     拿它去注册表反解回原地址 ⇒ 反解不出（没登记过、进程重启过、被淘了）就什么都不存，
   *     **绝不把前端送来的任意字符串当地址写进数据文件**；
   *   · 出去（任何一份清单）：`coverRef` 一律剥掉，界面要封面只能拿回同源 token 地址。
   * 与 sidecar 同口径：本机数据文件里可以有第三方地址，HTTP 响应里不可以有。
   */
  const coverRefFromCoverUrl = (raw) => {
    const matched = /^\/api\/online\/artwork\/([a-f0-9]{16})$/.exec(String(raw ?? ''))
    return matched ? onlineTrackCovers.coverRefFor(matched[1]) ?? '' : ''
  }
  const publicFavoriteItem = ({ coverRef, ...rest }) => rest   // eslint-disable-line no-unused-vars
  // 歌单逐条匹配（Task 9）：用的就是上面那份搜索门面 + sidecar 缓存。注入件只为离线判定。
  // 门面取 `searchEntries` 而不是 `search`（看板 95fe081 跳①）：匹配要把第三方封面地址存进 sidecar（服务端数据文件），
  // 而 `search()` 出去的是发给浏览器的契约形状，那个地址在那一步已经被换成同源地址了。
  const playlistMatcher = providedPlaylistMatcher ?? createPlaylistMatcher({ store: store.playlists, search: (query) => onlineSearcher.searchEntries(query), covers: onlineTrackCovers,
    // R143（任务四）+ R156（任务三）：偏好门面的**本体在 `createMatchPreference`**，那里三条性质各有行为断言。
    // 原先这段写在装配处，于是"开关关着时不摸凭据文件""两条开关各管各的""哪几家算数只有一个出处"
    // 三件事只能靠读源码文本判——变异验证 P16 就是这么漏的：删掉早退那一档的 `preferSamePlatform`
    // 没有任何测试会红，而"登录开关关着 ⇒ 同平台那条也跟着失效"正是要防的事。
    // `readConfig` 传的是**函数**不是快照：用户随时在设置里改这两把开关，每次匹配都读当下那份。
    preference: createMatchPreference({
      readConfig: () => store.config,
      describeSessions: () => onlineSession.describe(),
      playableProviders: AUDIO_PROVIDERS,   // 「哪些家算数」=「哪些家能播」，读那份表，不在这里抄第二份名单
    }),
  })
  // 粘贴导入（Task 10）：三认（链接 / 纯 id / 文本），截断必须可见。
  // QQ 那一家经 `createQqPlaylistSource()`（R138）而不是经桥——桥里没有它的后端，
  // 而自写请求走 `guardedFetch` 才进得出网审计（与歌词/搜索/音源同一条口径）。
  // 构造本身不出网（只有 call 才发），所以在线开关关着时这里也只是一个没人调用的门面。
  const playlistImporter = providedImporter ?? createPlaylistImporter({
    bridge, store: store.playlists, qq: createQqPlaylistSource(),
    // R158（任务五）：酷狗**手机分享页**那一路（只导首屏）。构造本身不出网，只有 `load` 才发那一跳；
    // 地址由 token 拼出来，用户贴进来的 URL 主机/路径一律不作数 ⇒ 这一路没有"拿外部地址去请求"的能力。
    share: createKugouShareSource(),
    // R155（任务二）：酷狗"口令短链"那一跳。**把关只有一道**——上面那条路由在 `online.search` 关着时
    // 直接 404，所以这里不再抄一遍同一判据（变异验证 T8 报"改了这里没有任何测试会红"，
    // 那就是死代码的形状：本仓的规矩是删掉它，不是留着当装饰）。
    // 这一跳只回 `Location` 一个字符串：导入器拿不到 fetcher，也就没法拿那条外部地址再去请求。
    resolveShortLink: async (url) => (await guardedShortLinkFetch(url)).redirectLocation ?? '',
  })
  const onlineAuth = providedAuth ?? createOnlineAuth({ bridge, session: onlineSession, log: (line) => console.log(line) })
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    try {
      const host = new URL(`http://${request.headers.host ?? ''}`)
      if (!LOOPBACK.has(host.hostname)) return json(response, 403, { error: '本服务仅接受 localhost 请求' })
      const url = new URL(request.url, host)
      if (request.headers.origin && request.headers.origin !== host.origin) return json(response, 403, { error: '不接受跨站点访问本地曲库' })
      const route = decodeURIComponent(url.pathname)
      if (route.includes('\0') || route.includes('\\')) return json(response, 400, { error: '无效路径' })
      const get = request.method === 'GET' || request.method === 'HEAD'
      if (route === '/api/health' && get) return json(response, 200, { service: 'rhine-local-music', projectDir: PROJECT_DIR, pid: process.pid })
      if (route === '/api/library' && get) {
        // A user or Codex can edit genre-rules.json while the player is running.
        await store.reloadRules()
        return json(response, 200, store.snapshot())
      }
      if (route === '/api/library/scan' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (store.scanPromise) return json(response, 202, store.snapshot())
        const roots = value.roots === undefined ? undefined : safeRootList(value.roots)
        // 6.6：重扫意味着标签可能变了（改了标题、补上伴生歌词文件），"上次没配到"必须作废。
        // 只清进程内缓存，不发任何请求；在线能力关闭时这两个 Map 本来就是空的。
        onlineLyricsMatcher.clearCache?.()
        void store.scan({ roots }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/genre-rules' && get) {
        await store.reloadRules()
        return json(response, 200, store.rules)
      }
      if (route === '/api/genre-rules' && request.method === 'POST') return json(response, 200, await store.updateRules(await bodyJson(request)))
      // R209 · 只读：数据目录在哪（设置面板那一行用它）。**单独一个路由，不塞进 `/api/config`** ——
      // 那个路由是**可写**的（面板保存设置就 POST 它），把算出来的路径混进去有被回写进 `config.json` 的风险。
      if (route === '/api/data-dir' && get) {
        return json(response, 200, {
          path: dataDir,
          // 这一档是谁赢的：壳按打包态补的 / 用户自己设的环境变量 / 服务自己的默认（开发形态直启）
          source: process.env.RHINE_DATA_DIR_SOURCE ?? 'server-default',
        })
      }
      if (['/api/config', '/api/library/config'].includes(route)) {
        // `onlineLyrics` 是 R77 那张新表的**镜像**（由 online.lyrics 现算，不存第二份）：
        // 设置面板今天只发旧字段，一个版本期内它在请求与响应两侧都继续可用。
        if (get) return json(response, 200, { ...store.config, onlineLyrics: { enabled: store.config.online?.lyrics === true }, musicBrainzConfigured: !!store.musicBrainzContact })
        if (request.method === 'POST') {
          const value = await bodyJson(request)
          if (value.roots !== undefined && store.scanPromise) return json(response, 409, { error: '正在扫描，请完成后再更改根目录' })
          // 歌单目录换了（F3）：先把老目录记下来，切完再把歌单与 sidecar **复制**过去。
          // 复制不移动：用户可能还在编辑器里开着老路径，删源会让"改个目录"变成不可逆的数据操作。
          // `?.` 是因为自检里有不带歌单实体的假 store（`fakeStore`），别让响应拼接收不住。
          const previousPlaylistDir = value.playlistDir !== undefined ? store.playlists?.dir : null
          let playlistMove = null
          // 镜像由 store 附在返回值上（真表只有 online 一份），这里不再二次推导。
          let saved
          try {
            saved = await store.updateConfig(value)
            if (previousPlaylistDir && store.playlists.dir !== previousPlaylistDir) {
              playlistMove = await store.playlists.copyEntriesFrom(previousPlaylistDir)
            }
          } catch (error) {
            return json(response, 400, { error: error?.message ?? String(error) })
          }
          // 开关一变就要同步桥的生死：全关 ⇒ 关掉子进程（"关着零暴露"要兑现到进程层面，
          // 不是只在调用前挡一下）；从全关再打开 ⇒ 重新起一个，顺带重置退避计数。
          const anyOnlineOn = ONLINE_SWITCHES.some((key) => saved.online?.[key] !== false)
          if (!anyOnlineOn) {
            await bridge.shutdown()
            // 全关 ⇒ 审计表一起清空：关掉之后面板里不该再留着"上次打开时打了谁"的旧行，
            // 否则"关着零暴露"在用户看到的界面上不成立。
            resetAudit()
          } else if (bridge.status().phase === 'off') bridge.ensure()
          // 面板要显示的是"当前真正在用的目录"（配置里那一项为 null 表示默认，界面不该显示 null）。
          return json(response, 200, {
            ...saved,
            ...(store.playlists ? { playlistDir: store.playlists.dir } : {}),
            musicBrainzConfigured: !!store.musicBrainzContact,
            ...(playlistMove ? { playlistMove } : {}),
          })
        }
      }
      if (route === '/api/library/enrich' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (!store.musicBrainzContact) return json(response, 400, { error: '在线资料库尚未配置：请在资料库设置填写自己的联系邮箱或项目网址。音乐仍可本地播放。' })
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        void store.enrich({ albumIds: value.albumIds, force: true }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/library/introductions' && request.method === 'POST') {
        const value = await bodyJson(request)
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
        void store.updateIntroductions({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/online/lyrics/match') {
        // 开关判定放在任何业务逻辑之前：关闭时不查索引、不出网（联网默认打开，但可以 here 一键关掉）。
        // 匹配器本身是纯构造（不开定时器、不建连接），关闭时它只是空转在闭包里。
        if (!store.config.online?.lyrics) return json(response, 404, { error: '在线歌词匹配已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '在线歌词匹配只接受 POST' })
        const value = await bodyJson(request)
        if (typeof value.trackId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.trackId)) return json(response, 400, { error: 'trackId 无效' })
        // R144：`retry` 只决定"绕不绕内存缓存"，不决定判据——阈值、逐字优先、实体声明拒绝一律照旧。
        if (value.retry !== undefined && typeof value.retry !== 'boolean') return json(response, 400, { error: 'retry 必须为布尔值' })
        const found = store.trackForOnlineMatch(value.trackId)
        // F4：索引里没有 ⇒ 只可能是在线曲目（`on-<来源>-<媒体 id>`）。这扇窄门要求随请求带来描述字段
        // 并逐项校验（见 online-lyrics.mjs 的 onlineLyricQueryFrom）；服务端不凭 id 反查任何缓存，
        // 免得又造出第二处真源。本地形态的 id 硬塞描述也进不来——判据是 id 前缀，不是"有没有 online 字段"。
        // 两条分支从 R144 起**合成一条**：认领记录、重试、近候选这些新东西必须对本地与在线曲目同时成立，
        // 分两处写迟早有一处漏（从前这两段就是逐字重复的匹配调用）。
        const song = found ? found.query : onlineLyricQueryFrom(value, value.trackId)
        if (!song) return json(response, 404, { error: '索引中没有此曲目' })
        // 冲突规则的服务端把关（6.6 收窄）：本地有**带时间轴**的词才一票否决（认领也不绕过它）；
        // 只有内嵌纯文本时仍然去问一次在线——命中就替换，未命中由前端回退到段落显示。
        if (found?.localLyric?.timed) {
          return json(response, 200, { trackId: value.trackId, matched: false, localLyrics: 'present', reason: '本地已有带时间轴的歌词（同目录文件或内嵌时间轴标签优先），未发起在线请求' })
        }
        const shape = found
          ? { localLyrics: found.localLyric.present ? 'untimed' : 'absent' }
          : { localLyrics: 'absent', trackKind: 'online' }
        return json(response, 200, { trackId: value.trackId, ...shape, ...publicLyricAnswer(await lyricAnswerFor(song, { retry: value.retry === true })) })
      }
      if (route === '/api/online/lyrics/claim') {
        // R144 · 手动认领：把"最后那一格"交给人。次序沿用 R61（开关 → 方法 → 体 → 才可能出网）。
        if (!store.config.online?.lyrics) return json(response, 404, { error: '在线歌词匹配已关闭：认领记录随之不再提供（重新勾选即可恢复，该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '歌词认领只接受 POST' })
        const value = await bodyJson(request)
        if (typeof value.trackId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.trackId)) return json(response, 400, { error: 'trackId 无效' })
        if (value.action !== undefined && !['claim', 'clear'].includes(value.action)) return json(response, 400, { error: "action 只支持 claim / clear" })
        const found = store.trackForOnlineMatch(value.trackId)
        const song = found ? found.query : onlineLyricQueryFrom(value, value.trackId)
        if (!song) return json(response, 404, { error: '索引中没有此曲目' })
        const fingerprint = lyricIdentityFingerprint(song)
        if (value.action === 'clear') {
          // 取消认领一次网都不出（它只是把本机那一条记录删掉）。
          return json(response, 200, { trackId: value.trackId, ...(await onlineLyricClaims.clear(fingerprint)) })
        }
        if (found?.localLyric?.timed) {
          return json(response, 400, { error: '本地已有带时间轴的歌词，它优先：先删掉那份同目录文件或内嵌时间轴，再来认领（这条立场与自动挡相同）' })
        }
        // 先校验再出网：形状不对的候选连"试取一次"都不该发起。
        // R148（Q20）：认领只认**我们签发过的令牌**——客户端不再往回送 `accessKey`，
        // 因此也没法拿一条真令牌去配另一首歌（展示字段必须与令牌登记的身份逐字对上）。
        const candidate = value.candidate ?? {}
        const identity = onlineLyricClaimTokens.resolve(candidate.claimToken)
        if (!identity) {
          return json(response, 400, { error: '认领要带我们签发的那条候选的令牌：列表已过期或服务重启过，请重新点一次「重试匹配歌词」再挑' })
        }
        if (String(candidate.provider ?? '') !== identity.provider || String(candidate.sourceId ?? '') !== identity.sourceId) {
          return json(response, 400, { error: '这条候选的来源与曲目标识和令牌对不上，没有写入任何记录' })
        }
        const { entry, error } = claimEntryFrom({ ...candidate, ...identity })
        if (error) return json(response, 400, { error })
        // **登记之前先真取一次**（与 R126「登记 + 真取到图两件事都成才算 ok」同一条纪律）：
        // 取不到带时间轴的词就不写，免得留下一条"认领了却永远没词"的记录。
        const probe = await onlineLyricsMatcher.fetchClaimed(song, entry)
        if (!probe.matched) {
          return json(response, 200, { ok: false, written: false, error: `${probe.reason ?? '这一首没有取到带时间轴的歌词'}（没有写入任何记录）` })
        }
        const report = await onlineLyricClaims.put(fingerprint, entry, { track: song })
        // 响应体只带计数与来源，**不带歌词正文、也不把自己刚收下的那份身份再吐回去**
        // （下面那两条断言钉的就是这两件事）。
        const { entry: echoed, ...publicReport } = report
        return json(response, 200, {
          trackId: value.trackId, ...publicReport,
          timedLines: probe.timedLines, format: probe.format, isWordByWord: probe.isWordByWord,
        })
      }
      if (route === '/api/online/status') {
        // 本地自省路由：不经过桥、不出网。它是"在线后端现在算什么状态"的唯一出口，
        // Task 4 的出网审计面板与 Task 12 的登录流都从这里读阶段。
        if (!get) return json(response, 405, { error: '在线状态只接受 GET' })
        return json(response, 200, {
          ...bridge.status(),
          switches: { ...ONLINE_DEFAULTS.online, ...store.config.online },
          masterOnlineEnabled: store.config.onlineEnabled === true,
        })
      }
      if (route === '/api/online/auth' || route === '/api/online/auth/account') {
        // M3-a Task C：登录状态的**唯一读口**。GET /auth 本地自省（不出网、不碰桥：读内存 + stat 会话文件）；
        // POST /auth/account 才是那一次"拿本机凭据去问一次账号"——分开两条，是为了让界面每次轮询不必出网。
        if (!store.config.onlineEnabled) return json(response, 404, { error: '联网功能已关闭：在音乐库面板的「在线能力」里重新打开即可使用扫码登录' })
        if (route === '/api/online/auth') {
          if (!get) return json(response, 405, { error: '登录状态只接受 GET' })
          return json(response, 200, { ...(await onlineAuth.status()), pollMs: AUTH_POLL_MS })
        }
        if (request.method !== 'POST') return json(response, 405, { error: '账号查询只接受 POST' })
        // provider 必须从请求体里读并校验：这里原来写死 `account()` + `provider:'netease'`，
        // 于是"问 QQ 的账号"会拿到网易的昵称与头像——两家都在面板上时，那就是一张贴错名字的头像。
        const asked = await bodyJson(request)
        const provider = asked.provider === undefined ? 'netease' : String(asked.provider)
        if (!AUTH_PROVIDERS.includes(provider)) return json(response, 400, { error: `不支持的登录提供方：${provider.slice(0, 20)}` })
        const account = await onlineAuth.account(provider)
        // 昵称与头像是**账号信息**，不是凭据；但它们来自上游，所以字段名要过 §7.1 那份键名白名单。
        return json(response, 200, { provider, ...account })
      }
      if (route === '/api/online/auth/start' || route === '/api/online/auth/poll' || route === '/api/online/auth/logout') {
        // 扫码登录的三个动作。次序沿用 R61：开关 → 方法 → 请求体 → 才可能碰桥与出网。
        // 响应形状里**没有凭据**这一项：确认态那一份 cookie 在 online-auth.mjs 直接进 jar 落盘，
        // 到这里只剩 state / 二维码 / 过期时间 / 可读原因（§7.1 的运行时半，断言在 check-music-auth-flow.mjs）。
        const action = route.slice('/api/online/auth/'.length)
        if (!store.config.onlineEnabled) return json(response, 404, { error: '联网功能已关闭：在音乐库面板的「在线能力」里重新打开即可使用扫码登录' })
        if (request.method !== 'POST') return json(response, 405, { error: `登录${action === 'start' ? '取码' : action === 'poll' ? '轮询' : '退出'}只接受 POST` })
        const value = await bodyJson(request)
        const provider = value?.provider === undefined ? 'netease' : String(value.provider)
        if (!AUTH_PROVIDERS.includes(provider)) return json(response, 400, { error: `这一版只有网易、酷狗与 QQ 的扫码通道，收到 ${provider.slice(0, 20)}` })
        const result = action === 'start' ? await onlineAuth.start(provider)
          : action === 'poll' ? await onlineAuth.poll(provider)
            : await onlineAuth.logout(provider)
        return json(response, 200, { provider, ...result })
      }
      if (route === '/api/online/audit') {
        // 出网审计表（R75）：默认打开之后，"我们只打了该打的地方"必须摊开给用户看，而不是让用户相信代码。
        // 读的是内存里的环形缓冲：它自己绝不出网、绝不落盘，也不含 URL 查询串与任何凭据。
        if (!ONLINE_SWITCHES.some((key) => store.config.online?.[key] !== false)) {
          return json(response, 404, { error: '在线能力已全部关闭：出网记录不再提供（重新勾选即可恢复）。此前的记录已随关闭清空。' })
        }
        if (!get) return json(response, 405, { error: '出网审计只接受 GET' })
        return json(response, 200, auditSnapshot())
      }
      if (route === '/api/online/cover/backfill') {
        // 在线封面补全（M3-c）的手动触发口。次序沿用 R61：开关 → 方法 → 请求体 → 才可能出网。
        // 启动扫描后那一轮自动补图走的是同一个 `store.backfillCovers`，所以"面板点一下"与"启动自己走"
        // 用的是同一份选取判据（只挑当前无封面的专辑），不存在第二套逻辑。
        if (!store.config.onlineEnabled || store.config.online?.covers === false) {
          return json(response, 404, { error: '在线封面补全已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）' })
        }
        // 方法判定排在开关之后、体之前：GET 一条路由绝不能"顺手"触发一轮出网。
        if (request.method !== 'POST') return json(response, 405, { error: '封面补全只接受 POST' })
        const value = await bodyJson(request)
        if (value.albumIds !== undefined && (!Array.isArray(value.albumIds) || value.albumIds.length > 10000 || value.albumIds.some((id) => typeof id !== 'string'))) return json(response, 400, { error: 'albumIds 必须是专辑 ID 数组' })
        if (value.force !== undefined && typeof value.force !== 'boolean') return json(response, 400, { error: 'force 必须为布尔值' })
        // 提供者没装配（不带在线模块的部署 / 自检注入假曲库）：说清楚，别留一个永远跑不完的空转轮。
        if (!store.coverProvider) return json(response, 503, { error: '本服务未装配封面来源：本地播放与本地封面不受任何影响' })
        if (store.coverPromise) return json(response, 202, store.snapshot())
        void store.backfillCovers({ albumIds: value.albumIds, force: value.force ?? false }).catch(() => {})
        return json(response, 202, store.snapshot())
      }
      if (route === '/api/online/search') {
        // 在线搜索（Task 7）：与歌词/音源同一道开关纪律——关掉就 404，一次上游请求都不发。
        if (!store.config.online?.search) return json(response, 404, { error: '在线搜索已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '在线搜索只接受 POST' })
        const value = await bodyJson(request)
        const result = await onlineSearcher.search(value)
        if (result.invalid) return json(response, 400, { error: result.error })
        // 全部源都没应答也是"一次合法的检索"：200 + ok:false + perSource 逐条原因，
        // 让界面能说清是哪个源坏了，而不是笼统报一个 5xx。
        return json(response, 200, result)
      }
      if (/^\/api\/online\/artwork\/[a-f0-9]{2,}$/.test(route)) {
        // 在线曲目封面（看板 ⑨ 追加）。三件事按这个顺序判，一个都不许少：
        //   ① 子开关：关掉就 404，一次上游请求都不发（与搜索/歌词/音源同一道纪律）；
        //   ② token 形状 + 注册表：只认我们自己签发过的那 16 位十六进制，反查不到就是没有——
        //      这条路由**不接受任何 URL 参数**，所以它不是一个"给个地址就帮你取"的代理；
        //   ③ 出网只走 guardedTrackCoverFetch（exact 主机表 + DNS 预解析 + 地址类别判定 + redirect:'error'），
        //      认魔数不认上游 content-type，落盘只有 store.cacheArtworkBytes 一个出处。
        if (!store.config.online?.covers) return json(response, 404, { error: '在线封面已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）' })
        const token = route.slice('/api/online/artwork/'.length)
        if (!TRACK_COVER_TOKEN_PATTERN.test(token)) return json(response, 400, { error: '封面 token 形状不合法' })
        const image = await onlineTrackCovers.load(token)
        if (!image) return json(response, 404, { error: '这张在线曲目没有可显示的封面（来源没给、没登记过，或取图失败）' })
        return await serveFile(request, response, { ...image, allowedRoot: store.dataDir }, { cache: 'private, max-age=86400' })
      }
      if (route === '/api/online/covers/retry') {
        // 墙上「重取封面」（R126 · 方案 A）：手动即时重问一次，不等 7 天窗口（`COVER_RETRY_MS`）。
        // 次序沿用 R61：开关 → 方法 → 请求体 → 才可能出网。
        // 判据沿用回填那一条，不另起一套：查询串 = 曲名 + 歌手、**同身份逐字相同**才采纳（为了拿张图
        // 把用户看到的匹配换掉是不可接受的），成功要"登记 + 真取到图"两件事都成才算 ok。
        if (!store.config.online?.covers) return json(response, 404, { error: '在线封面已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '重取封面只接受 POST' })
        const value = await bodyJson(request)
        const identity = /^on-(netease|qq|kugou)-(.+)$/.exec(typeof value.trackId === 'string' ? value.trackId : '')
        if (!identity) return json(response, 400, { error: 'trackId 不是一张在线曲目（本地曲目的封面在音频文件里，重问没有意义）' })
        const title = typeof value.title === 'string' ? value.title.slice(0, 200) : ''
        const artist = typeof value.artist === 'string' ? value.artist.slice(0, 200) : ''
        if (!title.trim()) return json(response, 400, { error: '重取封面要带曲名（查询串就是曲名 + 歌手）' })
        const provider = identity[1]
        const mediaId = identity[2].split('-')[0]
        const found = await onlineSearcher.searchEntries({ query: [title, artist].filter(Boolean).join(' '), offset: 0, limit: 10 })
        if (found.invalid) return json(response, 400, { error: found.error })
        if (found.ok !== true) {
          // 所有源都没应答 = 一次**没有结论**的尝试：与 R125 同一条口径，不落任何戳、也不谎报成功。
          return json(response, 200, { ok: false, searched: true, reason: '在线源这次都没应答：什么都没改，稍后可以再点一次' })
        }
        const same = (found.items ?? []).find((item) => item.provider === provider && String(item.mediaId) === mediaId && item.coverRef)
        // R146（任务九）：这一首在自己那家没给封面地址 ⇒ 允许采纳"另一家同一首"的图。
        // 四条判据全在 `coverFallbackOk` 里（来源不同 + 曲名歌手归一后逐字相等 + 两边时长都知道且相差 ≤3 秒 + 它自己有图）；
        // 界面没带时长就是不带证据 ⇒ 不回落，行为与今天逐字一致。
        const requestDuration = Number(value.durationMs ?? 0)
        const borrowed = same ? null : (found.items ?? []).find((item) => coverFallbackOk(
          { title, artist, durationMs: Number.isFinite(requestDuration) ? requestDuration : 0 }, item, { provider, mediaId }))
        const picked = same ?? borrowed
        if (!picked) {
          return json(response, 200, {
            ok: false, searched: true,
            reason: `检索前 10 条里没有 ${provider} 的这一首（或它没给封面地址）——平台的目录会变，过几天再试`,
          })
        }
        const coverUrl = onlineTrackCovers.register(picked.coverRef)
        const image = await onlineTrackCovers.load(coverUrl.slice('/api/online/artwork/'.length))
        if (!image) {
          // 登记过 ≠ 取到了。那张地址可能是 JSON 错误页（R106 真机抓到过 200/27KB 的检索 JSON），
          // 只有过魔数、进了内容寻址缓存的那一张才算数。
          return json(response, 200, { ok: false, searched: true, reason: '来源给了封面地址，但那张图取不到或不是一张可显示的图' })
        }
        const persisted = await playlistMatcher.rememberCover({
          provider, mediaId, coverRef: picked.coverRef, coverFrom: borrowed?.provider ?? null,
        })
        return json(response, 200, {
          ok: true, coverUrl, cached: true, searched: true,
          // 图是另一家给的时候，界面要能说出来（不让人以为"这家就是没有这张图"）
          ...(borrowed ? { coverFrom: String(borrowed.provider) } : {}),
          ...persisted,
        })
      }
      if (route === '/api/online/audio-scope') {
        // M3-b：「这条在线曲目现在能播多长」的唯一出口。界面拿不到 `<audio>` 之外的信息，
        // 而"试听片段 / 完整播放"必须说得出依据——依据只能来自取址响应（freeTrialInfo），不能靠猜时长。
        // 这条路由不出网之外的事：它走的就是音源解析器（命中缓存时一次请求都不发）。
        if (!store.config.online?.streaming) return json(response, 404, { error: '在线试听已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '播放范围查询只接受 POST' })
        const value = await bodyJson(request)
        const id = typeof value.trackId === 'string' ? value.trackId : ''
        const identity = /^on-(netease|qq|kugou)-(.+)$/.exec(id)
        if (!identity) return json(response, 400, { error: 'trackId 不是一张在线曲目（本地曲目不需要问播放范围）' })
        const parts = identity[2].split('-')
        // R141：回落需要"这首歌是谁"。界面本来就带着曲目对象，所以随请求带三样描述字段
        // （与歌词那一路的窄门同一形状）；**没带就不回落**——行为与今天逐字一致，不多发一个包。
        const audioIdentity = onlineAudioIdentityFrom(value)
        const resolved = await audioSource.resolve({
          provider: identity[1], mediaId: parts[0], mediaMid: parts[1] ?? '',
          ...(audioIdentity ? { identity: audioIdentity } : {}),
        })
        // 响应里**没有 URL**：签名地址给浏览器等于把第三方 CDN 的入口与有效期暴露出去，
        // 而播放走的是本机 /api/online/stream 中转，界面不需要它。
        return json(response, 200, {
          trackId: id,
          ok: resolved.ok === true,
          scope: resolved.ok ? (resolved.scope ?? 'unknown') : 'unavailable',
          ...(resolved.trial?.end ? { trialSeconds: resolved.trial.end } : {}),
          fee: Number(resolved.fee ?? 0) || 0,
          // 回落这件事要说得出：换了来源还写成原来源的徽标，等于界面在撒谎（用户点名要的那格）。
          ...(resolved.fallback ? { sourceProvider: resolved.provider, fallbackFrom: resolved.fallback.from } : {}),
          ...(resolved.reason ? { reason: String(resolved.reason).slice(0, 200) } : {}),
        })
      }
      if (route === '/api/online/stream') {
        // 在线试听（Task 6）。四步把关按"最便宜的先做"排：开关 → 方法 → 参数 → 才可能碰取址与出网。
        // 关掉之后这条路由既不取址也不出网（V1 的"关着零暴露"在这一条上的具体形态）。
        if (!store.config.online?.streaming) return json(response, 404, { error: '在线试听已关闭：在音乐库面板的「在线能力」里重新勾选即可恢复（该项默认开启）' })
        if (!get) return json(response, 405, { error: '在线试听只接受 GET/HEAD' })
        const provider = url.searchParams.get('p') ?? ''
        const mediaId = url.searchParams.get('id') ?? ''
        const mediaMid = url.searchParams.get('mm') ?? ''
        // R222：酷狗取址"带专辑参数"那一档的两个 id（`al`/`aa`，由 `toOnlineTrack` 并进同源地址）。
        // 与 `id`/`mm` 同一条把关：只收数字形状，认不出的**当没带**（那是可选提示，不是身份——
        // 取址那一侧对"没带"的读法就是纯 hash 那一档，判死这首歌反而更坏）。
        const albumId = /^\d{1,20}$/.test(url.searchParams.get('al') ?? '') ? url.searchParams.get('al') : ''
        const albumAudioId = /^\d{1,20}$/.test(url.searchParams.get('aa') ?? '') ? url.searchParams.get('aa') : ''
        // R225：曲名与歌手（`t`/`a`，由 `toOnlineTrack` 并进同一个同源地址）= R141 回落要的身份。
        // 这一格从前在生产路由上**缺失**（只有 POST /api/online/audio-scope 的请求体带过）⇒ 回落机制在位、
        // 判据全绿，但用户点歌这条路从未触发。把关用契约那一份（`onlineIdentityPair`），不在这里抄第二条规则：
        // **两个都合格才传**（只剩曲名会搜出一堆别人的翻唱），任一项不合格就当没带 ⇒ 行为与今天逐字一致、不多发一个包。
        const streamIdentity = onlineIdentityPair(url.searchParams.get('t'), url.searchParams.get('a'))
        // 形状先过：id 只能是我们自己发出去的那种标识，路径里永不出现用户输入的主机名或 URL。
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(mediaId) || !/^[A-Za-z0-9_-]{0,64}$/.test(mediaMid)) return json(response, 400, { error: '参数不合法' })
        if (!AUDIO_PROVIDERS.includes(provider)) return json(response, 400, { error: `不支持的音源：${provider || '（空）'}` })
        const source = await audioSource.resolve({ provider, mediaId, mediaMid, albumId, albumAudioId, ...(streamIdentity ? { identity: streamIdentity } : {}) })
        if (!source?.ok) {
          // 桥/后端没就绪 ⇒ 503（等一等或重开开关就好）；上游确实没有这条音源 ⇒ 502（换歌才有用）。
          // 两者混成一个码的话，用户会在"稍后再试"和"这首播不了"之间反复横跳。
          return json(response, source?.via === 'bridge' ? 503 : 502, { error: source?.reason ?? '拿不到音源' })
        }
        // Range 一律**原样透传**给上游，不自己解释、不自己换算（实测两家 CDN 都懂单段/suffix/开区间）。
        // 反面写法（先按 content-length 自己 parseRange 再向上游要整段）会把一次拖动变成一整首的下载。
        const clientRange = request.headers.range
        let upstream
        try {
          upstream = await streamUpstream(source.url, { headers: clientRange ? { range: String(clientRange) } : {} })
        } catch (error) {
          return json(response, 502, { error: `音源不可用：${error?.message ?? error}` })
        }
        if (upstream.status === 416) {
          // 越界：上游给的正文是一段错误说明（实测网易是 31 字节 text/plain），**不发给内核**；
          // content-range 上游没给就用取址时报回来的长度补一个 `bytes */N`。
          response.writeHead(416, {
            'Content-Type': audioSourceMime(source.kind), 'Cache-Control': 'no-store',
            // Accept-Ranges 也要带：本地 /api/audio 的 416 就是这么回的（真机逐条比过一次），
            // 少了这一行的话"同口径"就只在 200/206 两档成立。
            'Accept-Ranges': 'bytes',
            'Content-Range': upstream.headers.get('content-range') ?? `bytes */${Number(source.size ?? 0) || 0}`,
            'Content-Length': '0',
          })
          return response.end()
        }
        if (!upstream.ok) return json(response, 502, { error: `音源不可用（上游 ${upstream.status}）` })
        const headers = {
          // 类型用**取址时报的** kind，不用上游的：网易 CDN 的 content-type 实测是
          // application/octet-stream;charset=UTF-8，透传给内核只是把判断推给浏览器。
          'Content-Type': audioSourceMime(source.kind),
          'Cache-Control': 'no-store',                 // 不缓存：这是"不下载"红线的另一面
          'Accept-Ranges': upstream.headers.get('accept-ranges') ?? 'bytes',
          'X-Content-Type-Options': 'nosniff',
        }
        const declaredLength = upstream.headers.get('content-length')
        if (declaredLength) headers['Content-Length'] = declaredLength
        const contentRange = upstream.headers.get('content-range')
        if (contentRange) headers['Content-Range'] = contentRange
        // 上游给 206 才回 206；上游把带 Range 的请求当整段 200 回（实测会发生），就照 200 转——
        // 自己写成 206 是在骗内核，它会按错的偏移喂解码器。
        response.writeHead(upstream.status === 206 ? 206 : 200, headers)
        if (request.method === 'HEAD' || !upstream.body) return response.end()
        const chunkStream = typeof upstream.body.getReader === 'function' ? Readable.fromWeb(upstream.body) : Readable.from(upstream.body)
        chunkStream.on('error', () => response.destroy())
        response.on('close', () => chunkStream.destroy())
        // 管道到响应即结束：这一条路由没有任何写盘动作，音频字节只穿过内存（自检按源码钉这一条）。
        chunkStream.pipe(response)
        return undefined
      }
      // ── 歌单实体（Task 8）。三条纪律：id 必须先过 slug（它是文件名）、每请求重读（不缓存）、
      //    坏行过半拒写并回显清单（一半读不懂多半是格式理解错了，悄悄收下才是害人）。
      // ⑧ 伪专辑上架：专辑架要的那点信息（名字 / 行数 / 未匹配数 / 拼贴格原料）。
      // **必须排在 `/api/playlists/:id` 之前**——否则 `shelf` 会被当成一张叫 shelf 的歌单去读文件，
      // 读不到就 404，界面上表现为"歌单没上到架上"，而不是"路由顺序错了"，这类错最难查。
      if (route === '/api/playlists/shelf' && get) {
        const listed = await store.playlists.list()
        const taken = listed.slice(0, SHELF_PLAYLIST_LIMIT)
        const rows = []
        const details = []
        let broken = 0
        for (const entry of taken) {
          // 逐张读文本与匹配缓存（零出网）：某一张被用户改坏了不该把整架带走，所以逐条兜住并计数。
          const detail = await playlistMatcher.tracks(entry.id).catch(() => null)
          if (!detail) { broken += 1; continue }
          details.push(detail)
          rows.push(playlistShelfRow(detail))
        }
        // ⑨ 音乐人组：与歌单行**同一次遍历**的产物（多一个请求就是多一次全量读盘，两份真相也从这里开始）。
        const artistGroups = onlineArtistGroups(details)
        return json(response, 200, {
          playlists: rows,
          artists: artistGroups.groups.map(artistShelfRow),
          artistsOmitted: artistGroups.omitted,
          artistsLimit: artistGroups.limit,
          omitted: Math.max(0, listed.length - taken.length),
          broken,
          limit: SHELF_PLAYLIST_LIMIT,
        })
      }
      // ⑨ 某一组的明细：点开才取（与 `playlist:<slug>` 的"明细点开才取"同构）。
      // 挂在 `/api/online/` 而不是 `/api/playlists/` 下，是为了避开 R110 那条排序坑
      // （`shelf` 必须排在 `:id` 之前，这类"路由顺序错但症状像产品坏"的坑不重复踩）。
      const artistOne = /^\/api\/online\/artists\/([^/]+)$/.exec(route)
      if (artistOne && get) {
        let slug
        try { slug = slugOf(decodeURIComponent(artistOne[1])) } catch { return json(response, 400, { error: '非法的音乐人组标识' }) }
        const listed = await store.playlists.list()
        const details = []
        for (const entry of listed.slice(0, SHELF_PLAYLIST_LIMIT)) {
          const detail = await playlistMatcher.tracks(entry.id).catch(() => null)
          if (detail) details.push(detail)
        }
        // 找组时不套架上的上限：架上没铺出来的组，用户如果知道标识仍该能取到（而不是拿到一个 404 谎话）。
        const groups = onlineArtistGroups(details, Number.MAX_SAFE_INTEGER)
        const group = groups.groups.find((candidate) => candidate.slug === slug)
        if (!group) return json(response, 404, { error: '没有这个音乐人组（本机歌单里没有他已匹配的在线条目）' })
        return json(response, 200, {
          id: group.slug,
          name: group.name,
          playlists: group.playlists,
          items: group.tracks,
        })
      }
      if (route === '/api/favorites' && get) {
        // 收藏清单（R130）：本机 JSON，零出网。界面拿整份自己算"这一首收藏了吗"，
        // 不逐首问一次——那是 N 次读盘换一次渲染。
        // R135（Q11）：这份原始清单**剥掉 coverRef** 才出去（第三方地址一律不出服务端）。
        return json(response, 200, { items: (await favorites.list()).map(publicFavoriteItem), limit: MAX_FAVORITES })
      }
      if (route === '/api/favorites/view' && get) {
        // 收藏列表视图（R132）：清单 + 曲库现算的指纹索引 → "还在不在、能不能播"。
        // 每次请求重算索引而不是缓存它：曲库重扫后本地 id 整批改过（R130 用指纹而不用 id 的同一个理由），
        // 缓存这份对应关系就是把它冻结在上一副身子上。零出网（`toOnlineTrack` 只签发同源地址）。
        const snapshot = store.snapshot()
        return json(response, 200, favoriteView({
          items: await favorites.list(),
          tracks: snapshot.albums.flatMap((album) => album.tracks),
          limit: MAX_FAVORITES,
          // Q11：存过的封面地址在这里换成同源 token 地址；子开关关掉或没登记过就是空串（界面画占位）。
          coverUrlOf: (coverRef) => onlineTrackCovers.register(coverRef),
        }))
      }
      if (route === '/api/favorites' && request.method === 'POST') {
        const value = await bodyJson(request)
        // 两个动作：`check` 只读（换歌时问一次"这首收藏了吗"），`toggle` 写。
        // 为什么键不在前端算：指纹算法（归一 + 哈希）住在本机一处，前端再实现一遍就是第二个真相。
        if (!['check', 'toggle'].includes(value.action)) return json(response, 400, { error: '收藏只支持 check / toggle' })
        const track = value.track
        if (!track || typeof track !== 'object' || !String(track.title ?? '').trim() || !String(track.artist ?? '').trim()) {
          return json(response, 400, { error: '收藏要带曲名与歌手（键就是由它们算出来的）' })
        }
        try {
          if (value.action === 'check') {
            const items = await favorites.list()
            const key = favoriteKeyOf(track)
            return json(response, 200, { liked: items.some((item) => item.key === key), key, count: items.length })
          }
          // Q11：收藏时把同源封面地址反解回第三方地址存进清单（反解不出就不存这个字段）。
          const coverRef = coverRefFromCoverUrl(track.coverUrl)
          return json(response, 200, await favorites.toggle(coverRef ? { ...track, coverRef } : track))
        } catch (error) {
          return json(response, 400, { error: error?.message ?? String(error) })
        }
      }
      const playlistOne = /^\/api\/playlists\/([^/]+)$/.exec(route)
      if (playlistOne && get) {
        let id
        try { id = slugOf(decodeURIComponent(playlistOne[1])) } catch (error) { return json(response, 400, { error: error.message }) }
        const one = await store.playlists.get(id)
        if (!one) return json(response, 404, { error: '没有这张歌单（文件名可能是手改的，或它已被删除）' })
        return json(response, 200, { playlist: one })
      }
      if (route === '/api/playlists' && get) return json(response, 200, { playlists: await store.playlists.list() })
      if (route === '/api/playlists' && request.method === 'POST') {
        const value = await bodyJson(request)
        const actions = ['create', 'update', 'rename', 'delete', 'add', 'replace']
        if (!actions.includes(value.action)) return json(response, 400, { error: `action 只支持 ${actions.join(' / ')}` })
        try {
          // 追加（F2：搜索结果加进歌单）。**只往文件末尾加行**，不整份重写——
          // 重写会把用户的 `#` 注释与 `[album]` 分组抹掉，那等于把"文本是用户资产"改没了。
          // 条目里的 `audioUrl` 是我们自己签发的同源地址，反解成身份写进第 4 段（见 normalize 的逆函数）。
          if (value.action === 'add') {
            const items = Array.isArray(value.items) ? value.items : []
            const entries = items.map((item) => {
              const online = identityFromStreamUrl(item?.audioUrl)
              return {
                title: item?.title, artist: item?.artist, album: item?.album, durationMs: item?.durationMs,
                ...(online ? { online } : {}),
              }
            })
            if (value.id === undefined || value.id === null || value.id === '') {
              // 没有 id 就是"新建一张并加入"：名字由用户给，条目同一份载荷。
              const created = slugOf(value.name)
              if (await store.playlists.get(created)) return json(response, 409, { error: `已经有一张叫「${created}」的歌单` })
              const saved = await store.playlists.write(created, serializePlaylist({ name: created, items: entries }))
              return json(response, 200, { playlist: saved, added: entries.length })
            }
            const id = slugOf(value.id)
            const current = await store.playlists.get(id)
            if (!current) return json(response, 404, { error: '要追加的歌单不存在' })
            if (current.parseError) return json(response, 400, { error: `这张歌单现在读不了，先修好它：${current.parseError}` })
            const added = await store.playlists.write(id, appendEntriesToText(current.text, entries))
            return json(response, 200, { playlist: added, added: entries.length })
          }
          // 手工指定（R127 · 方案 B）：**只改一行**，且必须带上"原来那一行的原文"做对照。
          // 对照失败 ⇒ 抛 ⇒ 一个字都不写（表现是"这次没改成"，而不是"改错了别的那一行"）。
          // 写之前 `store.write` 会先落 `.backup`（与追加/编辑同一条既有纪律），失败不动文件。
          if (value.action === 'replace') {
            const id = slugOf(value.id)
            const current = await store.playlists.get(id)
            if (!current) return json(response, 404, { error: '要改的歌单不存在' })
            if (current.parseError) return json(response, 400, { error: `这张歌单现在读不了，先修好它：${current.parseError}` })
            const source = value.entry ?? {}
            const online = identityFromStreamUrl(source.audioUrl)
            const replaced = replaceEntryInText(current.text, {
              line: value.line, expect: value.expect,
              // 与"加入歌单"同一个换算：客户端给的是我们自己签发的同源地址，身份在这里反解出来，
              // 不在两处各写一遍（两处口径迟早会漂）。
              entry: {
                title: source.title, artist: source.artist,
                album: source.album, durationMs: source.durationMs,
                ...(online ? { online } : {}),
              },
            })
            const saved = await store.playlists.write(id, replaced.text)
            return json(response, 200, { playlist: saved, line: Number(value.line), before: replaced.before, after: replaced.after })
          }
          if (value.action === 'delete') {
            const removed = await store.playlists.remove(slugOf(value.id))
            return json(response, 200, { removed: removed.removed, playlists: await store.playlists.list() })
          }
          if (value.action === 'rename') {
            const renamed = await store.playlists.rename(slugOf(value.id), slugOf(value.name))
            if (!renamed) return json(response, 404, { error: '要改名的歌单不存在' })
            return json(response, 200, { playlist: renamed, playlists: await store.playlists.list() })
          }
          const creating = value.action === 'create'
          const id = slugOf(creating ? value.name : value.id)
          if (typeof value.text !== 'string' || !value.text.trim()) return json(response, 400, { error: 'text 不能为空' })
          const parsed = parsePlaylistText(value.text)          // 超上限会抛，由下面的 catch 变 400（不静默截断）
          if (parsed.items.length === 0) return json(response, 400, { error: '这张歌单里没有一条被读懂的条目', warnings: parsed.warnings.slice(0, 20) })
          if (parsed.warnings.length > parsed.items.length) {
            return json(response, 400, {
              error: `这张歌单有 ${parsed.warnings.length} 行没被读懂、只有 ${parsed.items.length} 行读懂了——多半是格式理解错了，已拒绝写入`,
              warnings: parsed.warnings.slice(0, 20),
            })
          }
          if (creating && await store.playlists.get(id)) return json(response, 409, { error: `已经有一张叫「${id}」的歌单` })
          const saved = await store.playlists.write(id, value.text)
          return json(response, 200, { playlist: saved, playlists: await store.playlists.list() })
        } catch (error) {
          return json(response, 400, { error: error?.message ?? String(error) })
        }
      }
      if (route === '/api/online/report') {
        // R161（任务八）· 播放上报。次序沿用 R61：开关 → 方法 → 体 → 才可能出网。
        // **缺省关**：关着的这一档连凭据文件都不读（`playReporter` 里第一句就返回，不问会话）。
        if (!store.config.online?.streaming) return json(response, 404, { error: '在线播放已关闭：没有可上报的播放' })
        if (request.method !== 'POST') return json(response, 405, { error: '播放上报只接受 POST' })
        const value = await bodyJson(request)
        if (value.positionSec !== undefined && !Number.isFinite(Number(value.positionSec))) {
          return json(response, 400, { error: 'positionSec 必须是数字' })
        }
        const target = onlineReportTargetOf(value?.trackId)
        if (!target) return json(response, 400, { error: '本地曲目不上报任何平台（这一条按曲目 id 的形状判，不按客户端自报）' })
        const reply = await playReporter.report({
          provider: target.provider, mediaId: target.mediaId,
          positionSec: Number(value?.positionSec ?? 0),
          enabled: store.config.playReporting === true,
        })
        // 上报失败**不影响播放**，所以这里回 200 + `sent:false`：让前端去 catch 一个"错误"
        // 会把一件无关紧要的事渲染成一句红字，用户会以为歌坏了。
        return json(response, 200, sanitizeEgressReasons({ ok: true, ...reply }))
      }
      if (route === '/api/online/playlist/mine') {
        // R159（任务六）· 账号歌单：**只读**——列的是"这台机器登录的那个账号自己的"歌单，
        // 不建、不改、不删（那三件事在任务十一之前一律不开）。次序沿用 R61：开关 → 方法 → 体 → 才可能出网。
        if (!store.config.online?.search) return json(response, 404, { error: '在线能力已关闭：不列账号歌单（在音乐库面板里重新勾选即可恢复，该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '账号歌单只接受 POST' })
        const value = await bodyJson(request)
        const provider = String(value?.provider ?? '')
        // QQ 那一家今天不给：它的包只 require 了 `/serverless` 与 `/mqtt` 两个子路径（R107/R108），
        // 里面有没有"我自己的歌单列表"这一条**没量到** ⇒ 不猜、不试第二种端点（与 R137 那次同一个立场）。
        if (provider === 'qq') return json(response, 400, { error: 'QQ 的账号歌单列表本机还没量到端点（不猜）；QQ 分享出来的公开歌单可以直接粘链接导入' })
        if (provider !== 'netease' && provider !== 'kugou') return json(response, 400, { error: '账号歌单今天支持网易与酷狗两家' })
        const credentials = await credentialsFor(provider)
        const called = await bridge.call('/bridge/playlist', {
          provider, action: 'mine',
          cookie: String(credentials.cookie ?? ''),
          ...(provider === 'kugou' ? { device: credentials.device } : {}),
          limit: value?.limit, offset: value?.offset, page: value?.page, pagesize: value?.pagesize,
        })
        // **`device` 一律剥掉再回**：桥把"用到哪一份身份"回报给父进程是有用的（取址那一路要存 mid/dfid），
        // 但那份对象里带着 `token` 与 `userid` —— 顺着响应进浏览器就破了"凭据不出服务端"那条红线。
        // 真机量到这一问之前没人拦它，是因为失败答复里才带 `device`，而失败在离线夹具里第一次就发生了。
        const { device: _unusedDevice, ...rest } = called ?? {}
        const publicReply = sanitizeEgressReasons(rest)
        // R165（任务十一）：列成功的那些 id 登记进"这台机器列出来过"那张表 ——
        // 写侧只认这张表里的 id，这是"只往用户自己的账号里写"那条红线在**我们这一侧**的落地。
        // R182：`writeId` 也要登记 —— 酷狗的写侧号（`listid`）与读侧号（`global_collection_id`）不是同一个，
        // 界面"加进来"那颗按钮带的是前者；漏登记它的表现是 403「不是这台机器刚才列出来的那些」。
        if (publicReply?.ok && Array.isArray(publicReply.items)) {
          issuedAccountPlaylists.issue(provider, publicReply.items.flatMap((item) => [item?.id, item?.writeId]));
        }
        // 前端那个 `request()` 认的是 `error` 这一格（其他路由也都在这里把 `reason` 翻成 `error`）：
        // 不翻的话界面上只剩"本地服务请求失败 (502)"，服务端那句"本机没有网易登录态"被吞掉（真机量到）。
        return json(response, publicReply.ok ? 200 : 502,
          publicReply.ok ? publicReply : { ...publicReply, error: String(publicReply.reason ?? '账号歌单没列出来') })
      }
      if (route === '/api/online/playlist/add') {
        // R165（任务十一）· 加歌到账号歌单：本仓**第一条写侧**在线通路。四条红线（只加不删 / 只写自己账号 /
        // 失败如实报 / 二次确认）里有三条落在这一道路由与桥那侧，次序沿用 R61：开关 → 方法 → 体 → 才可能出网。
        if (!store.config.online?.search) return json(response, 404, { error: '在线能力已关闭：不往账号歌单里写（在音乐库面板里重新勾选即可恢复，该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '加歌到账号歌单只接受 POST' })
        const value = await bodyJson(request)
        // ① 二次确认在**服务端也要一道**：只靠界面那颗 confirm 的话，任何一次误接线都能写出去。
        if (value?.confirm !== 'add-to-account-playlist') {
          return json(response, 400, { error: '这是写操作：需要界面明确带 confirm 标记（用户已经确认过一次），本服务不接受没有确认的写入' })
        }
        const provider = String(value?.provider ?? '')
        if (provider === 'qq') return json(response, 400, { error: 'QQ 的"加歌到账号歌单"本机还没量到端点（不猜、不试第二种）' })
        if (provider !== 'netease' && provider !== 'kugou') return json(response, 400, { error: '这一条今天支持网易与酷狗两家' })
        const playlistId = String(value?.playlistId ?? '').trim()
        if (!/^\d{1,20}$/.test(playlistId)) return json(response, 400, { error: '账号歌单 id 必须是数字' })
        // ② 只认这台机器最近列出来过的那几张（凭据只从本机分区来 ⇒ 列出来的就是"这个账号自己的"）。
        if (!issuedAccountPlaylists.has(provider, playlistId)) {
          return json(response, 403, { error: '这张歌单不是这台机器刚才列出来的那些（先在这里点「列…的歌单」再选一张）——本服务不往没有确认过归属的歌单里写' })
        }
        const requested = Array.isArray(value?.tracks) ? value.tracks.slice(0, 20) : []
        // ③ 曲目只认 `on-<来源>-<媒体 id>` 的形状，且**来源要与目标同一家**：
        //    把网易的曲目 id 塞进酷狗的歌单，平台大概会拒，但我们不该拿"平台会拒"当护栏（与 R159 同一立场）。
        const tracks = []
        for (const entry of requested) {
          const id = String(entry?.id ?? '')
          const target = onlineReportTargetOf(id)
          if (!target || target.provider !== provider) continue
          tracks.push({ mediaId: target.mediaId, name: String(entry?.name ?? '').slice(0, 200) })
        }
        if (!tracks.length) return json(response, 400, { error: '没有一条曲目是这一家的在线曲目（一次都不发）' })
        const credentials = await credentialsFor(provider)
        const called = await bridge.call('/bridge/playlist-write', {
          provider, action: 'add', playlistId, tracks,
          cookie: String(credentials.cookie ?? ''),
          ...(provider === 'kugou' ? { device: credentials.device } : {}),
        })
        const { device: _unusedDevice, ...rest } = called ?? {}
        const publicReply = sanitizeEgressReasons(rest)
        console.log(`账号歌单写入：${provider} 歌单 ${publicReply.ok ? '已接受' : '没成'}（${tracks.length} 条候选 · 实发 ${publicReply.sent ?? 0}）${publicReply.ok ? '' : ` —— ${String(publicReply.reason ?? '原因未知').slice(0, 160)}`}`)
        return json(response, publicReply.ok ? 200 : 502,
          publicReply.ok ? publicReply : { ...publicReply, error: String(publicReply.reason ?? '加歌没成功') })
      }
      if (route === '/api/online/playlist/import') {
        // 粘贴导入（Task 10）：与在线搜索同一张子开关（它可能经桥问网易），关掉 ⇒ 404 零出网。
        if (!store.config.online?.search) return json(response, 404, { error: '在线能力已关闭：粘贴导入需要联网（在音乐库面板里重新勾选即可恢复，该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '粘贴导入只接受 POST' })
        const value = await bodyJson(request)
        const result = await playlistImporter.import({ text: value.text, name: value.name })
        if (!result.ok) return json(response, 400, { error: result.error ?? result.reason ?? '导入失败', ...(result.warnings ? { warnings: result.warnings } : {}) })
        // R220：导入这一步就把**来源身份**写进 sidecar（`.playlist.txt` 正文一个字都不加，批复：不动格式）。
        // 写失败不影响"歌单已经导进来"这件事本身，但必须说出来——不许静默把这一格糊过去。
        const { identities, ...publicResult } = result
        if (Array.isArray(identities) && identities.length) {
          try {
            const applied = await playlistMatcher.applySourceIdentities(result.id, identities)
            publicResult.sourceIdentities = { filled: applied.filled, unfilled: applied.unfilled, total: applied.total, covers: applied.covers ?? 0 }
            console.log(`来源身份（导入这一步）：${result.name} 补到 ${applied.filled} 行 / 共 ${applied.total} 行，没补到 ${applied.unfilled} 行（对不上条目指纹的行一律不写）· 封面新补 ${applied.covers ?? 0} 行、仍无封面 ${applied.coverless ?? 0} 行（上游没给或这一家收不进白名单，界面照旧画占位）`)
          } catch (error) {
            publicResult.sourceIdentities = { filled: 0, unfilled: 0, total: 0, failed: true }
            console.log(`来源身份（导入这一步）没写进去：${String(error?.message ?? error).slice(0, 120)}`)
          }
        }
        return json(response, 200, publicResult)
      }
      // R198：展示封面 —— 点「播放已匹配的 N 条」之后给这张歌单选一张（`action: 'set'`），
      // 详情面板的「恢复程序化封面」删掉它（`action: 'clear'`）。
      // **零出网**：它只读写 sidecar 里那一格（`displayCoverRef` 本身不发起任何请求）；
      // 取图仍走既有的 `/api/online/artwork/<token>` → 缓存 →（必要时）guardedFetch，同一张主机白名单。
      const playlistDisplayCover = /^\/api\/playlists\/([^/]+)\/display-cover$/.exec(route)
      if (playlistDisplayCover) {
        let id
        try { id = slugOf(decodeURIComponent(playlistDisplayCover[1])) } catch (error) { return json(response, 400, { error: error.message }) }
        if (request.method !== 'POST') return json(response, 405, { error: '展示封面只接受 POST' })
        const body = await bodyJson(request).catch(() => ({}))
        const action = body?.action === 'clear' ? 'clear' : 'set'
        const result = await playlistMatcher.setDisplayCover(id, { clear: action === 'clear' })
        if (result.missing) return json(response, 404, { error: '没有这张歌单' })
        // 回执给的是**同源地址**（与服务端那一路同一口径）：第三方 URL 不出服务端。
        const view = await playlistMatcher.tracks(id)
        return json(response, 200, {
          action, changed: result.changed,
          displayCoverUrl: String(view?.displayCoverUrl ?? ''),
        })
      }
      // R220 · 老歌单「补一次来源身份」：按文件头的来历注释（`# kugou-playlist <id> imported …`）
      // 重新列一次那张账号歌单，把每行的 `sourceProvider + sourceMediaId [+ sourceMediaMid]` 写进 sidecar。
      // 三条边界：① **正文一个字都不改**（写的是派生文件）；② 没有来历注释 ⇒ 一句实话，不去猜它是哪家哪张；
      // ③ 报告按 R125/R126 的写法出数（补到几行 / 没补到几行），并进服务日志。
      const playlistIdentity = /^\/api\/playlists\/([^/]+)\/source-identity$/.exec(route)
      if (playlistIdentity) {
        if (!store.config.online?.search) return json(response, 404, { error: '在线能力已关闭：补来源身份需要联网（在音乐库面板里重新勾选即可恢复，该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '补来源身份只接受 POST' })
        let id
        try { id = slugOf(decodeURIComponent(playlistIdentity[1])) } catch (error) { return json(response, 400, { error: error.message }) }
        const playlist = await store.playlists.get(id)
        if (!playlist) return json(response, 404, { error: '没有这张歌单' })
        const provenance = readPlaylistProvenance(String(playlist.text ?? ''))
        if (!provenance?.provider || !provenance?.id) {
          return json(response, 200, { ok: false, error: '这张单没有"从哪家哪张账号歌单导入"的来历注释，补不了来源身份（自己写的文本、或导入时上游就没给 id，都在这一档）' })
        }
        const loaded = await playlistImporter.collect(provenance.provider, provenance.id)
        if (!loaded.ok) {
          return json(response, 200, { ok: false, error: `重新列这张账号歌单没成：${String(loaded.reason ?? '上游没给曲目').slice(0, 160)}` })
        }
        const applied = await playlistMatcher.applySourceIdentities(id, playlistImporter.identitiesOf(provenance.provider, loaded.items))
        console.log(`来源身份（补一次）：${playlist.name} ← ${provenance.provider} ${provenance.id}：补到 ${applied.filled} 行 / 共 ${applied.total} 行，没补到 ${applied.unfilled} 行 · 封面新补 ${applied.covers ?? 0} 行、仍无封面 ${applied.coverless ?? 0} 行`)
        return json(response, 200, { ok: true, provider: provenance.provider, sourceId: provenance.id, ...applied })
      }
      const playlistMatch = /^\/api\/playlists\/([^/]+)\/(match|tracks)$/.exec(route)
      if (playlistMatch) {
        let id
        try { id = slugOf(decodeURIComponent(playlistMatch[1])) } catch (error) { return json(response, 400, { error: error.message }) }
        const which = playlistMatch[2]
        if (which === 'tracks') {
          if (!get) return json(response, 405, { error: '歌单曲目只接受 GET' })
          const view = await playlistMatcher.tracks(id)
          if (!view) return json(response, 404, { error: '没有这张歌单' })
          return json(response, 200, view)
        }
        // 匹配会出网 ⇒ 它同时受"在线搜索"这张子开关管（它用的就是搜索门面）；关掉时零请求。
        if (!store.config.online?.search) return json(response, 404, { error: '在线搜索已关闭，歌单不再逐条联网匹配：在音乐库面板里重新勾选即可恢复（该项默认开启）' })
        if (request.method !== 'POST') return json(response, 405, { error: '歌单匹配只接受 POST' })
        const summary = await playlistMatcher.matchAll(id)
        if (summary.missing) return json(response, 404, { error: '没有这张歌单' })
        return json(response, 200, {
          total: summary.total, matched: summary.matched, failed: summary.failed,
          searches: summary.searches, sidecar: path.basename(store.playlists.matchFileOf(id)),
        })
      }
      const audio = /^\/api\/audio\/([a-zA-Z0-9-]+)$/.exec(route)
      const artwork = /^\/api\/artwork\/([a-zA-Z0-9-]+)$/.exec(route)
      const lyrics = /^\/api\/lyrics\/([a-zA-Z0-9-]+)$/.exec(route)
      if ((audio || artwork || lyrics) && get) {
        const file = audio ? store.trackFile(audio[1]) : artwork ? store.artworkFile(artwork[1]) : store.trackLyrics(lyrics[1])
        if (!file) return json(response, 404, { error: '索引中没有此文件' })
        // Sidecar lyrics are user-editable, so they keep the audio no-cache policy.
        return await serveFile(request, response, file, { cache: artwork ? 'private, max-age=3600' : 'private, no-cache' })
      }
      if (route === '/api/foobar/status' && get) return json(response, 200, { configured: !!store.config.foobarBaseUrl, baseUrl: store.config.foobarBaseUrl, connected: false, note: 'configured 仅代表已保存地址；连接状态需读取 /api/foobar/player 实际响应。' })
      if (route.startsWith('/api/foobar/')) {
        if (!store.config.foobarBaseUrl) return json(response, 503, { error: 'foobar2000 / Beefweb 尚未配置连接' })
        const suffix = route.slice('/api/foobar/'.length)
        if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(suffix) || !['GET', 'POST'].includes(request.method)) return json(response, 400, { error: '不支持的 Beefweb 请求' })
        const target = new URL(`/api/${suffix}`, store.config.foobarBaseUrl)
        target.search = url.search
        const payload = request.method === 'POST' ? JSON.stringify(await bodyJson(request)) : undefined
        const upstream = await fetch(target, { method: request.method, body: payload, headers: payload ? { 'Content-Type': 'application/json' } : {}, signal: AbortSignal.timeout(5000), redirect: 'error' })
        response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' })
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      if (route.startsWith('/api/')) return json(response, 404, { error: 'API 不存在或请求方法不支持' })
      if (!get) return json(response, 405, { error: '只接受 GET/HEAD' })
      const asset = path.resolve(distDir, `.${route === '/' ? '/index.html' : route}`)
      return await serveFile(request, response, { path: asset, allowedRoot: distDir }, { cache: route.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' })
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 400), { error: error.message })
      else response.destroy()
    }
  })
  server.requestTimeout = 30_000
  // 6.6（E1）：启动扫描的结果要留在服务日志里。原来 `void store.scan().catch(() => {})` 吞掉的是整轮结果 ——
  // 而 scan() 内部本就 try/catch（异常写进 scanStatus.error，promise 基本不会 reject），
  // 所以单挂 .catch 连"扫失败了"都看不见，用户侧只有一句"歌没出现"。
  if (autoScan) server.once('listening', () => {
    void store.scan().then((result) => {
      if (result?.skipped === 'no-roots') {
        console.log('启动扫描跳过：尚未配置音乐目录，保留现有索引。')
        return
      }
      for (const entry of result?.roots ?? []) if (entry.status === 'offline') console.warn(`启动扫描：${entry.path} 暂时离线（${entry.error ?? '未知原因'}），原索引已保留。`)
      if (result?.scan?.error) console.error(`启动扫描失败：${result.scan.error}`)
      else console.log(`启动扫描完成：${result?.albums?.length ?? 0} 张专辑。`)
      // 联网默认打开 ⇒ 扫描后会跟着排一轮在线资料补全。没配联系方式时它是整轮跳过，
      // 这件事必须留在日志里，否则用户只看到"开关是开的，怎么什么都没补到"。
      if (result?.enrich?.skipped === 'no-contact') console.log('在线资料补全跳过：尚未配置 MusicBrainz 联系方式（该项按 MusicBrainz 使用要求需要联系人标识）。本地浏览与播放不受影响。')
    }).catch((error) => console.error(`启动扫描失败：${error.message}`))
  })
  return { server, store, bridge }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portFlag = process.argv.indexOf('--port')
  const port = Number(portFlag >= 0 ? process.argv[portFlag + 1] : process.env.PORT ?? 5173)
  const { server, store, bridge } = await createMusicServer()
  server.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  server.listen(port, '127.0.0.1', async () => {
    console.log(`Rhine Local Music  http://127.0.0.1:${port}/`)
    console.log(`音乐索引：${store.dataDir}`)
    console.log(`音乐目录：${store.config.roots.join('、') || '尚未配置，在界面添加目录'}`)
    // 联网默认打开 ⇒ 启动时就把桥预热起来（第一次歌词匹配不该再等十几秒的三包冷启动）。
    // 四张子开关全关时 ensure() 根本不 spawn：这条调用在关闭态是零进程、零端口、零出网。
    if (ONLINE_SWITCHES.some((key) => store.config.online?.[key] !== false)) {
      bridge.ensure()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const warm = bridge.status()
      console.log(`在线后端：phase=${warm.phase}，宿主端口 ${warm.port || '（未就绪）'}，后端 ${warm.backends.map((b) => `${b.id}:${b.state}`).join(' ') || '（无）'}`)
    } else {
      console.log('在线后端：四张在线开关全部关闭 ⇒ 不启动桥子进程（零端口、零出网）。')
    }
  })
  // 关停次序（第五期 Task 3）：先让桥自己退（IPC shutdown → 1.5 秒内没退再 kill），再关本地 http server。
  // 反过来做的话，浏览器还会把请求打到已经没人应答的在线路由上。
  const close = () => {
    void bridge.shutdown().then(({ forced }) => {
      if (forced) console.warn('在线后端没有在 1.5 秒内自行退出，已强制结束（本地服务不受影响）。')
    }).finally(() => { server.closeAllConnections(); server.close(() => process.exit()) })
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}
