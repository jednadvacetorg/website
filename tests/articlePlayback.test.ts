import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createRenderer, defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { provideArticlePlayback, useArticlePlayback } from '../app/composables/articlePlayback.ts'
import { parsePlaybackTime, playbackHash, youtubeVideoId } from '../app/utils/playbackTime.ts'

test('playback timestamps accept seconds and readable durations', () => {
  for (const [input, expected] of [['0', 0], ['113', 113], ['24s', 24], ['1m53s', 113], ['1h53m4s', 6784], ['2h', 7200]] as const) {
    assert.equal(parsePlaybackTime(input), expected)
  }
  for (const input of ['', '-1', '1.5', 'Infinity', '1m trailing', '1s2m', '9007199254740992', null, undefined]) {
    assert.equal(parsePlaybackTime(input), null)
  }
})

test('shareable hashes are readable and round-trip at whole-second precision', () => {
  assert.equal(playbackHash(0), '#t=0s')
  assert.equal(playbackHash(113.9), '#t=1m53s')
  assert.equal(playbackHash(6784), '#t=1h53m4s')
  for (const time of [0, 24, 60, 3600, 6784, 86400]) {
    assert.equal(parsePlaybackTime(playbackHash(time).slice(3)), time)
  }
})

test('YouTube video identity accepts supported URLs but not unrelated hosts', () => {
  for (const url of [
    'https://youtu.be/1TNbb2PwIKY?t=113',
    'https://www.youtube.com/watch?v=1TNbb2PwIKY&t=1m53s',
    'https://www.youtube.com/embed/1TNbb2PwIKY?start=113',
    'https://m.youtube.com/watch?v=1TNbb2PwIKY#t=113',
  ]) assert.equal(youtubeVideoId(url), '1TNbb2PwIKY')
  assert.equal(youtubeVideoId('https://youtube.com.evil.test/watch?v=1TNbb2PwIKY'), null)
  assert.equal(youtubeVideoId('https://youtu.be/invalid'), null)
})

test('article playback coordinates players without feeding reported time back into the active player', async () => {
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/episode', component: {} }] })
  await router.push('/episode#t=113')
  let playback!: ReturnType<typeof provideArticlePlayback>
  const Child = defineComponent({
    setup() { assert.equal(useArticlePlayback(), playback); return () => h('div') },
  })
  const app = renderer.createApp(defineComponent({
    setup() { playback = provideArticlePlayback(() => 'https://youtu.be/1TNbb2PwIKY'); return () => h(Child) },
  }))
  app.use(router)
  app.mount({})
  try {
    const audio = { current: 0, playing: false, seeks: 0, scrolls: 0 }
    const video = { current: 0, playing: false, seeks: 0, scrolls: 0 }
    const register = (kind: 'audio' | 'video', state: typeof audio) => playback.register(kind, {
      time: () => state.current,
      seek: time => { state.current = time; state.seeks++ },
      pause: () => { state.playing = false; playback.paused(kind) },
      play: () => { state.playing = true; playback.started(kind) },
      scroll: () => { state.scrolls++ },
    })
    register('audio', audio)
    const unregisterVideo = register('video', video)
    await setImmediate()
    assert.equal(audio.current, 113)
    assert.equal(video.current, 113)
    assert.equal(audio.playing || video.playing, false)

    await router.push('/episode#t=3m26s')
    await setImmediate()
    assert.equal(audio.playing, true)
    assert.equal(video.playing, false)
    assert.equal(audio.scrolls, 1)
    const seeks = audio.seeks
    audio.current = 211.75
    playback.report('audio', audio.current)
    await setImmediate()
    assert.equal(audio.seeks, seeks)
    assert.equal(video.current, 211.75)
    assert.equal(router.currentRoute.value.hash, '#t=3m31s')

    audio.current = 212.5
    playback.prepare('video')
    assert.equal(video.current, 212.5)
    assert.equal(audio.playing, false)
    playback.started('video')
    video.current = 220
    playback.report('video', 220)
    assert.equal(audio.current, 220)
    playback.report('audio', 0)
    assert.equal(playback.time.value, 220)
    await setImmediate()

    await router.push('/episode#t=6m49s')
    await setImmediate()
    assert.equal(video.current, 409)
    assert.equal(video.playing, true)
    assert.equal(video.scrolls, 1)
    assert.equal(audio.playing, false)

    await router.replace('/episode#t=9m13s')
    await setImmediate()
    assert.equal(audio.current, 553)
    assert.equal(video.current, 553)
    unregisterVideo()
    await router.push('/episode#t=24s')
    await setImmediate()
    assert.equal(audio.playing, true)
    assert.equal(audio.current, 24)
    audio.playing = false
    playback.paused('audio')
    const scrolls = audio.scrolls
    await router.push('/episode#t=24s')
    await setImmediate()
    assert.equal(audio.playing, true, 'a repeated timestamp link resumes playback')
    assert.equal(audio.scrolls, scrolls + 1)
    const time = audio.current
    await router.push('/episode#chapter')
    await nextTick()
    assert.equal(audio.current, time, 'ordinary heading links must not seek')
  } finally {
    app.unmount()
  }
})

test('timestamp URLs bypass anchor scrolling before and after Nuxt restores router behavior', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: {} }, { path: '/episode', component: {} }] })
  const behavior: NonNullable<typeof router.options.scrollBehavior> = to => ({ el: to.hash })
  router.options.scrollBehavior = behavior
  let created = () => {}
  const originals = new Map(['defineNuxtPlugin', 'useRouter'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.defineProperty(globalThis, 'defineNuxtPlugin', { configurable: true, value: (setup: unknown) => setup })
  Object.defineProperty(globalThis, 'useRouter', { configurable: true, value: () => router })
  try {
    const { default: plugin } = await import('../app/plugins/playback-scroll.client.ts')
    const run = plugin as unknown as (app: { hook: (name: string, callback: () => void) => void }) => void
    run({ hook: (name, callback) => { assert.equal(name, 'app:created'); created = callback } })
    for (const restored of [false, true]) {
      if (restored) { router.options.scrollBehavior = behavior; created() }
      assert.deepEqual(await router.options.scrollBehavior!(router.resolve('/episode#t=1m53s'), router.resolve('/'), null), { el: '' })
      assert.equal(await router.options.scrollBehavior!(router.resolve('/episode#t=1m54s'), router.resolve('/episode#t=1m53s'), null), false)
      assert.deepEqual(await router.options.scrollBehavior!(router.resolve('/episode#chapter'), router.resolve('/episode'), null), { el: '#chapter' })
    }
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
