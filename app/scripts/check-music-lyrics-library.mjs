// Stage 5 T2 self-check for the local lyric data link: sidecar pairing, embedded
// SYLT/USLT extraction, the read-only /api/lyrics route and its root guards.
// Real MP3 bytes with hand-built ID3v2 frames are used on purpose, so the chain runs
// through music-metadata's own lyric parsing instead of a stubbed parser.
import test from 'node:test'
import { listenAndReady } from './check-ready.mjs';   // R211（A 类第 3 处）：见 library() 里的注释
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { parseFile } from 'music-metadata'
import { MusicLibraryStore, METADATA_VERSION } from './music-library.mjs'
import { createMusicServer } from './music-server.mjs'

// 自检必须离线：联网功能默认打开后 scan() 会跟着排一轮 MusicBrainz 补全，开发者 shell 里
// 恰好有 MUSICBRAINZ_CONTACT 时这些扫库用例就会真的出网。同款说明见 check-music-startup-scan.mjs。
delete process.env.MUSICBRAINZ_CONTACT

const id3Frame = (id, payload) => {
  const header = Buffer.alloc(10)
  header.write(id, 0, 'latin1')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** ID3v2.3 tag; its size is four 7-bit bytes, so it cannot be written as a plain BE word. */
function id3Tag(frames) {
  const body = Buffer.concat(frames)
  const header = Buffer.alloc(10)
  header.write('ID3', 0)
  header.writeUInt8(3, 3); header.writeUInt8(0, 4); header.writeUInt8(0, 5)
  header.writeUInt8((body.length >> 21) & 0x7f, 6); header.writeUInt8((body.length >> 14) & 0x7f, 7)
  header.writeUInt8((body.length >> 7) & 0x7f, 8); header.writeUInt8(body.length & 0x7f, 9)
  return Buffer.concat([header, body])
}

// UTF-8 text frames keep Chinese lyrics intact (latin1 would cut on a 0x00 byte).
const titleFrame = (value) => id3Frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]))
const usltFrame = (value) => id3Frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng', 'latin1'), Buffer.from([0]), Buffer.from(value, 'utf8'), Buffer.from([0])]))

/** SYLT: encoding, language, timeStampFormat (2 = ms), contentType (1 = lyrics), descriptor, then (text + uint32BE ms)*. */
function syltFrame(lines) {
  const parts = [Buffer.from([3]), Buffer.from('eng', 'latin1'), Buffer.from([2]), Buffer.from([1]), Buffer.from([0])]
  for (const [text, milliseconds] of lines) {
    parts.push(Buffer.from(text, 'utf8'), Buffer.from([0]))
    const timestamp = Buffer.alloc(4)
    timestamp.writeUInt32BE(milliseconds, 0)
    parts.push(timestamp)
  }
  return id3Frame('SYLT', Buffer.concat(parts))
}

const mp3With = (...frames) => id3Tag(frames)

/** A real library in the system temp dir plus a live music server on a random port. */
async function library(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-lyrics-test-'))
  const root = path.join(temporary, 'music')
  const dataDir = path.join(temporary, 'index')
  const distDir = path.join(temporary, 'dist')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(distDir)
  await fs.writeFile(path.join(distDir, 'index.html'), '<h1>fixture</h1>')
  const store = await new MusicLibraryStore({ dataDir, defaultRoots: [root], ...options }).init()
  const { server } = await createMusicServer({ store, distDir, autoScan: false })
  // R211（A 类第 3 处）：关闭钩子**先注册再探测** —— 从前探测排在 `t.after` 之前，坏探测一抛，服务与临时目录一起漏；
  // 现在 listen/探测整体交给 listenAndReady（连不上就换端口重听），抛错时 t.after 照样把这台收干净（错误原样抛）。
  let closed = false
  t.after(async () => {
    // Close the sockets first: Windows refuses to delete a tree that still holds files open.
    if (!closed) { closed = true; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
    await fs.rm(temporary, { force: true, recursive: true, maxRetries: 5, retryDelay: 80 })
  })
  const { origin } = await listenAndReady(server)
  return { temporary, root, dataDir, store, origin, scan: async (target = store) => {
    // A failed root is caught per root, so assert out loud that the scan really succeeded.
    await target.scan()
    assert.equal(target.scanStatus.error, undefined, 'the scan must not swallow an error')
    assert.deepEqual(target.snapshot().roots.map((entry) => entry.status), ['online'], 'a broken root would masquerade as an empty library')
  } }
}

const trackOf = (snapshot, albumTitle, trackTitle) => {
  const foundAlbum = snapshot.albums.find((entry) => entry.title === albumTitle)
  assert.ok(foundAlbum, `fixture album ${albumTitle} is missing`)
  const track = foundAlbum.tracks.find((entry) => entry.title === trackTitle)
  assert.ok(track, `fixture track ${trackTitle} is missing`)
  return track
}

const lyricFiles = async (dataDir) => (await fs.readdir(path.join(dataDir, 'lyrics'))).filter((name) => !name.includes('.tmp'))

test('sidecar .lrc/.ttml pair by basename, outrank embedded tags, and serve over /api/lyrics', async (t) => {
  const { root, store, origin, scan } = await library(t)
  await fs.writeFile(path.join(root, '青花瓷.mp3'), mp3With(titleFrame('青花瓷'), usltFrame('内嵌歌词应当落败')))
  const lrcText = '[00:01.23]伴生第一行\n[01:05.50]伴生第二行\n'
  await fs.writeFile(path.join(root, '青花瓷.lrc'), lrcText)
  // Paired through an NFC-composed vs decomposed basename and a case-folded extension.
  await fs.writeFile(path.join(root, '\u0041\u0308test.mp3'), mp3With(titleFrame('NFC 配对')))
  await fs.writeFile(path.join(root, '\u00C4test.LRC'), '[00:00.00]NFC 命中\n')
  await fs.writeFile(path.join(root, '两个都有.mp3'), mp3With(titleFrame('两个都有')))
  await fs.writeFile(path.join(root, '两个都有.ttml'), '<tt xml:lang="zh"><body><div begin="00:00:00.000">逐字</div></body></tt>')
  await fs.writeFile(path.join(root, '两个都有.lrc'), '[00:02.00]行级\n')
  await fs.writeFile(path.join(root, '无歌词.mp3'), mp3With(titleFrame('无歌词')))
  const nested = path.join(root, '专辑')
  await fs.mkdir(nested, { recursive: true })
  await fs.writeFile(path.join(nested, '01.mp3'), mp3With(titleFrame('专辑无词')))
  await fs.writeFile(path.join(nested, '02.mp3'), mp3With(titleFrame('专辑伴生')))
  const nestedTtml = '<tt xml:lang="zh"><body><div begin="00:00:01.000">嵌套逐字</div></body></tt>'
  await fs.writeFile(path.join(nested, '02.TTML'), nestedTtml)
  await scan()
  const snapshot = store.snapshot()

  const sidecar = trackOf(snapshot, '青花瓷', '青花瓷')
  assert.equal(sidecar.lyrics.source, 'sidecar', 'an explicit sidecar file must beat the embedded tag')
  assert.equal(sidecar.lyrics.format, 'lrc')
  assert.equal(sidecar.lyrics.url, `/api/lyrics/${sidecar.id}`)
  assert.equal('_lyrics' in sidecar, false, 'the lyric path stays out of the public snapshot')
  assert.equal('_path' in sidecar, false)
  const response = await fetch(`${origin}${sidecar.lyrics.url}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(response.headers.get('cache-control'), 'private, no-cache')
  assert.equal(await response.text(), lrcText)
  const head = await fetch(`${origin}${sidecar.lyrics.url}`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(lrcText)))

  assert.equal(trackOf(snapshot, 'NFC 配对', 'NFC 配对').lyrics.format, 'lrc', 'case-insensitive NFC pairing')
  const both = trackOf(snapshot, '两个都有', '两个都有')
  assert.equal(both.lyrics.source, 'sidecar')
  assert.equal(both.lyrics.format, 'lrc', 'a line-timed .lrc is preferred over .ttml when both exist')

  const ttml = trackOf(snapshot, '专辑', '专辑伴生')
  assert.equal(ttml.lyrics.source, 'sidecar', 'nested album folders pair sidecars too')
  assert.equal(ttml.lyrics.format, 'ttml')
  const ttmlResponse = await fetch(`${origin}${ttml.lyrics.url}`)
  assert.equal(ttmlResponse.headers.get('content-type'), 'application/ttml+xml; charset=utf-8')
  assert.equal(await ttmlResponse.text(), nestedTtml)

  assert.equal(trackOf(snapshot, '无歌词', '无歌词').lyrics, undefined, 'a lyric-less track omits the field')
  assert.equal(trackOf(snapshot, '专辑', '专辑无词').lyrics, undefined)
  assert.equal((await fetch(`${origin}/api/lyrics/${trackOf(snapshot, '无歌词', '无歌词').id}`)).status, 404)
  assert.deepEqual(await fs.readdir(path.join(store.dataDir, 'lyrics')).catch(() => []), [], 'sidecar-only libraries write nothing')
})

test('embedded SYLT is extracted as [mm:ss.xx] LRC while a USLT-only tag stays plain text', async (t) => {
  let reads = 0
  const { root, dataDir, store, origin, scan } = await library(t, { metadataParser: async (file, options) => { reads += 1; return parseFile(file, options) } })
  const folder = path.join(root, '内嵌')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, 'synced.mp3'), mp3With(titleFrame('同步内嵌'), syltFrame([['首行', 0], ['第一行 中文', 1230], ['second\r\nline', 65_500], ['跨分钟', 3_600_000]])))
  await fs.writeFile(path.join(folder, 'unsynced.mp3'), mp3With(titleFrame('非同步内嵌'), usltFrame('只有文字的内嵌歌词\n第二行')))
  await fs.writeFile(path.join(folder, 'lrc-in-uslt.mp3'), mp3With(titleFrame('非同步带时间戳'), usltFrame('[00:03.00]USLT 里带时间戳')))
  await fs.writeFile(path.join(folder, 'blank.mp3'), mp3With(titleFrame('空标签'), usltFrame('   ')))
  await scan()
  assert.equal(reads, 4)
  const snapshot = store.snapshot()

  const synced = trackOf(snapshot, '内嵌', '同步内嵌')
  assert.equal(synced.lyrics.source, 'embedded')
  assert.equal(synced.lyrics.format, 'lrc')
  const extracted = await (await fetch(`${origin}${synced.lyrics.url}`)).text()
  assert.equal(extracted, '[00:00.00]首行\n[00:01.23]第一行 中文\n[01:05.50]second line\n[60:00.00]跨分钟\n')
  const descriptor = store.trackLyrics(synced.id)
  assert.ok(descriptor.path.startsWith(path.join(dataDir, 'lyrics')), 'extracted lyrics are written under dataDir/lyrics')
  assert.ok(descriptor.path.endsWith('.lrc'))
  assert.equal(descriptor.allowedRoot, dataDir)

  const plain = trackOf(snapshot, '内嵌', '非同步内嵌')
  assert.equal(plain.lyrics.source, 'embedded')
  assert.equal(plain.lyrics.format, 'lyrics')
  const plainResponse = await fetch(`${origin}${plain.lyrics.url}`)
  assert.equal(plainResponse.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(await plainResponse.text(), '只有文字的内嵌歌词\n第二行\n')
  assert.ok(store.trackLyrics(plain.id).path.endsWith('.txt'))

  // Agreed rule: only syncText is converted, so timestamps carried by a USLT text stay
  // format "lyrics" and the text is served verbatim for the interface to re-sniff.
  const unsyncedTimed = trackOf(snapshot, '内嵌', '非同步带时间戳')
  assert.equal(unsyncedTimed.lyrics.format, 'lyrics')
  assert.equal(await (await fetch(`${origin}${unsyncedTimed.lyrics.url}`)).text(), '[00:03.00]USLT 里带时间戳\n')

  assert.equal(trackOf(snapshot, '内嵌', '空标签').lyrics, undefined, 'a blank USLT frame is not a lyric source')
  const written = await lyricFiles(dataDir)
  assert.equal(written.filter((name) => name.endsWith('.lrc')).length, 1, 'one content-addressed file per lyric body')
  assert.equal(written.filter((name) => name.endsWith('.txt')).length, 2)

  await scan()
  assert.equal(reads, 4, 'an unchanged library reuses the cached lyric descriptors')
  assert.equal(trackOf(store.snapshot(), '内嵌', '同步内嵌').lyrics.url, synced.lyrics.url)
  assert.deepEqual(await lyricFiles(dataDir), written, 'a rescan does not duplicate the extracted files')
})

test('the lyrics route keeps the origin, index and real-path guards', async (t) => {
  const { root, temporary, store, origin, scan } = await library(t)
  await fs.writeFile(path.join(root, '有词.mp3'), mp3With(titleFrame('有词')))
  await fs.writeFile(path.join(root, '有词.lrc'), '[00:00.00]安全\n')
  await scan()
  const track = store.snapshot().albums[0].tracks[0]
  assert.equal(track.lyrics.source, 'sidecar')

  const outside = path.join(temporary, 'outside')
  await fs.mkdir(outside)
  const secret = path.join(outside, 'secret.lrc')
  await fs.writeFile(secret, '[00:00.00]不应读到的文件\n')

  assert.equal((await fetch(`${origin}/api/lyrics/track-deadbeef`)).status, 404, 'an unknown id is not a file')
  assert.equal((await fetch(`${origin}/api/lyrics/${track.id}`, { headers: { Origin: 'https://unrelated.example' } })).status, 403, 'cross-site requests stay rejected')
  assert.equal((await fetch(`${origin}/api/lyrics/..%2f..%2foutside%2fsecret`)).status, 404, 'encoded traversal cannot reach the route')
  assert.equal((await fetch(`${origin}/api/lyrics/${track.id}%00`)).status, 400)
  assert.equal((await fetch(`${origin}/api/lyrics/${track.id}`, { method: 'POST' })).status, 404, 'the route stays read-only')

  // A tampered index entry must still fail the realpath containment check in serveFile.
  const indexTrack = store.index.albums[0].tracks[0]
  const original = indexTrack._lyrics
  indexTrack._lyrics = { ...original, path: secret }
  const escaped = await fetch(`${origin}/api/lyrics/${track.id}`)
  assert.equal(escaped.status, 403, 'a lyric path outside the allowed root is refused, not read')
  assert.doesNotMatch(await escaped.text(), /不应读到的文件/)
  indexTrack._lyrics = original

  // Dropping the root takes the album out of every file route at once.
  await store.updateConfig({ roots: [path.join(temporary, 'other-root')] })
  assert.equal(store.trackLyrics(track.id), null)
  assert.equal((await fetch(`${origin}/api/lyrics/${track.id}`)).status, 404)
})

test('a METADATA_VERSION bump re-reads a stale index and a new sidecar invalidates the cache', async (t) => {
  let reads = 0
  const counting = async (file, options) => { reads += 1; return parseFile(file, options) }
  const { root, dataDir, store, origin, scan } = await library(t, { metadataParser: counting })
  assert.ok(METADATA_VERSION >= 3, 'lyrics require a metadata version bump to backfill old indexes')
  await fs.writeFile(path.join(root, '有词.mp3'), mp3With(titleFrame('有词')))
  await fs.writeFile(path.join(root, '无词.mp3'), mp3With(titleFrame('无词')))
  await scan()
  assert.equal(reads, 2)
  assert.equal(trackOf(store.snapshot(), '有词', '有词').lyrics, undefined, 'an index without lyric sources has none')

  await fs.writeFile(path.join(root, '有词.lrc'), '[00:00.00]补上的伴生歌词\n')
  await scan()
  assert.equal(reads, 3, 'only the track whose sidecar appeared is re-read')
  const added = trackOf(store.snapshot(), '有词', '有词')
  assert.equal(added.lyrics.source, 'sidecar')
  assert.equal(added.lyrics.format, 'lrc')
  assert.equal(await (await fetch(`${origin}/api/lyrics/${added.id}`)).text(), '[00:00.00]补上的伴生歌词\n')
  assert.equal(store.trackLyrics(added.id).allowedRoot, root)

  // Rewind that track to an older metadata version, as an index written before this feature is.
  const stale = store.index.albums.find((entry) => entry.title === '有词').tracks.find((entry) => entry.title === '有词')
  delete stale.lyrics
  delete stale._lyrics
  stale._metadataVersion = METADATA_VERSION - 1
  await store.saveIndex()
  const reloaded = await new MusicLibraryStore({ dataDir, metadataParser: counting }).init()
  assert.equal(trackOf(reloaded.snapshot(), '有词', '有词').lyrics, undefined, 'the cached library is served before a scan')
  await scan(reloaded)
  assert.equal(reads, 4, 'the stale entry is re-read while the current one is reused')
  assert.equal(trackOf(reloaded.snapshot(), '有词', '有词').lyrics.source, 'sidecar', 'the backfilled lyric survives the reload')
  await scan(reloaded)
  assert.equal(reads, 4, 'a second scan on the refreshed index reads nothing again')
})

const artistFrame = (value) => id3Frame('TPE1', Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]))
const albumFrame = (value) => id3Frame('TALB', Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8')]))

test('在线匹配的只读视图：本地有无词的判定、标签文本抽取，且内部路径一律不外泄', async (t) => {
  const { root, store, scan } = await library(t)
  // 同一文件夹 = 一张专辑，这样 query.album 取的是专辑标题而不是单曲文件名。
  const folder = path.join(root, '在线样本')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, '01.mp3'), mp3With(titleFrame('有伴生'), artistFrame('山下達郎'), albumFrame('COME ALONG 3')))
  await fs.writeFile(path.join(folder, '01.lrc'), '[00:01.00]伴生行\n')
  await fs.writeFile(path.join(folder, '02.mp3'), mp3With(titleFrame('仅内嵌'), artistFrame('李荣浩'), albumFrame('COME ALONG 3'), usltFrame('内嵌段落第一行\n第二行')))
  await fs.writeFile(path.join(folder, '03.mp3'), mp3With(titleFrame('完全无词'), artistFrame('Li Ronghao'), albumFrame('COME ALONG 3')))
  await scan()

  const byTitle = (title) => store.snapshot().albums.flatMap((album) => album.tracks).find((track) => track.title === title)
  assert.ok(byTitle('完全无词'), 'fixture must be indexed')

  // 冲突规则的三档判定（6.6 定案：本地有**带时间轴**的词才一票否决，内嵌纯文本仍可去问在线）：
  // 伴生 = 有轴 / 仅内嵌 USLT（就是 F1 那首 Lovers 的形状）= 有词但无轴 / 完全无词
  const lyricView = (title) => store.trackForOnlineMatch(byTitle(title).id).localLyric
  assert.deepEqual(lyricView('有伴生'), { present: true, timed: true, format: 'lrc' }, '伴生文件是带时间轴的本地词，冲突规则不让出去')
  assert.deepEqual(lyricView('仅内嵌'), { present: true, timed: false, format: 'lyrics' }, '内嵌 USLT 只是"唯一有的歌词"，不是"更好的歌词"')
  assert.deepEqual(lyricView('完全无词'), { present: false, timed: false, format: null }, '完全没有才叫 absent')

  const view = store.trackForOnlineMatch(byTitle('完全无词').id)
  assert.equal(view.query.title, '完全无词')
  assert.equal(view.query.artist, 'Li Ronghao')
  assert.equal(view.query.album, 'COME ALONG 3', 'the album title comes from the index grouping, not a guess')
  assert.equal(typeof view.query.durationMs, 'number', 'duration is normalised to ms for the score multiplier')
  assert.deepEqual(view.album, { id: view.album.id, title: 'COME ALONG 3' })
  assert.equal(Object.keys(view.track).some((key) => key.startsWith('_')), false, 'the view carries no internal keys')
  assert.equal(JSON.stringify(view).includes(root), false, 'no filesystem path may leave the store through this view')

  assert.equal(store.trackForOnlineMatch('no-such-id'), null, 'an unknown id is a 404 upstream, not a guess')
  const bareId = view.track.id
  await store.updateConfig({ roots: [] })
  assert.equal(store.trackForOnlineMatch(bareId), null, 'a disconnected root cannot be matched online')
})

test('在线打分的查询字段只取带信息量的标签：冒充的专辑名与占位艺术家一律传空', async (t) => {
  const { root, store, scan } = await library(t)
  // ① 内嵌 TALB 在 ⇒ 用标签（真实样本就是这个形状：单曲文件夹 + 从内嵌标签读到的专辑名）。
  const withTag = path.join(root, 'さよなら夏の日')
  await fs.mkdir(withTag, { recursive: true })
  await fs.writeFile(path.join(withTag, '山下達郎 - さよなら夏の日.mp3'), mp3With(titleFrame('さよなら夏の日'), artistFrame('山下達郎'), albumFrame('COME ALONG 3')))
  // ② 文件夹名等于歌名、又没有 TALB ⇒ 那不是专辑证据，传空让打分走中性满权重。
  const selfNamed = path.join(root, 'Lovers - Single')
  await fs.mkdir(selfNamed, { recursive: true })
  await fs.writeFile(path.join(selfNamed, 'Lovers.mp3'), mp3With(titleFrame('Lovers'), artistFrame('Li Ronghao')))
  // ③ 直接放在曲库根上的单曲：album.title 由文件名推出（music-library.mjs:424）。
  await fs.writeFile(path.join(root, 'Carefree.mp3'), mp3With(titleFrame('Carefree'), artistFrame('Kevin MacLeod')))
  // ④ 多曲目文件夹、无 TALB：文件夹名是真正的专辑名；缺艺术家时库里写的是占位符 '未知艺术家'。
  const multi = path.join(root, '黑马')
  await fs.mkdir(multi, { recursive: true })
  await fs.writeFile(path.join(multi, '01.mp3'), mp3With(titleFrame('黑马')))
  await fs.writeFile(path.join(multi, '02.mp3'), mp3With(titleFrame('不搭')))
  await scan()

  const queryOf = (title) => {
    const track = store.snapshot().albums.flatMap((album) => album.tracks).find((entry) => entry.title === title)
    assert.ok(track, `fixture track ${title} is missing`)
    return store.trackForOnlineMatch(track.id).query
  }
  assert.equal(queryOf('さよなら夏の日').album, 'COME ALONG 3', 'an embedded TALB is the strongest album evidence')
  assert.equal(queryOf('Lovers').album, 'Lovers - Single', 'a folder title is real (if weak) album evidence, so the scorer gets it')
  assert.equal(queryOf('Carefree').album, '', 'a loose single at the library root derives its album title from the filename, which is not album evidence')
  assert.equal(queryOf('黑马').album, '黑马', 'a self-titled album keeps its 30-point album weight: the title came from the folder, not the file')
  assert.equal(queryOf('黑马').artist, '', "the library's 未知艺术家 placeholder must never be sent as an artist")
  assert.equal(queryOf('不搭').artist, '')
  assert.equal(queryOf('さよなら夏の日').artist, '山下達郎')
  assert.equal(queryOf('Carefree').artist, 'Kevin MacLeod')
  assert.equal(typeof queryOf('さよなら夏の日').durationMs, 'number', 'duration is normalised to ms for the score multiplier')
})
