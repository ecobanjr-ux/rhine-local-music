import test from 'node:test'
import assert from 'node:assert/strict'
import { MusicPlayer } from '../src/music-player.ts'

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
const BGM_SRC = '/audio/atmosphere.ogg'

/** Fake browser surface: no network, no real timers, no sound. */
function environment(t) {
  const instances = []
  const document = new EventTarget()
  const previousAudio = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

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
      instances.push(this)
    }
    play() {
      this.paused = false
      this.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    }
    pause() {
      if (this.paused) return
      this.paused = true
      this.dispatchEvent(new Event('pause'))
    }
    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() {}
  }

  Object.defineProperty(globalThis, 'Audio', { configurable: true, writable: true, value: ControlledAudio })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document })
  t.after(() => {
    if (previousAudio) Object.defineProperty(globalThis, 'Audio', previousAudio)
    else delete globalThis.Audio
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else delete globalThis.document
  })
  return {
    instances,
    songs: () => instances.filter((entry) => entry.src !== BGM_SRC),
    gesture: () => document.dispatchEvent(new Event('pointerdown')),
  }
}

const track = (id, duration = 200) => ({
  id,
  albumId: `album-${id}`,
  title: `曲 ${id}`,
  artist: '测试者',
  duration,
  format: 'MP3',
  browserPlayable: true,
  audioUrl: `/api/audio/${id}`,
  relativePath: `${id}.mp3`,
})

const newPlayer = () =>
  new MusicPlayer({ volume: 1, songFadeEnabled: false, bgmEnabled: false, bgmVolume: 0 })

test('clockTime 直读元素时钟，不受 timeupdate 与 pendingSeek 抑制影响', async (t) => {
  const { instances } = environment(t)
  const player = newPlayer()
  await player.play('a', [track('a'), track('b')])
  await settle()
  const audio = player.mediaElement()
  assert.ok(audio, 'a song element must exist')
  audio.currentTime = 42.5
  assert.equal(player.clockTime(), 42.5)
  // timeupdate 被 pendingSeek 抑制时，元素时钟依然可读
  player.seek(70)
  audio.currentTime = 70
  assert.equal(player.clockTime(), 70)
  player.dispose()
})

test('无元素或停止后返回 0，不抛异常', async (t) => {
  const { songs } = environment(t)
  const player = newPlayer()
  assert.equal(player.clockTime(), 0)
  assert.equal(player.mediaElement(), null)
  await player.play('a', [track('a'), track('b')])
  await settle()
  assert.equal(songs().length, 1)
  assert.equal(player.mediaElement(), songs()[0])
  player.stop()
  assert.equal(player.clockTime(), 0)
  assert.equal(player.mediaElement(), null)
  player.dispose()
})

test('换曲后 clockTime 与 mediaElement 指向新元素', async (t) => {
  const { songs } = environment(t)
  const player = newPlayer()
  await player.play('a', [track('a'), track('b')])
  await settle()
  const first = player.mediaElement()
  first.currentTime = 90
  assert.equal(player.clockTime(), 90)
  await player.next()
  await settle()
  const second = player.mediaElement()
  assert.equal(songs().length, 2, 'a fresh element is created per track')
  assert.notEqual(second, first)
  assert.equal(player.clockTime(), 0, 'the new element has not advanced yet')
  second.currentTime = 3.5
  assert.equal(player.clockTime(), 3.5)
  player.dispose()
})

test('clockTime 与 mediaElement 不触发状态广播', async (t) => {
  const { songs } = environment(t)
  const player = newPlayer()
  await player.play('a', [track('a')])
  await settle()
  let emissions = 0
  player.subscribe(() => { emissions += 1 })
  const before = emissions
  songs()[0].currentTime = 55
  player.clockTime()
  player.mediaElement()
  assert.equal(emissions, before, 'reading the clock must not emit')
  player.dispose()
})
