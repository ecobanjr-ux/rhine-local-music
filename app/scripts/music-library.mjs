import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { AlbumIntroductionProvider } from './album-introductions.mjs'
import { guardedMetadataFetch } from './online-guard.mjs'
import { PlaylistStore, resolvePlaylistDir } from './playlists.mjs'

const AUDIO_EXTENSIONS = new Set(['.flac', '.wav', '.m4a', '.mp4', '.alac', '.dsf', '.dff', '.mp3', '.aac', '.aiff', '.aif', '.ogg', '.opus'])
const BROWSER_EXTENSIONS = new Set(['.flac', '.wav', '.m4a', '.mp4', '.mp3', '.aac', '.ogg', '.opus'])
// Sidecar lyric files paired with a track by basename; .lrc is preferred when both exist.
const LYRIC_EXTENSIONS = new Set(['.lrc', '.ttml'])
const MBID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const unique = (items) => [...new Set(items.filter(Boolean))]
// 导出给歌单匹配复用（R76）：条目指纹必须与曲库的归一口径一致，另写一套归一就会有两份真源。
export const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24)
const text = (value) => typeof value === 'string' ? value.trim() : ''
export const normalized = (value) => text(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
const exists = async (file) => { try { await fs.access(file); return true } catch { return false } }
const statOrNull = async (file) => { try { return await fs.stat(file) } catch { return null } }
const timestamp = () => new Date().toISOString()
// Bump whenever the indexed track shape changes: a cached track carrying an older
// version is re-read instead of reused, which is how new fields get backfilled.
export const METADATA_VERSION = 3

// 图片缓存的扩展名档：认不出的类型不落盘（`cacheArtworkBytes` 返回 null）。
const ARTWORK_EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }
/**
 * 封面补全每张之间的间隔。实测：iTunes 检索连发 12 次（无间隔）全部 200，没观察到限流
 * ⇒ 这一档**不是**测出来的阈值，是主动留的余量：默认打开意味着每台机器启动后都会自己走一遍曲库，
 * 不该把用户的补图变成对上游的连发。
 */
const COVER_REQUEST_INTERVAL_MS = 1000
/** 已有结论多久之内不再重问：沿用专辑介绍那一份 7 天口径（同一件事在本仓只该有一个数）。 */
const COVER_LOOKUP_REUSE_MS = 7 * 86400_000

export const DEFAULT_RULES = {
  version: 1,
  genres: [
    { id: 'mandopop', name: '华语流行', aliases: ['Mandopop', '国语流行音乐', '华语流行音乐', '华语流行', '国语流行', 'Chinese Pop'] },
    { id: 'pop', name: '流行', aliases: ['Pop', '流行音乐'] },
    { id: 'rock', name: '摇滚', aliases: ['Rock', '摇滚音乐'] },
    { id: 'jazz', name: '爵士', aliases: ['Jazz', '爵士乐'] },
    { id: 'classical', name: '古典', aliases: ['Classical', '古典音乐'] },
    { id: 'electronic', name: '电子', aliases: ['Electronic', 'Electronica', '电子音乐'] },
    { id: 'ambient', name: '氛围', aliases: ['Ambient', '氛围音乐'] },
    { id: 'soundtrack', name: '原声', aliases: ['Soundtrack', 'OST', '原声音乐', '电影原声'] },
    { id: 'unclassified', name: '未分类', aliases: [] },
  ],
  albumOverrides: {},
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw new Error(`无法读取 ${file}: ${error.message}`) }
}

export function validateRules(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.genres) || value.genres.length > 1000 || !value.albumOverrides || typeof value.albumOverrides !== 'object' || Array.isArray(value.albumOverrides)) throw new Error('流派规则需要 version:1、genres 数组和 albumOverrides 对象')
  const ids = new Set()
  const genres = value.genres.map((genre) => {
    if (!genre || typeof genre.id !== 'string' || !/^[\w-]{1,100}$/.test(genre.id) || ids.has(genre.id) || !text(genre.name) || (genre.aliases !== undefined && (!Array.isArray(genre.aliases) || genre.aliases.some((alias) => typeof alias !== 'string')))) throw new Error('流派 ID 必须唯一，名称和别名必须为文本')
    ids.add(genre.id)
    return { id: genre.id, name: text(genre.name), aliases: unique((genre.aliases ?? []).map(text)) }
  })
  if (!ids.has('unclassified')) genres.push({ id: 'unclassified', name: '未分类', aliases: [] })
  ids.add('unclassified')
  const albumOverrides = {}
  for (const [id, genreId] of Object.entries(value.albumOverrides)) {
    if (!ids.has(genreId)) throw new Error(`专辑 ${id} 的人工流派 ${genreId} 不存在`)
    Object.defineProperty(albumOverrides, id, { value: genreId, enumerable: true, writable: true, configurable: true })
  }
  return { version: 1, genres, albumOverrides }
}

export function resolveGenre(album, rules) {
  const override = Object.hasOwn(rules.albumOverrides, album.id) ? rules.albumOverrides[album.id] : undefined
  if (override && rules.genres.some((genre) => genre.id === override)) return override
  const inputs = unique([...(album._onlineGenres ?? []), ...(album._localGenres ?? album.rawGenres ?? [])])
  for (const input of inputs) {
    const target = normalized(input)
    const match = rules.genres.find((genre) => [genre.name, genre.id, ...(genre.aliases ?? [])].some((alias) => normalized(alias) === target))
    if (match) return match.id
  }
  return inputs.length ? `source-${hash(normalized(inputs[0]))}` : 'unclassified'
}

export function safeRootList(roots) {
  if (!Array.isArray(roots) || roots.length > 64 || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0'))) throw new Error('音乐目录必须是绝对路径数组（最多 64 个）')
  // Nested roots would scan the same album twice; keep the highest selected root.
  return unique(roots.map((root) => path.resolve(root))).filter((root, _, all) => !all.some((parent) => parent !== root && root.startsWith(`${parent}${path.sep}`)))
}

function audioMime(file) {
  return ({ '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.mp3': 'audio/mpeg', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function imageMime(file) {
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' })[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function lyricMime(file) {
  return path.extname(file).toLowerCase() === '.ttml' ? 'application/ttml+xml; charset=utf-8' : 'text/plain; charset=utf-8'
}

/** Sidecar pairing compares NFC-normalised, case-folded basenames, like the cover pairing. */
const sidecarKey = (value) => path.parse(value).name.normalize('NFC').toLocaleLowerCase()

/** When a track has both, the line-timed .lrc wins over .ttml; order is stable otherwise. */
const lyricRank = (name) => path.extname(name).toLowerCase() === '.lrc' ? 0 : 1

/** Synchronized lyric timestamps are milliseconds; LRC carries centiseconds. */
function lrcTimestamp(value) {
  const milliseconds = Math.max(0, Math.floor(Number.isFinite(value) && value > 0 ? value : 0))
  const pad = (input) => String(input).padStart(2, '0')
  return `[${pad(Math.floor(milliseconds / 60_000))}:${pad(Math.floor(milliseconds / 1000) % 60)}.${pad(Math.floor(milliseconds / 10) % 100)}]`
}

const lyricLine = (entry) => `${lrcTimestamp(entry?.timestamp)}${text(entry?.text).replace(/[\r\n]+/g, ' ')}`

/** Root-level files are singles; nested folders are albums. Source files stay read-only. */
async function walkAlbums(root) {
  const folders = []
  const visit = async (folder) => {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    const files = entries.filter((entry) => entry.isFile())
    const tracks = files.filter((entry) => AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).map((entry) => path.join(folder, entry.name))
    if (tracks.length) {
      const images = files.filter((entry) => /\.(png|jpe?g|webp)$/i.test(entry.name))
      const preferred = ['cover', 'folder', 'front']
      images.sort((a, b) => {
        const rank = (entry) => { const value = preferred.indexOf(path.parse(entry.name).name.toLowerCase()); return value < 0 ? 99 : value }
        return rank(a) - rank(b) || a.name.localeCompare(b.name)
      })
      // Same-basename .lrc/.ttml pair per track, so albums and root singles share one lookup.
      const lyricFiles = files
        .filter((entry) => LYRIC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        .sort((a, b) => lyricRank(a.name) - lyricRank(b.name))
      const lyricsOf = (list) => new Map(list.map((file) => {
        const match = lyricFiles.find((entry) => sidecarKey(entry.name) === sidecarKey(file))
        return [file, match ? path.join(folder, match.name) : undefined]
      }))
      if (folder === root) {
        for (const file of tracks) {
          const name = path.parse(file).name.normalize('NFC').toLocaleLowerCase()
          const image = images.find((entry) => path.parse(entry.name).name.normalize('NFC').toLocaleLowerCase() === name)
          folders.push({ folder, tracks: [file], singleFile: file, cover: image ? path.join(folder, image.name) : undefined, lyrics: lyricsOf([file]) })
        }
      } else {
        folders.push({ folder, tracks, cover: images[0] ? path.join(folder, images[0].name) : undefined, lyrics: lyricsOf(tracks) })
      }
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(path.join(folder, entry.name))
  }
  await visit(root)
  return folders
}

const albumEntryId = (entry) => `album-${hash(entry.singleFile ?? entry.folder)}`
const firstString = (value) => Array.isArray(value) ? text(value[0]) : text(value)
const numberOrUndefined = (value) => Number.isFinite(value) && value > 0 ? value : undefined

/**
 * 联网能力的产品默认值（2026-10-04 用户定案：联网功能默认打开）。
 * 唯一真源：构造函数的初始配置、init() 对磁盘缺项/意外值的回落，都读这一处，
 * 免得"默认开启"这件事在两个文件里各写一遍而漂掉。设置面板的文案由断言钉住与它同步。
 *
 * R77（第五期）：`onlineLyrics.enabled` 那一项换成四张子开关 `online.{lyrics,search,streaming,covers}`。
 * 理由：搜索/试听/封面的风险面与歌词不同（歌词只读文本，试听会流出音频字节），
 * 一个开关管四件事等于没有开关。旧字段在一个版本期内**只读**（见 init 的归并与 updateConfig 的兼容分支）。
 */
export const ONLINE_SWITCHES = ['lyrics', 'search', 'streaming', 'covers']
export const ONLINE_DEFAULTS = {
  onlineEnabled: true,
  online: Object.fromEntries(ONLINE_SWITCHES.map((key) => [key, true])),
}

/** 把磁盘上的开关表归一成四键布尔表；缺项落回产品默认，意外值落回默认并留一句日志。 */
function normalizeOnlineSwitches(stored, legacyLyrics) {
  const online = {}
  for (const key of ONLINE_SWITCHES) online[key] = pickOnlineSwitch(stored?.[key], ONLINE_DEFAULTS.online[key], `online.${key}`)
  // 旧字段只在"新表里那一项目前还没被写过"时才说话——新表是唯一的持久化真源。
  if (legacyLyrics !== undefined && stored?.lyrics === undefined) {
    online.lyrics = pickOnlineSwitch(legacyLyrics, ONLINE_DEFAULTS.online.lyrics, 'onlineLyrics.enabled（旧字段）')
  }
  return online
}

/** 磁盘上的联网开关：只有布尔值才算"用户表过态"；缺项静默落回产品默认（正常升级路径），
 *  写了却不是布尔值（"yes" / 1 / 手写坏的 JSON）才落回默认并留一句日志。 */
function pickOnlineSwitch(stored, fallback, label) {
  if (typeof stored === 'boolean') return stored
  if (stored !== undefined) console.warn(`config.json 里的 ${label} 不是布尔值（${JSON.stringify(stored)}），按默认值 ${fallback} 处理。`)
  return fallback
}

export class MusicLibraryStore {
  constructor({ dataDir, defaultRoots = [], metadataParser = parseFile, fetcher = guardedMetadataFetch, musicBrainzContact = process.env.MUSICBRAINZ_CONTACT, introductionProvider, coverProvider, onChange = () => {} }) {
    this.dataDir = path.resolve(dataDir)
    this.defaultRoots = defaultRoots
    this.parseFile = metadataParser
    this.fetcher = fetcher
    this.musicBrainzContact = musicBrainzContact
    this.environmentContact = musicBrainzContact
    this.onChange = onChange
    // R161（任务八）：`playReporting` **缺省关**——这一项与上面几项不同，它不是"要不要联网取东西"，
    // 而是"要不要把我在听什么**送出去**"。方向相反，所以缺省必须是关（隐私口径由缺省值承担，不由文案承担）。
    this.config = { version: 1, roots: [], onlineEnabled: ONLINE_DEFAULTS.onlineEnabled, online: { ...ONLINE_DEFAULTS.online }, preferLoggedInSource: false, preferSamePlatformSource: true, playReporting: false, kugouDeviceIdentity: false, foobarBaseUrl: null, playlistDir: null }
    this.index = { version: 1, albums: [], roots: [], scannedAt: null }
    this.rules = structuredClone(DEFAULT_RULES)
    this.scanStatus = { running: false }
    this.enrichStatus = { running: false, completed: 0, total: 0 }
    this.introductionsStatus = { running: false, completed: 0, total: 0, updated: 0, notFound: 0, failed: 0 }
    this.coverStatus = { running: false, completed: 0, total: 0, matched: 0, notFound: 0, failed: 0 }
    // 在线封面补全的提供者由**装配层注入**（曲库不 import online-covers，那边反过来 import 本模块的
    // `normalized`：归一口径必须只有一份，而 import 只能有一个方向）。没注入就整轮跳过。
    this.coverProvider = coverProvider ?? null
    this.introductionProvider = introductionProvider ?? new AlbumIntroductionProvider({ fetcher, contact: () => this.musicBrainzContact })
    this.lastMusicBrainzRequest = 0
    this.saveChain = Promise.resolve()
    // 歌单实体（第五期 Task 8）：与 genre-rules 同构地挂在曲库上，共享同一个 dataDir。
    // 它自己**不缓存内容**——每次 get/list 都重读磁盘，所以用户在编辑器里改完就是生效了。
    this.playlists = new PlaylistStore({ dataDir: this.dataDir })
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true })
    await this.playlists.init()                       // 只建 dataDir/playlists 目录，不读内容（读是每请求的事）
    this.config = await readJson(path.join(this.dataDir, 'config.json'), { ...this.config, roots: safeRootList(this.defaultRoots) })
    this.musicBrainzContact = this.config.musicBrainzContact || this.environmentContact
    this.config.roots = safeRootList(this.config.roots)
    // 联网功能默认打开（2026-10-04 定案）。归一规则两句话：
    //   ① 磁盘上是**明确布尔值**时以它为准 —— 用户在面板里关掉的那一项，重启后仍是关；
    //   ② 缺项（旧库根本没写过这一项）或意外值（"yes" / 1 / 缺 enabled）一律落回产品默认（开启），
    //      而不是把"没写过"读成"用户关过"。旧实现是"非 true 即关闭"，在默认开启下会让
    //      一次手滑的配置编辑静默关掉在线能力，且用户无从察觉。
    this.config.onlineEnabled = pickOnlineSwitch(this.config.onlineEnabled, ONLINE_DEFAULTS.onlineEnabled, 'onlineEnabled')
    this.config.online = normalizeOnlineSwitches(this.config.online, this.config.onlineLyrics?.enabled)
    // R156（任务三）：同平台优先**缺省开**（用户在本批明确要的行为），但"磁盘上没写过"不等于"用户关过"——
    // 与 R72 那条同一口径：**只有明确布尔值才算表过态**，缺项落回产品默认、意外值落回默认并留一句日志。
    this.config.preferSamePlatformSource = pickOnlineSwitch(
      this.config.preferSamePlatformSource, true, 'preferSamePlatformSource')
    // 歌单目录（F3）：磁盘上存的是用户选的那个，认不出来（相对路径、盘根…）就退回默认，
    // 而不是让启动整个失败——老库升级上来时这个字段根本不存在。
    try {
      this.playlists.useDir(resolvePlaylistDir(this.config.playlistDir, this.dataDir))
    } catch {
      this.config.playlistDir = null
      this.playlists.useDir(null)
    }
    // R77：旧字段归并完就从内存与磁盘（init 结尾会回写 config.json）一起退场，
    // 不让它成为第二处真源；面板那侧看到的 onlineLyrics 是 snapshot() 现算的镜像。
    delete this.config.onlineLyrics
    this.index = await readJson(path.join(this.dataDir, 'library-index.json'), this.index)
    if (this.index.version !== 1 || !Array.isArray(this.index.albums)) throw new Error('曲库索引版本或格式不受支持，已保留原文件')
    this.rules = validateRules(await readJson(path.join(this.dataDir, 'genre-rules.json'), DEFAULT_RULES))
    if (!(await exists(path.join(this.dataDir, 'genre-rules.json')))) await writeJsonAtomic(path.join(this.dataDir, 'genre-rules.json'), this.rules)
    await writeJsonAtomic(path.join(this.dataDir, 'config.json'), this.config)
    return this
  }

  saveIndex() {
    // Serialize snapshots so an enrichment finishing during a scan cannot leave
    // an older snapshot on disk after a newer one has been written.
    const snapshot = structuredClone(this.index)
    this.saveChain = this.saveChain.catch(() => {}).then(() => writeJsonAtomic(path.join(this.dataDir, 'library-index.json'), snapshot))
    return this.saveChain
  }

  async reloadRules() {
    this.rules = validateRules(await readJson(path.join(this.dataDir, 'genre-rules.json'), DEFAULT_RULES))
  }

  async updateRules(value) {
    const rules = validateRules(value)
    const file = path.join(this.dataDir, 'genre-rules.json')
    if (await exists(file)) await fs.copyFile(file, `${file}.backup`)
    await writeJsonAtomic(file, rules)
    this.rules = rules
    this.onChange()
    return rules
  }

  async updateConfig(value) {
    const next = { ...this.config }
    if (value.roots !== undefined) next.roots = safeRootList(value.roots)
    // 歌单目录（F3）：校验与切换都走 resolvePlaylistDir（非法就是抛 ⇒ 路由变 400），
    // 这里只负责"改指向"；把老目录里的单子复制过来是路由那一步的事（要给用户报数）。
    if (value.playlistDir !== undefined) {
      next.playlistDir = resolvePlaylistDir(value.playlistDir, this.dataDir)
      this.playlists.useDir(next.playlistDir)
      await this.playlists.ensureDir()
    }
    if (value.onlineEnabled !== undefined) {
      if (typeof value.onlineEnabled !== 'boolean') throw new Error('onlineEnabled 必须为布尔值')
      next.onlineEnabled = value.onlineEnabled
    }
    // R143（任务四）：「匹配时优先已登录音源」。**故意不放进 `online` 那张表**——
    // 那四家是"要不要出网"的开关，这一项是"出网之后挑哪一条"的偏好，性质不同；
    // 而且那张表有"不认识的键就拒"的把关，塞进去等于把两类东西混进一个名字空间。
    // 缺省 **false**：不打开时匹配行为与今天逐字一致（最保守读法）。
    if (value.preferLoggedInSource !== undefined) {
      if (typeof value.preferLoggedInSource !== 'boolean') throw new Error('preferLoggedInSource 必须为布尔值')
      next.preferLoggedInSource = value.preferLoggedInSource
    }
    // R156（任务三）：同平台优先的开关。**缺省 true**（用户本批明确要的行为），归一在 init 那一侧做
    // （"没写过"不等于"关过"）。与上面两条同理：不放进 `online` 那张表——那张管"要不要出网"，
    // 这一项管"出网之后挑哪一条"。
    if (value.preferSamePlatformSource !== undefined) {
      if (typeof value.preferSamePlatformSource !== 'boolean') throw new Error('preferSamePlatformSource 必须为布尔值')
      next.preferSamePlatformSource = value.preferSamePlatformSource
    }
    // R161（任务八）：播放上报开关。**缺省 false**（关），且不在 `online` 那张表里——
    // 那张表管"要不要出网取东西"，这一项管"要不要把听歌事实送出去"，方向相反，
    // 混进一张表就会让"关掉在线能力"与"关掉上报"变成同一件事（用户可能只想关后者）。
    // 归一**故意不做**在 init 那一侧：这一项的缺省是 false，"盘上没写过"与"用户关过"结果一样，
    // 不需要 R72 那套"只有明确表过态才算"的区分（那条纪律是给缺省开的项准备的）。
    if (value.playReporting !== undefined) {
      if (typeof value.playReporting !== 'boolean') throw new Error('playReporting 必须为布尔值')
      next.playReporting = value.playReporting
    }
    // R154（任务一）：酷狗**设备身份备用路**的开关，缺省 **false**。
    // 为什么默认关：本批一手实测证明酷狗要的是"别塞一个随机设备号"（显式带空 dfid 就 200 给整首），
    // **不是**"必须注册一台设备" ⇒ 那条被用户批准的伪装路线今天用不上，就不该默认消耗它。
    // 打开后唯一的差别是：撞上"需要设备校验"（上游 20028）时允许调一次 `register_dev` 换 dfid 再重试一次。
    // 与 preferLoggedInSource 同理：**不放进 `online` 那张表**（那张管"要不要出网"，这一项管"以什么身份出"）。
    if (value.kugouDeviceIdentity !== undefined) {
      if (typeof value.kugouDeviceIdentity !== 'boolean') throw new Error('kugouDeviceIdentity 必须为布尔值')
      next.kugouDeviceIdentity = value.kugouDeviceIdentity
    }
    if (value.online !== undefined) {
      const raw = value.online
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('online 必须是 { lyrics, search, streaming, covers } 的布尔表')
      const unknown = Object.keys(raw).filter((key) => !ONLINE_SWITCHES.includes(key))
      if (unknown.length) throw new Error(`online 里有不认识的开关：${unknown.join('、')}`)
      for (const key of Object.keys(raw)) if (typeof raw[key] !== 'boolean') throw new Error(`online.${key} 必须为布尔值`)
      next.online = { ...next.online, ...raw }
    }
    // 旧字段 `onlineLyrics.enabled` 在一个版本期内继续接受（设置面板今天还只发这一项），
    // 但它写的其实是 online.lyrics —— 两处同时提交且不一致就是真源漂移，直接拒。
    if (value.onlineLyrics !== undefined) {
      const raw = value.onlineLyrics
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('onlineLyrics 必须是 { enabled: true|false }')
      const keys = Object.keys(raw)
      if (keys.length !== 1 || keys[0] !== 'enabled') throw new Error('onlineLyrics 只接受 enabled 一项')
      if (typeof raw.enabled !== 'boolean') throw new Error('onlineLyrics.enabled 必须为布尔值')
      if (value.online?.lyrics !== undefined && value.online.lyrics !== raw.enabled) {
        throw new Error('online.lyrics 与旧字段 onlineLyrics.enabled 冲突：请只提交一项')
      }
      next.online = { ...next.online, lyrics: raw.enabled }
    }
    if (value.musicBrainzContact !== undefined) {
      if (typeof value.musicBrainzContact !== 'string' || value.musicBrainzContact.length > 500 || /[\r\n]/.test(value.musicBrainzContact)) throw new Error('MusicBrainz 联系方式必须是邮箱或项目网址')
      const contact = value.musicBrainzContact.trim()
      if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^https?:\/\/\S+$/.test(contact)) throw new Error('请输入有效的联系邮箱或 http(s) 项目网址')
      next.musicBrainzContact = contact
    }
    if (value.foobarBaseUrl !== undefined) {
      if (!value.foobarBaseUrl) next.foobarBaseUrl = null
      else {
        const url = new URL(value.foobarBaseUrl)
        if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('foobar 仅允许本机 HTTP 地址，例如 http://127.0.0.1:8880')
        next.foobarBaseUrl = url.origin
      }
    }
    await writeJsonAtomic(path.join(this.dataDir, 'config.json'), next)
    this.config = next
    this.musicBrainzContact = next.musicBrainzContact || this.environmentContact
    // 响应里带上新表那一项的镜像（磁盘与内存里都只有 `online` 一份）：设置面板今天读的还是旧字段名。
    return { ...next, onlineLyrics: { enabled: next.online.lyrics === true } }
  }

  snapshot() {
    const counts = new Map()
    const generated = new Map()
    const albums = this.index.albums.filter((album) => this.config.roots.includes(album._root)).map((album) => {
      const genreId = resolveGenre(album, this.rules)
      counts.set(genreId, (counts.get(genreId) ?? 0) + 1)
      if (genreId.startsWith('source-')) generated.set(genreId, { id: genreId, name: album._onlineGenres?.[0] ?? album._localGenres?.[0] ?? album.rawGenres[0] })
      return {
        id: album.id, title: album.title, artist: album.artist, year: album.year, discCount: album.discCount,
        description: album.descriptionSource?.url ? album.description : undefined, descriptionSource: album.descriptionSource?.url ? album.descriptionSource : undefined,
        localNote: album.localNote,
        introduction: album.introduction,
        // 补图结论原样回读（`matched|not-found|error` + 逐源原因）：界面上"这张为什么还是空"
        // 该有一句真话可说，而不是让用户对着渐变占位猜是网络问题还是上游真没图。
        coverLookup: album.coverLookup,
        genreId, rawGenres: unique([...(album._onlineGenres ?? []), ...(album._localGenres ?? [])]),
        folder: album.folder, coverUrl: album._cover ? `/api/artwork/${album.id}?v=${album._cover.version}` : undefined,
        tracks: album.tracks.map(({ _path, _fingerprint, _common, _embeddedCover, _metadataVersion, _lyrics, ...track }) => track),
        producers: album.producers ?? [], offline: !!album.offline,
        online: album.online ?? { status: 'unqueried' },
      }
    })
    const genres = [...this.rules.genres, ...generated.values()].filter((genre) => counts.has(genre.id)).map((genre) => ({ ...genre, albumCount: counts.get(genre.id) ?? 0 }))
    return {
      version: 1, albums, genres,
      roots: this.config.roots.map((root) => this.index.roots.find((entry) => entry.path === root) ?? { path: root, status: 'unscanned' }),
      scan: { ...this.scanStatus }, onlineEnabled: !!this.config.onlineEnabled, enrich: { ...this.enrichStatus },
      onlineLyrics: { enabled: this.config.online?.lyrics === true },
      online: { ...ONLINE_DEFAULTS.online, ...this.config.online },
      introductions: { ...this.introductionsStatus },
      covers: { ...this.coverStatus },
      // 面板要显示的是**当前真正在用的那个目录**（不是配置里可能为 null 的那一项）
      playlistDir: this.playlists.dir,
      playlistDirDefault: this.playlists.defaultDir,
    }
  }

  async scan({ roots } = {}) {
    if (this.scanPromise) return this.scanPromise
    this.scanStatus = { running: true, startedAt: timestamp() }
    this.scanPromise = (async () => {
      // 与 enrich()/introductions() 同样的"先让出一拍"：this.scanPromise 是在这个 IIFE 开始执行之后才赋值的，
      // 零根护栏会在第一个 await 之前就 return，若不同步让出，finally 里的 scanPromise=null 会被随后的赋值盖掉
      // ⇒ 留下一把永不落地的锁，此后改根目录一律 409、点重新扫描一律 202 只回旧快照（真实服务端复验抓到）。
      await Promise.resolve()
      try {
        if (roots !== undefined) await this.updateConfig({ roots })
        // 6.6 数据丢失级护栏：一个根目录都没配时**什么都不做**，而不是把索引扫成空。
        // 触发场景（第四期实测撞过）：另一个实例用同一 dataDir 但环境里没有根目录 ⇒ config 的 roots 为空
        // ⇒ snapshot() 本就按 roots 过滤（看不到专辑），若继续扫下去会把 albums:[] 写回
        // library-index.json，缓存被永久清空 —— 需要重扫全部文件才能恢复。
        // 注意只拦"零根"：配了目录但目录本身消失，仍走下面的 offline 分支保留专辑记录。
        if (!this.config.roots.length) {
          this.scanStatus.skipped = 'no-roots'
          this.scanStatus.finishedAt = timestamp()
          return { ...this.snapshot(), skipped: 'no-roots' }
        }
        await this.reloadRules()
        const nextAlbums = []
        const nextRoots = []
        for (const root of this.config.roots) {
          const previous = this.index.albums.filter((album) => album._root === root)
          try {
            const stat = await fs.stat(root)
            if (!stat.isDirectory()) throw new Error('根目录不是文件夹')
            // Finish enumeration before replacing anything: partial permission
            // failures must never masquerade as deletions.
            const folders = await walkAlbums(root)
            const rootAlbums = []
            const previousById = new Map(previous.map((album) => [album.id, album]))
            for (const folder of folders) rootAlbums.push(await this.readAlbum(root, folder, previousById.get(albumEntryId(folder))))
            nextAlbums.push(...rootAlbums)
            nextRoots.push({ path: root, status: 'online' })
          } catch (error) {
            nextRoots.push({ path: root, status: 'offline', error: error.message })
            nextAlbums.push(...previous.map((album) => ({ ...album, offline: true })))
          }
        }
        // A concurrent online request may have updated the prior objects.
        for (const album of nextAlbums) {
          const current = this.index.albums.find((entry) => entry.id === album.id)
          if (current?.online?.checkedAt && (!album.online?.checkedAt || current.online.checkedAt > album.online.checkedAt)) {
            album.online = current.online
            album._onlineGenres = current._onlineGenres
            album.description = current.description
            album.descriptionSource = current.descriptionSource
            album.producers = uniqueProducers([...(album.producers ?? []).filter((person) => person.source !== 'MusicBrainz'), ...current.producers.filter((person) => person.source === 'MusicBrainz')])
          }
          if (current?.introduction?.checkedAt && current.title === album.title && current.artist === album.artist && current.year === album.year && (!album.introduction?.checkedAt || current.introduction.checkedAt > album.introduction.checkedAt)) {
            album.introduction = current.introduction
            album.description = current.description
            album.descriptionSource = current.descriptionSource
          }
        }
        this.index = { version: 1, albums: nextAlbums, roots: nextRoots, scannedAt: timestamp() }
        await this.saveIndex()
        this.scanStatus.finishedAt = timestamp()
      } catch (error) {
        this.scanStatus.error = error.message
      } finally {
        this.scanStatus.running = false
        this.scanPromise = null
        this.onChange()
      }
      if (this.config.onlineEnabled) void this.enrich().catch(() => {})
      // 扫描排后补一轮封面（M3-c）：判据在 `backfillCovers` 里（只挑"当前无封面"的专辑），
      // 这里只管开关。R77 的第四张子开关 `online.covers` 关掉 ⇒ 这一轮一次请求都不发。
      if (this.config.onlineEnabled && this.coverProvider && this.config.online?.covers !== false) {
        void this.backfillCovers().catch(() => {})
      }
      return this.snapshot()
    })()
    return this.scanPromise
  }

  async readAlbum(root, entry, previous) {
    const id = albumEntryId(entry)
    let fileCover
    if (entry.cover) {
      const stat = await fs.stat(entry.cover)
      fileCover = { path: entry.cover, mime: imageMime(entry.cover), version: hash(`${entry.cover}:${stat.size}:${stat.mtimeMs}`), embedded: false }
    }
    // A single owns its embedded artwork; a matching image is only a fallback.
    let cover = entry.singleFile ? undefined : fileCover
    const tracks = []
    for (const file of entry.tracks) {
      const stat = await fs.stat(file)
      const sidecarPath = entry.lyrics?.get(file)
      const sidecar = sidecarPath ? await statOrNull(sidecarPath) : null
      // A sidecar lyric file is edited in place, so its fingerprint belongs in the cache key:
      // adding, touching or deleting one must re-read the track instead of serving the stale entry.
      const fingerprint = `${stat.size}:${stat.mtimeMs}${sidecar ? `:lyrics:${sidecar.size}:${sidecar.mtimeMs}` : ''}`
      const old = previous?.tracks.find((track) => track._path === file)
      if (old?._fingerprint === fingerprint && old._metadataVersion === METADATA_VERSION && (cover || old._embeddedCover !== undefined)) {
        tracks.push(old)
        if (!cover && old._embeddedCover) cover = old._embeddedCover
        continue
      }
      let metadata
      let metadataError
      try { metadata = await this.parseFile(file, { duration: true, skipCovers: !!cover }) }
      catch (error) { metadataError = error.message; metadata = { common: {}, format: {} } }
      const common = metadata.common ?? {}
      let embedded = null
      if (!cover) {
        const picture = common.picture?.find((image) => /front/i.test(image.type ?? '')) ?? common.picture?.[0]
        if (picture?.data?.length && picture.data.length < 30 * 1024 * 1024) {
          const mime = picture.format === 'image/jpg' ? 'image/jpeg' : picture.format
          const cached = await this.cacheArtworkBytes(picture.data, mime)
          if (cached) { embedded = { ...cached, embedded: true }; cover = embedded }
        }
      }
      const extension = path.extname(file).toLowerCase()
      const trackId = `track-${hash(file)}`
      // Only a sidecar that still exists counts as a source; a vanished file falls back to the tag.
      const lyrics = await this.resolveLyrics({ sidecarPath: sidecar ? sidecarPath : undefined, tags: common.lyrics })
      const discPrefix = path.basename(file).match(/^(\d{1,2})[-_](\d{1,3})(?:[\s._-]|$)/)
      const discNumber = numberOrUndefined(common.disk?.no) ?? (discPrefix ? numberOrUndefined(Number(discPrefix[1])) : undefined)
      const trackNumber = numberOrUndefined(common.track?.no) ?? (discPrefix ? numberOrUndefined(Number(discPrefix[2])) : undefined)
      tracks.push({
        id: trackId, albumId: id, title: text(common.title) || path.parse(file).name,
        artist: text(common.artist) || text(common.albumartist) || '未知艺术家',
        trackNumber, discNumber,
        duration: Number.isFinite(metadata.format?.duration) ? metadata.format.duration : 0,
        format: extension.slice(1).toUpperCase(), codec: metadata.format?.codec,
        bitsPerSample: numberOrUndefined(metadata.format?.bitsPerSample), sampleRate: numberOrUndefined(metadata.format?.sampleRate),
        bitrate: numberOrUndefined(metadata.format?.bitrate), numberOfChannels: numberOrUndefined(metadata.format?.numberOfChannels),
        lossless: typeof metadata.format?.lossless === 'boolean' ? metadata.format.lossless : undefined,
        browserPlayable: BROWSER_EXTENSIONS.has(extension), audioUrl: `/api/audio/${trackId}`,
        // Tracks without any lyric source omit the field entirely; the UI must not see a null.
        ...(lyrics ? { lyrics: { source: lyrics.source, format: lyrics.format, url: `/api/lyrics/${trackId}` } } : {}),
        relativePath: path.relative(root, file),
        _path: file, _fingerprint: fingerprint, _metadataVersion: METADATA_VERSION,
        _common: {
          album: text(common.album), albumartist: text(common.albumartist), year: numberOrUndefined(common.year),
          genres: unique((common.genre ?? []).map(text)), producers: unique((common.producer ?? []).map(text)),
          releaseId: firstString(common.musicbrainz_albumid), releaseGroupId: firstString(common.musicbrainz_releasegroupid),
          discTotal: numberOrUndefined(common.disk?.of), discNumberSource: common.disk?.no ? 'tag' : discPrefix ? 'filename' : undefined,
          comments: (common.comment ?? []).map((comment) => typeof comment === 'string' ? comment : text(comment.text)).filter(Boolean),
          ...(metadataError ? { metadataError } : {}),
        },
        _embeddedCover: cover && !embedded ? undefined : embedded,
        _lyrics: lyrics,
      })
    }
    cover ??= fileCover
    tracks.sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999) || a.relativePath.localeCompare(b.relativePath, 'zh-CN', { numeric: true }))
    const first = tracks[0]
    const localGenres = unique(tracks.flatMap((track) => track._common.genres))
    const releaseId = tracks.map((track) => track._common.releaseId).find((value) => MBID.test(value))
    const releaseGroupId = tracks.map((track) => track._common.releaseGroupId).find((value) => MBID.test(value))
    const title = entry.singleFile ? first?.title || path.parse(entry.singleFile).name : first?._common.album || path.basename(entry.folder)
    const artist = (entry.singleFile ? first?.artist : first?._common.albumartist || first?.artist) || '未知艺术家'
    const unchangedIdentity = previous && title === previous.title && artist === previous.artist && first?._common.year === previous.year && tracks.length === previous.tracks.length && (!releaseId || releaseId === previous.online?.releaseId)
    // 在线补来的封面**不是从文件推出来的**，所以单独存一份 `onlineCover`，每次重扫按
    // "文件夹 → 内嵌 → 在线"的优先级现算 `_cover`。为什么不直接把上一次的 `_cover` 带过来：
    // 中间那一档 —— 用户放了 Cover.png 又删掉，"之前补的那张"必须还在，
    // 否则删一下本地封面就永久丢掉在线结果（还得再出一次网才知道）。
    // 缓存文件被清掉过就当场丢掉，不留一条指向空洞的路由。
    let onlineCover = unchangedIdentity ? previous.onlineCover : undefined
    if (onlineCover && !await exists(onlineCover.path)) onlineCover = undefined
    cover ??= onlineCover
    return {
      id, title, artist, year: first?._common.year,
      discCount: Math.max(1, ...tracks.map((track) => track._common.discTotal ?? track.discNumber ?? 1)),
      localNote: unique(tracks.flatMap((track) => track._common.comments ?? [])).join('\n') || undefined,
      description: unchangedIdentity && previous.descriptionSource?.url ? previous.description : undefined,
      descriptionSource: unchangedIdentity && previous.descriptionSource?.url ? previous.descriptionSource : undefined,
      introduction: unchangedIdentity ? previous.introduction : undefined,
      // 补图结论跟着身份走：身份没变就保留"上次查过、没有"，免得每次重扫都替同一张专辑再出一次网。
      coverLookup: unchangedIdentity ? previous.coverLookup : undefined,
      onlineCover,
      genreId: 'unclassified', rawGenres: localGenres,
      folder: entry.folder, tracks, offline: false,
      producers: uniqueProducers([
        ...tracks.flatMap((track) => track._common.producers.map((name) => ({ name, role: 'producer', source: 'local', trackTitle: track.title }))),
        ...(unchangedIdentity ? (previous.producers ?? []).filter((person) => person.source !== 'local') : []),
      ]),
      online: unchangedIdentity ? previous.online : { status: 'unqueried', releaseId, releaseGroupId },
      _root: root, _cover: cover, _localGenres: localGenres,
      _onlineGenres: unchangedIdentity ? previous._onlineGenres ?? [] : [],
    }
  }

  trackFile(id) {
    for (const album of this.index.albums) if (this.config.roots.includes(album._root)) {
      const track = album.tracks.find((entry) => entry.id === id)
      if (track) return { path: track._path, mime: audioMime(track._path), allowedRoot: album._root }
    }
    return null
  }

  /**
   * Picks one lyric source per track. An explicit sidecar file beats an embedded tag:
   * this service never rewrites tags, so dropping a corrected .lrc beside the audio is
   * the only way a user can fix lyrics, and it has to win to take effect.
   */
  async resolveLyrics({ sidecarPath, tags }) {
    if (sidecarPath) return { path: sidecarPath, source: 'sidecar', format: path.extname(sidecarPath).toLowerCase() === '.ttml' ? 'ttml' : 'lrc' }
    const entries = Array.isArray(tags) ? tags.filter(Boolean) : []
    const synced = entries.find((entry) => Array.isArray(entry.syncText) && entry.syncText.length)
    if (synced) return { path: await this.writeLyricsFile(synced.syncText.map(lyricLine).join('\n'), '.lrc'), source: 'embedded', format: 'lrc' }
    const plain = entries.map((entry) => text(entry.text)).find(Boolean)
    if (plain) return { path: await this.writeLyricsFile(plain, '.txt'), source: 'embedded', format: 'lyrics' }
    return undefined
  }

  /** Content-addressed like artwork, so identical lyrics share one cached file. */
  async writeLyricsFile(body, extension) {
    const target = path.join(this.dataDir, 'lyrics', `${hash(body)}${extension}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (!(await exists(target))) await fs.writeFile(target, `${body}\n`, { mode: 0o600 })
    return target
  }

  /**
   * 内容寻址的图片缓存 —— **全仓只有这一处**把图片写进 `dataDir/artwork`
   * （内嵌封面与在线补图都走它，同一份命名、同一份权限、同一句"已存在就不覆盖"）。
   * 判据只留一处的道理与 M3-b 的 scope 那条相同：两处各写一套，迟早会漂成"内嵌的能显示、在线的不行"。
   * 认不出的 mime 返回 null：不猜扩展名，也不把未知内容当成图片落盘。
   */
  async cacheArtworkBytes(data, mime) {
    const extension = ARTWORK_EXTENSIONS[mime]
    if (!extension || !data?.length) return null
    const version = hash(data)
    const target = path.join(this.dataDir, 'artwork', `${version}${extension}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (!(await exists(target))) await fs.writeFile(target, data, { mode: 0o600 })
    return { path: target, mime, version }
  }

  /**
   * 在线封面补全一轮（第五期 M3-c）。与 `updateIntroductions` 同形状，因为要守的是同一批事：
   *   · **选取判据只有一条**：这张专辑当前**没有任何封面**（内嵌与同目录文件都没有）⇒
   *     本地有图永远赢，这条把"补图"关在"显示"之外，绝不覆盖用户自己放进文件夹的封面；
   *   · 逐张串行 + 每两张之间让出一拍（`COVER_REQUEST_INTERVAL_MS`）：默认打开意味着每个用户的曲库
   *     都会在启动后自己走一遍，不能把它变成对上游的连发；
   *   · 连续 3 次访问失败就停在这一轮（不静默重试风暴），但**状态仍逐张落**，可回读、可再触发；
   *   · 每张的结果写进 `album.coverLookup`（`matched|not-found|error` + 时间 + 逐源原因），
   *     "没查到"与"查不到"分开记；只有 matched 才写图片文件与 `_cover`。
   * `provider` 没注入时整轮跳过（自检与不带在线模块的部署都不该因为缺一个提供者就抛）。
   */
  async backfillCovers({ albumIds, force = false } = {}) {
    if (this.coverPromise) return this.coverPromise
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    if (!this.coverProvider) {
      this.coverStatus = { running: false, completed: 0, total: 0, skipped: 'no-provider' }
      return this.snapshot()
    }
    const selected = this.index.albums.filter((album) => {
      if (!this.config.roots.includes(album._root) || album.offline) return false
      if (albumIds && !albumIds.includes(album.id)) return false
      // 有封面（本地或已补过）的一律不碰：这条判据是本功能的第一红线。
      if (album._cover) return false
      if (force) return true
      const checked = album.coverLookup?.checkedAt
      return !(album.coverLookup?.status && checked && Date.now() - Date.parse(checked) <= COVER_LOOKUP_REUSE_MS)
    }).map((album) => ({ id: album.id, title: album.title, artist: album.artist, year: album.year, releaseId: album.online?.releaseId }))
    this.coverStatus = { running: true, completed: 0, total: selected.length, matched: 0, notFound: 0, failed: 0 }
    this.coverPromise = (async () => {
      await Promise.resolve()
      let consecutiveFailures = 0
      try {
        for (const [index, album] of selected.entries()) {
          // 每两张之间让出一拍（第一张不必等）：既是给上游留余量，也是让前端轮询能看见进度。
          if (index) await new Promise((resolve) => setTimeout(resolve, COVER_REQUEST_INTERVAL_MS))
          this.coverStatus.currentAlbum = album.title
          this.onChange()
          let outcome
          try { outcome = await this.coverProvider.lookup(album) }
          catch (error) { outcome = { status: 'error', error: error.message } }
          const current = this.index.albums.find((entry) => entry.id === album.id)
          // 扫库可能在我们出网这几秒里换掉了这张的记录：身份对不上就整张丢弃，不给旧结果配新封面。
          const identityIntact = current && current.title === album.title && current.artist === album.artist && !current._cover
          if (outcome?.status === 'matched' && identityIntact) {
            const cached = await this.cacheArtworkBytes(outcome.bytes, outcome.mime)
            if (cached) {
              const descriptor = { ...cached, embedded: false, online: true, source: outcome.source }
              // 两处一起写：`_cover` 是"这张专辑现在显示什么"，`onlineCover` 是"其中在线那一份"。
              // 只写 `_cover` 的话，用户往文件夹里放一张封面再删掉，之前补的那张就永久没了。
              current._cover = descriptor
              current.onlineCover = descriptor
              current.coverLookup = { status: 'matched', checkedAt: timestamp(), source: outcome.source, ...(outcome.evidence ?? {}) }
              this.coverStatus.matched += 1
              // 判定要留在服务日志里（照 autoScan 那一行的口径）：面板上只看得见"有没有图"，
              // "为什么没有"只有这一行说得清 —— 尤其"上游 200 但没落文件"这种最容易误判成 bug 的形状。
              console.log(`封面补全「${album.title} / ${album.artist}」：命中（来源 ${outcome.source}，`
                + `图片 ${outcome.bytes?.length ?? 0} 字节 → artwork/${path.basename(cached.path)}）`)
            } else {
              current.coverLookup = { status: 'error', checkedAt: timestamp(), error: `封面内容类型不可缓存：${outcome.mime ?? '未知'}` }
              this.coverStatus.failed += 1
              console.warn(`封面补全「${album.title} / ${album.artist}」：上游给了内容但类型不可缓存（${outcome.mime ?? '未知'}），未落文件。`)
            }
          } else if (identityIntact) {
            const status = outcome?.status === 'error' ? 'error' : 'not-found'
            current.coverLookup = {
              status, checkedAt: timestamp(),
              ...(outcome?.error ? { error: outcome.error } : {}),
              ...(!outcome?.error && outcome?.reason ? { reason: outcome.reason } : {}),
              ...(outcome?.attempts?.length ? { attempts: outcome.attempts.slice(0, 4) } : {}),
            }
            if (status === 'error') { this.coverStatus.failed += 1; this.coverStatus.error = outcome?.error ?? outcome?.reason ?? ''; consecutiveFailures += 1 }
            else { this.coverStatus.notFound += 1 }
            const detail = (outcome?.attempts ?? []).join('；') || outcome?.error || outcome?.reason || '没有可用的封面来源'
            console.log(`封面补全「${album.title} / ${album.artist}」：${status === 'error' ? '没问到' : '没有'}，未落文件 —— ${detail}`)
          } else {
            // 结论被丢掉也要留一行：否则"明明补到了却没图"会变成一个新的谜。
            console.log(`封面补全「${album.title} / ${album.artist}」：结果已丢弃（重扫后身份变了或这张已经有封面了）。`)
          }
          // 只要这一张得出了"有/没有"的结论（哪怕是没有），就不算连续失败：
          // 判据只看访问有没有成，把"上游确实没这张图"计进熔断会让一整轮在有图的曲库上提前停住。
          if (outcome?.status !== 'error') consecutiveFailures = 0
          this.coverStatus.completed += 1
          await this.saveIndex()
          this.onChange()
          if (consecutiveFailures >= 3) {
            this.coverStatus.error = `封面来源连续 3 次访问失败，已暂停剩余 ${selected.length - this.coverStatus.completed} 张（避免重复超时打上游）`
            break
          }
        }
      } catch (error) { this.coverStatus.error = `封面补全未完成：${error.message}` }
      finally {
        this.coverStatus.running = false
        delete this.coverStatus.currentAlbum
        this.coverPromise = null
        this.onChange()
        if (selected.length) {
          const done = this.coverStatus
          console.log(`封面补全这一轮：${selected.length} 张无封面专辑里补到 ${done.matched} 张，`
            + `${done.notFound} 张确实没有，${done.failed} 张没问到。`
            + (done.error ? `（${done.error}）` : ''))
        }
      }
      return this.snapshot()
    })()
    return this.coverPromise
  }

  trackLyrics(id) {
    for (const album of this.index.albums) if (this.config.roots.includes(album._root)) {
      const track = album.tracks.find((entry) => entry.id === id)
      if (track?._lyrics) {
        const lyrics = track._lyrics
        // Extracted lyrics live under dataDir, sidecars under the music root; serveFile
        // still realpath-checks the file against the matching allowed root.
        return { path: lyrics.path, mime: lyricMime(lyrics.path), allowedRoot: lyrics.source === 'embedded' ? this.dataDir : album._root }
      }
    }
    return null
  }

  /**
   * 在线歌词匹配用的只读视图：公开曲目字段 + 所属专辑 + 本地歌词的三档判定。
   * 6.6 把冲突规则的服务端把关位从"有没有词"收窄成 `localLyric.timed`——**有带时间轴的词**才一票否决；
   * 内嵌 USLT 纯文本（format:'lyrics'）没有任何时间轴，它只是"唯一有的歌词"，不是"更好的歌词"，
   * 所以路由层仍会去问一次在线。`present` 只影响回给前端的文案（决定回退到段落还是回退到无词）。
   */
  trackForOnlineMatch(id) {
    for (const album of this.index.albums) if (this.config.roots.includes(album._root)) {
      const track = album.tracks.find((entry) => entry.id === id)
      if (!track) continue
      // 与快照同样的剥离：内部键（路径、指纹、歌词文件）一律不出这个视图。
      const { _path, _fingerprint, _common, _embeddedCover, _metadataVersion, _lyrics, ...publicTrack } = track
      // 喂给打分的只有真正带信息量的标签，两处刻意让打分走"没有这项信息"的中性路径：
      // ① 专辑名优先内嵌 TALB；没有标签时退回分组标题，但**曲库根上的散落单曲除外**——
      //    那种分组的 album.title 是由文件名推出来的（见 :424），拿它去比上游的真实专辑名必然 0 分，
      //    而空串在上游打分里是中性满权重。同名专辑（《黑马》里的主打歌）不受影响：
      //    它在自己的文件夹里，标题来自文件夹名而不是文件名。
      // ② 库里的 '未知艺术家' 是缺标签时的占位符，传出去会被当成一个真实且不一致的歌手
      //    （artistScore 0 并触发 74 分上限），空串才是"这里没有信息"的正确表达。
      const groupTitle = String(album.title ?? '').trim()
      const title = String(track.title ?? '').trim()
      const derivedAlbumGroup = !String(track.relativePath ?? '').includes('/') && !String(track.relativePath ?? '').includes('\\')
      const albumTitle = String(_common?.album ?? '').trim() || (derivedAlbumGroup ? '' : groupTitle)
      const artist = String(track.artist ?? '').trim()
      const query = {
        title,
        artist: artist === '未知艺术家' ? '' : artist,
        album: albumTitle,
        durationMs: Math.round((track.duration ?? 0) * 1000),
      }
      return {
        track: publicTrack,
        album: { id: album.id, title: albumTitle },
        // 6.6：timed 按**格式**判定（'lyrics' = 内嵌纯文本，无任何时间轴），不按内容猜。
        // 边界如实标注：一个没有任何 [mm:ss] 的 .lrc 伴生文件仍算有轴，本期不额外解析。
        localLyric: {
          present: Boolean(track.lyrics),
          timed: Boolean(track.lyrics) && track.lyrics.format !== 'lyrics',
          format: track.lyrics?.format ?? null,
        },
        query,
      }
    }
    return null
  }

  artworkFile(id) {
    const album = this.index.albums.find((entry) => entry.id === id && this.config.roots.includes(entry._root))
    // 内嵌与在线补的两份都落在 `dataDir/artwork`（同一个内容寻址缓存），允许根因此都是 dataDir；
    // 只有文件夹封面才以那张专辑自己的目录为允许根。少了 `online` 这一半，补来的图会被 serveFile 判成越界。
    const fromCache = album?._cover?.embedded || album?._cover?.online
    return album?._cover ? { ...album._cover, allowedRoot: fromCache ? this.dataDir : album._root } : null
  }

  async musicBrainz(endpoint, params = {}) {
    const url = new URL(`https://musicbrainz.org/ws/2/${endpoint}`)
    for (const [key, value] of Object.entries({ ...params, fmt: 'json' })) url.searchParams.set(key, value)
    return this.onlineJson(url)
  }

  async onlineJson(url) {
    if (!this.musicBrainzContact) throw new Error('请先配置自己的联系邮箱或项目网址，以满足 MusicBrainz User-Agent 要求')
    const wait = Math.max(0, this.lastMusicBrainzRequest + 1100 - Date.now())
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastMusicBrainzRequest = Date.now()
    // 超时与禁重定向交给了 guardedFetch（默认 fetcher），不再自己挂 AbortSignal；
    // 自检注入假 fetcher 的用法不变（第二个参数现在收的是 `{ headers, timeoutMs }`）。
    const response = await this.fetcher(url, {
      headers: { 'User-Agent': `RhineLocalMusic/0.1 (${this.musicBrainzContact})`, Accept: 'application/json' },
      timeoutMs: 15000,
    })
    if (!response.ok) throw new Error(`${url.hostname} HTTP ${response.status}，保留本地资料，可稍后重试`)
    return response.json()
  }

  async albumIntroduction(group) {
    // Only follow links already attached to the confidently matched album group;
    // title-only encyclopedia searches can silently pick an unrelated work.
    const relations = group?.relations ?? []
    let language
    let title
    const wikidata = relations.find((relation) => relation.type === 'wikidata')?.url?.resource
    const qid = wikidata?.match(/^https?:\/\/(?:www\.)?wikidata\.org\/wiki\/(Q\d+)\/?$/)?.[1]
    if (qid) {
      const entity = await this.onlineJson(new URL(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`))
      const links = entity.entities?.[qid]?.sitelinks
      if (links?.zhwiki?.title) { language = 'zh'; title = links.zhwiki.title }
      else if (links?.enwiki?.title) { language = 'en'; title = links.enwiki.title }
    }
    if (!title) {
      const candidates = relations.map((relation) => relation.url?.resource).filter(Boolean).map((resource) => {
        try {
          const url = new URL(resource)
          const match = /^(zh|en)\.wikipedia\.org$/.exec(url.hostname)
          return match && url.pathname.startsWith('/wiki/') ? { language: match[1], title: decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ') } : null
        } catch { return null }
      }).filter(Boolean).sort((a, b) => (a.language === 'zh' ? -1 : 1) - (b.language === 'zh' ? -1 : 1))
      if (candidates[0]) ({ language, title } = candidates[0])
    }
    if (!title) return null
    const api = new URL(`https://${language}.wikipedia.org/w/api.php`)
    const params = { action: 'query', format: 'json', formatversion: '2', prop: 'extracts|info|pageprops', inprop: 'url', ppprop: 'disambiguation', exintro: '1', explaintext: '1', exchars: '800', redirects: '1', titles: title }
    for (const [key, value] of Object.entries(params)) api.searchParams.set(key, value)
    const data = await this.onlineJson(api)
    const page = data.query?.pages?.find((entry) => !entry.missing && !Object.hasOwn(entry.pageprops ?? {}, 'disambiguation') && text(entry.extract))
    if (!page) return null
    return {
      description: text(page.extract),
      descriptionSource: { name: language === 'zh' ? '维基百科' : 'Wikipedia', url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`, checkedAt: timestamp(), license: 'CC BY-SA（以来源页为准）' },
    }
  }

  async enrich({ albumIds, force = false } = {}) {
    if (this.enrichPromise) return this.enrichPromise
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    // 未配置联系方式时**整轮跳过**，而不是让 onlineJson 逐张抛错：默认开启后，扫描后的自动补全
    // 会在每张专辑上写一条 `online:{status:'error',checkedAt}`（真实曲库实测 5/5 张全中，且 checkedAt
    // 一旦落下，配好联系方式的那一轮就不再重查这些专辑）。跳过时状态可回读、专辑记录不动、索引不写盘。
    if (!this.musicBrainzContact) {
      this.enrichStatus = { running: false, completed: 0, total: 0, skipped: 'no-contact' }
      return this.snapshot()
    }
    const selected = this.index.albums.filter((album) => !album.offline && (!albumIds || albumIds.includes(album.id)) && (force || !album.online?.checkedAt))
    this.enrichStatus = { running: true, completed: 0, total: selected.length }
    this.enrichPromise = (async () => {
      // Yield once even for an empty queue so finally clears the assigned promise.
      await Promise.resolve()
      try {
        for (const album of selected) {
          await this.enrichAlbum(album)
          this.enrichStatus.completed += 1
          await this.saveIndex()
          this.onChange()
        }
      } catch (error) { this.enrichStatus.error = error.message }
      finally { this.enrichStatus.running = false; this.enrichPromise = null }
      return this.snapshot()
    })()
    return this.enrichPromise
  }

  async updateIntroductions({ albumIds, force = false } = {}) {
    if (this.introductionsPromise) return this.introductionsPromise
    if (albumIds !== undefined && (!Array.isArray(albumIds) || albumIds.length > 10000 || albumIds.some((id) => typeof id !== 'string'))) throw new Error('albumIds 必须是专辑 ID 数组')
    if (typeof force !== 'boolean') throw new Error('force 必须为布尔值')
    const selected = this.index.albums.filter((album) => {
      if (!this.config.roots.includes(album._root) || (albumIds && !albumIds.includes(album.id))) return false
      if (force) return true
      if (album.description && album.descriptionSource?.url) return false
      const cached = album.introduction
      return !cached || cached.status === 'error' || !cached.checkedAt || Date.now() - Date.parse(cached.checkedAt) > 7 * 86400_000
    }).map((album) => ({ id: album.id, title: album.title, artist: album.artist, year: album.year }))
    this.introductionsStatus = { running: true, completed: 0, total: selected.length, updated: 0, notFound: 0, failed: 0 }
    this.introductionsPromise = (async () => {
      await Promise.resolve()
      let consecutiveFailures = 0
      try {
        for (const album of selected) {
          this.introductionsStatus.currentAlbum = album.title
          this.onChange()
          let result
          try { result = await this.introductionProvider.lookup(album) }
          catch (error) { result = { status: 'error', checkedAt: timestamp(), error: error.message } }
          if (!['matched', 'not-found', 'uncertain', 'error'].includes(result?.status)) result = { status: 'error', checkedAt: timestamp(), error: '专辑介绍来源返回无效状态' }
          const current = this.index.albums.find((entry) => entry.id === album.id)
          if (current && current.title === album.title && current.artist === album.artist && current.year === album.year) {
            current.introduction = { status: result.status, checkedAt: result.checkedAt ?? timestamp(), ...(result.error ? { error: result.error } : {}), ...(result.candidateUrl ? { candidateUrl: result.candidateUrl } : {}) }
            if (result.status === 'matched' && result.description && result.descriptionSource?.url) {
              current.description = result.description
              current.descriptionSource = result.descriptionSource
              this.introductionsStatus.updated += 1
            } else if (result.status === 'error' || result.status === 'matched') {
              current.introduction.status = 'error'
              current.introduction.error ||= '来源未提供可引用的专辑介绍'
              this.introductionsStatus.failed += 1
            } else this.introductionsStatus.notFound += 1
          }
          this.introductionsStatus.completed += 1
          if (result.status === 'error') {
            consecutiveFailures += 1
            this.introductionsStatus.error = result.error
          } else consecutiveFailures = 0
          await this.saveIndex()
          this.onChange()
          if (consecutiveFailures >= 3 && this.introductionsStatus.completed < selected.length) {
            this.introductionsStatus.error = `百科来源连续 3 次访问失败，已暂停剩余 ${selected.length - this.introductionsStatus.completed} 张，避免重复超时。${result.error ?? ''}`
            break
          }
        }
      } catch (error) { this.introductionsStatus.error = `更新未完成：${error.message}` }
      finally {
        this.introductionsStatus.running = false
        delete this.introductionsStatus.currentAlbum
        this.introductionsPromise = null
        this.onChange()
      }
      return this.snapshot()
    })()
    return this.introductionsPromise
  }

  async enrichAlbum(album) {
    const checkedAt = timestamp()
    try {
      let releaseId = album.online?.releaseId
      if (!releaseId) {
        const escape = (value) => value.replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&')
        const found = await this.musicBrainz('release', { query: `release:"${escape(album.title)}" AND artist:"${escape(album.artist)}"`, limit: '5' })
        const candidates = (found.releases ?? []).filter((candidate) =>
          normalized(candidate.title) === normalized(album.title) &&
          normalized((candidate['artist-credit'] ?? []).map((credit) => credit.name ?? credit.artist?.name ?? '').join('')) === normalized(album.artist) &&
          Number(candidate['track-count']) === album.tracks.length &&
          (!album.year || !candidate.date || candidate.date.startsWith(String(album.year))) && Number(candidate.score ?? 0) >= 95)
        // Multiple pressings are not interchangeable for production credits.
        if (candidates.length !== 1) {
          album.online = { ...album.online, status: found.releases?.length ? 'uncertain' : 'not-found', checkedAt }
          return
        }
        releaseId = candidates[0].id
      }
      if (!MBID.test(releaseId)) throw new Error('无效的 MusicBrainz Release ID')
      const release = await this.musicBrainz(`release/${releaseId}`, { inc: 'artist-credits+recordings+recording-level-rels+artist-rels+release-groups+genres' })
      const releaseGroupId = release['release-group']?.id ?? album.online?.releaseGroupId
      const group = releaseGroupId && MBID.test(releaseGroupId) ? await this.musicBrainz(`release-group/${releaseGroupId}`, { inc: 'genres+artist-rels+url-rels' }) : null
      const genres = [...(release.genres ?? []), ...(group?.genres ?? [])].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).map((genre) => text(genre.name))
      const producers = []
      const collect = (relations = [], trackTitle) => {
        for (const relation of relations) if (/producer/i.test(relation.type ?? '') && relation.artist?.name) {
          producers.push({ name: relation.artist.name, role: relation.type, source: 'MusicBrainz', trackTitle, url: `https://musicbrainz.org/artist/${relation.artist.id}` })
        }
      }
      collect(release.relations)
      collect(group?.relations)
      for (const medium of release.media ?? []) for (const track of medium.tracks ?? []) collect(track.recording?.relations, track.title ?? track.recording?.title)
      const online = { status: 'matched', releaseId, releaseGroupId, checkedAt, sourceUrl: `https://musicbrainz.org/release/${releaseId}` }
      let introduction
      try {
        introduction = await this.albumIntroduction(group)
        online.descriptionStatus = introduction ? 'available' : 'not-found'
      } catch (error) {
        online.descriptionStatus = 'error'
        online.descriptionError = error.message
      }
      // Commit after all awaited requests, to the current record after any scan.
      const current = this.index.albums.find((entry) => entry.id === album.id)
      if (!current || current.title !== album.title || current.artist !== album.artist || current.year !== album.year) return
      current._onlineGenres = unique(genres)
      current.producers = uniqueProducers([...(current.producers ?? []).filter((person) => person.source !== 'MusicBrainz'), ...producers])
      current.online = online
      if (introduction) Object.assign(current, introduction)
      Object.assign(album, { _onlineGenres: current._onlineGenres, producers: current.producers, online: current.online, description: current.description, descriptionSource: current.descriptionSource })
    } catch (error) {
      album.online = { ...album.online, status: 'error', checkedAt, error: error.message }
      this.enrichStatus.error = error.message
    }
  }
}

function uniqueProducers(producers) {
  const seen = new Set()
  return producers.filter((producer) => {
    const key = `${producer.name}:${producer.role}:${producer.trackTitle ?? ''}:${producer.source}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
