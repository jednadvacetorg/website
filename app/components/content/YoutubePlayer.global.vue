<script setup lang="ts">
const props = defineProps<{
  url: string
  title: string
  hero?: boolean
}>()

const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const iframe = useTemplateRef<HTMLIFrameElement>('iframe')
const embedUrl = ref('')

interface YoutubeApi {
  ready: (callback: () => void) => void
  Player: new (element: HTMLIFrameElement, options: {
    events: {
      onReady: (event: { target: { playVideo: () => void } }) => void
      onError: () => void
      onAutoplayBlocked: () => void
    }
  }) => { destroy: () => void }
}

let dispose = () => {}

async function startPlayback() {
  if (!videoId.value || state.value !== 'idle') return

  const externalUrl = youtubeUrl.value
  embedUrl.value = `https://www.youtube-nocookie.com/embed/${videoId.value}?autoplay=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
  state.value = 'loading'
  let active = true
  let player: { destroy: () => void } | undefined
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
  }

  function failPlayback() {
    if (!active) return
    dispose()
    state.value = 'error'
    // Async errors may outlive the user activation. Keep a real link available
    // as well: browsers can block this automatic new tab.
    window.open(externalUrl, '_blank', 'noopener,noreferrer')
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
              onReady: (event) => {
                if (!active) return
                showPlayer()
                try {
                  event.target.playVideo()
                } catch {
                  failPlayback()
                }
              },
              onError: failPlayback,
              // A blocked autoplay isn't a broken video: expose native controls.
              onAutoplayBlocked: showPlayer,
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
const youtubeUrl = computed(() => videoId.value ? `https://www.youtube.com/watch?v=${videoId.value}?autoplay=1` : props.url)

watch(() => props.url, () => {
  dispose()
  state.value = 'idle'
})

onBeforeUnmount(() => dispose())
</script>

<template>
  <div v-if="videoId && state !== 'error'" class="group/youtube relative aspect-video overflow-hidden bg-black"
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
  <div v-else>
    <p v-if="state === 'error'" role="alert">Video se tu nepodařilo načíst. Zkus ho otevřít přímo na YouTube.</p>
    <UButton :to="youtubeUrl" target="_blank" rel="noopener noreferrer"
      color="neutral" variant="link">Přehrát video na YouTube (nová karta)</UButton>
  </div>
</template>
