import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp, createRouter, eventHandler, toNodeListener } from 'h3'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import type { NotificationDatabase, NotificationStatement } from '../server/utils/notifications.ts'

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

const withRoutes = async (run: (baseUrl: string) => Promise<void>, database?: NotificationDatabase) => {
  const app = createApp()
  app.use('/activate', eventHandler(event => {
    event.context._platform = { cloudflare: { env: { DB: database } } }
    return activate(event)
  }))
  app.use('/recover', eventHandler(event => {
    event.context._platform = { cloudflare: { env: { DB: database } } }
    return recover(event)
  }))
  const management = createRouter()
  management.get('/manage/:token', eventHandler(event => {
    event.context._platform = { cloudflare: { env: { DB: database } } }
    return manageGet(event)
  }))
  management.post('/manage/:token', eventHandler(event => {
    event.context._platform = { cloudflare: { env: { DB: database } } }
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

test('native push HTTP activation, challenge retry, pending reactivation and device-only recovery use applied D1', async t => {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => { close(): void, exec(sql: string): void, prepare(sql: string): { all(...values: unknown[]): Record<string, unknown>[], get(...values: unknown[]): unknown, run(...values: unknown[]): unknown }, transaction<T>(operation: () => T): () => T }
  const sqlite = new Database(':memory:')
  t.after(() => sqlite.close())
  sqlite.exec(readFileSync(new URL('../server/db/migrations/sqlite/0000_majestic_lightspeed.sql', import.meta.url), 'utf8'))
  sqlite.exec('PRAGMA foreign_keys = ON')
  const executions = new WeakMap<NotificationStatement, () => unknown>()
  const database: NotificationDatabase = { prepare(sql) {
    let values: unknown[] = []
    const statement: NotificationStatement = { bind(...next) { values = next; return statement }, first: async <T>() => sqlite.prepare(sql).get(...values) as T ?? null, all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }), run: async () => sqlite.prepare(sql).run(...values) }
    executions.set(statement, () => sqlite.prepare(sql).run(...values))
    return statement
  }, batch: async statements => sqlite.transaction(() => statements.map(statement => executions.get(statement)!()))() }
  const previousRuntime = runtimeConfig
  t.after(() => { runtimeConfig = previousRuntime })
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const contact = { endpoint: 'https://push.example.test/device', expirationTime: null, keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey)).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } }
  runtimeConfig = { notificationRootKey: Buffer.alloc(32, 4).toString('base64url'), notificationCommunitySlugs: 'brno', notificationConsentVersion: '2026-09', notificationTurnstileSecret: 'synthetic-turnstile', notificationTurnstileExpectedHostname: 'example.test',
    notificationWebPushEnabled: true, notificationWebPushFirstMessageReady: true, notificationWebPushEventDeliveryReady: true,
    notificationVapidPrivateKey: (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d, public: { notificationVapidPublicKey: Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url') }, notificationVapidSubject: 'mailto:test@example.test',
    notificationExpectedTargetIdentity: '1'.repeat(64), notificationExpectedBundleHash: '2'.repeat(64), notificationExpectedMigrationHash: '3'.repeat(64), notificationExpectedConfigHash: '4'.repeat(64), notificationExpectedDeploymentId: '11111111-1111-1111-1111-111111111111' }
  const now = Date.now()
  runtimeConfig.notificationWebPushEvidence = JSON.stringify({ channel: 'web-push', evidenceKind: 'production-observation', mode: 'readiness', manualSwitch: true, targetIdentity: runtimeConfig.notificationExpectedTargetIdentity, bundleHash: runtimeConfig.notificationExpectedBundleHash, migrationHash: runtimeConfig.notificationExpectedMigrationHash, configHash: runtimeConfig.notificationExpectedConfigHash, deploymentId: runtimeConfig.notificationExpectedDeploymentId, verifiedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), interoperability: ['chromium'],
    keyHash: createHash('sha256').update(JSON.stringify([runtimeConfig.notificationRootKey, runtimeConfig.notificationVapidPrivateKey, (runtimeConfig.public as Record<string, unknown>).notificationVapidPublicKey, runtimeConfig.notificationVapidSubject])).digest('hex'), gates: Object.fromEntries(['artifacts', 'deployment', 'bindings', 'migration', 'vapid', 'protocol', 'interoperability', 'browser:chromium', 'sharedManagementStop', 'liveCanary', 'firstMessage', 'eventDelivery'].map(gate => [gate, 'passed'])) })
  const config = await notificationConfig(runtimeConfig)
  const ip = '192.0.2.7'
  const requesterHash = Buffer.from(await crypto.subtle.sign('HMAC', config.abuseHashKey, new TextEncoder().encode(ip))).toString('base64url')
  for (let i = 0; i < 5; i++) sqlite.prepare('INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES (?, ?, ?)').run(requesterHash, new Date(now - (i + 2) * 60_000).toISOString(), new Date(now + 86_400_000).toISOString())
  const originalFetch = globalThis.fetch
  let challengeCalls = 0
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      challengeCalls++
      assert.equal((init?.body as URLSearchParams).get('response'), 'synthetic-body-token')
      return new Response(JSON.stringify({ success: true, hostname: 'example.test', action: 'notification-operation' }), { status: 200 })
    }
    return originalFetch(url, init)
  }
  try {
    await withRoutes(async base => {
      const post = (path: string, body: unknown, address = ip) => originalFetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': address }, body: JSON.stringify(body) })
      const body = { ...activation, channel: 'web-push', contact }
      // Even otherwise-current synthetic evidence cannot authorize the old D1 schema.
      const oldSchema = await post('activate', body, '198.51.100.7')
      assert.equal(oldSchema.status, 503)
      assert.deepEqual(sqlite.prepare('SELECT id FROM notification_contacts').all(), [])
      assert.deepEqual(sqlite.prepare('SELECT id FROM notification_outbox').all(), [])
      for (const name of ['0001_phase_7_columns', '0002_phase_7_constraints']) sqlite.exec(readFileSync(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8'))
      sqlite.exec('PRAGMA foreign_keys = ON')
      assert.equal((await post('activate', body)).status, 403)
      assert.deepEqual(sqlite.prepare('SELECT id FROM notification_contacts').all(), [])
      sqlite.prepare('UPDATE notification_abuse_attempts SET attempted_at = ?').run(new Date(now - 120_000).toISOString())
      const active = await post('activate', { ...body, turnstileToken: 'synthetic-body-token' })
      assert.equal(active.status, 200)
      assert.deepEqual(await active.json(), { state: 'active' })
      assert.equal(challengeCalls, 1)
      assert.equal((await post('activate', body)).status, 429)
      const [before] = sqlite.prepare('SELECT id, capability_generation, management_token_digest, destination FROM notification_contacts').all()
      assert.equal(JSON.parse(before!.destination as string).expirationTime, undefined, 'native metadata is not part of device identity')
      assert.equal((await post('activate', body, '192.0.2.8')).status, 200)
      const recovery = await post('recover', { channel: 'web-push', contact }, '192.0.2.9')
      assert.equal(recovery.status, 202)
      const text = await recovery.text()
      assert.ok(!text.includes(contact.endpoint))
      assert.equal(sqlite.prepare('SELECT capability_generation FROM notification_contacts').all()[0]!.capability_generation, 2)
      const absent = await post('recover', { channel: 'web-push', contact: { ...contact, endpoint: 'https://push.example.test/absent' } }, '192.0.2.10')
      assert.equal(await absent.text(), text)
      const [outbox] = sqlite.prepare("SELECT payload_ciphertext, payload_iv FROM notification_outbox WHERE status = 'pending'").all()
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(outbox!.payload_iv as string, 'base64url') }, config.outboxTransportKey, Buffer.from(outbox!.payload_ciphertext as string, 'base64url'))
      const token = JSON.parse(new TextDecoder().decode(plaintext)).capability
      const stopped = await post(`manage/${token}`, { action: 'stop-channel' }, '192.0.2.11')
      assert.equal(stopped.status, 200)
      const pending = await post('activate', body, '192.0.2.12')
      assert.equal(pending.status, 200)
      assert.deepEqual(await pending.json(), { state: 'pending-reactivation' })
      assert.deepEqual(sqlite.prepare('SELECT channel, reason FROM notification_suppressions').all(), [{ channel: 'web-push', reason: 'user-stop' }])
    }, database)
  } finally { runtimeConfig = previousRuntime; globalThis.fetch = originalFetch }
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

test('production fixture opt-in cannot activate SMS or native push and keeps recovery private', async () => {
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const contact = { endpoint: 'https://push.example.test/private-device', expirationTime: null, keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey)).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } }
  const previous = runtimeConfig
  process.env.NODE_ENV = 'production'
  runtimeConfig = { notificationUiVerificationFixture: true }
  try {
    await withRoutes(async base => {
      for (const [channel, destination] of [['sms', '+420777123456'], ['web-push', contact]]) {
        const post = (path: string, body: unknown) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        assert.equal((await post('activate', { ...activation, channel, contact: destination, turnstileToken: fixtureToken })).status, 503)
        const bodies: string[] = []
        for (const token of [undefined, fixtureToken]) {
          const response = await post('recover', { channel, contact: destination, turnstileToken: token })
          assert.equal(response.status, 202)
          const text = await response.text()
          assert.ok(!text.includes('+420777123456') && !text.includes(contact.endpoint) && !text.includes(contact.keys.auth))
          bodies.push(text)
        }
        assert.equal(bodies[0], bodies[1])
      }
      for (const token of ['malformed', 'A'.repeat(43)]) {
        assert.deepEqual(await (await fetch(`${base}/manage/${token}`)).json(), { state: 'unavailable' })
      }
    })
  } finally { runtimeConfig = previous; process.env.NODE_ENV = 'development' }
})
