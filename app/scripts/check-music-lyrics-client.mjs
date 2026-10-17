import test from 'node:test'
import assert from 'node:assert/strict'
import { createLyricsClient } from '../src/lyrics-client.ts'
import { parseLyrics } from '../src/lyrics/index.ts'

/** Worker double that parses inline, so the client's worker protocol is exercised for real. */
class FakeWorker {
  static instances = []
  onmessage = null
  onerror = null
  posted = []
  constructor() {
    FakeWorker.instances.push(this)
  }
  postMessage(job) {
    this.posted.push(job)
    // 真 worker 会把这两个字段透给解析层；double 也必须透，否则客户端漏传就是测不出来。
    parseLyrics({ text: job.text, format: job.format, translation: job.translation, romanization: job.romanization }).then((result) => {
      this.onmessage?.({
        data: {
          id: job.id,
          data: result.data,
          empty: result.empty,
          ...(result.rejected ? { rejected: result.rejected } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
      })
    })
  }
  terminate() {}
}

const trackWith = (lyrics) => ({
  id: 'track-x',
  albumId: 'album-x',
  title: '示例曲',
  artist: '测试者',
  duration: 100,
  format: 'MP3',
  browserPlayable: true,
  audioUrl: '/api/audio/track-x',
  relativePath: '示例曲.mp3',
  ...(lyrics ? { lyrics } : {}),
})

const LRC = '[00:01.00]第一行\n[00:05.00]第二行\n'

const fetchReturning = (body, ok = true, status = 200) => async () => ({
  ok,
  status,
  text: async () => body,
})

test('无歌词曲目不发起任何请求', async () => {
  let calls = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, text: async () => '' }
    },
  })
  const loaded = await client.load(trackWith(undefined))
  assert.equal(loaded.source, 'none')
  assert.equal(loaded.empty, true)
  assert.equal(calls, 0, 'a track without lyrics must not hit the network')
  client.dispose()
})

test('sidecar LRC 经 worker 解析并缓存', async () => {
  FakeWorker.instances.length = 0
  let calls = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async (url) => {
      calls += 1
      assert.equal(url, '/api/lyrics/track-x')
      return { ok: true, status: 200, text: async () => LRC }
    },
  })
  const track = trackWith({ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' })
  const first = await client.load(track)
  assert.equal(first.source, 'sidecar')
  assert.equal(first.format, 'lrc')
  assert.equal(first.empty, false)
  assert.equal(first.data.lines.length, 2)
  assert.ok(Math.abs(first.data.lines[1].startTime - 5) < 1e-6, 'seconds-based timeline')
  assert.equal(client.usingWorker, true)
  const second = await client.load(track)
  assert.equal(calls, 1, 'the second load must be served from cache')
  assert.equal(second.trackId, 'track-x')
  client.reset()
  await client.load(track)
  assert.equal(calls, 2, 'reset() clears the cache so a rescan is picked up')
  client.dispose()
})

test('worker 不可用时回落主线程解析，结果一致', async () => {
  const client = createLyricsClient({
    WorkerImpl: () => {
      throw new Error('no worker support')
    },
    fetchImpl: fetchReturning(LRC),
  })
  const loaded = await client.load(trackWith({ source: 'embedded', format: 'lrc', url: '/api/lyrics/track-x' }))
  assert.equal(client.usingWorker, false)
  assert.equal(loaded.empty, false)
  assert.equal(loaded.data.lines.length, 2)
  assert.equal(loaded.source, 'embedded')
  client.dispose()
})

test('安全预检在客户端里保持可见（rejected 透传）', async () => {
  const evil = '<?xml version="1.0"?><!DOCTYPE tt [<!ENTITY x "y">]><tt><body></body></tt>'
  const client = createLyricsClient({ WorkerImpl: FakeWorker, fetchImpl: fetchReturning(evil) })
  const loaded = await client.load(trackWith({ source: 'sidecar', format: 'ttml', url: '/api/lyrics/track-x' }))
  assert.equal(loaded.rejected, 'entity-declaration')
  assert.equal(loaded.empty, true)
  client.dispose()
})

test('读取失败与解析失败都降级为无歌词并带错误信息', async () => {
  const failing = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
  })
  const missing = await failing.load(trackWith({ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' }))
  assert.equal(missing.empty, true)
  assert.match(missing.error, /404/)
  failing.dispose()

  const throwing = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  const broken = await throwing.load(trackWith({ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' }))
  assert.equal(broken.empty, true)
  assert.match(broken.error, /network down/)
  throwing.dispose()
})

test('同一曲目并发加载只请求一次', async () => {
  let calls = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, text: async () => LRC }
    },
  })
  const track = trackWith({ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' })
  const [a, b] = await Promise.all([client.load(track), client.load(track)])
  assert.equal(calls, 1, 'in-flight requests must be deduplicated')
  assert.equal(a.data.lines.length, b.data.lines.length)
  client.dispose()
})

// ── 任务 8（R60）：在线异步升级通路 ────────────────────────────────────────
const QRC_SAMPLE = '[0,2250]アルファ(0,160)ベータ(160,160)\n[2250,2250]ガンマ(2250,450)デルタ(2700,450)\n[4500,2000]イプシロン(4500,375)オメガ(4875,375)\n'
const TRANSLATION_SAMPLE = '[00:00.00]第一行译文\n[00:02.25]第二行译文\n[00:04.50]第三行译文\n'
const ROMAJI_SAMPLE = '[00:00.00]arufa\n[00:02.25]ganma\n[00:04.50]ipushiron\n'
const MATCHED_SONG = { title: 'さよなら夏の日 (道别的夏天)', artist: '山下達郎', durationMs: 267000 }

test('在线升级：本地无词时 load 先回 none，upgrade 后到；命中后写缓存，第二次 load 直接是 online', async () => {
  const source = { calls: [], result: async () => ({ matched: true, format: 'qrc', text: QRC_SAMPLE, provider: 'qq', score: 100, matchedSong: MATCHED_SONG }) }
  let onlineCalls = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => { throw new Error('本地没有歌词就不该读文件') },
    online: { match: async (track) => { onlineCalls += 1; source.calls.push(track.id); return source.result(track) } },
  })
  const first = await client.load(trackWith(undefined))
  assert.equal(first.source, 'none', 'load() 必须先放行本地结果，不等在线')
  assert.equal(first.empty, true)
  assert.equal(onlineCalls, 1, 'promise 一建立就发起：前奏期间把匹配跑完，而不是等舞台来取')
  assert.equal(typeof first.upgrade?.then, 'function', '无词曲目才带 upgrade promise')

  const upgraded = await first.upgrade
  assert.equal(upgraded.source, 'online')
  assert.equal(upgraded.format, 'qrc')
  assert.equal(upgraded.provider, 'qq')
  assert.equal(upgraded.online?.score, 100)
  assert.deepEqual(upgraded.online?.matchedSong, MATCHED_SONG)
  assert.equal(upgraded.empty, false)
  assert.equal(upgraded.data.lines.length, 3)
  assert.ok((upgraded.data.lines[0].words ?? []).length >= 2, '逐字词必须解析出词级时间戳')
  assert.equal(onlineCalls, 1)

  const second = await client.load(trackWith(undefined))
  assert.equal(second.source, 'online', '命中后覆盖缓存，第二次不再出网')
  assert.equal(onlineCalls, 1)
  assert.equal(second.upgrade, undefined, '缓存里已是最终结果')
  client.dispose()
})

test('本地有**带时间轴**的词一律不建 upgrade：伴生 LRC / TTML 都不触发在线（冲突规则不让出去）', async () => {
  for (const reference of [{ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' }, { source: 'sidecar', format: 'ttml', url: '/api/lyrics/track-x' }]) {
    let onlineCalls = 0
    const client = createLyricsClient({
      WorkerImpl: () => new FakeWorker(),
      fetchImpl: fetchReturning(LRC),
      online: { match: async () => { onlineCalls += 1; return { matched: true, format: 'qrc', text: QRC_SAMPLE } } },
    })
    const loaded = await client.load(trackWith(reference))
    assert.equal(loaded.source, reference.source)
    assert.equal(loaded.upgrade, undefined, `${reference.format} 是带时间轴的本地词，不许建 upgrade`)
    assert.equal(onlineCalls, 0, `${reference.format} 是带时间轴的本地词，不许出网`)
    client.dispose()
  }
})

test('6.6：内嵌纯文本（USLT）先放行段落，再挂 upgrade；在线命中时标记"替换内嵌纯文本"', async () => {
  let onlineCalls = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    // 段落必须真的被读出来：F1/R63 的显示不能因为"要试在线"而退回去
    fetchImpl: fetchReturning('内嵌段落第一行\n第二行\n'),
    online: { match: async () => { onlineCalls += 1; return { matched: true, format: 'qrc', text: QRC_SAMPLE, provider: 'qq', score: 96, matchedSong: MATCHED_SONG } } },
  })
  const loaded = await client.load(trackWith({ source: 'embedded', format: 'lyrics', url: '/api/lyrics/track-x' }))
  assert.equal(loaded.source, 'embedded', 'load() 必须先放行本地段落，不等在线')
  assert.equal(loaded.format, 'lyrics')
  // 段落是按"纯文本"渲染的（舞台的 showPlainText 分支读 loaded.text），解析层给的是"零条带时间轴的行"。
  // 这个 empty:true 正是 6.6 要去问在线的理由，别把它误读成"没有歌词"。
  assert.equal(loaded.empty, true, '内嵌纯文本没有 timed lines，显示由 loaded.text 承担')
  assert.ok(loaded.text.includes('内嵌段落第一行'), '段落文本必须留在结果里：未命中时舞台靠它继续显示')
  assert.equal(onlineCalls, 1, '无时间轴的本地词不再挡在线')
  assert.equal(typeof loaded.upgrade?.then, 'function', '无时间轴内嵌词也要挂 upgrade')

  const upgraded = await loaded.upgrade
  assert.equal(upgraded.source, 'online')
  assert.equal(upgraded.replacedLocalUntimedLyric, true, '徽标要能说清这是替换，不是首发')
  assert.equal(upgraded.data.lines.length, 3)

  const again = await client.load(trackWith({ source: 'embedded', format: 'lyrics', url: '/api/lyrics/track-x' }))
  assert.equal(again.source, 'online', '命中后覆盖缓存，第二次不再出网')
  assert.equal(onlineCalls, 1)
  client.dispose()
})

test('6.6：在线未命中时升级结果兑现成"空 + 原因"，由舞台的空结果守卫把显示留在段落上', async () => {
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: fetchReturning('内嵌段落第一行\n第二行\n'),
    online: { match: async () => ({ matched: false, reason: '最高分 5（阈值 75），最接近《别的歌》' }) },
  })
  const loaded = await client.load(trackWith({ source: 'embedded', format: 'lyrics', url: '/api/lyrics/track-x' }))
  assert.equal(loaded.source, 'embedded')
  assert.ok(loaded.upgrade, '前置条件：段落也要挂 upgrade')
  const after = await loaded.upgrade
  assert.equal(after.empty, true, '未命中的升级结果是空的')
  assert.equal(after.replacedLocalUntimedLyric, undefined, '没替换就不许声称替换')
  assert.equal(after.online, undefined)
  assert.match(after.error ?? '', /最高分/, '未命中原因要留给状态条/日志')
  // 带着 pending upgrade 的结果不许进缓存（真实取证踩过的缺陷）：
  // 同一首被再次加载时（重复选曲、换回这首歌）必须仍然挂得出 upgrade，否则在线结果永远到不了。
  const second = await client.load(trackWith({ source: 'embedded', format: 'lyrics', url: '/api/lyrics/track-x' }))
  assert.ok(second.upgrade, '第二次加载同一首无轴曲目仍要有 upgrade：缓存里不能只留一个"永远不会被替换的段落"')
  assert.equal(second.source, 'embedded', '段落照样先放行')
  // 显示停在段落靠的是舞台守卫（check-music-lyrics-stage 钉住 `upgraded.empty` 那一行），
  // 而不是 client 把段落结果原样递回来——两条合起来才是"回退段落"这条路径。
  client.dispose()
})

test('6.6：在线能力关闭时，USLT 曲目仍只走本地段落（零请求、零 upgrade）', async () => {
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: fetchReturning('内嵌段落第一行\n第二行\n'),
  })
  const loaded = await client.load(trackWith({ source: 'embedded', format: 'lyrics', url: '/api/lyrics/track-x' }))
  assert.equal(loaded.source, 'embedded')
  assert.equal(loaded.upgrade, undefined, '没开在线能力就不该有升级')
  client.dispose()
})

test('读文件失败 / 解析失败不算"无词"：照旧透出 error，不去在线碰运气', async () => {
  const notFound = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
    online: { match: async () => ({ matched: true, format: 'qrc', text: QRC_SAMPLE }) },
  })
  const missing = await notFound.load(trackWith({ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' }))
  assert.match(missing.error, /404/)
  assert.equal(missing.upgrade, undefined, '有歌词引用但读不到 ≠ 没有歌词')
  notFound.dispose()

  const broken = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: fetchReturning('[00:01.00]'),
    online: { match: async () => ({ matched: true, format: 'qrc', text: QRC_SAMPLE }) },
  })
  const unparsable = await broken.load(trackWith({ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' }))
  assert.equal(unparsable.empty, true)
  assert.equal(unparsable.upgrade, undefined, '解析不出行也不改走在线：那是本地文件的问题，得让人看得见')
  broken.dispose()
})

test('未命中 / 抛异常 / 实体声明 / 零有效行都兑现成结果，绝不 reject（在线能力不许卡住播放）', async () => {
  const cases = [
    { name: '未命中', match: async () => ({ matched: false, reason: '最高分 5（阈值 75），最接近的是《别的歌》' }), expect: /最高分/ },
    { name: '服务端说不清原因', match: async () => ({ matched: false }), expect: /未找到/ },
    { name: '抛异常', match: async () => { throw new Error('后端不可用') }, expect: /后端不可用/ },
    { name: '返回 null（开关已关）', match: async () => null, expect: /未开启|未找到/ },
    { name: 'matched 但没有正文', match: async () => ({ matched: true, format: 'qrc', text: '' }), expect: /未找到|无有效行/ },
    { name: '含实体声明的在线载荷', match: async () => ({ matched: true, format: 'ttml', text: '<!DOCTYPE tt [<!ENTITY x "y">]><tt></tt>' }), expect: /实体声明/ },
    { name: '解析后零有效行', match: async () => ({ matched: true, format: 'lrc', text: '[00:00.00]   \n[00:05.00]   \n' }), expect: /无有效行|没有/ },
  ]
  for (const item of cases) {
    const client = createLyricsClient({
      WorkerImpl: () => new FakeWorker(),
      fetchImpl: async () => { throw new Error('不该读本地文件') },
      online: { match: item.match },
    })
    const first = await client.load(trackWith(undefined))
    const settled = await first.upgrade.then((value) => ({ state: 'fulfilled', value }), () => ({ state: 'rejected' }))
    assert.equal(settled.state, 'fulfilled', `${item.name}：upgrade 绝不 reject`)
    assert.equal(settled.value.source, 'none', `${item.name}：必须回落到无词态`)
    assert.match(settled.value.error ?? '', item.expect, `${item.name}：要给出可读原因`)
    client.dispose()
  }
})

test('在线结果不写缓存，所以中途打开开关不必重扫曲库就能再生效', async () => {
  let allowed = false
  let requests = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => { throw new Error('不该读本地文件') },
    online: {
      match: async () => {
        requests += 1
        if (!allowed) return { matched: false, reason: '在线歌词匹配未开启' }
        return { matched: true, format: 'qrc', text: QRC_SAMPLE, provider: 'qq', score: 90, matchedSong: MATCHED_SONG }
      },
    },
  })
  const off = await client.load(trackWith(undefined))
  assert.equal((await off.upgrade).source, 'none')
  allowed = true
  const again = await client.load(trackWith(undefined))
  assert.equal(again.source, 'none', '未命中不进缓存，所以还会带一个新的 upgrade')
  assert.equal(typeof again.upgrade?.then, 'function')
  assert.equal((await again.upgrade).source, 'online', '打开开关后下一次选曲就能配上，不需要重扫')
  assert.equal(requests, 2)
  client.dispose()
})

test('R60：本地与在线共用同一次 worker 调用，且 translation/romanization 透到行字段', async () => {
  FakeWorker.instances.length = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: fetchReturning(LRC),
  })
  await client.load(trackWith({ source: 'sidecar', format: 'lrc', url: '/api/lyrics/track-x' }))
  assert.equal(FakeWorker.instances.length, 1, '一条曲目一次 worker 调用')
  assert.equal(FakeWorker.instances[0].posted.length, 1, '不得为同一次解析发两个 job')
  client.dispose()

  FakeWorker.instances.length = 0
  const onlineClient = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => { throw new Error('不该读本地文件') },
    online: {
      match: async () => ({
        matched: true, format: 'qrc', text: QRC_SAMPLE,
        translation: TRANSLATION_SAMPLE, romanization: ROMAJI_SAMPLE,
        provider: 'qq', score: 100, matchedSong: MATCHED_SONG,
      }),
    },
  })
  const loaded = await onlineClient.load(trackWith(undefined))
  const upgraded = await loaded.upgrade
  const job = FakeWorker.instances[0].posted[0]
  assert.equal(job.format, 'qrc', '格式提示必须交给 worker，否则逐字要退回嗅探')
  assert.equal(job.translation, TRANSLATION_SAMPLE)
  assert.equal(job.romanization, ROMAJI_SAMPLE)
  const first = upgraded.data.lines[0]
  assert.equal(typeof first.translation, 'string', '译文落到行上，岛内字幕将来才有数据')
  assert.equal(typeof first.romanization, 'string', '罗马音落到行上')
  assert.equal(upgraded.text, QRC_SAMPLE, '原文随结果带出，供"纯文本静态显示"那条路径复用')
  onlineClient.dispose()
})

test('R60：没有在线来源时行为与既有一致（无词曲目零请求、无 upgrade）', async () => {
  let calls = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, text: async () => '' } },
  })
  const loaded = await client.load(trackWith(undefined))
  assert.equal(loaded.source, 'none')
  assert.equal(loaded.upgrade, undefined)
  assert.equal(calls, 0)
  client.dispose()
})

test('R60：同一曲目并发 load 共用同一个 upgrade，重复调用不双倍出网', async () => {
  let requests = 0
  const client = createLyricsClient({
    WorkerImpl: () => new FakeWorker(),
    fetchImpl: async () => { throw new Error('不该读本地文件') },
    online: { match: async () => { requests += 1; return { matched: true, format: 'qrc', text: QRC_SAMPLE, provider: 'qq', score: 88, matchedSong: MATCHED_SONG } } },
  })
  const track = trackWith(undefined)
  const [a, b] = await Promise.all([client.load(track), client.load(track)])
  assert.equal(a.source, 'none')
  assert.equal(b.source, 'none')
  await Promise.all([a.upgrade, b.upgrade])
  assert.equal(requests, 1, '并发去重失效就会双倍打接口')
  assert.equal((await client.load(track)).source, 'online')
  assert.equal(requests, 1)
  client.dispose()
})
