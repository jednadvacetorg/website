import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch, type InjectionKey } from 'vue'
import { useRouteHash } from '@vueuse/router'
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router'
import { playbackHash, parsePlaybackTime } from '../utils/playbackTime.ts'

/**
 * Coordinates the audio and YouTube versions of one article, not a global player.
 * ArticleLayout provides this context; its players inject it and register adapters
 * for their native media APIs. The context keeps one playback position, pauses the
 * other player when switching, and connects chapter links to the URL's #t=… hash.
 * It does not load media or create the YouTube iframe; those remain player concerns.
 */
type PlayerKind = 'audio' | 'video'
interface PlaybackPlayer {
  seek: (time: number) => void
  play: () => void | Promise<void>
  pause: () => void
  time: () => number
  scroll: () => void
}

function createArticlePlayback(video: () => string | undefined) {
  const router = useRouter()
  const path = router.currentRoute.value.path
  const hash = useRouteHash('', { mode: 'replace' })
  const time = ref(0)
  // Keep the preferred player after a pause so chapter links can resume it.
  const selected = ref<PlayerKind>('audio')
  const playing = ref<PlayerKind | null>(null)
  const error = ref('')
  const players = new Map<PlayerKind, PlaybackPlayer>()
  // Progress updates also change the hash. Ignore our own writes so they cannot
  // seek/restart the active player or scroll the reader on every playback tick.
  let writtenHash = ''
  let mounted = false

  function writeTime(value: number) {
    if (!Number.isFinite(value) || value < 0) return
    time.value = value
    const next = playbackHash(value)
    if (hash.value !== next) {
      writtenHash = next
      // Start navigation now: VueUse's deferred setter can overwrite a chapter
      // navigation made later in the same tick with an older playback position.
      void router.replace({ hash: next })
    }
  }

  function seek(value: number) {
    writeTime(value)
    players.forEach(player => player.seek(value))
  }

  function readHash(startPlayback = false) {
    const value = parsePlaybackTime(new URLSearchParams((hash.value ?? '').replace(/^#/, '')).get('t'))
    if (value !== null) {
      if (startPlayback) void jump(value)
      else seek(value)
    }
  }
  // A shared URL only prepares the position. Later external hash changes (chapter
  // links or browser navigation) also start playback and scroll to the chosen player.
  onMounted(() => { readHash(); mounted = true })
  watch(hash, value => {
    if (router.currentRoute.value.path !== path) return
    if (value === writtenHash) { writtenHash = ''; return }
    readHash(mounted)
  })
  // A repeated chapter click is a duplicated navigation, not a hash change.
  const removeNavigation = router.afterEach((to, _from, failure) => {
    if (mounted && to.path === path && isNavigationFailure(failure, NavigationFailureType.duplicated)) readHash(true)
  })
  onBeforeUnmount(removeNavigation)

  function prepare(kind: PlayerKind, targetTime?: number) {
    // Read the source player directly when switching: background tabs can throttle
    // time reports. An explicit chapter position takes precedence over that clock.
    const active = playing.value && players.get(playing.value)
    if (targetTime !== undefined) writeTime(targetTime)
    else if (active) writeTime(active.time())
    players.forEach((player, key) => { if (key !== kind) player.pause() })
    selected.value = kind
    playing.value = null
    players.get(kind)?.seek(time.value)
  }

  async function jump(value: number) {
    const kind = players.has(selected.value) ? selected.value : players.has('audio') ? 'audio' : 'video'
    const player = players.get(kind)
    if (!player) return
    prepare(kind, value)
    seek(value)
    player.scroll()
    try { await player.play() } catch { error.value = 'Přehrávání se nepodařilo spustit. Zkus tlačítko přehrávače.' }
  }

  return {
    video: computed(video),
    selected: computed(() => selected.value),
    time: computed(() => time.value),
    error,
    register(kind: PlayerKind, player: PlaybackPlayer) {
      players.set(kind, player)
      player.seek(time.value)
      return () => { players.delete(kind); if (playing.value === kind) playing.value = null }
    },
    prepare,
    seek,
    started(kind: PlayerKind) {
      players.forEach((player, key) => { if (key !== kind) player.pause() })
      selected.value = kind
      playing.value = kind
      error.value = ''
    },
    paused(kind: PlayerKind) {
      if (playing.value === kind) playing.value = null
    },
    report(kind: PlayerKind, value: number) {
      if (selected.value !== kind) return
      writeTime(value)
      // Only the inactive player follows progress; seeking the source would cause
      // feedback loops. An unloaded iframe simply remembers this pending position.
      players.forEach((player, key) => { if (key !== kind) player.seek(value) })
    },
  }
}

const playbackKey: InjectionKey<ReturnType<typeof createArticlePlayback>> = Symbol('articlePlayback')

export function provideArticlePlayback(video: () => string | undefined) {
  const playback = createArticlePlayback(video)
  provide(playbackKey, playback)
  return playback
}

export function useArticlePlayback() {
  return inject(playbackKey, null)
}
