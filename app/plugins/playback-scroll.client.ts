import { parsePlaybackTime } from '../utils/playbackTime.ts'

export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter()
  function preservePlaybackScroll() {
    const scrollBehavior = router.options.scrollBehavior
    router.options.scrollBehavior = (to, from, savedPosition) => {
      const timestamp = parsePlaybackTime(new URLSearchParams(to.hash.slice(1)).get('t'))
      if (timestamp !== null) {
        if (to.path === from.path) return false
        return scrollBehavior?.({ ...to, hash: '' }, from, savedPosition)
      }
      return scrollBehavior?.(to, from, savedPosition)
    }
  }
  preservePlaybackScroll()
  // Nuxt restores its scroll behavior during app:created; wrap that version too.
  nuxtApp.hook('app:created', preservePlaybackScroll)
})
