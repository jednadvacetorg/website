<script setup lang="ts">
const { src, title, cover } = defineProps<{
  src: string
  title: string
  cover: string
}>()

const audio = useTemplateRef<HTMLAudioElement>('audio')
const root = useTemplateRef<{ $el: HTMLElement }>('root')
const playback = useArticlePlayback()
const { $counterscale } = useNuxtApp()
const currentTime = ref(0)
const duration = ref(0)
const isPlaying = ref(false)
const hasStarted = ref(false)
let hasTrackedPlayback = false

function formatTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '--:--'

  const totalSeconds = Math.floor(value)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  const minutes = Math.floor(totalSeconds / 60)

  return `${minutes}:${seconds}`
}

const formattedCurrentTime = computed(() => formatTime(currentTime.value))
const formattedDuration = computed(() => formatTime(duration.value))

function seekBy(seconds: number) {
  if (!audio.value || !Number.isFinite(audio.value.duration)) return

  audio.value.currentTime = Math.min(Math.max(audio.value.currentTime + seconds, 0), audio.value.duration)
  playback?.seek(audio.value.currentTime)
}

async function togglePlayback() {
  if (!audio.value) return

  if (audio.value.paused) {
    playback?.prepare('audio')
    try {
      await audio.value.play()
    } catch {
      if (playback) playback.error.value = 'Audio se nepodařilo spustit. Zkus přehrávání znovu.'
    }
    return
  }

  audio.value.pause()
}

function setMediaSession() {
  if (!('mediaSession' in navigator)) return

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: 'Jednadvacet',
    artwork: [{ src: new URL(cover, window.location.origin).href }],
  })

  navigator.mediaSession.setActionHandler('play', () => { if (audio.value?.paused) return togglePlayback() })
  navigator.mediaSession.setActionHandler('pause', () => audio.value?.pause())
  navigator.mediaSession.setActionHandler('seekbackward', details => seekBy(-(details.seekOffset ?? 15)))
  navigator.mediaSession.setActionHandler('seekforward', details => seekBy(details.seekOffset ?? 30))
}

function updateTime() {
  currentTime.value = audio.value?.currentTime ?? 0
  if (!audio.value?.paused) playback?.report('audio', currentTime.value)
}

function seekTo(time: number) {
  if (!audio.value || audio.value.readyState === 0) return
  const max = Number.isFinite(audio.value.duration) ? audio.value.duration : Infinity
  audio.value.currentTime = Math.min(Math.max(time, 0), max)
  currentTime.value = audio.value.currentTime
}

function updateDuration() {
  duration.value = audio.value?.duration ?? 0
  if (playback && !isPlaying.value) seekTo(playback.time.value)
}

function handlePlay() {
  playback?.started('audio')
  isPlaying.value = true
  hasStarted.value = true
  setMediaSession()

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing'
  }
}

function handlePlaying() {
  if (hasTrackedPlayback) return
  hasTrackedPlayback = true
  $counterscale.trackAudioStart()
}

function handlePause() {
  if (isPlaying.value) playback?.report('audio', audio.value?.currentTime ?? 0)
  playback?.paused('audio')
  isPlaying.value = false

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused'
  }
}

let unregister: (() => void) | undefined
onMounted(() => {
  updateDuration()
  unregister = playback?.register('audio', {
    seek: seekTo,
    play: () => audio.value?.play(),
    pause: () => audio.value?.pause(),
    time: () => audio.value?.currentTime ?? currentTime.value,
    scroll: () => root.value?.$el.scrollIntoView({ block: 'center', behavior: 'smooth' }),
  })
})
onBeforeUnmount(() => {
  audio.value?.pause()
  unregister?.()
  if ('mediaSession' in navigator && hasStarted.value) {
    for (const action of ['play', 'pause', 'seekbackward', 'seekforward'] as const) navigator.mediaSession.setActionHandler(action, null)
  }
})
</script>

<template>
  <UCard ref="root" variant="soft" class="relative overflow-hidden scroll-mt-24">
    <UProgress :model-value="currentTime" :max="duration || 1" size="xs" class="absolute inset-x-0 top-0" />
    <span v-if="hasStarted" class="absolute right-4 top-2 text-xs tabular-nums text-muted sm:right-6" aria-live="off">
      {{ formattedCurrentTime }} / {{ formattedDuration }}
    </span>

    <audio
      ref="audio"
      :src
      preload="metadata"
      @durationchange="updateDuration"
      @loadedmetadata="() => { if (playback) seekTo(playback.time.value) }"
      @timeupdate="updateTime"
      @play="handlePlay"
      @playing="handlePlaying"
      @pause="handlePause"
      @ended="handlePause"
    />

    <div class="flex flex-wrap items-center gap-3">
      <UButton
        :icon="isPlaying ? 'i-lucide-pause' : 'i-lucide-play'"
        :aria-label="isPlaying ? 'Pozastavit audio verzi' : 'Přehrát audio verzi'"
        @click="togglePlayback"
      />
      <Transition name="audio-controls" mode="out-in">
        <span v-if="!hasStarted" key="label" class="font-medium">Audio verze <span class="text-muted">{{ formattedDuration }}</span></span>
        <div v-else key="controls" class="flex items-center gap-1">
          <UButton
            icon="i-lucide-rewind"
            label="15 s"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Vrátit o 15 sekund"
            @click="seekBy(-15)"
          />
          <UButton
            icon="i-lucide-fast-forward"
            label="30 s"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="Posunout o 30 sekund"
            @click="seekBy(30)"
          />
        </div>
      </Transition>
      <div
        class="flex w-full flex-wrap items-center justify-center gap-1 sm:ms-auto sm:w-auto sm:justify-end"
        :class="{ 'sm:translate-y-2': hasStarted }"
      >
        <PodcastFollowLinks />
      </div>
    </div>
  </UCard>
</template>

<style scoped>
.audio-controls-enter-active,
.audio-controls-leave-active {
  transition: opacity 150ms ease, transform 150ms ease;
}

.audio-controls-enter-from,
.audio-controls-leave-to {
  opacity: 0;
  transform: translateX(-0.25rem);
}
</style>
