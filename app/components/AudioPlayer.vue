<script setup lang="ts">
import { podcast } from '#shared/data/social'

const { src, title, cover } = defineProps<{
  src: string
  title: string
  cover: string
}>()

const audio = useTemplateRef<HTMLAudioElement>('audio')
const currentTime = ref(0)
const duration = ref(0)
const isPlaying = ref(false)
const hasStarted = ref(false)

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
}

async function togglePlayback() {
  if (!audio.value) return

  if (audio.value.paused) {
    await audio.value.play()
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

  navigator.mediaSession.setActionHandler('play', () => audio.value?.play())
  navigator.mediaSession.setActionHandler('pause', () => audio.value?.pause())
  navigator.mediaSession.setActionHandler('seekbackward', details => seekBy(-(details.seekOffset ?? 15)))
  navigator.mediaSession.setActionHandler('seekforward', details => seekBy(details.seekOffset ?? 30))
}

function updateTime() {
  currentTime.value = audio.value?.currentTime ?? 0
}

function updateDuration() {
  duration.value = audio.value?.duration ?? 0
}

function handlePlay() {
  isPlaying.value = true
  hasStarted.value = true
  setMediaSession()

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing'
  }
}

function handlePause() {
  isPlaying.value = false

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'paused'
  }
}

onMounted(updateDuration)
</script>

<template>
  <UCard variant="soft" class="relative overflow-hidden">
    <UProgress :model-value="currentTime" :max="duration || 1" size="xs" class="absolute inset-x-0 top-0" />
    <span v-if="hasStarted" class="absolute right-4 top-2 text-xs tabular-nums text-muted sm:right-6" aria-live="off">
      {{ formattedCurrentTime }} / {{ formattedDuration }}
    </span>

    <audio
      ref="audio"
      :src
      preload="metadata"
      @durationchange="updateDuration"
      @timeupdate="updateTime"
      @play="handlePlay"
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
        <span class="text-sm text-muted">Sleduj jako podcast:</span>
        <UTooltip v-for="(platform, key) in podcast.platforms" :key="key" :text="platform.label" arrow>
          <span :tabindex="platform.to ? undefined : 0">
            <UButton
              :icon="'icon' in platform ? platform.icon : undefined"
              :to="platform.to"
              external
              :target="platform.to?.startsWith('https://') ? '_blank' : undefined"
              :disabled="!platform.to"
              :aria-label="platform.label"
              color="neutral"
              variant="ghost"
              size="xs"
            >
              <template v-if="'image' in platform" #leading>
                <img :src="platform.image" alt="" class="size-4" width="16" height="16">
              </template>
            </UButton>
          </span>
        </UTooltip>
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
