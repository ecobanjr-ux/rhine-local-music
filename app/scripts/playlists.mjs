// 本项目自撰（非移植代码）。文本歌单实体：格式定义、解析、校验、原子写、每请求重读（R74 / R76）。
//
// 为什么是纯文本文件而不是数据库一行：歌单是**用户资产**，用户应该能用编辑器打开、能 git 管、
// 能拷给别人。所以三条纪律是硬的：
//   ① 解析对**内容**永不抛——坏行进 warnings 并带行号，绝不因为第 137 行少个分隔符就打不开整张单子；
//      只对**上限**抛（行数 / 单行字符数 / 张数），因为超限静默截断等于悄悄丢掉用户的条目。
//   ② 写之前先 `.backup`（沿用 genre-rules 那套惯例），且原子写 tmp + rename + 0o600。
//   ③ **每请求重读**：路由层不缓存，用户在外部编辑器改完文件，下一次轮询就能看到
//      （与 `reloadRules` 同一口径；进程内缓存会让"手改文件"这件事看起来没生效）。
//
// 格式（v1，之后只允许向后兼容地扩）：
//   # Rhine 歌单 v1        ← 以 # 开头的行一律忽略；`# name: X` 是这一张的名字
//   [album] 黑马            ← 可选专辑头，作用于其后条目，直到下一个 [album]（空头 = 清除）
//   恋人 - 李荣浩            ← 基本形：以**第一个** " - " 为界（曲名本身含 " - " 请用 JSON 形或 en dash）
//   さよなら夏の日 - 山下達郎 | COME ALONG 3 | 4:27   ← 竖线尾段顺序固定：专辑、时长
//   恋人 - 李荣浩 | 黑马 | 4:36 | on:netease:27699577  ← 第 4 段（可选）= 在线条目身份（F2）；
//                                                  QQ 还要带 mediaMid：on:qq:<songmid>:<mediaMid>
//   { "version": 1, "name": "黑马", "items": [ … ] }  ← JSON 形：首字符是 { 或 [ 时自动识别
import path from 'node:path'
import { promises as fs, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export const PLAYLIST_SUFFIX = '.playlist.txt'
export const MATCH_SUFFIX = '.matches.json'
// 备份名是"原文件名 + .backup"（与 genre-rules 那套惯例逐字一致），不是另造一个后缀。
export const BACKUP_SUFFIX = '.backup'
export const MAX_PLAYLIST_LINES = 2000
export const MAX_PLAYLIST_CHARS = 240
export const MAX_PLAYLISTS = 200

/**
 * 歌单来历注释（R137 定下的格式，R156 起**读写两侧共用这一份**）：
 * `# <平台>-playlist <id> imported <ISO>`。
 *
 * 为什么"读注释"而不是"另存字段"（任务三的第一个决定，理由要留在代码里）：
 *   · 歌单是**用户可编辑的纯文本资产**（R137 的既定形态）。另存一份到 sidecar 或索引里，
 *     用户复制文件、改名、手工搬进另一张单时那份字段就会与文件脱节——而"这张单从哪来"
 *     恰恰只有在文件自己身上才跟着文件走；
 *   · 注释已经是写入侧必填的（导入器每次都会写），再存一份就是第二个真相；
 *   · 代价照实记：用户删掉那行注释，同平台优先就失效（退化成"只按分数与登录偏好挑"）。
 *     这是**可恢复的失效**，不是数据损坏，界面那句话里也这么写。
 */
const PROVENANCE = /#\s*([a-z]+)-playlist\s+(\S+)\s+imported\s+(\S+)/i;
export const PROVENANCE_PROVIDERS = Object.freeze(['netease', 'qq', 'kugou']);

/** 写侧：导入器用它拼那一行（格式只有一处定义，读侧与写侧不会各写一份再分家）。 */
export function provenanceComment(provider, id, iso = new Date().toISOString()) {
  return `# ${String(provider ?? '').toLowerCase()}-playlist ${String(id ?? '').trim()} imported ${iso}`;
}

/**
 * 读侧：从歌单原文里认来历。只认那张表里的平台名（`# qq-playlist …` 认，
 * `# whatever-playlist …` 不认 ⇒ 返回 null，绝不把没见过的字符串当平台）。
 * 返回 `{provider, id, importedAt}` 或 null（手写歌单、网易 v1 之前导入的、注释被删的都归 null）。
 */
export function readPlaylistProvenance(text) {
  const matched = PROVENANCE.exec(String(text ?? ''));
  if (!matched) return null;
  const provider = matched[1].toLowerCase();
  if (!PROVENANCE_PROVIDERS.includes(provider)) return null;
  return { provider, id: matched[2], importedAt: matched[3] };
}
const SLUG_PATTERN = /^[\w\u4e00-\u9fa5-]{1,40}$/

/** 名字从 `# name: X` 头注释里取；没有就回落文件名（文件名本身就是用户起的 slug）。 */
export function nameOf(text, fallback = '') {
  const match = /^#\s*name\s*:\s*(.+)$/im.exec(String(text ?? ''))
  return (match?.[1] ?? '').trim() || fallback
}

/** 校验并返回 slug。路径分隔符、点、空串、超长一律拒——它是文件名，不是可以拼的东西。 */
export function slugOf(name) {
  const slug = String(name ?? '').trim()
  if (!SLUG_PATTERN.test(slug)) throw new Error(`歌单名不合法（只允许中文、字母、数字、下划线、短横线，1-40 字）：${JSON.stringify(slug.slice(0, 40))}`)
  return slug
}

const parseClock = (value) => {
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(String(value ?? '').trim())
  return match ? Number(match[1]) * 60000 + Number(match[2]) * 1000 : undefined
}
const formatClock = (ms) => {
  const total = Math.round(Number(ms) / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** JSON 形（另一种载体）→ 同一张内部形状。坏 JSON 当坏行处理，不抛。 */
function parsePlaylistJson(text, warnings) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    warnings.push({ line: 1, reason: `JSON 解析失败：${error?.message ?? error}` })
    return { items: [], warnings }
  }
  const root = Array.isArray(value) ? { items: value } : value ?? {}
  const rawItems = Array.isArray(root.items) ? root.items : []
  const items = []
  rawItems.forEach((item, index) => {
    const title = String(item?.title ?? '').trim()
    const artist = String(item?.artist ?? '').trim()
    if (!title || !artist) { warnings.push({ line: index + 1, reason: 'JSON 条目缺 title 或 artist' }); return }
    const durationMs = Number(item?.durationMs)
    items.push({
      title, artist,
      album: String(item?.album ?? '').trim() || undefined,
      ...(Number.isFinite(durationMs) && durationMs > 0 ? { durationMs: Math.round(durationMs) } : {}),
    })
  })
  // JSON 形没有"行"可言：这里的 entryLines 是**数组下标 + 1**（与上面 warnings.line 同一个口径）。
  // 「手工指定」那条写回路径会认出 JSON 形并明确拒绝，不会拿这个下标去当行号用。
  return { items, warnings, entryLines: items.map((unused, index) => index + 1), name: String(root.name ?? '').trim() || undefined }
}

/**
 * 文本 → 条目 + 警告。**内容**问题永不抛（坏行留痕），只有上限（行数 / 单行字符数）才抛。
 * 抛上限而不是截断，是为了让"这张单子太大了"成为用户看得见的一件事，而不是"我导入的歌少了几首"。
 */
export function parsePlaylistText(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '')
  const trimmed = clean.trim()
  // JSON 形的判据不能只看首字符：文本形的专辑头 `[album] …` 也是 `[` 起头，
  // 用"首字符是 { 或 ["会把整张文本歌单当成坏 JSON 而一条不剩（自检第一条就是这么抓到的）。
  // 真正的 JSON 数组在 `[` 之后必然紧跟空白、`{` 或 `"`，绝不会紧跟字母。
  if (trimmed.startsWith('{') || /^\[\s*[{"]/.test(trimmed)) {
    const warnings = []
    return parsePlaylistJson(trimmed, warnings)
  }
  const lines = clean.split(/\r?\n/)
  if (lines.length > MAX_PLAYLIST_LINES) throw new Error(`行数超过上限 ${MAX_PLAYLIST_LINES}（当前 ${lines.length} 行）：请拆成两张歌单，本工具不做静默截断`)
  const items = []
  const warnings = []
  /** 与 items 同序的行号（1 起）：见 `parsePlaylistText` 末尾那段说明。 */
  const entryLines = []
  let album
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    if (line.length > MAX_PLAYLIST_CHARS) throw new Error(`第 ${index + 1} 行：单行超过 ${MAX_PLAYLIST_CHARS} 字符`)
    if (line.startsWith('[album]')) { album = line.slice(7).trim() || undefined; return }
    const cut = line.indexOf(' - ')
    if (cut < 0) { warnings.push({ line: index + 1, reason: '缺少 " - " 分隔符' }); return }
    const title = line.slice(0, cut).trim()
    // 只按**第一个** " - " 切：`Bad - Guy - 某人` 的歌手就是 `Guy - 某人`，不做二次猜测。
    const tail = line.slice(cut + 3).split('|').map((part) => part.trim())
    if (!title || !tail[0]) { warnings.push({ line: index + 1, reason: '歌名或歌手为空' }); return }
    const artist = tail[0]
    // 第 4 段是**在线条目身份**（F2：搜索结果直接加进来的那些）。写成 `on:` 起头的那一段就是身份，
    // 不必固定在第几段——用户手抄时 `歌名 - 歌手 | on:netease:123`（不补空专辑段）是最自然的写法，
    // 把它当成专辑名会把身份悄悄吞掉。其余段仍按"专辑、时长"的顺序解释。
    const identityPattern = /^on:([a-z][a-z0-9-]{0,15}):([A-Za-z0-9_-]{1,64})(?::([A-Za-z0-9_-]{1,64}))?$/
    let online
    const rest = []
    let badIdentity
    for (const segment of tail.slice(1)) {
      if (!segment.startsWith('on:')) { rest.push(segment); continue }
      const identity = identityPattern.exec(segment)
      if (!identity) { badIdentity = segment; break }
      if (online) { badIdentity = segment; break }
      online = { provider: identity[1], mediaId: identity[2], ...(identity[3] ? { mediaMid: identity[3] } : {}) }
    }
    if (badIdentity !== undefined) { warnings.push({ line: index + 1, reason: `在线身份那段不认识（应为 on:<来源>:<媒体 id>[:<媒体次 id>]）：${badIdentity}` }); return }
    if (rest.length > 2) { warnings.push({ line: index + 1, reason: `竖线段数超出格式（专辑、时长各一段）：${rest[2]}` }); return }
    const [extraAlbum, clock] = rest
    if (clock !== undefined && clock !== '') {
      const durationMs = parseClock(clock)
      if (durationMs === undefined) { warnings.push({ line: index + 1, reason: `时长格式不认识：${clock}` }); return }
      items.push({ title, artist, album: extraAlbum || album, durationMs, ...(online ? { online } : {}) })
      entryLines.push(index + 1)
      return
    }
    items.push({ title, artist, album: extraAlbum || album, ...(online ? { online } : {}) })
    entryLines.push(index + 1)
  })
  // `entryLines[i]` = 第 i 条条目在文件里的**行号**（1 起）。它单独成一个数组而不是挂在条目上，
  // 是为了让条目形状保持不变：`parse(serialize(parse(t))) === parse(t)` 那类往返断言、
  // 以及"条目就是条目"的契约都不受影响。R127 的「手工指定」要"只改目标行"，
  // 没有这个映射就只能靠"猜那一行长什么样"——猜错就是改错行。
  return { items, warnings, entryLines, name: nameOf(clean) || undefined }
}

/**
 * 条目 → 文本。可逆性是硬要求：`parse(serialize(parse(t))) === parse(t)`。
 * 这里一律用**行内** `| 专辑 | 时长` 形式而不是 `[album]` 头——头是给人手改时省事用的，
 * 机器写回时逐行自带专辑更不容易串台（改一行不至于影响后面所有行）。
 */
/** 一条条目 → 一行文本（v1 的竖线尾段顺序固定：专辑、时长、在线身份）。 */
/**
 * 字段里不许出现这个格式自己的分隔符与换行。**一手实测撞出来的**：酷狗一张真实歌单里有一条专辑名
 * 带半角竖线（`红色高跟鞋 (Single Version|0.8x)`），原样写出去的那一行被自家解析器判
 * "竖线段数超出格式"整条丢掉 —— 落盘 41 行只读回 40 条，而导入回执还以为自己报清楚了。
 * 竖线换成**全角竖线**（看着几乎一样、能被读回），换行折成一个空格：
 * 宁可用一个相近的字符，也不许让一行变成两行、或写出一条读不回来的垃圾。
 * 判据写在写这一侧（不是要求"上游永远不给这种字符"——那句话我管不着）。
 */
const FIELD_SAFE = (value) => String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '｜')
export function serializeEntry(item) {
  const tail = []
  tail.push(FIELD_SAFE(item.album))
  if (item.durationMs || item.online) tail.push(item.durationMs ? formatClock(item.durationMs) : '')
  if (item.online?.provider && item.online?.mediaId) {
    tail.push(`on:${item.online.provider}:${item.online.mediaId}${item.online.mediaMid ? `:${item.online.mediaMid}` : ''}`)
  }
  const head = `${FIELD_SAFE(item.title)} - ${FIELD_SAFE(item.artist)}`
  while (tail.length && tail[tail.length - 1] === '') tail.pop()   // 尾部空段不写（写了就是把格式写胖）
  return tail.length ? `${head} | ${tail.join(' | ')}` : head
}

/**
 * 条目形状的校验（追加与替换**共用**）。两处各写一遍迟早会漂，所以只留一个出处。
 * `label` 决定报错时怎么称呼这一条（"第 1 条" / "要指定的这一条"）。
 */
function assertEntryShape(entry, label) {
  const title = String(entry?.title ?? '').trim()
  const artist = String(entry?.artist ?? '').trim()
  if (!title || !artist) throw new Error(`${label}缺少歌名或歌手`)
  if (entry?.online) {
    const { provider, mediaId, mediaMid } = entry.online
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(String(provider ?? '')) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(mediaId ?? ''))) {
      throw new Error(`${label}的在线身份不完整（要 provider 与 mediaId）`)
    }
    if (mediaMid !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(String(mediaMid))) throw new Error(`${label}的媒体次 id 不合法`)
  }
  return { title, artist }
}

/**
 * 往一份既有文本歌单**追加**条目（F2：搜索结果加进歌单）。
 * 为什么不是"解析 → 合并 → 整体重写"：那样会丢掉用户的 `#` 注释与 `[album]` 分组，
 * 而追加是只往后面加行——手改过的文件加完还是他那份文件。
 */
export function appendEntriesToText(text, entries) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) throw new Error('没有要加入的条目')
  for (const [position, entry] of list.entries()) assertEntryShape(entry, `第 ${position + 1} 条`)
  const base = String(text ?? '')
  const lines = list.map((entry) => serializeEntry({ title: String(entry?.title ?? '').trim(), artist: String(entry?.artist ?? '').trim(), album: entry?.album, durationMs: entry?.durationMs, online: entry?.online }))
  const joined = lines.join('\n')
  // 原文件末尾没有换行时先补一个，否则第一条会和用户最后一行黏成一行。
  const prefix = base && !/\n$/.test(base) ? `${base}\n${joined}` : `${base}${joined}`
  // 追加完再走一遍解析：行数 / 单行字符数超限由它抛，不静默截断（与读路径同一口径）。
  parsePlaylistText(`${prefix}\n`)
  return `${prefix}\n`
}

/**
 * **只改一行**的替换（R127 · 方案 B「手工指定」）。与追加同一套纪律，但多一道锁：
 *   · `line` 是解析器记下的行号，`expect` 是客户端当时看到的那一行原文；两者对不上就抛，
 *     一个字都不写。用户在别处改过文件、或面板开着没刷新，表现都是"这次没改成"，
 *     而**不是"改错了别的那一行"**——这是这条写回路径唯一真正危险的地方。
 *   · 其余每一行逐字节照抄：`#` 注释、`[album]` 分组、空行、结尾换行都不动。
 *   · 新行由 `serializeEntry` 生成（第 4 段是在线身份）⇒ 替换完这一条免匹配直接可播。
 *   · 目标行必须真的是一条曲目（不是注释 / `[album]` 头 / 坏行），判据用同一个解析器，不另起一套。
 *   · 行数与单行字符数上限仍由 `parsePlaylistText` 抛，不静默截断。
 */
export function replaceEntryInText(text, { line, expect, entry } = {}) {
  const base = String(text ?? '')
  const trimmedBase = base.trim()
  if (trimmedBase.startsWith('{') || /^\[\s*[{"]/.test(trimmedBase)) {
    throw new Error('JSON 形歌单不支持逐行手工指定（那是另一种载体）：请改用文本形，或删掉这一行后从搜索结果加入')
  }
  const target = Number(line)
  if (!Number.isInteger(target) || target < 1) throw new Error('行号不合法')
  const wanted = String(expect ?? '').trim()
  if (!wanted) throw new Error('没带上"原来那一行"的原文，无法确认要改的是哪一行')
  const lines = base.split(/\r?\n/)
  const actual = lines[target - 1]
  if (actual === undefined) throw new Error(`这份文件只有 ${lines.length} 行，第 ${target} 行不存在`)
  if (actual.trim() !== wanted) {
    throw new Error(`第 ${target} 行已经不是刚才看到的那一行了（现在是「${actual.trim() || '空行'}」），本次没有写入`)
  }
  const parsed = parsePlaylistText(base)
  if (!parsed.entryLines.includes(target)) throw new Error(`第 ${target} 行不是一条曲目（注释、专辑头或没读懂的行不能手工指定）`)
  assertEntryShape(entry, '要指定的这一条')
  const replacement = serializeEntry({
    title: String(entry?.title ?? '').trim(), artist: String(entry?.artist ?? '').trim(),
    album: entry?.album, durationMs: entry?.durationMs, online: entry?.online,
  })
  if (replacement.length > MAX_PLAYLIST_CHARS) throw new Error(`替换后的这一行超过 ${MAX_PLAYLIST_CHARS} 字符上限`)
  const next = lines.slice()
  next[target - 1] = replacement
  const joined = next.join('\n')
  parsePlaylistText(joined)                       // 超限与形状由它复检（不静默截断）
  return { text: joined, before: actual, after: replacement }
}

export function serializePlaylist(playlist) {
  const lines = ['# Rhine 歌单 v1']
  if (playlist?.name) lines.push(`# name: ${playlist.name}`)
  for (const item of playlist?.items ?? []) lines.push(serializeEntry(item))
  for (const warning of playlist?.warnings ?? []) lines.push(`# 第 ${warning.line} 行没被读懂：${warning.reason}`)
  return `${lines.join('\n')}\n`
}

async function exists(file) {
  try { await fs.access(file); return true } catch { return false }
}

/** `writeJsonAtomic` 的字符串版：同一套 tmp + rename + 0o600，不另起一条写盘路径。 */
export async function atomicWriteText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/**
 * 磁盘上的一堆歌单：一个文件 = 一张，文件名 `<slug>.playlist.txt`。
 * 附属文件（`.backup` / `.matches.json`）与它同目录同基名，路径纯函数算得出——
 * 这是 R76 那条"关联必须确定"的形态：没有索引、没有查表、删 sidecar 无害。
 */
/**
 * 歌单目录（F3：用户可指定）。返回 `null` 表示"用默认（数据目录/playlists）"。
 *
 * 校验只有一条主张：**它是个目录，不是一个能往系统里乱放东西的字符串**。
 * 必须是绝对路径（相对路径会随进程工作目录漂，今天能打开明天就打不开）、
 * 不能是盘根或文件系统根（那等于"把用户的歌单撒在整块盘上"）、不能含 NUL、长度受限。
 * 至于"这个目录能不能写"——那是 `init`/`relocate` 用真实文件系统调用去证的，不在这里猜。
 */
export function resolvePlaylistDir(raw, dataDir) {
  if (raw === undefined || raw === null) return null
  const value = String(raw).trim()
  if (!value || value === 'default' || value === '默认') return null
  if (value.length > 240) throw new Error(`歌单文件夹路径过长（${value.length} 字，上限 240）`)
  if (/\0/.test(value)) throw new Error('歌单文件夹路径不合法')
  if (!path.isAbsolute(value)) throw new Error('歌单文件夹要填**绝对路径**（如 D:\\音乐\\歌单）；相对路径会随程序的工作目录变，今天能打开的单子明天可能就找不到了')
  const resolved = path.resolve(value)
  const parsed = path.parse(resolved)
  if (parsed.root === resolved) throw new Error(`歌单文件夹不能是盘根或文件系统根（${resolved}）：那样歌单会和整块盘上的其他东西混在一起`)
  if (/[<>:"|?*]/.test(resolved.slice(parsed.root.length))) throw new Error('歌单文件夹路径里有不能用于路径的字符（< > : " | ? *）')
  return resolved === path.resolve(path.join(dataDir ?? '', 'playlists')) ? null : resolved
}

/** 架上最多铺这么多张歌单：超出部分只在歌单面板里可见，架上留一行"还有 N 张"的说明。 */
export const SHELF_PLAYLIST_LIMIT = 60
/** 拼贴封面的格数（2×2）。 */
export const SHELF_COVER_SEEDS = 4

/**
 * 一张歌单在**专辑架上**要显示的那点信息（⑧ 伪专辑）。纯函数：输入是
 * `playlistMatcher.tracks(id)` 的结果（文本 + 匹配缓存，零出网），输出不含任何可播地址。
 *
 * 三条讲究：
 * ① 明细（成员曲目表、能不能播）点开才取 ⇒ 这里只带行数与未匹配数，架上不养第二份真相；
 * ② "最主要的音乐人"必须**确定性**：并列时按首次出现排，不靠 Map 的迭代顺序碰巧
 *    （同一输入两次结果不一致，架上的列就会每次刷新换个位置）；
 * ③ `coverSeeds` 是**文本**（成员的标题/歌手），不是封面 URL —— 在线条目的字段白名单
 *    （`bridge/providers/normalize.mjs:18`）今天刻意不带图，所以架上的拼贴格是按这些文本
 *    算出来的程序化色块：它不冒充真封面，也不新增任何出网面。
 */
export function playlistShelfRow(detail) {
  const items = Array.isArray(detail?.items) ? detail.items : []
  // 字典用 null 原型对象而不是 Map：本文件的"不许有内存映射表"那条纪律（R76 硬要求 A）
  // 针对的是歌单↔sidecar 的**关联**，这里只是个临时计数，但判据是文本扫描，
  // 与其放宽判据不如换个写法 —— 顺带还挡住了 `__proto__` 当歌手名时把计数写进原型。
  const firstSeen = Object.create(null)
  const counts = Object.create(null)
  items.forEach((item, index) => {
    const name = String(item?.entry?.artist ?? '').trim().replace(/\s+/g, ' ')
    if (!name) return
    if (!(name in firstSeen)) firstSeen[name] = index
    counts[name] = (counts[name] ?? 0) + 1
  })
  const ranked = Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || firstSeen[a] - firstSeen[b])
  // id 从 store 来时就该是合法 slug，但**一张被用户手改成怪文件名的单不该让整架 500**：
  // 这里兜住 slugOf 的抛，退成空串，界面上那格因此显示文件名而不是报错。
  let id = String(detail?.id ?? '');
  try { id = slugOf(id) } catch { id = String(detail?.id ?? '').slice(0, 40) }
  return {
    id,
    name: String(detail?.name ?? '').trim().slice(0, 80) || id,
    items: items.length,
    matched: Number(detail?.matched ?? 0) || 0,
    unmatched: Number(detail?.unmatched ?? 0) || 0,
    artist: ranked[0] ?? '',
    // R198：展示封面（**同源 token 地址**，由服务端从 sidecar 的 `displayCoverRef` 签出来）。
    // 为空串时架上那格照旧是下面的程序化拼贴原料 —— "有真图"与"没有"是两件事。
    coverUrl: String(detail?.displayCoverUrl ?? ''),
    coverSeeds: items.slice(0, SHELF_COVER_SEEDS).map((item) => ({
      title: String(item?.entry?.title ?? '').trim().slice(0, 60),
      artist: String(item?.entry?.artist ?? '').trim().slice(0, 40),
    })),
  }
}

/**
 * ⑨ 在线按音乐人分组：架上一列最多铺几个音乐人（与歌单同一档，超出的组数如实报 `omitted`）。
 */
export const SHELF_ARTIST_LIMIT = 60

/**
 * 分组键：去首尾空白并折叠内部空白。**空串就是"没有音乐人"，调用方要丢掉这一档**——
 * 不造「未知歌手」组：第四期真机抓到过占位艺术家 `'未知艺术家'` 被当成真实歌手，
 * 那一次把正例从满分打到阈值以下（`memory/folia-port-p4-run-log.md`），给它建一张专辑等于把错复发一次。
 */
export function artistGroupKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ')
}

/** `slugOf` 的兜底版：一张被用户改成怪名字的组不该让整架 500。 */
function safeGroupSlug(name) {
  try {
    return slugOf(name)
  } catch {
    return String(name ?? '').slice(0, 40)
  }
}

/**
 * 把若干张歌单的明细按音乐人聚成组（⑨）。**纯函数、零出网**：明细要由调用方取好传进来
 * （`playlistMatcher.tracks(id)` 的结果 = 文本 + sidecar 缓存）。
 *
 * 三条讲究：
 * ① 只数**已匹配且带在线身份**的条目——播不了的条目聚成组，等于做出一张"点开能按播放但会失败"的假专辑；
 * ② 同一首出现在两张单里只算一条（内核也会去重，但架上说的那个数字得是真实曲数，
 *    否则"播放全部 12 条"结果队列只有 9 首，就是 R114 那一类"回执与队列不符"）；
 * ③ 排序确定性：条数降序、并列按首次出现，不靠对象迭代顺序碰巧（与 `playlistShelfRow` 同一条口径）。
 */
export function onlineArtistGroups(detailsList, limit = SHELF_ARTIST_LIMIT) {
  const groups = Object.create(null)
  const order = []
  for (const detail of Array.isArray(detailsList) ? detailsList : []) {
    const listName = String(detail?.name ?? detail?.id ?? '').trim()
    for (const item of detail?.items ?? []) {
      if (!item?.matched || !item.track) continue
      const key = artistGroupKey(item.entry?.artist ?? item.track?.artist)
      if (!key) continue
      let group = groups[key]
      if (!group) {
        // 字典一律 null 原型：本文件有一条"不许用内存映射表"的文本扫描判据（R76 硬要求 A），
        // 换个写法比放宽判据好，顺带挡住有人真把歌手名写成 `__proto__` 时把计数写进原型。
        group = groups[key] = { name: key, tracks: [], seen: Object.create(null), playlists: Object.create(null) }
        order.push(group)
      }
      const trackId = String(item.track.id ?? '')
      if (!trackId || group.seen[trackId]) continue
      group.seen[trackId] = true
      group.tracks.push(item.track)
      if (listName) group.playlists[listName] = true
    }
  }
  const ranked = order.slice().sort((a, b) => b.tracks.length - a.tracks.length || order.indexOf(a) - order.indexOf(b))
  const taken = ranked.slice(0, Math.max(0, limit))
  return {
    groups: taken.map((group) => ({
      name: group.name,
      slug: safeGroupSlug(group.name),
      tracks: group.tracks,
      playlists: Object.keys(group.playlists).sort(),
    })),
    omitted: Math.max(0, ranked.length - taken.length),
    limit,
  }
}

/**
 * 架上那一行要的原料（**不带曲目明细**：与 ⑧ 同一条"点开才取"的口径，
 * 60 组 × N 条塞进一次曲库刷新会把响应撑大，而且明细是会变的——两份真相从这里开始）。
 */
export function artistShelfRow(group) {
  return {
    slug: String(group?.slug ?? ''),
    name: String(group?.name ?? '').slice(0, 80),
    items: (group?.tracks ?? []).length,
    playlists: (group?.playlists ?? []).length,
    coverSeeds: (group?.tracks ?? []).slice(0, SHELF_COVER_SEEDS).map((track) => ({
      title: String(track?.title ?? '').trim().slice(0, 60),
      artist: String(group?.name ?? ''),
    })),
  }
}

export class PlaylistStore {
  constructor({ dataDir, dir } = {}) {
    this.dataDir = dataDir
    this.defaultDir = path.join(dataDir, 'playlists')
    this.dir = dir ? path.resolve(dir) : this.defaultDir
  }

  /** 换目录（F3）。只改指向，不动文件——搬移是 `copyEntriesFrom` 的事，且永远不删源。 */
  useDir(dir) {
    const resolved = dir ? path.resolve(dir) : this.defaultDir
    const previous = this.dir
    this.dir = resolved
    return { previous, current: resolved, changed: previous !== resolved }
  }

  /** 目标目录必须存在且可建（写之前先证一次，别让用户的"应用"按钮静默失败）。 */
  async ensureDir(playlistDirTarget = this.dir) {
    await fs.mkdir(playlistDirTarget, { recursive: true })
    const stat = await fs.stat(playlistDirTarget)
    if (!stat.isDirectory()) throw new Error(`歌单文件夹指向的是一个文件，不是目录：${playlistDirTarget}`)
    return playlistDirTarget
  }

  /**
   * 把旧目录里的歌单与 sidecar **复制**进当前目录（F3）。
   * 为什么不移动：用户在编辑器里可能还开着老路径，删源会让"改个目录"变成一次不可逆的数据操作；
   * 复制留一份重复，永远比丢一份好。同名文件跳过并计数——不覆盖，覆盖就是拿新目录里已有的那份去赌。
   */
  async copyEntriesFrom(oldDir) {
    const from = path.resolve(oldDir)
    if (from === this.dir) return { copied: 0, skipped: 0, from, to: this.dir }
    await this.ensureDir()
    let names = []
    try {
      names = await fs.readdir(from)
    } catch {
      return { copied: 0, skipped: 0, from, to: this.dir, warning: '旧目录读不到，新目录保持原样' }
    }
    let copied = 0
    let skipped = 0
    for (const name of names) {
      if (!name.endsWith(PLAYLIST_SUFFIX) && !name.endsWith(MATCH_SUFFIX)) continue
      if (existsSync(path.join(this.dir, name))) { skipped += 1; continue }
      // 目的地一律写 `this.dir`（R74 的扫描面靠它判定"只准写歌单目录"），不引入第二个路径变量。
      await fs.copyFile(path.join(from, name), path.join(this.dir, name))
      copied += 1
    }
    return { copied, skipped, from, to: this.dir }
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true })
    return this
  }

  fileOf(id) { return path.join(this.dir, `${slugOf(id)}${PLAYLIST_SUFFIX}`) }
  matchFileOf(id) { return path.join(this.dir, `${slugOf(id)}${MATCH_SUFFIX}`) }

  /** 每请求重读：这里没有任何形式的内存缓存。 */
  async get(id) {
    const file = this.fileOf(id)
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    if (text === null) return null
    const stat = await fs.stat(file)
    // 上限违规是**抛**的（不静默截断），但一张被用户改超线的文件不该让 GET 变成 500：
    // 这里接住它，作为一条 line:0 的警告 + parseError 报出去，界面上说得出"这张读不了、为什么"。
    let parsed
    try {
      parsed = parsePlaylistText(text)
    } catch (error) {
      return {
        id: slugOf(id), name: nameOf(text, slugOf(id)), text, items: [],
        warnings: [{ line: 0, reason: String(error?.message ?? error) }],
        parseError: String(error?.message ?? error), updatedAt: stat.mtimeMs,
      }
    }
    return {
      id: slugOf(id), name: parsed.name ?? nameOf(text, slugOf(id)), text,
      items: parsed.items, warnings: parsed.warnings, entryLines: parsed.entryLines,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}), updatedAt: stat.mtimeMs,
    }
  }

  async list() {
    const names = (await fs.readdir(this.dir).catch(() => []))
      .filter((name) => name.endsWith(PLAYLIST_SUFFIX))
      .map((name) => name.slice(0, -PLAYLIST_SUFFIX.length))
    const out = []
    for (const id of names) {
      // 读不到 = 刚被外部删掉；名字不合法的（用户手放的怪文件）跳过而不是让整张列表失败。
      const got = await this.get(id).catch(() => null)
      if (got) out.push({ id: got.id, name: got.name, items: got.items.length, warnings: got.warnings.length, updatedAt: got.updatedAt })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 覆盖写之前先 `.backup`；新建不凭空造备份。张数上限在这里挡（只挡新建）。 */
  async write(id, text) {
    const slug = slugOf(id)
    const file = this.fileOf(slug)
    const existed = await exists(file)
    if (!existed && (await this.list()).length >= MAX_PLAYLISTS) {
      throw new Error(`歌单数量已达上限（最多 ${MAX_PLAYLISTS} 张）：先删掉不用的再建新的`)
    }
    if (existed) await fs.copyFile(file, `${file}${BACKUP_SUFFIX}`).catch(() => {})
    await atomicWriteText(file, text)
    return this.get(slug)
  }

  /** 改名：文本、备份、sidecar 三者一起走，不留孤儿。 */
  async rename(id, nextId) {
    const from = slugOf(id)
    const to = slugOf(nextId)
    if (from === to) return this.get(from)
    if (await exists(this.fileOf(to))) throw new Error(`已经有一张叫「${to}」的歌单`)
    for (const suffix of [PLAYLIST_SUFFIX, `${PLAYLIST_SUFFIX}${BACKUP_SUFFIX}`, MATCH_SUFFIX]) {
      await fs.rename(path.join(this.dir, from + suffix), path.join(this.dir, to + suffix)).catch(() => {})
    }
    await this.relabelSidecar(to)
    return this.get(to)
  }

  /**
   * sidecar 里存着自己的歌单名（`playlist` 字段），匹配器靠它挡"串单"——把 A 单的缓存文件拷给 B 单时
   * 宁可重搜也不误用。改名之后这个字段就成了旧名，不更新的话整单缓存会白丢一次（重搜全部条目）。
   * 更新失败不影响正确性：匹配器会把它当没有而重建，只是多花一次出网。
   */
  async relabelSidecar(id) {
    const file = this.matchFileOf(id)
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || parsed.playlist === id) return false
      parsed.playlist = id
      await atomicWriteText(file, `${JSON.stringify(parsed, null, 2)}\n`)
      return true
    } catch {
      return false
    }
  }

  /** 删除：三件一起删。sidecar 删不掉也不影响"歌单已消失"这个事实。 */
  async remove(id) {
    const slug = slugOf(id)
    for (const suffix of [PLAYLIST_SUFFIX, `${PLAYLIST_SUFFIX}${BACKUP_SUFFIX}`, MATCH_SUFFIX]) {
      await fs.rm(path.join(this.dir, slug + suffix), { force: true }).catch(() => {})
    }
    return { removed: slug }
  }
}
