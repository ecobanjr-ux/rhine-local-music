import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MusicPlayer, PLAYBACK_MODES, shuffleIndices } from '../src/music-player.ts'

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

/** No browser, network, real timers, or actual sound is used by these tests. */
function environment(t) {
  let now = 0
  let nextTimer = 1
  const timers = new Map()
  const instances = []
  const document = new EventTarget()
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousTimeout = globalThis.setTimeout
  const previousClear = globalThis.clearTimeout
  const previousNow = Object.getOwnPropertyDescriptor(performance, 'now')

  class ControlledAudio extends EventTarget {
    constructor(src = '') {
      super()
      this.src = src
      this.volume = 1
      this.paused = true
      this.ended = false
      this.duration = 120
      this.currentTime = 0
      this.readyState = 1
      this.playCalls = 0
      this.deferred = []
      this.holdPlay = false
      instances.push(this)
    }

    play() {
      this.playCalls += 1
      if (this.holdAll || this.holdPlay) {
        this.holdPlay = false
        return new Promise((resolve, reject) => {
          this.deferred.push(() => { this.begin(); resolve() })
          this.pendingReject = reject
        })
      }
      this.begin()
      return Promise.resolve()
    }

    begin() {
      this.paused = false
      this.dispatchEvent(new Event('playing'))
    }

    resolvePlay() {
      assert.ok(this.deferred.length, 'there must be a held audio play request')
      this.deferred.shift()()
    }

    /**
     * R219 补的观察面：真实浏览器里元素出错/被中断时，那枚挂着的 `play()` promise 会被 **reject**
     * （不是永远悬着）。没有这一格，"慢第一拍落地成失败"那条路在离线里根本跑不到。
     */
    rejectPlay(error) {
      assert.ok(this.deferred.length, 'there must be a held audio play request')
      this.deferred.shift()
      const reject = this.pendingReject
      this.pendingReject = null
      reject(error ?? new DOMException('aborted', 'AbortError'))
    }

    pause() {
      if (this.paused) return
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }

    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() {}
    /**
     * R160（任务七）· 输出设备。浏览器里这是 `HTMLMediaElement.prototype` 上的方法，
     * 这个受控 Audio 类不是它的子类，所以在实例上给一份同名的：记每一次调用（含切回默认的那一次），
     * 并按 `sinkFailFor` 决定拒不拒 —— 拒绝路径要能被判据钉住（"不许因为选了设备反而没声音"）。
     */
    async setSinkId(id) {
      this.sinkCalls = this.sinkCalls ?? []
      this.sinkCalls.push(String(id))
      if (this.sinkFailFor && String(id) === this.sinkFailFor) {
        this.sinkFailFor = ''          // 只拒第一次：第二次是播放器切回默认，那一次必须成功
        const error = new Error('simulated')
        error.name = 'OverconstrainedError'
        throw error
      }
      this.sinkId = String(id)
    }
  }

  Object.defineProperty(globalThis, 'Audio', { configurable: true, writable: true, value: ControlledAudio })
  // 播放器的能力探测读的是 `HTMLMediaElement.prototype.setSinkId`（不是实例），所以这里也要给一个"类"。
  // 没有 DOM 的环境里这个全局本不存在 ⇒ 播放器会回"不支持"，测的正是那一档。
  const previousMediaElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLMediaElement')
  class HTMLMediaElementShim {}
  HTMLMediaElementShim.prototype.setSinkId = async function setSinkId(id) { this.sinkId = String(id) }
  Object.defineProperty(globalThis, 'HTMLMediaElement', { configurable: true, writable: true, value: HTMLMediaElementShim })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document })
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextTimer++
    timers.set(id, { callback, at: now + Number(delay) })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  t.after(() => {
    if (previousAudio) Object.defineProperty(globalThis, 'Audio', previousAudio)
    else delete globalThis.Audio
    if (previousMediaElement) Object.defineProperty(globalThis, 'HTMLMediaElement', previousMediaElement)
    else delete globalThis.HTMLMediaElement
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
    if (previousNow) Object.defineProperty(performance, 'now', previousNow)
    else delete performance.now
    globalThis.setTimeout = previousTimeout
    globalThis.clearTimeout = previousClear
  })

  return {
    instances,
    gesture: () => document.dispatchEvent(new Event('pointerdown')),
    pendingTimers: () => timers.size,
    async advance(milliseconds) {
      await settle()
      const end = now + milliseconds
      let next
      while ((next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0])) {
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await settle()
      }
      now = end
      await settle()
    },
  }
}

const track = (id) => ({ id, albumId: 'album-test', title: id, artist: 'Test artist', duration: 120, format: 'WAV', browserPlayable: true, relativePath: `${id}.wav`, audioUrl: `/api/audio/${id}` })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.0001, `expected ${actual} ≈ ${expected}`)

test('在线曲目走自己的分支：src 用服务端给的中转地址，不被本地扩展名判据拦下，失败文案不说"检查本地文件"', async (t) => {
  // Task 6 的接线。这一条不是"读源码找关键字"，是真的把 MusicPlayer 跑起来看它做了什么：
  // browserPlayable=false 是本地判据（按扩展名算出来的），在线曲目没有扩展名，
  // 若不分叉就会被它误判成"这格式播不了"，用户看到一个根本不存在的问题。
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  const online = {
    ...track('online-1'),
    sourceKind: 'online',
    provider: 'netease',
    format: 'MP3',
    browserPlayable: false,
    relativePath: '',
    audioUrl: '/api/online/stream?p=netease&id=1997438791',
  }
  player.setQueue([online])
  env.gesture()
  await env.advance(700)
  const playing = player.play('online-1')
  await env.advance(60)
  await playing
  const song = env.instances[1]
  assert.equal(song.src, '/api/online/stream?p=netease&id=1997438791', '内核拿的是那条同源中转地址，不是 /api/audio/<id>')
  assert.equal(song.playCalls, 1, '没有因为 browserPlayable=false 被挡在播放之前')
  assert.equal(player.state.error, null, '在线曲目不得触发"此格式无法在当前浏览器中播放"')
  // 网络层失败（MediaError code 2 = 下载失败）：要说"网络或音源"，不能让用户去翻硬盘和本地服务。
  song.error = { code: 2 }
  song.dispatchEvent(new Event('error'))
  await env.advance(60)
  assert.match(String(player.state.error), /在线试听.*(失败|不可用)/, '在线曲目有专属失败文案')
  assert.doesNotMatch(String(player.state.error), /本地服务|音乐文件/, '在线失败不许说"检查本地服务和音乐文件"')
  // 对照：本地曲目同一枚错误码仍走原来那句文案（改动没有把本地路径顺手改掉）。
  const localPlayer = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  localPlayer.setQueue([track('second')])
  env.gesture()
  await env.advance(700)
  const localPlaying = localPlayer.play('second')
  await env.advance(60)
  await localPlaying
  const localSong = env.instances[env.instances.length - 1]
  assert.equal(localSong.src, '/api/audio/second', '本地曲目的 src 与改前逐字相同')
  localSong.error = { code: 2 }
  localSong.dispatchEvent(new Event('error'))
  await env.advance(60)
  assert.match(String(localPlayer.state.error), /本地服务/, '本地文案保持原样')
  player.dispose()
  localPlayer.dispose()
})

test('BGM has an independent default, live volume, zero-volume gate, and clamped settings', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0 })
  const bgm = env.instances[0]
  assert.equal(player.state.songFadeEnabled, true)
  assert.equal(player.state.bgmVolume, 0.18)
  assert.equal(bgm.playCalls, 0, 'no autoplay before a gesture')
  env.gesture()
  await env.advance(700)
  near(bgm.volume, 0.18)
  assert.equal(player.state.bgmPlaying, true, 'muted songs do not mute the BGM')
  player.setVolume(1)
  await env.advance(700)
  near(bgm.volume, 0.18)
  player.setBgmVolume(0.42)
  await env.advance(700)
  near(bgm.volume, 0.42)
  assert.equal(player.state.volume, 1)
  player.setBgmVolume(NaN)
  assert.equal(player.state.bgmVolume, 0.42)
  player.setBgmVolume(-1)
  await env.advance(250)
  assert.equal(player.state.bgmVolume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.bgmEnabled, true, 'zero volume preserves the independent enabled preference')
  player.setBgmVolume(9)
  await env.advance(700)
  assert.equal(player.state.bgmVolume, 1)
  near(bgm.volume, 1)
  player.dispose()
  assert.equal(env.pendingTimers(), 0)
})

test('song playback waits for BGM silence despite rapid BGM volume and toggle changes', async (t) => {
  const env = environment(t)
  // Isolate BGM timing from the optional song envelope in this transport check.
  const player = new MusicPlayer({ volume: 0.65, bgmVolume: 0.3, songFadeEnabled: false })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const playing = player.play('first')
  const song = env.instances[1]
  await env.advance(96)
  assert.equal(song.playCalls, 0)
  assert.ok(bgm.volume > 0 && bgm.volume < 0.3)
  player.setBgmVolume(0.8)
  player.setBgmEnabled(false)
  player.setBgmEnabled(true)
  player.setVolume(0.25)
  await env.advance(100)
  assert.equal(song.playCalls, 0, 'controls must not bypass the shared fade-out promise')
  await env.advance(60)
  await playing
  assert.equal(song.playCalls, 1)
  assert.equal(song.volume, 0.25)
  assert.equal(bgm.volume, 0)
  assert.equal(bgm.paused, true)
  assert.equal(player.state.playing, true)
  assert.equal(player.state.bgmVolume, 0.8)
  player.setBgmVolume(0.4)
  await env.advance(700)
  assert.equal(song.volume, 0.25, 'BGM volume cannot alter song output')
  assert.equal(bgm.paused, true, 'BGM stays silent while a song plays')
  player.stop()
  await env.advance(700)
  near(bgm.volume, 0.4)
  assert.equal(player.state.bgmPlaying, true)
  player.dispose()
})

test('rapidly cancelling a pending song restores only the latest BGM volume', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.5 })
  player.setQueue([track('first')])
  env.gesture()
  await env.advance(700)
  const bgm = env.instances[0]
  const pending = player.play('first')
  const song = env.instances[1]
  await env.advance(72)
  player.stop()
  player.setBgmVolume(0.2)
  player.setBgmEnabled(false)
  await env.advance(24)
  player.setBgmEnabled(true)
  player.setBgmVolume(0.33)
  await env.advance(700)
  await pending
  assert.equal(song.playCalls, 0, 'cancelled song never starts after the old fade finishes')
  assert.equal(song.paused, true)
  near(bgm.volume, 0.33)
  assert.equal(player.state.bgmPlaying, true)
  assert.equal(player.state.playing, false)
  player.dispose()
  await env.advance(1000)
  assert.equal(bgm.paused, true)
  assert.equal(env.pendingTimers(), 0)
})

test('a late BGM play resolution stays silent when a song has taken over', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmVolume: 0.4, songFadeEnabled: false })
  const bgm = env.instances[0]
  bgm.holdPlay = true
  player.setQueue([track('first')])
  env.gesture()
  await settle()
  assert.equal(bgm.playCalls, 1)
  const playing = player.play('first')
  await env.advance(250)
  await playing
  const song = env.instances[1]
  assert.equal(song.paused, false)
  bgm.resolvePlay()
  await settle()
  assert.equal(bgm.paused, true)
  assert.equal(bgm.volume, 0)
  assert.equal(player.state.bgmPlaying, false)
  assert.equal(player.state.playing, true)
  player.dispose()
})

// R109（播放模式）：内核唯一的 `ended` 判据现在有四档，模式的所有差别都藏在 autoNextIndex 里。
// 这一组用例的共同目的：**默认档（顺序）的行为必须与今天逐字相同**，另外三档各自钉死，
// 而随机用的是"无重复的一轮"（每次独立抽会连着播同一首，用户会当 bug 报）。
const randomOf = (values) => { let at = 0; return () => values[at++ % values.length] }
/** 让当前这首歌"播完"：真机就是播放器发 `ended`，这里手工喂同一枚事件。 */
const finishSong = async (env) => {
  const song = env.instances[env.instances.length - 1]
  song.ended = true
  song.paused = true
  song.dispatchEvent(new Event('ended'))
  await env.advance(60)
  return song
}
const six = ['t0', 't1', 't2', 't3', 't4', 't5'].map(track)

test('R109：顺序播放（缺省档）末曲播完就停 —— 模式改动不许动到升级前那条行为', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmEnabled: false, songFadeEnabled: false })
  assert.equal(player.state.playbackMode, 'sequential', '缺省就是顺序：升级当天零观感变化')
  player.setQueue(six)
  env.gesture()
  await env.advance(700)
  await player.play('t5')
  await finishSong(env)
  assert.equal(player.state.transport, 'idle', '末曲播完回 idle（不是绕回第一首）')
  assert.equal(player.state.currentTrack.id, 't5', '停在原地不动，也不"跳回第一首又不播"')
  // 中途播完仍然正常续播（这一句钉的是"加了模式没把老的那条 next 判据改坏"）。
  await player.play('t1')
  await finishSong(env)
  assert.equal(player.state.currentTrack.id, 't2')
  player.dispose()
})

test('R109：列表循环末曲绕回第一首；单曲循环重播同一首且不锁住手动「下一首」', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ bgmEnabled: false, songFadeEnabled: false, playbackMode: 'repeat-all' })
  player.setQueue(six)
  env.gesture()
  await env.advance(700)
  await player.play('t5')
  await finishSong(env)
  assert.equal(player.state.currentIndex, 0, '列表循环：末曲播完绕回第一首')
  assert.equal(player.state.currentTrack.id, 't0')
  // 列表循环里手动按到头 ⇒ 绕回第一首（绕与不绕的判据只有一处：autoNextIndex / manualNextIndex 都读同一档模式）。
  await player.play('t5')
  await player.next()
  assert.equal(player.state.currentTrack.id, 't0', '列表循环：手动按到头也绕回')
  const stopped = new MusicPlayer({ bgmEnabled: false, songFadeEnabled: false })
  stopped.setQueue(six)
  await stopped.play('t5')
  await stopped.next()
  assert.equal(stopped.state.transport, 'idle', '顺序档里手动按到头就停（这是升级前的行为，不许被模式改动顺手改成绕回）')
  stopped.dispose()
  player.setPlaybackMode('repeat-one')
  await player.play('t2')
  const before = env.instances.length
  await finishSong(env)
  assert.equal(player.state.currentTrack.id, 't2', '单曲循环：播完还是这一首')
  assert.equal(player.state.currentIndex, 2)
  assert.ok(env.instances.length > before, '重播是重新起一个音频元素（不是把 ended 那台硬拉回去）')
  await player.next()
  assert.equal(player.state.currentTrack.id, 't3', '单曲循环不锁人：手动「下一首」照常换歌')
  player.dispose()
})

test('R109/R111：随机是"无重复的一轮"，一轮覆盖全队列后**播完即停**（批复①），主动再播才开新一轮', async (t) => {
  const env = environment(t)
  // 确定性的伪随机：每抽一次换一个种子 ⇒ 每一轮拿到不同排列，而结果可逐字断言。
  let seed = 7
  const player = new MusicPlayer({
    bgmEnabled: false,
    songFadeEnabled: false,
    playbackMode: 'shuffle',
    random: () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 },
  })
  const ids = six.map((entry) => entry.id)
  player.setQueue(six)
  env.gesture()
  await env.advance(700)
  await player.play('t0')
  const heard = [player.state.currentTrack.id]
  for (let step = 0; step < 8; step += 1) { await finishSong(env); heard.push(player.state.currentTrack.id) }
  assert.deepEqual([...new Set(heard.slice(0, 6))].sort(), ids.sort(), '一整轮 6 首各出现一次（不多不少）')
  // 批复①（2026-10-07）：四档互斥的经典语义——随机管"走一遍"，重复交给单曲 / 列表循环。
  assert.equal(heard[6], heard[5], '第六首播完就停：不许自己开下一轮')
  assert.equal(heard[7], heard[5], '再喂一次"播完"也不开下一轮（停住必须是稳的）')
  assert.equal(player.state.transport, 'idle', '停 = 回到 idle，不是卡在 playing 空转')
  // 用户主动按播放 = 开始新一轮（自动续播那条路到不了 play()，所以不会把"停住"变成"永远停不住"）。
  await player.toggle()
  await env.advance(60)
  assert.equal(player.state.currentTrack.id, heard[5], '按播放先重播停住的那一首')
  const round2 = [player.state.currentTrack.id]
  for (let step = 0; step < 7; step += 1) { await finishSong(env); round2.push(player.state.currentTrack.id) }
  assert.deepEqual([...new Set(round2.slice(0, 6))].sort(), ids.sort(), '主动开的第二轮同样 6 首各一次')
  assert.notEqual(round2[0], round2[1], '新一轮开头也不连着播同一首')
  assert.equal(round2[6], round2[5], '第二轮播完照样停')
  // 换队列 ⇒ 一轮重新算（"一轮"是相对当前队列的，不是相对进程生命周期的）。
  await player.play('t0', six.slice(0, 3))
  const short = [player.state.currentTrack.id]
  for (let step = 0; step < 4; step += 1) { await finishSong(env); short.push(player.state.currentTrack.id) }
  assert.deepEqual([...new Set(short.slice(0, 3))].sort(), ['t0', 't1', 't2'], '三首的队列：一轮就是这三首')
  assert.equal(short[3], short[2], '三首走完就停，不回头重播')
  player.dispose()
})

test('R109：随机模式下换队列 ⇒ 本轮的签作废（留着旧下标会越界或错播别人的歌）', async (t) => {
  const env = environment(t)
  let seed = 3
  const player = new MusicPlayer({
    bgmEnabled: false,
    songFadeEnabled: false,
    playbackMode: 'shuffle',
    random: () => { seed = (seed * 2654435761) % 2147483648; return seed / 2147483648 },
  })
  player.setQueue(six)
  env.gesture()
  await env.advance(700)
  await player.play('t0')
  await finishSong(env)                                  // 抽签一次，把本轮的签用掉一部分
  // 入口一：`play(id, tracks)` —— 点专辑 / 搜索结果 / 歌单换队列走的就是这一条。
  const four = ['b0', 'b1', 'b2', 'b3'].map(track)
  await player.play('b1', four)
  assert.equal(player.state.currentIndex, 1)
  const after = []
  for (let step = 0; step < 3; step += 1) { await finishSong(env); after.push(player.state.currentTrack?.id) }
  assert.deepEqual(after.filter(Boolean).length, 3, '换队列后连着三首都不许掉出队列（旧排列的下标越界就会直接停住）')
  assert.deepEqual([...new Set(after)].sort(), ['b0', 'b2', 'b3'],
    '新的一轮恰好覆盖"除当前这首之外的全部"：当前这首（b1）要留到下一轮才可能再出现')
  player.dispose()
  // 入口二：`setQueue` 且**本轮还剩半截没用完的签** —— 曲库重扫后队列变短走的是那一条。
  // 拿 6 首发一轮、只抽走一张，然后把队列缩到 2 张（当前这首还在里面 ⇒ 不该停播）：
  // 剩下的旧签有三个下标在新队列里根本不存在，不作废就会越界停住或把刚播过的这首再来一遍。
  const second = new MusicPlayer({
    bgmEnabled: false,
    songFadeEnabled: false,
    playbackMode: 'shuffle',
    random: () => { seed = (seed * 2654435761) % 2147483648; return seed / 2147483648 },
  })
  second.setQueue(six)
  await second.play('t0')
  await finishSong(env)
  const stillPlaying = second.state.currentTrack.id
  assert.notEqual(stillPlaying, 't0', '随机模式下第二首不该是刚播过的那首')
  second.setQueue([track('t0'), track(stillPlaying)])
  assert.equal(second.state.currentTrack.id, stillPlaying, 'setQueue 保留当前这首（今天的行为，模式改动不许顺手改掉）')
  await finishSong(env)
  assert.equal(second.state.currentTrack.id, 't0',
    '缩短后的队列重新发签：旧下标在新队列里多半不存在，留着就会越界停住或把这一首再播一遍')
  second.dispose()
})

test('R109：模式的非法值回落顺序、四档周期逐字钉住、随机模式的「上一首」沿历史后退', async (t) => {
  const env = environment(t)
  let seed = 11
  const player = new MusicPlayer({
    bgmEnabled: false, songFadeEnabled: false,
    random: () => { seed = (seed * 48271) % 2147483648; return seed / 2147483648 },
  })
  assert.equal(player.setPlaybackMode('no-such-mode'), 'sequential', '非法值不许把界面停在没人认识的模式上')
  assert.deepEqual([...PLAYBACK_MODES], ['sequential', 'repeat-all', 'repeat-one', 'shuffle'],
    '这张表就是传输区与岛内共用的循环顺序：换顺序要连着改界面文案的推导，不许两处各列一份')
  assert.equal(player.cyclePlaybackMode(), 'repeat-all')
  assert.equal(player.cyclePlaybackMode(), 'repeat-one')
  assert.equal(player.cyclePlaybackMode(), 'shuffle')
  assert.equal(player.cyclePlaybackMode(), 'sequential', '周期是四档回到原点（传输区与岛内共用这张表）')
  player.setPlaybackMode('shuffle')
  player.setQueue(six)
  env.gesture()
  await env.advance(700)
  await player.play('t0')
  await finishSong(env)
  const second = player.state.currentTrack.id
  assert.notEqual(second, 't0')
  await finishSong(env)
  const third = player.state.currentTrack.id
  assert.notEqual(third, second, '一轮之内不重复')
  await player.previous()
  await env.advance(60)
  assert.equal(player.state.currentTrack.id, second, '随机里的「上一首」= 刚听过的那首（那里的 currentIndex-1 是队列邻居，不是上一首）')
  await player.previous()
  await env.advance(60)
  assert.equal(player.state.currentTrack.id, 't0', '连按两次退两步：沿历史后退，不是来回跳同一对')
  // 后退之后让歌自然播完 ⇒ 从剩下的签里继续（历史已被退掉一格，这里钉的是"不许把退掉那首又抽回来"）。
  await finishSong(env)
  assert.ok(six.some((entry) => entry.id === player.state.currentTrack?.id), '自动续播仍在队列里')
  player.dispose()
})

test('R109：shuffleIndices 是排他的随机排列，注入件坏了也不越界', () => {
  assert.deepEqual(shuffleIndices(4, randomOf([0, 0, 0])), [1, 2, 3, 0], 'Fisher–Yates 的每一步都换到 0 号位：这个序列的结果必须可逐字预言')
  assert.deepEqual(shuffleIndices(4, randomOf([0.999, 0.999, 0.999, 0.999])), [0, 1, 2, 3], '每步都换到自己 ⇒ 恒等排列')
  assert.deepEqual(shuffleIndices(0), [], '空队列给空排列，不抛')
  assert.deepEqual(shuffleIndices(-3), [], '负长度也当空队列')
  const broken = shuffleIndices(5, () => Number.NaN)
  assert.deepEqual([...broken].sort(), [0, 1, 2, 3, 4], '注入件给 NaN 时也必须是一个排列（"不重复"不能靠 random 自律）')
  const wild = shuffleIndices(5, () => 9)
  assert.deepEqual([...wild].sort(), [0, 1, 2, 3, 4], '越界的 random 同样被夹回合法下标')
})

test('整单入队的在线队列是一条真队列：自然衔接、手动下一首、R109 四档都在它上面成立（实机"279 条播完即停"的反例）', async (t) => {
  // 这一条钉的是**内核侧的事实**：界面把整单经 play(id, tracks) 全量入队之后，续播/换歌/四档
  // 都该和本地队列一样工作。曾经的缺陷是界面只塞了一首进去（回执却写"正在播放 279 条"），
  // 表现就是"当前曲播完即停、下一首也切不动"——队列里只有它自己，四档模式自然全都无从生效。
  const env = environment(t)
  const online = (n) => ({
    ...track(`on-${n}`), sourceKind: 'online', provider: 'netease', format: 'MP3',
    browserPlayable: false, relativePath: '', audioUrl: `/api/online/stream?id=on-${n}`,
  })
  const queue = [1, 2, 3, 4].map(online)
  const player = new MusicPlayer({ bgmEnabled: false, songFadeEnabled: false })
  env.gesture()
  await env.advance(700)
  await player.play('on-1', queue)
  await env.advance(60)
  assert.equal(player.state.queue.length, 4, 'play(id, tracks) 必须把整单收进内核队列（只塞一首就是那个 bug 的形状）')
  assert.equal(player.state.currentIndex, 0, '从点的那一条起播')
  assert.equal(player.state.currentTrack.id, 'on-1')
  // 连续自然衔接：on-1 → on-2 → on-3（验收口径要的是"≥3 首"）
  for (const [expectId, index] of [['on-2', 1], ['on-3', 2]]) {
    await finishSong(env)
    assert.equal(player.state.currentTrack?.id, expectId, `顺序模式自然播完该接 ${expectId}`)
    assert.equal(player.state.currentIndex, index)
    assert.equal(env.instances[env.instances.length - 1].src, `/api/online/stream?id=${expectId}`,
      '续播的 src 仍是服务端那条同源中转地址，没退回 /api/audio/<id>')
  }
  await player.next()
  await env.advance(60)
  assert.equal(player.state.currentTrack?.id, 'on-4', '手动「下一首」在在线队列上要真的换歌')
  await finishSong(env)
  assert.equal(player.state.playing, false, '顺序模式走到队尾该停（这一档不循环）')
  assert.equal(player.state.currentTrack?.id, 'on-4')
  // 列表循环：队尾回队首
  assert.equal(player.setPlaybackMode('repeat-all'), 'repeat-all')
  await player.play('on-4')
  await env.advance(60)
  await finishSong(env)
  assert.equal(player.state.currentTrack?.id, 'on-1', '列表循环在队尾回到队首')
  // 单曲循环：自动续播停在同一首，但手动那一按不锁人
  player.setPlaybackMode('repeat-one')
  await player.play('on-1')
  await env.advance(60)
  await finishSong(env)
  assert.equal(player.state.currentTrack?.id, 'on-1', '单曲循环自然续播停在同一首')
  await player.next()
  await env.advance(60)
  assert.equal(player.state.currentTrack?.id, 'on-2', '单曲循环不锁手动「下一首」')
  // 随机：一轮四首各一次，抽干即停（R111 批复①）
  player.setPlaybackMode('shuffle')
  await player.play('on-1', queue)
  await env.advance(60)
  const pass = new Set([player.state.currentTrack.id])
  for (let i = 0; i < 3; i += 1) {
    await finishSong(env)
    assert.ok(['on-1', 'on-2', 'on-3', 'on-4'].includes(player.state.currentTrack?.id ?? ''), '随机续播不许跑出队列')
    pass.add(player.state.currentTrack.id)
  }
  assert.equal(pass.size, 4, '随机的一轮 = 四首各一次，不重复')
  await finishSong(env)
  assert.equal(player.state.playing, false, '随机一轮播完即停，不自动开下一轮')
  assert.equal(pass.size, 4, '停住这件事不许把第五首塞进来')
  player.dispose()
})

test('R126：applyTrackCover 只换封面、不换对象顺序，且不在队列时如实回 0', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  const a = track('a'), b = track('b')
  player.setQueue([a, b])
  assert.equal(player.applyTrackCover('a', '/api/online/artwork/0123456789abcdef'), 1, '补到一张 ⇒ 改动 1 条')
  assert.deepEqual(player.state.queue.map((x) => x.id), ['a', 'b'], '顺序不许动（动了当前下标就错位）')
  assert.equal(player.state.queue[0].coverUrl, '/api/online/artwork/0123456789abcdef', '封面写进队列那一条')
  assert.equal(player.state.queue[1].coverUrl, undefined, '别的一条都不许被顺手改')
  assert.notEqual(player.state.queue[0], a, '换的是新对象——下游按对象身份判"要不要重喂"（feed-gate）')
  assert.equal(player.applyTrackCover('a', '/api/online/artwork/0123456789abcdef'), 0, '同一张地址再补一次是空操作，不该再惊动订阅者')
  assert.equal(player.applyTrackCover('missing', '/api/online/artwork/x'), 0, '不在队列里 ⇒ 回 0，让调用方说实话')
  assert.equal(player.applyTrackCover('b', ''), 0, '空地址不进内核（界面会画成破图）')
  // 空操作不许惊动订阅者：宿主每帧都在读 state，多一次 emit 就多一次整墙重建的可能。
  let emits = 0
  const off = player.subscribe(() => { emits += 1 })
  emits = 0                                      // subscribe 会立刻同步跑一次回调（既有语义），从这一刻起只数变更
  player.applyTrackCover('a', '/api/online/artwork/0123456789abcdef')
  player.applyTrackCover('missing', '/api/online/artwork/y')
  assert.equal(emits, 0, '两次空操作都不该 emit（订阅者被无谓唤醒是这类"顺手写"的默认代价）')
  player.applyTrackCover('b', '/api/online/artwork/ffffffffffffffff')
  assert.equal(emits, 1, '真改了就要通知，否则墙上的格子不会变')
  off()
  player.dispose()
  assert.equal(player.applyTrackCover('a', '/api/online/artwork/y'), 0, '已销毁的内核不接受任何补写')
})


// ── R160（任务七）· 音频输出设备（setSinkId）────────────────────────────────────
// 播放器侧是真的跑（不是读源码找关键字）；界面那一格只能读源码（没有 DOM 可点），
// 但那条"未授权时不给设备名与 id"是 2026-10-10 在 headless Edge 上量出来的事实，写进了注释与判据。
const appSource = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8')

test('R160 缺省空串 = 一次 setSinkId 都不发；选了设备之后换曲要跟着套上新元素', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  player.setQueue([track('a'), track('b')])
  env.gesture()
  await env.advance(700)
  await player.play('a')
  const first = env.instances[1]
  assert.deepEqual(first.sinkCalls ?? [], [], '没碰过这一项 ⇒ 行为与今天逐字一致（缺省纪律，与 R109 的 sequential 同一条）')
  const reply = await player.setOutputDevice('sink-left')
  assert.equal(reply.ok, true)
  assert.equal(reply.supported, true)
  assert.deepEqual(first.sinkCalls, ['sink-left'], '选完立刻作用在**当前这一首**上，不等换曲')
  assert.equal(player.outputDeviceId(), 'sink-left')
  // 换曲 = 换元素（`setSinkId` 是每个元素各自的，不是全局的）
  await player.play('b')
  const second = env.instances[env.instances.length - 1]
  assert.notEqual(second, first, '换曲确实换了元素')
  assert.deepEqual(second.sinkCalls, ['sink-left'], '新元素要自己再套一次，否则"选了设备"只对第一首生效')
  // 切回默认：给的是空串，而且**真的发出去**（实测 `setSinkId('')` 是成功的，不是"没选设备所以报错"）
  const back = await player.setOutputDevice('')
  assert.equal(back.ok, true)
  assert.deepEqual(second.sinkCalls, ['sink-left', ''])
})

test('R160 设备切不过去时那一首照样要有声音：退回默认 + 说得出原因 + 状态不被写成"已切换"', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  player.setQueue([track('a')])
  env.gesture()
  await env.advance(700)
  await player.play('a')
  const song = env.instances[1]
  song.sinkFailFor = 'sink-gone'      // 那台设备已经拔掉了：浏览器会拒
  const reply = await player.setOutputDevice('sink-gone')
  assert.equal(reply.ok, false)
  assert.equal(reply.supported, true, '能力是有的，是这一台切不过去 —— 两件事不能混成一句"不支持"')
  assert.match(reply.reason, /OverconstrainedError/, '浏览器给的名字要带出来，"失败"两个字没法排查')
  assert.deepEqual(song.sinkCalls, ['sink-gone', ''], '拒绝之后必须立刻切回默认：不许"因为选了设备反而没声音"')
  assert.equal(song.sinkId, '', '切回默认要真的落在元素上')
  assert.equal(player.outputDeviceError(), 'OverconstrainedError', '失败原因留着给界面说')
})

test('R160 没有这个能力时不改状态、不假装成功（没有 DOM 的自检环境走的就是这一档）', async (t) => {
  const env = environment(t)
  delete globalThis.HTMLMediaElement          // 模拟 Firefox / Safari：能力探测要回"不支持"
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  player.setQueue([track('a')])
  env.gesture()
  await env.advance(700)
  await player.play('a')
  const reply = await player.setOutputDevice('anything')
  assert.equal(reply.supported, false)
  assert.equal(reply.ok, false)
  assert.match(reply.reason, /不支持/)
  assert.equal(player.outputDeviceId(), '', '不支持 ⇒ 一个字都不记（否则换台浏览器会带着一个从没生效过的 id）')
  assert.equal(env.instances[1].sinkCalls, undefined, '连一次都不该发（不是发了再吞掉错误）')
})

test('R160 界面那一格：未授权不给设备名这件事要写在界面上，授权必须是显式点击', () => {
  // 三条都是"这一档会不会变成隐私/体验事故"的判据，只能钉源码：
  const grantBody = /async function grantOutputSinksPermission\(\): Promise<\{ ok: boolean; reason: string \}> \{([\s\S]*?)\n\}/.exec(appSource)?.[1] ?? ''
  assert.ok(grantBody, '授权那一个函数还在（下面两条要圈在它的函数体里判）')
  assert.match(grantBody, /getUserMedia\(\{ audio: true \}\)/,
    '拿设备名的确要一次麦克风授权 —— 但它必须只出现在这一个函数里')
  assert.equal((appSource.match(/\.getUserMedia\(/g) ?? []).length, 1,
    '调用点全仓只许一处；出现在开机路径或"刷新设备列表"里就是静默弹权限（数的是 `.getUserMedia(`，不是提到这个名字的注释与文案）')
  assert.match(appSource, /track\.stop\(\)/, '读完名单立刻停轨：不采集、不落盘、不上传')
  assert.match(appSource, /data-action="output-devices-grant"/, '授权那颗按钮存在')
  assert.match(appSource, /outputSinks\.length && !outputSinksLabelled/, '只有"列出了设备但没名字"时才给那颗按钮')
  assert.match(appSource, /浏览器在没有授权时不给设备名与 id/, '这一句实测事实要写在界面上，不能只写在注释里')
  assert.match(appSource, /addEventListener\("devicechange"/, '插拔耳机之后要自己重列一次')
  // 打开设置面板就列一次（`enumerateDevices` 不出网也不要权限）：不补这一格，第一次看到的
  // "列出 0 个输出设备"其实是"还没问过"的 0 —— 真机量到过一次，界面在那一刻说的是假话。
  assert.match(appSource, /if \(next === "settings"\) \{[\s\S]{0,400}?void refreshOutputSinks\(\)\.then\(\(\) => repaintOutputDeviceRow\(\)\)/,
    '设置面板打开时列一次设备')
  assert.match(appSource, /浏览器没给出可切换的输出设备/, '"问了但一个都没有"与"有但没名字"是两句话，不许合成一句"列出 0 个"')
  assert.match(appSource, /if \(preferences\.outputDevice\) void applyOutputDevice/, '缺省空串时开机不发那一问（零观感变化）')
  assert.match(appSource, /这台浏览器不支持选择音频输出设备/, '不支持那一档给的是实话，不是留一个永远不生效的下拉框')
  assert.match(appSource, /已回到系统默认继续播放/, '切换失败那句要说清"声音没断"，否则用户以为播放器坏了')
  assert.match(appSource, /id="output-device-setting"[\s\S]{0,40}aria-label="音频输出设备"/, '控件有可访问名')
  assert.match(appSource, /esc\(device\.deviceId\)[\s\S]{0,80}esc\(device\.label/, 'id 与 label 都过那一个转义出口（外部数据）')
})

// ── R219 · 在线试听"要点两次才播"：慢第一拍期间按键不许把第一拍丢掉 ────────────────────────
// 现场：验收侧 10 秒自测后用户回报"必须再点一次才播" ⇒ 定性为吞点击/状态机要两拍，不是自动播放那一类。
// 我方一手实测（D:/tag-tools/r219-repro*.mjs）：搜索面板与歌单详情两条路**一次点击就播**（网易行 206、playing 落地）；
// 但走回落链的那条 QQ 行第一拍要 **9.9 秒**才回 502 —— 这段时间里用户按播放/暂停（那颗键、空格、媒体键都走 toggle()），
// 从前 `toggle()` 直接 `++operation` + `pause()` 把在飞的第一拍判成过期 ⇒ 第一拍被丢 ⇒ "必须再点一次"。
const onlineSong = (id) => ({
  ...track(id), sourceKind: 'online', provider: 'netease', format: 'MP3',
  browserPlayable: false, relativePath: '', audioUrl: `/api/online/stream?p=netease&id=${id}`,
})

test('R219 ①：一次点击就起播——play() 落地即 playing，只一个元素、只 play 一次（本件回归线）', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  player.setQueue([onlineSong('on-netease-9001')])
  env.gesture()
  await env.advance(700)
  await player.play('on-netease-9001')
  await env.advance(60)
  assert.equal(player.state.transport, 'playing', '(i) 一次调用就进 playing')
  assert.equal(env.instances.length, 2, '(i) 一次点击只多出一个音频元素（第 0 个是构造时就建的 BGM）')
  assert.equal(env.instances[1].playCalls, 1, '(i) 也只该 play 一次')
  player.dispose()
})

test('R219 ②：慢第一拍还在飞时——同一行连点与按播放/暂停都不许把第一拍丢掉', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  player.setQueue([onlineSong('on-netease-9002')])
  env.gesture()
  await env.advance(700)
  const playing = player.play('on-netease-9002')
  const song = env.instances[1]
  assert.ok(song && song !== env.instances[0], '音频元素在第一个 await 之前就建好了（这条前提变了本判据要跟着改）')
  song.holdAll = true                        // 在线取址/串流慢（真机走回落链量到 ~10 秒）；连点时两次 play() 都悬着（浏览器就是这么干的）
  await env.advance(60)
  assert.equal(player.state.transport, 'loading', '第一拍在飞的时候就是 loading（不许伪装成 playing）')
  // (a) 同一行再点一次（用户"点第二下"最常见的形态）：幂等 —— 不另起元素、不丢第一拍
  const queue = player.state.queue
  const again = player.play('on-netease-9002', queue)
  await env.advance(60)
  assert.equal(env.instances.length, 2, '(ii) 同一行连点不许另起第二个音频元素')
  assert.equal(player.state.transport, 'loading', '(ii) 连点也不许把 loading 这一拍改成别的状态（那是把第一拍重置）')
  // (b) 按一次播放/暂停（那颗键、空格、媒体键都走 toggle()）：不许把在飞的第一拍判过期
  const toggling = player.toggle()
  await env.advance(60)
  assert.equal(player.state.transport, 'loading', '(ii) 第二拍按键不许掐掉在飞的第一拍（从前这里 ++operation + pause）')
  while (song.deferred.length) song.resolvePlay()   // 第一拍落地
  await Promise.all([playing, again, toggling])
  await env.advance(60)
  assert.equal(player.state.transport, 'playing', '(ii) 第一拍活了下来：慢取址落地之后自己播，不需要第三次')
  assert.equal(player.state.error, null, '(ii) 这不该被记成一次失败')
  await player.toggle()
  await env.advance(60)
  assert.equal(player.state.transport, 'paused', '(ii) 真的在播了以后按这一颗才是暂停（toggle 的原有语义没动）')
  player.dispose()
})

test('R219 ③：慢第一拍落地成失败——停在那句实话上，不静默、也不自动再问一次上游', async (t) => {
  const env = environment(t)
  const player = new MusicPlayer({ volume: 0.5, bgmVolume: 0, songFadeEnabled: false })
  player.setQueue([onlineSong('on-netease-9003')])
  env.gesture()
  await env.advance(700)
  const playing = player.play('on-netease-9003')
  const song = env.instances[1]
  song.holdPlay = true
  await env.advance(60)
  const toggling = player.toggle()
  await env.advance(60)
  song.rejectPlay(new DOMException('no supported resources', 'NotSupportedError'))
  await toggling
  await playing
  await env.advance(60)
  assert.equal(player.state.transport, 'error', '(iii) 失败停在 error 档')
  assert.match(String(player.state.error), /在线试听/, '(iii) 界面那句实话必须在，而且是在线曲目专属那套文案')
  assert.equal(env.instances.length, 2, '(iii) toggle 之后不许自动再起一个歌曲元素（不静默重问上游）')
  assert.equal(song.playCalls, 1)
  const appSource = readFileSync(new URL('../src/music-app.ts', import.meta.url), 'utf8')
  assert.match(appSource, /if \(state\.error && state\.error !== lastPlayerError\) notify\(state\.error\);/,
    '(iii) 内核那句 error 由界面送到用户眼前（notify）——不是只写在状态里')
  player.dispose()
})
