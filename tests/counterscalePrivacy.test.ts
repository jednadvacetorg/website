import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import * as Counterscale from '@counterscale/tracker'

// Execute the real client plugin and installed SDK. Only the Nuxt/router and DOM/XHR
// boundaries are supplied here; no network or tracker implementation is mocked.
const origin = 'https://privacy.example.test'
const privateA = '/notifications/manage/SYNTH_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const privateB = '/notifications/manage/SYNTH_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
type Route = { path: string, fullPath: string }
type AfterEach = (to: Route, from: Route, failure?: Error) => void

async function fixture(initial: string, canonical: string | null = null, referrer = '') {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const requests: URL[] = []
  const events = new Map<string, Set<() => void>>()
  const mounted = new Set<() => void>()
  const unmount = new Set<() => void>()
  const afterEach = new Set<AfterEach>()
  const location = new URL(initial, origin)
  const route = () => ({ path: location.pathname, fullPath: location.pathname + location.search + location.hash })
  const currentRoute = { value: route() }
  const listen = (name: string, callback: () => void) => {
    if (!events.has(name)) events.set(name, new Set())
    events.get(name)!.add(callback)
  }
  install('window', { location })
  install('location', location)
  install('navigator', { userAgent: 'Synthetic client tracker security test' })
  install('document', {
    referrer,
    querySelector: () => canonical ? { href: new URL(canonical, origin).href } : null,
    createElement: () => {
      let url = new URL(location.href)
      return {
        set href(value: string) { url = new URL(value, location.href) },
        get href() { return url.href },
        get protocol() { return url.protocol },
        get hostname() { return url.hostname },
        get host() { return url.host },
        get pathname() { return url.pathname },
        get search() { return url.search },
      }
    },
  })
  install('addEventListener', listen)
  install('removeEventListener', (name: string, callback: () => void) => events.get(name)?.delete(callback))
  install('history', {
    pushState: (_state: unknown, _title: string, url: string) => { location.href = new URL(url, origin).href },
    replaceState: (_state: unknown, _title: string, url: string) => { location.href = new URL(url, origin).href },
  })
  install('fetch', () => { throw Error('Unexpected outbound fetch') })
  install('XMLHttpRequest', class {
    status = 200
    responseText = '{"ht":1}'
    onload?: () => void
    url!: URL
    open(method: string, url: string) {
      assert.equal(method, 'GET')
      this.url = new URL(url, origin)
      assert.equal(this.url.origin, origin)
      assert.equal(this.url.pathname, '/cntrsclc')
    }
    setRequestHeader() {}
    send() { requests.push(this.url); this.onload?.() }
  })
  install('defineNuxtPlugin', (setup: unknown) => setup)
  install('useRouter', () => ({
    currentRoute,
    afterEach: (callback: AfterEach) => { afterEach.add(callback); return () => afterEach.delete(callback) },
  }))
  const app = {
    hook: (name: string, callback: () => void) => {
      assert.equal(name, 'app:mounted')
      mounted.add(callback)
      return () => mounted.delete(callback)
    },
    vueApp: { onUnmount: (callback: () => void) => unmount.add(callback) },
  }
  try {
    const { default: plugin } = await import('../app/plugins/counterscale.client.ts')
    const run = plugin as unknown as (nuxtApp: typeof app) => { provide: { counterscale: Record<string, () => void> } }
    const provided = run(app).provide.counterscale
    const settle = () => delay(15)
    const navigate = async (path: string, mode: 'push' | 'replace' | 'pop' = 'push', failure?: Error) => {
      const from = currentRoute.value
      const target = new URL(path, origin)
      const to = { path: target.pathname, fullPath: target.pathname + target.search + target.hash }
      if (!failure) {
        if (mode === 'pop') {
          location.href = target.href
          for (const callback of events.get('popstate') || []) callback()
        } else history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', path)
        currentRoute.value = to
      }
      for (const callback of afterEach) callback(to, from, failure)
      await settle()
    }
    return {
      requests, provided, navigate, settle, afterEach,
      currentUrl: () => location.href,
      pageviews: () => requests.filter(url => url.searchParams.has('p')),
      mount: async () => { for (const callback of mounted) callback(); await settle() },
      dispose: () => { for (const callback of unmount) callback() },
      async close() {
        for (const callback of unmount) callback()
        Counterscale.cleanup()
        await settle()
        assert.equal([...events.values()].reduce((count, listeners) => count + listeners.size, 0), 0)
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor)
          else Reflect.deleteProperty(globalThis, key)
        }
      },
    }
  } catch (error) {
    Counterscale.cleanup()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    throw error
  }
}

test('direct private entries never enter the collector, with or without an unsafe canonical', async () => {
  for (const path of [privateA, '/NOTIFICATIONS/MANAGE/SYNTH_CASE', '/%6eotifications/%6danage/SYNTH_ENCODED', '/notifications%2fmanage/SYNTH_SLASH']) {
    for (const canonical of [null, privateB]) {
      const client = await fixture(path, canonical)
      try {
        await client.mount()
        assert.deepEqual(client.requests.map(url => url.href), [], 'private entry must make zero collector requests')
      } finally { await client.close() }
    }
  }
})

test('public navigation reports once, skips private push/replace/back-forward and failed navigation', async (t) => {
  const client = await fixture('/kalendar?utm_source=community&utm_medium=email&utm_campaign=meetup', privateA, 'https://search.example.test/results?q=bitcoin')
  try {
    // Nuxt initial resolution happens before app:mounted; it must not become a second pageview.
    await client.navigate('/kalendar?utm_source=community&utm_medium=email&utm_campaign=meetup')
    await client.mount()
    assert.deepEqual(client.pageviews().map(url => url.searchParams.get('p')), ['/kalendar'])
    const first = client.pageviews()[0]!
    assert.equal(first.searchParams.get('us'), 'community')
    assert.equal(first.searchParams.get('um'), 'email')
    assert.equal(first.searchParams.get('uc'), 'meetup')
    assert.equal(first.searchParams.get('r'), 'https://search.example.test/results')
    assert.equal(first.searchParams.get('h'), origin)
    assert.equal(first.searchParams.get('sid'), 'privacy.example.test')
    const count = client.requests.length
    await client.navigate(privateA)
    await client.navigate(privateB, 'replace')
    await client.navigate(privateA, 'pop')
    await client.navigate(privateB, 'pop')
    await client.navigate('/NOTIFICATIONS/MANAGE/SYNTH_CASE')
    await client.navigate('/%6eotifications/%6danage/SYNTH_ENCODED')
    assert.equal(client.requests.length, count)
    await client.navigate('/blog', 'push', Error('aborted navigation'))
    assert.equal(client.requests.length, count)
    await client.navigate('/blog?utm_source=signal')
    await client.navigate('/kalendar', 'pop')
    assert.deepEqual(client.pageviews().map(url => url.searchParams.get('p')), ['/kalendar', '/blog', '/kalendar'])
    assert.equal(client.pageviews()[1]!.searchParams.get('us'), 'signal')
    assert.ok(client.requests.every(url => !decodeURIComponent(url.href).includes('SYNTH_')))
    t.diagnostic(JSON.stringify({ publicPageviews: client.pageviews().map(url => url.href), privateNavigationRequests: client.requests.length - 6 }))
  } finally { await client.close() }
})

test('management entry can leave for public pages without forwarding document referrer or canonical bearer', async () => {
  for (const referrer of [origin + privateA, 'https://other.example.test' + privateA]) {
    const client = await fixture(privateA, privateB, referrer)
    try {
      await client.mount()
      await client.navigate('/blog')
      assert.deepEqual(client.pageviews().map(url => url.searchParams.get('p')), ['/blog'])
      assert.equal(client.pageviews()[0]!.searchParams.get('r'), '')
      assert.ok(client.requests.every(url => !decodeURIComponent(url.href).includes('SYNTH_')))
    } finally { await client.close() }
  }
})

test('public explicit URLs ignore unsafe canonical and preserve ordinary query referrers without a canonical', async () => {
  for (const canonical of [null, origin + privateA]) {
    const client = await fixture('/blog?ref=community&utm_source=newsletter', canonical)
    try {
      await client.mount()
      assert.deepEqual(client.pageviews().map(url => url.searchParams.get('p')), ['/blog'])
      assert.equal(client.pageviews()[0]!.searchParams.get('r'), 'community')
      assert.equal(client.pageviews()[0]!.searchParams.get('us'), 'newsletter')
    } finally { await client.close() }
  }
})

test('five zero-argument guide counters retain fixed public URLs and no capability referrer', async (t) => {
  const client = await fixture('/kalendar?ref=' + encodeURIComponent(origin + privateA), privateB)
  try {
    await client.mount()
    const before = client.pageviews().length
    assert.deepEqual(Object.keys(client.provided), ['trackSubscriptionGuide', 'trackSmsIntent', 'trackEmailIntent', 'trackWebIntent', 'trackICalendarCopy'])
    for (const counter of Object.values(client.provided)) { assert.equal(counter.length, 0); counter() }
    await client.settle()
    assert.deepEqual(client.pageviews().slice(before).map(url => url.searchParams.get('p')), [
      '/kalendar/subscription-guide', '/kalendar/signin-sms', '/kalendar/signin-mail', '/kalendar/signin-web', '/kalendar/copy-ical',
    ])
    assert.ok(client.requests.every(url => !decodeURIComponent(url.href).includes('SYNTH_')))
    t.diagnostic(JSON.stringify({ guidePageviews: client.pageviews().slice(before).map(url => url.href) }))
  } finally { await client.close() }
})

test('private management values never enter any campaign or referrer field while ordinary attribution and the browser URL survive', async (t) => {
  const campaign = { utm_source: 'community', utm_medium: 'email', utm_campaign: 'meetup', utm_term: 'bitcoin', utm_content: 'guide' }
  const wireFields = { utm_source: 'us', utm_medium: 'um', utm_campaign: 'uc', utm_term: 'ut', utm_content: 'uco' }
  const leaks: { field: string, canonical: boolean, url: string }[] = []
  for (const field of [...Object.keys(campaign), 'ref', 'referer', 'referrer', 'source']) {
    for (const value of [origin + privateA, '/NOTIFICATIONS/MANAGE/SYNTH_CASE', '/%6eotifications/%6danage/SYNTH_ENCODED']) {
      for (const canonical of [null, privateB]) {
        const query = new URLSearchParams({ ...campaign, [field]: value })
        const initial = '/blog?' + query
        const client = await fixture(initial, canonical)
        try {
          await client.mount()
          assert.equal(client.currentUrl(), origin + initial, 'analytics sanitization must not edit the browser URL')
          assert.deepEqual(client.pageviews().map(url => url.searchParams.get('p')), ['/blog'])
          for (const [key, wire] of Object.entries(wireFields)) {
            if (key !== field) assert.equal(client.pageviews()[0]!.searchParams.get(wire), campaign[key as keyof typeof campaign])
          }
          for (const url of client.requests) {
            if ([...url.searchParams.values()].some(value => value.includes('SYNTH_'))) leaks.push({ field, canonical: !!canonical, url: url.href })
          }
        } finally { await client.close() }
      }
    }
  }
  t.diagnostic(JSON.stringify({ campaignAndReferrerCases: 54, leaks }))
  assert.deepEqual(leaks, [])
})

test('Vue app disposal removes navigation listeners and stale provided counters cannot report', async () => {
  const client = await fixture('/kalendar')
  try {
    await client.mount()
    assert.equal(client.afterEach.size, 1)
    client.dispose()
    assert.equal(client.afterEach.size, 0)
    const count = client.requests.length
    await client.navigate('/blog')
    for (const counter of Object.values(client.provided)) counter()
    await client.settle()
    assert.equal(client.requests.length, count)
  } finally { await client.close() }
  const beforeMount = await fixture('/kalendar')
  try {
    beforeMount.dispose()
    await beforeMount.mount()
    await beforeMount.navigate('/blog')
    assert.equal(beforeMount.afterEach.size, 0)
    assert.deepEqual(beforeMount.requests, [])
  } finally { await beforeMount.close() }
})
