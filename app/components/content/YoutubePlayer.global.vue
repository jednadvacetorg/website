<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { youtubeVideoId } from '~/utils/playbackTime'

const props = defineProps<{
  url: string
  title: string
  hero?: boolean
}>()

const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const iframe = useTemplateRef<HTMLIFrameElement>('iframe')
const embedUrl = ref('')
const root = useTemplateRef<HTMLElement>('root')
const articlePlayback = useArticlePlayback()
const playback = articlePlayback?.video.value && youtubeVideoId(props.url) === youtubeVideoId(articlePlayback.video.value) ? articlePlayback : null
const { $counterscale } = useNuxtApp()
let hasStarted = false
interface YoutubePlayer {
  destroy: () => void
  playVideo: () => void
  pauseVideo: () => void
  seekTo: (time: number, allowSeekAhead: boolean) => void
  getCurrentTime: () => number
  getDuration: () => number
}
let player: YoutubePlayer | undefined
let pendingTime = 0
let videoPlaying = false
let playbackRequested = false

function seekTo(time: number) {
  pendingTime = time
  // Do not seek a paused iframe on every audio tick: defer until it is used.
  if (state.value === 'ready' && player && (playback?.selected.value === 'video' || playbackRequested)) {
    const duration = player.getDuration()
    player.seekTo(duration > 0 ? Math.min(time, duration) : time, true)
  }
}

const polling = useIntervalFn(() => {
  if (videoPlaying && player) playback?.report('video', player.getCurrentTime())
}, 1000, { immediate: false })

interface YoutubeApi {
  ready: (callback: () => void) => void
  Player: new (element: HTMLIFrameElement, options: {
    events: {
      onReady: () => void
      onStateChange: (event: { data: number }) => void
      onError: () => void
      onAutoplayBlocked: () => void
    }
  }) => YoutubePlayer
}

let dispose = () => {}

async function startPlayback() {
  if (state.value === 'ready' && player) {
    playbackRequested = true
    playback?.prepare('video')
    seekTo(playback?.time.value ?? pendingTime)
    player.playVideo()
    return
  }
  if (!videoId.value || state.value !== 'idle') return

  playbackRequested = true
  pendingTime = playback?.time.value ?? pendingTime
  embedUrl.value = `https://www.youtube-nocookie.com/embed/${videoId.value}?playsinline=1&enablejsapi=1&start=${Math.floor(pendingTime)}&origin=${encodeURIComponent(window.location.origin)}`
  state.value = 'loading'
  let active = true
  let script: HTMLScriptElement | undefined
  const timeout = window.setTimeout(failPlayback, 15_000)

  dispose = () => {
    active = false
    window.clearTimeout(timeout)
    if (script) {
      script.onload = null
      script.onerror = null
      script.remove()
    }
    player?.destroy()
    player = undefined
    videoPlaying = false
    playbackRequested = false
    polling.pause()
    playback?.paused('video')
  }

  function failPlayback() {
    if (!active) return
    dispose()
    unregister?.()
    unregister = undefined
    state.value = 'error'
  }

  function showPlayer() {
    if (!active) return
    window.clearTimeout(timeout)
    state.value = 'ready'
  }

  await nextTick()
  if (!active) return

  const youtubeWindow = window as Window & { YT?: YoutubeApi }
  function connectPlayer() {
    if (!active) return
    try {
      if (!youtubeWindow.YT?.ready) return failPlayback()
      youtubeWindow.YT.ready(() => {
        if (!active || !iframe.value || !youtubeWindow.YT) return
        try {
          player = new youtubeWindow.YT.Player(iframe.value, {
            events: {
              onReady: () => {
                if (!active) return
                showPlayer()
                if (!playbackRequested) return
                try {
                  playback?.prepare('video')
                  seekTo(playback?.time.value ?? pendingTime)
                  player?.playVideo()
                } catch {
                  failPlayback()
                }
              },
              onStateChange: ({ data }) => {
                if (!active || !player) return
                if (data === 1) {
                  if (!hasStarted) {
                    hasStarted = true
                    $counterscale.trackVideoStart()
                  }
                  // Native iframe controls can start playback after audio took over.
                  if (playback && playback.selected.value !== 'video') {
                    playback?.prepare('video')
                    playbackRequested = true
                    seekTo(playback?.time.value ?? pendingTime)
                  }
                  videoPlaying = true
                  playbackRequested = false
                  playback?.started('video')
                  polling.resume()
                } else {
                  if (videoPlaying || data === 2 || data === 0) playback?.report('video', player.getCurrentTime())
                  videoPlaying = false
                  polling.pause()
                  playback?.paused('video')
                }
              },
              onError: failPlayback,
              // A blocked autoplay isn't a broken video: expose native controls.
              onAutoplayBlocked: () => { playbackRequested = false; showPlayer() },
            },
          })
        } catch {
          failPlayback()
        }
      })
    } catch {
      failPlayback()
    }
  }

  if (youtubeWindow.YT?.ready) {
    connectPlayer()
  } else {
    script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onload = connectPlayer
    script.onerror = failPlayback
    document.head.append(script)
  }
}
const videoId = computed(() => youtubeVideoId(props.url))
const youtubeUrl = computed(() => videoId.value ? `https://www.youtube.com/watch?v=${videoId.value}&t=${Math.floor(playback?.time.value ?? pendingTime)}s` : props.url)

let unregister: (() => void) | undefined
onMounted(() => {
  unregister = playback?.register('video', {
    seek: seekTo,
    play: startPlayback,
    pause: () => {
      playbackRequested = false
      if (state.value === 'ready') player?.pauseVideo()
      videoPlaying = false
      polling.pause()
    },
    time: () => state.value === 'ready' ? player?.getCurrentTime() ?? pendingTime : pendingTime,
    scroll: () => root.value?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  })
})

watch(() => props.url, () => {
  dispose()
  hasStarted = false
  state.value = 'idle'
})

onBeforeUnmount(() => { unregister?.(); dispose() })
</script>

<template>
  <div v-if="videoId && state !== 'error'" ref="root" class="group/youtube relative aspect-video overflow-hidden bg-black scroll-mt-24"
    :class="{ 'rounded-lg': !hero }">
    <iframe v-if="state !== 'idle'" ref="iframe" :src="embedUrl" :title="title"
      allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen
      class="absolute inset-0 size-full border-0" />
    <img v-if="state !== 'ready'" :src="`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`" alt=""
      width="480" height="360" class="absolute inset-0 size-full object-cover transform transition-transform ease-out motion-reduce:transition-none"
      :class="{ 'group-hover/youtube:scale-110': state === 'idle' }" />
    <div v-if="!hero && state !== 'ready'" class="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent p-4 pb-8">
      <p class="line-clamp-2 text-3xl font-medium text-white">{{ title }}</p>
    </div>
    <UButton v-if="state === 'idle'" :to="youtubeUrl" target="_blank" rel="noopener noreferrer"
      color="neutral" variant="ghost" :aria-label="`Přehrát video: ${title}`"
      class="absolute inset-0 block size-full p-0 hover:bg-transparent active:bg-transparent" @click.prevent="startPlayback">
      <UIcon name="i-simple-icons-youtube" class="absolute top-1/2 left-1/2 size-16 -translate-x-1/2 -translate-y-1/2 text-primary" />
    </UButton>
    <div v-if="state === 'loading'" role="status" class="absolute inset-0 flex items-center justify-center bg-black/60">
      <UIcon name="i-lucide-loader-circle" class="size-16 animate-spin text-primary" aria-hidden="true" />
      <span class="sr-only">Načítám video…</span>
    </div>
  </div>
  <div v-else ref="root" class="scroll-mt-24">
    <p v-if="state === 'error'" role="alert">Video se tu nepodařilo načíst. Zkus ho otevřít přímo na YouTube.</p>
    <UButton :to="youtubeUrl" target="_blank" rel="noopener noreferrer"
      color="neutral" variant="link">Přehrát video na YouTube (nová karta)</UButton>
  </div>
</template>
