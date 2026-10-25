import * as Counterscale from '@counterscale/tracker'

export default defineNuxtPlugin((nuxtApp) => {
  const router = useRouter()
  Counterscale.init({
    siteId: window.location.hostname,
    reporterUrl: '/cntrsclc', // Proxy to https://analytics.jednadvacet.org/collect, so ad-blockers will not block it
    autoTrackPageviews: false,
  })

  const isPrivate = (value: string) => {
    let path: string
    try { path = new URL(value, window.location.origin).pathname } catch { return false }
    try { path = decodeURIComponent(path) } catch { /* Keep malformed paths opaque. */ }
    return /^\/notifications\/manage(?:\/|$)/i.test(path)
  }
  let active = true
  const track = (path: string) => {
    if (!active || isPrivate(path)) return
    // Explicit same-origin URLs bypass unsafe/stale canonical metadata. Preserve
    // normal SDK attribution, but never forward a management capability as `r`.
    const query = new URLSearchParams(window.location.search)
    const privateReferrer = [document.referrer, ...['ref', 'referer', 'referrer', 'source', 'utm_source'].map(key => query.get(key) || '')]
      .some(value => value && isPrivate(value))
    const url = new URL(window.location.origin + path)
    // The SDK also serializes UTM values independently of its referrer field.
    // Sanitize only the analytics copy; keep the browser URL and normal attribution.
    for (const [key, value] of [...url.searchParams]) {
      if (['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'referer', 'referrer', 'source'].includes(key) && isPrivate(value)) {
        url.searchParams.delete(key, value)
      }
    }
    Counterscale.trackPageview({
      url: url.href,
      ...(privateReferrer ? { referrer: window.location.origin } : {}),
    })
  }
  let removeNavigation: (() => void) | undefined
  const removeMounted = nuxtApp.hook('app:mounted', () => {
    // Initial router resolution has finished: count it once, then successful SPA
    // transitions (including replace and back/forward), never aborted navigation.
    removeNavigation = router.afterEach((to, _from, failure) => {
      if (!failure) track(to.fullPath)
    })
    track(router.currentRoute.value.fullPath)
  })
  const cleanup = () => {
    if (!active) return
    active = false
    removeMounted()
    removeNavigation?.()
    Counterscale.cleanup()
  }
  nuxtApp.vueApp.onUnmount(cleanup)
  if (import.meta.hot) import.meta.hot.dispose(cleanup)

  const trackSubscriptionGuide = () => track('/kalendar/subscription-guide')
  const trackSmsIntent = () => track('/kalendar/signin-sms')
  const trackEmailIntent = () => track('/kalendar/signin-mail')
  const trackWebIntent = () => track('/kalendar/signin-web')
  const trackICalendarCopy = () => track('/kalendar/copy-ical')

  return {
    provide: {
      counterscale: {
        trackSubscriptionGuide,
        trackSmsIntent,
        trackEmailIntent,
        trackWebIntent,
        trackICalendarCopy,
      },
    },
  }
})
