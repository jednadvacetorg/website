import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp, createRouter, eventHandler, toNodeListener } from 'h3'

process.env.NODE_ENV = 'development'
let runtimeConfig: Record<string, unknown> = { notificationUiVerificationFixture: true }
;(globalThis as typeof globalThis & { useRuntimeConfig: () => Record<string, unknown> }).useRuntimeConfig = () => runtimeConfig

const activate = (await import('../server/api/notifications/activate.post.ts')).default
const recover = (await import('../server/api/notifications/manage-request.post.ts')).default
const manageGet = (await import('../server/api/notifications/manage/[token].get.ts')).default
const managePost = (await import('../server/api/notifications/manage/[token].post.ts')).default

const fixtureToken = 'notification-ui-verification-token'
const activation = {
  channel: 'email',
  contact: 'guide@example.test',
  communitySlugs: ['brno'],
  frequencies: ['created'],
  consentAt: '2026-09-17T00:00:00.000Z',
  consentVersion: '2026-09',
}

const withRoutes = async (run: (baseUrl: string) => Promise<void>) => {
  const app = createApp()
  app.use('/activate', eventHandler(event => {
    event.context._platform = { cloudflare: { env: {} } }
    return activate(event)
  }))
  app.use('/recover', eventHandler(event => {
    event.context._platform = { cloudflare: { env: {} } }
    return recover(event)
  }))
  const management = createRouter()
  management.get('/manage/:token', eventHandler(event => {
    event.context._platform = { cloudflare: { env: {} } }
    return manageGet(event)
  }))
  management.post('/manage/:token', eventHandler(event => {
    event.context._platform = { cloudflare: { env: {} } }
    return managePost(event)
  }))
  app.use(management)
  const server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

test('activation accepts the fixture challenge only through the JSON body token', async () => {
  await withRoutes(async baseUrl => {
    const challenge = await fetch(`${baseUrl}/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Turnstile-Response': fixtureToken }, body: JSON.stringify(activation) })
    assert.equal(challenge.status, 403)
    const success = await fetch(`${baseUrl}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...activation, turnstileToken: fixtureToken }) })
    assert.equal(success.status, 200)
    assert.deepEqual(await success.json(), { state: 'active' })
  })
})

test('recovery keeps its JSON contact contract independent from activation fields', async () => {
  await withRoutes(async baseUrl => {
    const challenge = await fetch(`${baseUrl}/recover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'email', contact: 'guide@example.test' }) })
    assert.equal(challenge.status, 403)
    const success = await fetch(`${baseUrl}/recover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'email', contact: 'guide@example.test', turnstileToken: fixtureToken, email: 'not-an-email', telephone: 'invalid' }) })
    assert.equal(success.status, 202)
    assert.match((await success.json() as { message: string }).message, /Pokud pro tento kontakt/)
  })
})

test('development fixture projects many collapsed-management communities and scopes row mutations', async () => {
  await withRoutes(async baseUrl => {
    const active = await fetch(`${baseUrl}/manage/notification-ui-management-active`)
    const result = await active.json() as { state: string, channel: string, maskedContact: string, communities: Array<{ slug: string, title: string, frequencies: string[] }> }
    assert.equal(result.state, 'active')
    assert.equal(result.channel, 'email')
    assert.equal(result.maskedContact, 'u•••@example.test')
    assert.equal(result.communities.length, 6)
    assert.match(result.communities[0]!.title, /mimořádně dlouhým/)
    assert.deepEqual(result.communities[0]!.frequencies, ['created', 'week-before'])
    assert.deepEqual(result.communities[5]!.frequencies, ['day-before'])

    const saved = await fetch(`${baseUrl}/manage/notification-ui-management-active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'update-frequencies', communitySlug: 'brno', frequencies: ['day-before'] }),
    })
    const savedResult = await saved.json() as typeof result
    assert.deepEqual(savedResult.communities.find(community => community.slug === 'brno')?.frequencies, ['day-before'])
    assert.deepEqual(savedResult.communities.find(community => community.slug === 'praha')?.frequencies, ['created', 'day-before'])

    const removed = await fetch(`${baseUrl}/manage/notification-ui-management-active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove-community', communitySlug: 'praha' }),
    })
    const removedResult = await removed.json() as typeof result
    assert.equal(removedResult.communities.some(community => community.slug === 'praha'), false)
    assert.deepEqual(removedResult.communities.find(community => community.slug === 'brno')?.frequencies, ['created', 'week-before'])

    const stopped = await fetch(`${baseUrl}/manage/notification-ui-management-active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop-channel' }),
    })
    assert.deepEqual(await stopped.json(), { state: 'unavailable' })
  })
})

test('development fixture keeps pending scope read-only and neutralizes terminal or unknown links', async () => {
  await withRoutes(async baseUrl => {
    const pending = await fetch(`${baseUrl}/manage/notification-ui-management-pending-reactivation`)
    assert.deepEqual(await pending.json(), {
      state: 'pending-reactivation',
      channel: 'sms',
      maskedContact: '+1555 ••• ••••',
      communities: [{
        slug: 'brno',
        title: 'Brno s mimořádně dlouhým názvem pro ověření zalamování',
        frequencies: ['created'],
      }],
    })
    for (const token of ['notification-ui-management-stopped', 'notification-ui-management-old', 'notification-ui-management-unavailable', 'notification-ui-management-unknown-token']) {
      const response = await fetch(`${baseUrl}/manage/${token}`)
      assert.deepEqual(await response.json(), { state: 'unavailable' })
    }
  })
})

test('reserved management tokens are inert when the development fixture guard is absent', async () => {
  process.env.NODE_ENV = 'production'
  runtimeConfig = { notificationUiVerificationFixture: true }
  try {
    await withRoutes(async baseUrl => {
      const response = await fetch(`${baseUrl}/manage/notification-ui-management-active`)
      assert.deepEqual(await response.json(), { state: 'unavailable' })
    })
  } finally {
    process.env.NODE_ENV = 'development'
    runtimeConfig = { notificationUiVerificationFixture: true }
  }
})
