import test from 'node:test'
import { listenAndReady } from './check-ready.mjs'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { MusicLibraryStore } from './music-library.mjs'
import { createMusicServer, parseRange } from './music-server.mjs'

// 自检必须离线：联网功能默认打开后 scan() 会跟着排一轮 MusicBrainz 补全，开发者 shell 里
// 恰好有 MUSICBRAINZ_CONTACT 时这些扫库用例就会真的出网。同款说明见 check-music-startup-scan.mjs。
delete process.env.MUSICBRAINZ_CONTACT

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-music-test-'))
  t.after(() => fs.rm(temporary, { force: true, recursive: true }))
  const root = path.join(temporary, 'music')
  await fs.mkdir(root)
  const store = await new MusicLibraryStore({ dataDir: path.join(temporary, 'index'), defaultRoots: [root], ...options }).init()
  return { temporary, root, store }
}

async function fakeAlbum(root, name = 'Album', files = ['01.flac']) {
  const folder = path.join(root, name)
  await fs.mkdir(folder, { recursive: true })
  for (const file of files) await fs.writeFile(path.join(folder, file), Buffer.from('only a temporary metadata fixture'))
  return folder
}

function wavFixture() {
  const sampleRate = 48000
  const dataSize = sampleRate * 2
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(dataSize, 40)
  return bytes
}

test('real WAV parsing exposes duration, lossless technical metadata, and byte-accurate Range playback', async (t) => {
  const { root, store, temporary } = await fixture(t)
  const folder = await fakeAlbum(root, 'Test WAV', [])
  const bytes = wavFixture()
  await fs.writeFile(path.join(folder, '1-01 Test.wav'), bytes)
  await store.scan()
  const track = store.snapshot().albums[0].tracks[0]
  assert.equal(track.format, 'WAV')
  assert.equal(track.duration, 1)
  assert.equal(track.sampleRate, 48000)
  assert.equal(track.bitsPerSample, 16)
  assert.equal(track.lossless, true)
  assert.equal(track.discNumber, 1)
  assert.equal(track.trackNumber, 1)
  assert.equal(track.browserPlayable, true)
  assert.equal('_path' in track, false)
  const distDir = path.join(temporary, 'dist')
  await fs.mkdir(distDir)
  await fs.writeFile(path.join(distDir, 'index.html'), '<h1>fixture</h1>')
  const { server } = await createMusicServer({ store, distDir, autoScan: false })
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  // R211（B 类）：listen 与探测整体交给 listenAndReady（连不上就换端口重听）；关闭钩子排在探测之前（R190 那一族）。
  const { origin } = await listenAndReady(server)
  const ranged = await fetch(`${origin}${track.audioUrl}`, { headers: { Range: 'bytes=0-43' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), `bytes 0-43/${bytes.length}`)
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(0, 44))
  const suffix = await fetch(`${origin}${track.audioUrl}`, { headers: { Range: 'bytes=-9' } })
  assert.equal(suffix.status, 206)
  assert.equal((await suffix.arrayBuffer()).byteLength, 9)
  const invalid = await fetch(`${origin}${track.audioUrl}`, { headers: { Range: `bytes=${bytes.length}-` } })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), `bytes */${bytes.length}`)
  assert.equal((await fetch(`${origin}/api/audio/not-indexed`)).status, 404)
  assert.equal((await fetch(`${origin}/api/library`, { headers: { Origin: 'https://unrelated.example' } })).status, 403)
  assert.equal((await fetch(`${origin}/api/library/scan`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await fetch(`${origin}/api/foobar/player`)).status, 503)
  const library = await (await fetch(`${origin}/api/library`)).json()
  assert.equal(library.albums.length, 1)
  store.introductionProvider = { lookup: async () => ({ status: 'matched', description: 'A synthetic encyclopedia introduction.', descriptionSource: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Test_fixture' } }) }
  const introduction = await fetch(`${origin}/api/library/introductions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ albumIds: [library.albums[0].id], force: true }) })
  assert.equal(introduction.status, 202, 'introduction updates must not require a MusicBrainz contact')
  await store.introductionsPromise
  assert.equal(store.snapshot().introductions.updated, 1)
  assert.equal(store.snapshot().albums[0].description, 'A synthetic encyclopedia introduction.')
  const malformedUpdate = await fetch(`${origin}/api/library/introductions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":"yes"}' })
  assert.equal(malformedUpdate.status, 400)
})

test('incremental scan detects additions/removals, caches unchanged tags, and preserves a disconnected root', async (t) => {
  let reads = 0
  const { root, store } = await fixture(t, { metadataParser: async () => { reads += 1; return { common: { album: 'Album', artist: 'Artist', genre: ['Mandopop'] }, format: { duration: 10 } } } })
  const first = await fakeAlbum(root, 'First')
  await store.scan()
  assert.equal(reads, 1)
  const firstId = store.snapshot().albums[0].id
  await store.scan()
  assert.equal(reads, 1, 'unchanged metadata should be read from the cached index')
  await fakeAlbum(root, 'Second')
  await store.scan()
  assert.equal(store.snapshot().albums.length, 2)
  assert.equal(reads, 2)
  await fs.rm(first, { recursive: true })
  await store.scan()
  assert.equal(store.snapshot().albums.length, 1)
  assert.ok(store.snapshot().albums.every((album) => album.id !== firstId))
  const disconnected = `${root}-disconnected`
  await fs.rename(root, disconnected)
  await store.scan()
  assert.equal(store.snapshot().albums.length, 1)
  assert.equal(store.snapshot().roots[0].status, 'offline')
  assert.equal(store.snapshot().albums[0].offline, true)
  await fs.rename(disconnected, root)
  await store.scan()
  assert.equal(store.snapshot().albums[0].offline, false)
})

test('folder covers override embedded art; removing a cover reveals cached or newly extracted embedded art', async (t) => {
  const embedded = Buffer.from('embedded-test-image')
  const { root, store } = await fixture(t, { metadataParser: async (_file, options) => ({ common: { picture: options.skipCovers ? [] : [{ format: 'image/png', type: 'Cover (front)', data: embedded }] }, format: {} }) })
  const folder = await fakeAlbum(root)
  const cover = path.join(folder, 'Cover.png')
  await fs.writeFile(cover, 'folder-test-image')
  await store.scan()
  const album = store.snapshot().albums[0]
  assert.equal(store.artworkFile(album.id).path, cover)
  assert.equal(store.artworkFile(album.id).embedded, false)
  await fs.unlink(cover)
  await store.scan()
  assert.equal(store.artworkFile(album.id).embedded, true)
  assert.deepEqual(await fs.readFile(store.artworkFile(album.id).path), embedded)
})

test('manual genres survive rescans and online refresh; editing the rules needs no audio rewrite', async (t) => {
  const { root, store } = await fixture(t, { metadataParser: async () => ({ common: { genre: ['国语流行音乐'], album: 'Album', artist: 'Artist' }, format: {} }) })
  await fakeAlbum(root)
  await store.scan()
  const album = store.snapshot().albums[0]
  assert.equal(album.genreId, 'mandopop')
  await store.updateRules({ ...store.rules, albumOverrides: { [album.id]: 'jazz' } })
  store.index.albums[0]._onlineGenres = ['Rock']
  assert.equal(store.snapshot().albums[0].genreId, 'jazz')
  await store.scan()
  assert.equal(store.snapshot().albums[0].genreId, 'jazz')
  const rulesFile = path.join(store.dataDir, 'genre-rules.json')
  const rules = JSON.parse(await fs.readFile(rulesFile, 'utf8'))
  rules.albumOverrides[album.id] = 'classical'
  await fs.writeFile(rulesFile, JSON.stringify(rules))
  await store.reloadRules()
  assert.equal(store.snapshot().albums[0].genreId, 'classical')
  assert.ok(await fs.stat(`${rulesFile}.backup`))
})

test('DSD is indexed without promising browser playback, and overlapping scans coalesce', async (t) => {
  let release
  let reads = 0
  const gate = new Promise((resolve) => { release = resolve })
  const { root, store } = await fixture(t, { metadataParser: async () => { reads += 1; await gate; return { common: {}, format: { codec: 'DSD', sampleRate: 2822400 } } } })
  await fakeAlbum(root, 'DSD', ['01.dsf', '02.dff'])
  const first = store.scan()
  const second = store.scan()
  release()
  await Promise.all([first, second])
  assert.equal(reads, 2)
  assert.deepEqual(store.snapshot().albums[0].tracks.map((track) => track.browserPlayable), [false, false])
  const reloaded = await new MusicLibraryStore({ dataDir: store.dataDir }).init()
  assert.equal(reloaded.snapshot().albums.length, 1, 'cached library is available before another scan')
})

test('ambiguous online matches never assign guessed production credits or genres', async (t) => {
  let calls = 0
  const candidate = { title: 'Album', id: 'ad934c98-0bbd-4060-8ebf-c5a23d2f2b6b', score: 100, 'track-count': 1, 'artist-credit': [{ name: 'Artist' }] }
  const { root, store } = await fixture(t, {
    metadataParser: async () => ({ common: { album: 'Album', artist: 'Artist', genre: ['Jazz'] }, format: {} }),
    musicBrainzContact: 'test@example.invalid',
    fetcher: async () => { calls += 1; return { ok: true, json: async () => ({ releases: [candidate, { ...candidate, id: 'bd934c98-0bbd-4060-8ebf-c5a23d2f2b6b' }] }) } },
  })
  await fakeAlbum(root)
  await store.scan()
  await store.enrich()
  const album = store.snapshot().albums[0]
  assert.equal(calls, 1)
  assert.equal(album.online.status, 'uncertain')
  assert.equal(album.genreId, 'jazz')
  assert.deepEqual(album.producers, [])
})

test('album introductions follow matched release-group links, retain attribution, and never use local comments', async (t) => {
  const releaseId = 'ad934c98-0bbd-4060-8ebf-c5a23d2f2b6b'
  const groupId = 'bd934c98-0bbd-4060-8ebf-c5a23d2f2b6b'
  const requests = []
  const { root, store } = await fixture(t, {
    metadataParser: async () => ({ common: { album: 'Album', artist: 'Artist', musicbrainz_albumid: releaseId, comment: [{ text: 'A mastering note, not an introduction.' }] }, format: { lossless: false, codec: 'MPEG-4/AAC' } }),
    musicBrainzContact: 'test@example.invalid',
    fetcher: async (url) => {
      requests.push({ url: url.href, time: Date.now() })
      let result
      if (url.pathname === `/ws/2/release/${releaseId}`) result = { 'release-group': { id: groupId }, genres: [{ name: 'Jazz', count: 2 }], relations: [], media: [] }
      else if (url.pathname === `/ws/2/release-group/${groupId}`) result = { relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } }] }
      else if (url.hostname === 'www.wikidata.org') result = { entities: { Q123: { sitelinks: { zhwiki: { title: '测试专辑' } } } } }
      else if (url.hostname === 'zh.wikipedia.org') result = { query: { pages: [{ title: '测试专辑', extract: 'This is an attributed online fixture introduction.' }] } }
      else throw new Error(`Unexpected network target ${url}`)
      return { ok: true, json: async () => result }
    },
  })
  await fakeAlbum(root, 'Album', ['01.m4a'])
  await store.scan()
  const before = store.snapshot().albums[0]
  assert.equal(before.description, undefined)
  assert.equal(before.localNote, 'A mastering note, not an introduction.')
  assert.equal(before.tracks[0].lossless, false)
  await store.updateRules({ ...store.rules, albumOverrides: { [before.id]: 'classical' } })
  await store.enrich()
  const after = store.snapshot().albums[0]
  assert.equal(after.description, 'This is an attributed online fixture introduction.')
  assert.equal(after.descriptionSource.name, '维基百科')
  assert.ok(after.descriptionSource.url.startsWith('https://zh.wikipedia.org/wiki/'))
  assert.equal(after.online.descriptionStatus, 'available')
  assert.equal(after.genreId, 'classical')
  assert.equal(requests.length, 4)
  for (let i = 1; i < requests.length; i += 1) assert.ok(requests[i].time - requests[i - 1].time >= 1000)
  await store.enrich()
  assert.equal(requests.length, 4, 'automatic enrichment does not refetch a cached match')
  assert.equal(store.enrichPromise, null, 'empty enrichment queues do not leave a stale in-flight promise')
})

test('Range validation rejects malformed and multipart requests and clips an excessive end', () => {
  assert.equal(parseRange('bytes=0-2,4-5', 10), false)
  assert.equal(parseRange('bytes=-0', 10), false)
  assert.equal(parseRange('bytes=7-2', 10), false)
  assert.equal(parseRange('bytes=0-', 0), false)
  assert.deepEqual(parseRange('bytes=7-99', 10), { start: 7, end: 9 })
})

test('联网开关默认开启（R77 之后是四张子表）：缺项落回默认、意外值落回默认并写回合法值、明确的 false 才持久关闭、写入仍严格校验', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rhine-online-switch-'))
  t.after(() => fs.rm(temporary, { force: true, recursive: true, maxRetries: 5, retryDelay: 80 }))
  const ALL_ON = { lyrics: true, search: true, streaming: true, covers: true }

  // ① 全新数据目录（磁盘上根本没有 config.json）⇒ 总开关与四张子表都按默认开启落库
  const fresh = path.join(temporary, 'fresh')
  const freshStore = await new MusicLibraryStore({ dataDir: fresh }).init()
  assert.equal(freshStore.config.onlineEnabled, true, 'a brand-new library ships with the online metadata switch on')
  assert.deepEqual(freshStore.config.online, ALL_ON, 'a brand-new library ships all four online sub-switches on (R77)')
  assert.deepEqual(freshStore.snapshot().onlineLyrics, { enabled: true }, 'the state the front end renders is the default-on one')
  const persisted = JSON.parse(await fs.readFile(path.join(fresh, 'config.json'), 'utf8'))
  assert.deepEqual({ onlineEnabled: persisted.onlineEnabled, online: persisted.online }, { onlineEnabled: true, online: ALL_ON }, 'the default is written to disk, not just held in memory')
  assert.equal('onlineLyrics' in persisted, false, '磁盘上不得同时存在新旧两份开关（R77 的唯一真源）')

  // ② 旧库升级：磁盘上写过的布尔值一律算"用户表过态"，不被新默认覆盖；从未写过的项才落回新默认
  const legacy = path.join(temporary, 'legacy')
  await fs.mkdir(legacy, { recursive: true })
  await fs.writeFile(path.join(legacy, 'config.json'), JSON.stringify({ version: 1, roots: [], onlineEnabled: false }))
  const legacyStore = await new MusicLibraryStore({ dataDir: legacy }).init()
  assert.equal(legacyStore.config.onlineEnabled, false, 'an explicit false on disk is a recorded choice; the new default must not overwrite it')
  assert.deepEqual(legacyStore.config.online, ALL_ON, 'sub-switches the old version never wrote fall back to the new default')

  // ③ 意外值（手写坏的 config.json）落回产品默认，并把归一后的合法值写回磁盘
  const tampered = path.join(temporary, 'tampered')
  await fs.mkdir(tampered, { recursive: true })
  await fs.writeFile(path.join(tampered, 'config.json'), JSON.stringify({ version: 1, roots: [], onlineEnabled: true, onlineLyrics: { enabled: 'yes' } }))
  const store = await new MusicLibraryStore({ dataDir: tampered }).init()
  assert.equal(store.config.online.lyrics, true, 'a non-boolean value is not a user choice: it lands on the product default (on)')
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tampered, 'config.json'), 'utf8')).online, ALL_ON, 'the coerced value is written back in the NEW table so the bad value cannot survive a restart')
  assert.equal(store.config.onlineEnabled, true, 'MusicBrainz enrichment keeps its separate switch')

  // ④ 写入侧的严格校验一条不让步：非法形状一律拒（新旧两种形状都算），合法布尔双向可存且跨重启保持
  for (const bad of [{ onlineLyrics: 'on' }, { onlineLyrics: null }, { onlineLyrics: { enabled: 1 } }, { onlineLyrics: {} },
    { onlineLyrics: { enabled: true, extra: 1 } }, { online: 'on' }, { online: { lyrics: 'yes' } }, { online: { karaoke: true } },
    { online: { lyrics: true }, onlineLyrics: { enabled: false } }]) {
    await assert.rejects(() => store.updateConfig(bad), /online/, `${JSON.stringify(bad)} must be rejected`)
  }
  assert.deepEqual(store.config.online, ALL_ON, 'a rejected write leaves the switches untouched')
  assert.equal((await store.updateConfig({ onlineLyrics: { enabled: false } })).onlineLyrics.enabled, false, 'an explicit disable through the legacy field is accepted and mirrored back')
  assert.equal((await new MusicLibraryStore({ dataDir: tampered }).init()).config.online.lyrics, false, 'the explicit disable survives a restart — that is the only way to be off')
  assert.equal((await store.updateConfig({ online: { covers: false } })).online.covers, false, '新表可以只提交一项')
  assert.equal((await store.updateConfig({ onlineLyrics: { enabled: true } })).onlineLyrics.enabled, true, 'and it can be turned back on')
})

test('未配置 MusicBrainz 联系方式时，扫描后的在线资料补全整轮跳过且不落错误状态', async (t) => {
  const { root, store } = await fixture(t, { metadataParser: async () => ({ common: { album: '跳过取样', artist: '某人' }, format: { duration: 10 } }) })
  await fakeAlbum(root, '跳过取样', ['01.flac'])
  store.config.musicBrainzContact = ''
  store.musicBrainzContact = ''
  let fetchCalls = 0
  store.fetcher = async () => { fetchCalls += 1; throw new Error('不该发起任何在线请求') }
  const snapshot = await store.scan()
  assert.equal(snapshot.enrich?.skipped, 'no-contact', '扫描结果里能看到"补全被跳过"这一档')
  assert.equal(fetchCalls, 0, '跳过不得走到传输层')
  // scan() 给新专辑的初始值是 `online:{status:'unqueried'}`（无 checkedAt）；跳过必须把它留在这一格。
  // 修复前是逐张写成 `{status:'error', checkedAt}`，而 checkedAt 一旦落下，配好联系方式后的那轮就不再重查它。
  assert.equal(store.index.albums[0].online?.status, 'unqueried', '跳过后专辑的在线状态仍是"未查询"，不是 error')
  assert.equal(store.index.albums[0].online?.checkedAt, undefined, '不得留下 checkedAt —— 留下了就等于把这张专辑永久排除在补全之外')
  assert.equal(store.enrichStatus.running, false, '跳过不是后台任务，不留悬挂的锁')

  // 配上联系方式后同一张专辑仍应被正常排进补全队列（跳过不得把专辑标记成"已查过"）
  let queued = 0
  store.musicBrainzContact = 'fixture@example.invalid'
  store.fetcher = async (url) => {
    queued += 1
    assert.equal(new URL(url).hostname, 'musicbrainz.org', '补全只该问 MusicBrainz 本身')
    return { ok: true, status: 200, json: async () => ({ releases: [] }) }
  }
  const again = await store.scan()
  assert.equal(again.enrich?.skipped, undefined, '配好联系方式后不再有跳过标记')
  await store.enrich() // 扫描后的自动补全是 fire-and-forget，断言前必须汇合（enrich 幂等：在飞则复用同一条 promise）
  assert.equal(queued, 1, '联系方式到位后，同一张没被真正查过的专辑照常进入补全')
  assert.equal(store.index.albums[0].online?.status, 'not-found', '走到在线一轮后才有正常的"未找到"状态')
})
