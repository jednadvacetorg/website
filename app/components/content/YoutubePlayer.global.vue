<script setup lang="ts">
const props = defineProps<{
  url: string
  title: string
}>()

const playing = ref(false)
const loaded = ref(false)
const iframe = useTemplateRef<HTMLIFrameElement>('iframe')
const embedUrl = ref('')

interface YoutubeApi {
  ready: (callback: () => void) => void
  Player: new (element: HTMLIFrameElement, options: {
    events: { onReady: (event: { target: { playVideo: () => void } }) => void }
  }) => { destroy: () => void }
}

let player: { destroy: () => void } | undefined

async function startPlayback() {
  if (!videoId.value || playing.value) return

  embedUrl.value = `https://www.youtube-nocookie.com/embed/${videoId.value}?autoplay=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
  playing.value = true
  await nextTick()

  // The iframe load event precedes player readiness. Start playback only once
  // YouTube can accept commands, keeping the thumbnail visible until then.
  const youtubeWindow = window as Window & { YT?: YoutubeApi }
  try {
    if (!youtubeWindow.YT?.ready) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.onload = () => resolve()
        script.onerror = () => { script.remove(); reject(new Error('YouTube API failed to load')) }
        document.head.append(script)
      })
    }
    youtubeWindow.YT?.ready(() => {
      if (!playing.value || !iframe.value || !youtubeWindow.YT) return
      player = new youtubeWindow.YT.Player(iframe.value, {
        events: {
          onReady: (event) => {
            event.target.playVideo()
            loaded.value = true
          },
        },
      })
    })
  } catch {
    // Leave the native player accessible if the API script is blocked.
    loaded.value = true
  }
}
const videoId = computed(() => {
  try {
    const url = new URL(props.url)
    let id: string | null = null
    if (url.hostname === 'youtu.be') {
      id = url.pathname.split('/')[1] ?? null
    } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
      id = url.pathname === '/watch'
        ? url.searchParams.get('v')
        : /^\/(?:embed|live|shorts)\/([^/]+)/.exec(url.pathname)?.[1] ?? null
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null
  } catch {
    return null
  }
})

watch(() => props.url, () => {
  player?.destroy()
  player = undefined
  playing.value = false
  loaded.value = false
})

onBeforeUnmount(() => player?.destroy())
</script>

<template>
  <div v-if="videoId" class="group/youtube relative aspect-video overflow-hidden rounded-lg bg-black">
    <iframe v-if="playing" ref="iframe" :src="embedUrl" :title="title"
      allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen
      class="absolute inset-0 size-full border-0" />
    <img v-if="!loaded" :src="`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`" alt=""
      width="480" height="360" class="absolute inset-0 size-full object-cover transform transition-transform ease-out motion-reduce:transition-none"
      :class="{ 'group-hover/youtube:scale-110': !playing }" />
    <div v-if="!loaded" class="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent p-4 pb-8">
      <p class="line-clamp-2 text-xl font-medium text-white">{{ title }}</p>
    </div>
    <UButton v-if="!playing" color="neutral" variant="ghost" :aria-label="`Přehrát video: ${title}`"
      class="absolute inset-0 block size-full p-0 hover:bg-transparent active:bg-transparent" @click="startPlayback">
      <UIcon name="i-simple-icons-youtube" class="absolute top-1/2 left-1/2 size-16 -translate-x-1/2 -translate-y-1/2 text-primary" />
    </UButton>
    <div v-if="playing && !loaded" role="status" class="absolute inset-0 flex items-center justify-center bg-black/60">
      <UIcon name="i-lucide-loader-circle" class="size-16 animate-spin text-primary" aria-hidden="true" />
      <span class="sr-only">Načítám video…</span>
    </div>
  </div>
  <UButton v-else :to="url" target="_blank" color="neutral" variant="link">Přehrát video na YouTube</UButton>
</template>
