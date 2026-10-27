import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp, createRouter, eventHandler, toNodeListener, type H3Event } from 'h3'
import type {} from 'nitropack'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { activateNotificationChannel, requestNotificationManagementRecovery, stopNotificationChannel, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'
import type { NotificationMessagesQueue } from '../server/utils/notificationMessagesQueue.ts'

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

// Applied migrations and SQLite transactions retain real D1 statement change counts.
const managementDatabase = () => {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => {
    close(): void, exec(sql: string): void,
    prepare(sql: string): { all(...values: unknown[]): Record<string, unknown>[], get(...values: unknown[]): unknown, run(...values: unknown[]): { changes: number } },
    transaction<T>(operation: () => T): () => T,
  }
  const sqlite = new Database(':memory:')
  for (const name of ['0000_majestic_lightspeed', '0001_phase_7_columns', '0002_detach_event_callback_fk', '0003_restore_event_ledger_checks', '0004_restore_event_callback_fk', '0005_lifecycle_email_columns', '0006_lifecycle_email_constraints']) sqlite.exec(readFileSync(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8'))
  sqlite.exec('PRAGMA foreign_keys = ON')
  const executions = new WeakMap<NotificationStatement, () => { changes: number }>()
  let rejectBatch = false
  const database: NotificationDatabase = {
    prepare(sql) {
      let values: unknown[] = []
      const statement: NotificationStatement = {
        bind(...next) { values = next; return statement },
        first: async <T>() => sqlite.prepare(sql).get(...values) as T ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
        run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...values).changes } }),
      }
      executions.set(statement, () => sqlite.prepare(sql).run(...values))
      return statement
    },
    batch: async statements => sqlite.transaction(() => statements.map((statement, index) => {
      // Reject the last statement after earlier writes have actually executed.
      if (rejectBatch && index === statements.length - 1) throw new Error('synthetic-private-storage-detail')
      return { meta: { changes: executions.get(statement)!().changes } }
    }))(),
  }
  const snapshot = () => ['notification_contacts', 'notification_subscriptions', 'notification_suppressions', 'notification_outbox', 'notification_management_capabilities'].map(table => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  return { database, snapshot, close: () => sqlite.close(), reject: () => { rejectBatch = true } }
}

const managementRuntime = {
  notificationRootKey: Buffer.alloc(32, 4).toString('base64url'), notificationCommunitySlugs: 'brno,praha', notificationConsentVersion: '2026-09',
  notificationTurnstileSecret: 'synthetic-turnstile', notificationTurnstileExpectedHostname: 'example.test',
  notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
}
const managementToken = Buffer.alloc(32, 1).toString('base64url')
const readyEmailRuntime = () => {
  const value = { ...managementRuntime, brevoApiKey: 'synthetic-api-key'.repeat(3), brevoCallbackSecret: 'synthetic-callback-secret'.repeat(2), brevoSenderName: 'Jednadvacet', brevoSenderEmail: 'noreply@jednadvacet.org', notificationEmailManualEnabled: true,
    notificationExpectedTargetIdentity: '1'.repeat(64), notificationExpectedBundleHash: '2'.repeat(64), notificationExpectedMigrationHash: '3'.repeat(64), notificationExpectedConfigHash: '4'.repeat(64), notificationExpectedDeploymentId: '11111111-1111-1111-1111-111111111111' }
  return { ...value, notificationEmailEvidence: JSON.stringify({ channel: 'email', evidenceKind: 'production-observation', mode: 'readiness', manualSwitch: true,
    targetIdentity: value.notificationExpectedTargetIdentity, bundleHash: value.notificationExpectedBundleHash, migrationHash: value.notificationExpectedMigrationHash, configHash: value.notificationExpectedConfigHash, deploymentId: value.notificationExpectedDeploymentId,
    verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
    keyHash: createHash('sha256').update(JSON.stringify([value.notificationRootKey, value.brevoApiKey, value.brevoCallbackSecret, value.brevoSenderName, value.brevoSenderEmail])).digest('hex'),
    gates: Object.fromEntries(['artifacts', 'deployment', 'bindings', 'migration', 'sender', 'dns', 'callbackMetadata', 'https', 'sandbox', 'callback', 'liveCanary', 'humanInbox', 'humanCalendar', 'humanLink', 'humanLogs', 'firstMessage', 'eventDelivery'].map(gate => [gate, 'passed'])),
  }) }
}
const managementCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(1), subtle: crypto.subtle }
const managementActions = [
  { action: 'stop-channel' },
  { action: 'update-frequencies', communitySlug: 'brno', frequencies: ['week-before'] },
  { action: 'remove-community', communitySlug: 'brno' },
  { action: 'confirm-reactivation' },
] as const

const seedManagement = async (database: NotificationDatabase, pending = false) => {
  const config = { ...await notificationConfig(managementRuntime), emailDeliveryReady: true }
  const dependencies = { database, config, crypto: managementCrypto }
  await activateNotificationChannel({ ...activation, contact: 'Alice@example.com', communitySlugs: ['brno', 'praha'], frequencies: ['created', 'day-before'] }, dependencies)
  if (pending) {
    await stopNotificationChannel(managementToken, dependencies)
    await activateNotificationChannel({ ...activation, contact: 'Alice@example.com', communitySlugs: ['brno', 'praha'], frequencies: ['created', 'day-before'] }, { ...dependencies, crypto: { ...managementCrypto, randomBytes: length => new Uint8Array(length).fill(2) } })
  }
  return { ...dependencies, token: pending ? Buffer.alloc(32, 2).toString('base64url') : managementToken }
}

const withRoutes = async (run: (baseUrl: string) => Promise<void>, database?: NotificationDatabase, publication?: { queue?: NotificationMessagesQueue, promises: Promise<unknown>[], events?: H3Event[], register?: boolean, rejectRegistration?: boolean }) => {
  const app = createApp()
  const boundary = (event: H3Event) => {
    event.context._platform = { cloudflare: { env: { DB: database, NOTIFICATION_MESSAGES_QUEUE: publication?.queue } } }
    if (publication && publication.register !== false) {
      publication.events?.push(event)
      event.context.nitro = { errors: [] }
      event.context.waitUntil = (promise: Promise<unknown>) => {
        if (publication.rejectRegistration) throw Error('private execution-context detail')
        publication.promises.push(promise)
      }
      // Actual H3 event, with Nitro's installed registration/forwarding semantics.
      event.waitUntil = promise => {
        (event.context.nitro._waitUntilPromises ??= []).push(promise)
        event.context.waitUntil(promise)
      }
    }
  }
  app.use('/activate', eventHandler(event => {
    boundary(event)
    return activate(event)
  }))
  app.use('/recover', eventHandler(event => {
    boundary(event)
    return recover(event)
  }))
  const management = createRouter()
  management.get('/manage/:token', eventHandler(event => {
    boundary(event)
    return manageGet(event)
  }))
  management.post('/manage/:token', eventHandler(event => {
    boundary(event)
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
    if (publication) await Promise.all(publication.promises)
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
  }, batch: async statements => sqlite.transaction(() => statements.map(statement => {
    const result = executions.get(statement)!() as { changes?: number }
    return { meta: { changes: result.changes ?? 0 } }
  }))() }
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
      for (const name of ['0001_phase_7_columns', '0002_detach_event_callback_fk', '0003_restore_event_ledger_checks', '0004_restore_event_callback_fk', '0005_lifecycle_email_columns', '0006_lifecycle_email_constraints']) sqlite.exec(readFileSync(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8'))
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

for (const channel of ['email', 'sms'] as const) {
  test(`real H3 ${channel} recovery validates supplied tokens for new and changing requesters`, async t => {
    const storage = managementDatabase()
    t.after(storage.close)
    const previous = runtimeConfig
    runtimeConfig = managementRuntime
    t.after(() => { runtimeConfig = previous })
    const originalFetch = globalThis.fetch
    const consumed = new Set<string>()
    let calls = 0
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return originalFetch(url, init)
      calls++
      const body = init?.body as URLSearchParams
      assert.equal(body.get('secret'), 'synthetic-turnstile')
      const token = body.get('response')!
      if (token === 'network-failure') throw new Error('synthetic private network detail')
      if (token === 'invalid-json') return new Response('not JSON')
      const success = !['invalid', 'expired'].includes(token) && !consumed.has(token)
      if (success) consumed.add(token)
      return new Response(JSON.stringify({
        success,
        action: token === 'wrong-action' ? 'other-operation' : 'notification-operation',
        hostname: token === 'wrong-hostname' ? 'other.example.test' : 'example.test',
      }), { status: token === 'http-error' ? 503 : 200 })
    }
    t.after(() => { globalThis.fetch = originalFetch })
    await withRoutes(async base => {
      const post = (token: unknown, ip: string) => originalFetch(`${base}/recover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ channel, contact: channel === 'email' ? 'absent@example.test' : '+420777123456', ...(token === undefined ? {} : { turnstileToken: token }) }),
      })
      const before = storage.snapshot()
      assert.equal((await post(undefined, '192.0.2.30')).status, 202, 'a token-free first attempt remains allowed')
      assert.equal(calls, 0)
      assert.equal((await post('rate-limited-token', '192.0.2.30')).status, 429)
      assert.equal(calls, 0, 'the minute gate still runs before Siteverify')

      let address = 31
      for (const token of ['invalid', 'expired', 'wrong-action', 'wrong-hostname', 'network-failure', 'invalid-json', 'http-error']) {
        const previousCalls = calls
        assert.equal((await post(token, `192.0.2.${address++}`)).status, 403, `first-attempt ${token} must be rejected`)
        assert.equal(calls, previousCalls + 1)
      }
      const callsBeforeMalformed = calls
      for (const token of ['', null, false, 42, {}, []]) {
        assert.equal((await post(token, `192.0.2.${address++}`)).status, 403)
      }
      assert.equal(calls, callsBeforeMalformed, 'malformed tokens never reach the provider')

      assert.equal((await post('single-use', '192.0.2.100')).status, 202)
      assert.equal((await post('single-use', '192.0.2.101')).status, 403, 'a different first-time requester cannot reuse a token')
      assert.equal(calls, callsBeforeMalformed + 2)
      assert.deepEqual(storage.snapshot(), before, 'absent-contact probes never create lifecycle or outbox state')
    }, storage.database)
  })

  test(`real H3 ${channel} recovery rejects invalid widget tokens and keeps sixth-attempt/minute policy`, async t => {
    const storage = managementDatabase()
    t.after(storage.close)
    const previous = runtimeConfig
    runtimeConfig = managementRuntime
    t.after(() => { runtimeConfig = previous })
    const config = await notificationConfig(runtimeConfig)
    const ip = channel === 'email' ? '192.0.2.18' : '192.0.2.19'
    const now = Date.now()
    const hash = Buffer.from(await crypto.subtle.sign('HMAC', config.abuseHashKey, new TextEncoder().encode(ip))).toString('base64url')
    for (let i = 0; i < 5; i++) await storage.database.prepare('INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES (?, ?, ?)').bind(hash, new Date(now - (i + 2) * 60_000).toISOString(), new Date(now + 86_400_000).toISOString()).run()
    const originalFetch = globalThis.fetch
    let calls = 0
    const consumed = new Set<string>()
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') return originalFetch(url, init)
      calls++
      assert.equal(init?.method, 'POST')
      const body = init?.body as URLSearchParams
      assert.equal(body.get('remoteip'), ip)
      assert.equal(body.get('secret'), 'synthetic-turnstile')
      const token = body.get('response')!
      const success = !['invalid', 'expired'].includes(token) && !consumed.has(token)
      if (success) consumed.add(token)
      return new Response(JSON.stringify({ success, hostname: token === 'wrong-hostname' ? 'other.example.test' : 'example.test', action: token === 'wrong-action' ? 'other-operation' : 'notification-operation', ...(!success ? { 'error-codes': ['timeout-or-duplicate'] } : {}) }))
    }
    t.after(() => { globalThis.fetch = originalFetch })
    await withRoutes(async base => {
      const post = (token?: string, headerToken?: string) => originalFetch(`${base}/recover`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, ...(headerToken ? { 'CF-Turnstile-Response': headerToken } : {}) }, body: JSON.stringify({ channel, contact: channel === 'email' ? 'absent@example.test' : '+420777123456', ...(token ? { turnstileToken: token } : {}) }) })
      const advance = () => storage.database.prepare('UPDATE notification_abuse_attempts SET attempted_at = ? WHERE requester_hash = ?').bind(new Date(now - 120_000).toISOString(), hash).run()
      const before = storage.snapshot()
      // Attempt six: a header token is never authority and does not reach Siteverify.
      assert.equal((await post(undefined, 'valid')).status, 403)
      assert.equal(calls, 0)
      for (const token of ['invalid', 'wrong-action', 'wrong-hostname', 'expired']) {
        await advance()
        assert.equal((await post(token)).status, 403)
        assert.deepEqual(storage.snapshot(), before)
      }
      await advance()
      const accepted = await post('single-use')
      assert.equal(accepted.status, 202)
      const generic = await accepted.text()
      assert.ok(generic.includes('Pokud pro tento kontakt'))
      const callsBeforeRateLimit = calls
      assert.equal((await post('new-token')).status, 429)
      assert.equal(calls, callsBeforeRateLimit, 'a token does not bypass the minute limit')
      await advance()
      assert.equal((await post('single-use')).status, 403, 'Siteverify duplicate rejection is enforced')
      assert.deepEqual(storage.snapshot(), before)
      assert.equal(calls, 6)
    }, storage.database)
  })
}

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
    const savedResult = (await saved.json() as { outcome: string, management: typeof result }).management
    assert.deepEqual(savedResult.communities.find(community => community.slug === 'brno')?.frequencies, ['day-before'])
    assert.deepEqual(savedResult.communities.find(community => community.slug === 'praha')?.frequencies, ['created', 'day-before'])

    const removed = await fetch(`${baseUrl}/manage/notification-ui-management-active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'remove-community', communitySlug: 'praha' }),
    })
    const removedResult = (await removed.json() as { outcome: string, management: typeof result }).management
    assert.equal(removedResult.communities.some(community => community.slug === 'praha'), false)
    assert.deepEqual(removedResult.communities.find(community => community.slug === 'brno')?.frequencies, ['created', 'week-before'])

    const stopped = await fetch(`${baseUrl}/manage/notification-ui-management-active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop-channel' }),
    })
    assert.deepEqual(await stopped.json(), { outcome: 'stopped' })
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

test('management POST reports missing D1 as a sanitized infrastructure failure', async () => {
  const token = 'A'.repeat(32)
  await withRoutes(async baseUrl => {
    const response = await fetch(`${baseUrl}/manage/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop-channel' }),
    })
    assert.equal(response.status, 503)
    assert.equal((await response.text()).includes('DB'), false)
  })
})

for (const body of managementActions) {
  test(`real management ${body.action} loses its own pre-read authority to recovery`, async t => {
    const storage = managementDatabase()
    t.after(storage.close)
    const previous = runtimeConfig
    runtimeConfig = managementRuntime
    t.after(() => { runtimeConfig = previous })
    const dependencies = await seedManagement(storage.database, body.action === 'confirm-reactivation')
    let entered!: () => void
    let release!: () => void
    const batchEntered = new Promise<void>(resolve => { entered = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    let paused = false
    const database: NotificationDatabase = { ...storage.database, batch: async statements => {
      if (!paused) { paused = true; entered(); await resume }
      return storage.database.batch(statements)
    } }
    await withRoutes(async base => {
      const pending = fetch(`${base}/manage/${dependencies.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      await batchEntered
      try {
        await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database: storage.database, config: dependencies.config })
        const before = storage.snapshot()
        release()
        const response = await pending
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { outcome: 'unavailable' })
        assert.deepEqual(storage.snapshot(), before)
      } finally { release(); await pending }
    }, database)
  })

  test(`real management ${body.action} rejected atomic batch returns sanitized 503 and rolls back`, async t => {
    const storage = managementDatabase()
    t.after(storage.close)
    const previous = runtimeConfig
    runtimeConfig = managementRuntime
    t.after(() => { runtimeConfig = previous })
    const { token } = await seedManagement(storage.database, body.action === 'confirm-reactivation')
    const before = storage.snapshot()
    storage.reject()
    await withRoutes(async base => {
      const response = await fetch(`${base}/manage/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 503)
      const result = await response.json() as Record<string, unknown>
      assert.equal(result.statusMessage, 'Notification management is unavailable')
      assert.equal(JSON.stringify(result).includes('synthetic-private-storage-detail'), false)
      assert.equal('outcome' in result, false)
      assert.deepEqual(storage.snapshot(), before)
    }, storage.database)
  })

  test(`real management ${body.action} stale after recovery returns only unavailable`, async t => {
    const storage = managementDatabase()
    t.after(storage.close)
    const previous = runtimeConfig
    runtimeConfig = managementRuntime
    t.after(() => { runtimeConfig = previous })
    const dependencies = await seedManagement(storage.database, body.action === 'confirm-reactivation')
    await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database: storage.database, config: dependencies.config })
    const before = storage.snapshot()
    await withRoutes(async base => {
      const response = await fetch(`${base}/manage/${dependencies.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { outcome: 'unavailable' })
      assert.deepEqual(await (await fetch(`${base}/manage/${dependencies.token}`)).json(), { state: 'unavailable' })
      assert.deepEqual(storage.snapshot(), before)
    }, storage.database)
  })
}

for (const count of [1, 2, 3]) {
  test(`real management commits save, ${count}-frequency removal and final removal with exact outcomes`, async t => {
    const storage = managementDatabase()
    t.after(storage.close)
    const previous = runtimeConfig
    runtimeConfig = managementRuntime
    t.after(() => { runtimeConfig = previous })
    await seedManagement(storage.database)
    const selected = ['created', 'day-before', 'week-before'].slice(0, count)
    const projection = (communities: unknown[]) => ({ state: 'active', channel: 'email', maskedContact: 'A•••@example.com', communities })
    const brno = { slug: 'brno', title: 'brno', frequencies: selected }
    const praha = { slug: 'praha', title: 'praha', frequencies: ['created', 'day-before'] }
    await withRoutes(async base => {
      const post = async (body: unknown) => {
        const response = await fetch(`${base}/manage/${managementToken}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        assert.equal(response.status, 200)
        return response.json()
      }
      assert.deepEqual(await post({ action: 'update-frequencies', communitySlug: 'brno', frequencies: selected }), { outcome: 'saved', management: projection([brno, praha]) })
      assert.deepEqual(await post({ action: 'remove-community', communitySlug: 'brno' }), { outcome: 'removed', management: projection([praha]) })
      const afterRemoval = storage.snapshot()
      assert.deepEqual(await post({ action: 'remove-community', communitySlug: 'brno' }), { outcome: 'unavailable' })
      assert.deepEqual(storage.snapshot(), afterRemoval)
      assert.deepEqual(await post({ action: 'remove-community', communitySlug: 'praha' }), { outcome: 'stopped' })
      const [contacts, subscriptions, suppressions, outbox] = storage.snapshot()
      assert.deepEqual(contacts, [])
      assert.deepEqual(subscriptions, [])
      assert.equal(suppressions!.length, 1)
      assert.equal(suppressions![0]!.reason, 'user-stop')
      assert.ok(outbox!.every(row => row.status === 'invalidated' && row.payload_ciphertext === null && row.payload_iv === null))
    }, storage.database)
  })
}

test('real management confirmation and explicit stop return their committed discriminants and projections', async t => {
  const storage = managementDatabase()
  t.after(storage.close)
  const previous = runtimeConfig
  runtimeConfig = managementRuntime
  t.after(() => { runtimeConfig = previous })
  const { token } = await seedManagement(storage.database, true)
  await withRoutes(async base => {
    const post = (action: string) => fetch(`${base}/manage/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
    const confirmed = await post('confirm-reactivation')
    assert.equal(confirmed.status, 200)
    assert.deepEqual(await confirmed.json(), {
      outcome: 'reactivated', management: { state: 'active', channel: 'email', maskedContact: 'A•••@example.com', communities: ['brno', 'praha'].map(slug => ({ slug, title: slug, frequencies: ['created', 'day-before'] })) },
    })
    assert.deepEqual(storage.snapshot()[2], [])
    const stopped = await post('stop-channel')
    assert.equal(stopped.status, 200)
    assert.deepEqual(await stopped.json(), { outcome: 'stopped' })
    assert.deepEqual(storage.snapshot()[0], [])
    assert.deepEqual(storage.snapshot()[1], [])
  }, storage.database)
})

test('authoritative real H3 confirmation registers retained pending work after CAS commit and responds before Queue completion', async t => {
  const storage = managementDatabase()
  t.after(storage.close)
  const previous = runtimeConfig
  runtimeConfig = managementRuntime
  t.after(() => { runtimeConfig = previous })
  const { token } = await seedManagement(storage.database, true)
  const before = storage.snapshot()[3]!
  const pending = before.filter(row => row.status === 'pending')
  assert.equal(pending.length, 1)
  const promises: Promise<unknown>[] = []
  const events: H3Event[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const sent: unknown[] = []
  await withRoutes(async base => {
    try {
      const response = await fetch(`${base}/manage/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm-reactivation' }), signal: AbortSignal.timeout(3000) })
      assert.equal(response.status, 200)
      assert.equal((await response.json() as { outcome: string }).outcome, 'reactivated')
      assert.equal(promises.length, 1)
      assert.equal(events[0]!.context.nitro._waitUntilPromises![0], promises[0], 'exact promise is forwarded to execution-context registration')
      assert.equal(storage.snapshot()[0]![0]!.state, 'active')
      assert.deepEqual(storage.snapshot()[2], [])
      release()
      await promises[0]
      assert.deepEqual(sent, [{ outboxId: pending[0]!.id, version: pending[0]!.version }])
      assert.equal(storage.snapshot()[3]!.length, before.length, 'confirmation creates no duplicate lifecycle row')
      assert.equal(storage.snapshot()[3]!.find(row => row.id === pending[0]!.id)!.status, 'queued')
    } finally { release() }
  }, storage.database, { promises, events, queue: { send: async pointer => {
    assert.equal(storage.snapshot()[0]![0]!.state, 'active', 'send begins only after authoritative commit')
    sent.push(pointer)
    await held
  } } })
})

test('real confirmation failure, stale bearer, CAS loss and active projection register no success wake', async t => {
  for (const scenario of ['failed-batch', 'stale', 'cas-loss', 'already-active'] as const) await t.test(scenario, async () => {
    const storage = managementDatabase()
    const previous = runtimeConfig
    runtimeConfig = managementRuntime
    try {
      const dependencies = await seedManagement(storage.database, scenario !== 'already-active')
      if (scenario === 'stale') await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { ...dependencies, crypto: undefined })
      if (scenario === 'failed-batch') storage.reject()
      let raced = false
      const database: NotificationDatabase = scenario !== 'cas-loss' ? storage.database : { ...storage.database, batch: async statements => {
        if (!raced) { raced = true; await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { ...dependencies, crypto: undefined }) }
        return storage.database.batch(statements)
      } }
      const promises: Promise<unknown>[] = []
      let sends = 0
      await withRoutes(async base => {
        const response = await fetch(`${base}/manage/${dependencies.token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm-reactivation' }) })
        assert.equal(response.status, scenario === 'failed-batch' ? 503 : 200)
        if (scenario !== 'failed-batch') assert.deepEqual(await response.json(), { outcome: 'unavailable' })
        assert.equal(promises.length, 0)
        assert.equal(sends, 0)
        assert.equal(raced, scenario === 'cas-loss')
      }, database, { promises, queue: { send: async () => { sends++ } } })
    } finally { runtimeConfig = previous; storage.close() }
  })
})

test('activation wakes only real committed outcomes including updated and pending reactivation, never failed batch', async t => {
  const previous = runtimeConfig
  runtimeConfig = readyEmailRuntime()
  t.after(() => { runtimeConfig = previous })
  for (const scenario of ['active', 'updated', 'pending-reactivation', 'failed-batch', 'cas-loss'] as const) await t.test(scenario, async () => {
    const storage = managementDatabase()
    try {
      const dependencies = await seedManagement(storage.database, scenario === 'pending-reactivation')
      if (scenario === 'active') await stopNotificationChannel(dependencies.token, dependencies)
      // Fresh activation is demonstrated with a distinct unsuppressed identity.
      const contact = scenario === 'active' ? 'new@example.test' : 'Alice@example.com'
      let batches = 0
      const database: NotificationDatabase = scenario !== 'failed-batch' && scenario !== 'cas-loss' ? storage.database : { ...storage.database, batch: async statements => {
        if (++batches === 2) {
          if (scenario === 'failed-batch') storage.reject()
          else await requestNotificationManagementRecovery({ channel: 'email', contact }, { ...dependencies, crypto: undefined })
        }
        return storage.database.batch(statements)
      } }
      const promises: Promise<unknown>[] = []
      const sent: unknown[] = []
      await withRoutes(async base => {
        const response = await fetch(`${base}/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.60' }, body: JSON.stringify({ ...activation, contact }) })
        const failed = scenario === 'failed-batch' || scenario === 'cas-loss'
        assert.equal(response.status, scenario === 'failed-batch' ? 503 : scenario === 'cas-loss' ? 409 : 200)
        if (!failed) assert.deepEqual(await response.json(), { state: scenario })
        assert.equal(promises.length, failed ? 0 : 1)
        await Promise.all(promises)
        if (!failed) assert.ok(sent.length >= 1)
        else assert.equal(sent.length, 0)
      }, database, { promises, queue: { send: async pointer => { assert.ok(storage.snapshot()[3]!.some(row => row.id === pointer.outboxId)); sent.push(pointer) } } })
    } finally { storage.close() }
  })
})

test('allowed real recovery registers identical generic wake for eligible, absent and failed storage; Queue failures expose no existence', async t => {
  const previous = runtimeConfig
  runtimeConfig = readyEmailRuntime()
  t.after(() => { runtimeConfig = previous })
  const logs: unknown[][] = []
  const error = console.error
  console.error = (...values: unknown[]) => { logs.push(values) }
  t.after(() => { console.error = error })
  const bodies: string[] = []
  for (const scenario of ['eligible', 'absent', 'missing-queue', 'failed-publication', 'failed-recovery'] as const) await t.test(scenario, async () => {
    const storage = managementDatabase()
    try {
      await seedManagement(storage.database)
      let batches = 0
      const database: NotificationDatabase = scenario !== 'failed-recovery' ? storage.database : { ...storage.database, batch: async statements => {
        if (++batches === 2) { storage.reject() }
        return storage.database.batch(statements)
      } }
      const promises: Promise<unknown>[] = []
      const logCount = logs.length
      await withRoutes(async base => {
        const response = await fetch(`${base}/recover`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.61' }, body: JSON.stringify({ channel: 'email', contact: scenario === 'absent' ? 'absent@example.test' : 'Alice@example.com' }) })
        assert.equal(response.status, 202)
        bodies.push(await response.text())
        assert.equal(promises.length, 1)
        await Promise.all(promises)
        if (scenario === 'missing-queue' || scenario === 'failed-publication') {
          assert.deepEqual(logs.slice(logCount), [['[notifications] Lifecycle pointer publication failed']])
          assert.ok(storage.snapshot()[3]!.some(row => row.status === 'pending' && typeof row.payload_ciphertext === 'string'))
          assert.equal(storage.snapshot()[0]![0]!.capability_generation, 2)
        }
      }, database, { promises, queue: scenario === 'missing-queue' ? undefined : { send: async () => { if (scenario === 'failed-publication') throw Error('Alice@example.com private Queue detail') } } })
    } finally { storage.close() }
  })
  assert.equal(new Set(bodies).size, 1)
  assert.ok(bodies.every(body => !body.includes('Alice') && !body.includes('Queue')))
})

test('HTTP recovery with disabled or expired delivery preserves the old management link and generic response', async t => {
  const previous = runtimeConfig
  t.after(() => { runtimeConfig = previous })
  for (const scenario of ['disabled', 'expired'] as const) await t.test(scenario, async () => {
    runtimeConfig = readyEmailRuntime()
    if (scenario === 'disabled') runtimeConfig.notificationEmailManualEnabled = false
    else {
      const evidence = JSON.parse(String(runtimeConfig.notificationEmailEvidence))
      evidence.verifiedAt = new Date(Date.now() - 3600000).toISOString()
      evidence.expiresAt = new Date(Date.now() - 1000).toISOString()
      runtimeConfig.notificationEmailEvidence = JSON.stringify(evidence)
    }
    const storage = managementDatabase()
    try {
      await seedManagement(storage.database)
      const before = storage.snapshot()
      const responses: string[] = []
      await withRoutes(async base => {
        for (const [index, contact] of ['Alice@example.com', 'absent@example.test'].entries()) {
          const response = await fetch(`${base}/recover`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': `192.0.2.${80 + index}` }, body: JSON.stringify({ channel: 'email', contact }) })
          assert.equal(response.status, 202)
          responses.push(await response.text())
        }
        const oldLink = await fetch(`${base}/manage/${managementToken}`)
        assert.equal((await oldLink.json()).state, 'active')
      }, storage.database, { promises: [], queue: { send: async () => {} } })
      assert.equal(new Set(responses).size, 1)
      const after = storage.snapshot()
      assert.deepEqual(after.slice(0, 3), before.slice(0, 3))
      assert.equal(after[3]!.length, before[3]!.length, 'no replacement recovery message is created')
      assert.deepEqual(after[4], before[4])
    } finally { storage.close() }
  })
})

test('absent real recovery without Queue distinguishes an empty outbox from unrelated pending work only in diagnostics', async t => {
  const previous = runtimeConfig
  runtimeConfig = managementRuntime
  t.after(() => { runtimeConfig = previous })
  const logs: unknown[][] = []
  const error = console.error
  console.error = (...values: unknown[]) => { logs.push(values) }
  t.after(() => { console.error = error })
  const bodies: string[] = []
  for (const scenario of ['empty', 'unrelated-pending'] as const) await t.test(scenario, async () => {
    const storage = managementDatabase()
    try {
      if (scenario === 'unrelated-pending') await seedManagement(storage.database)
      const before = storage.snapshot()
      const promises: Promise<unknown>[] = []
      const events: H3Event[] = []
      const logCount = logs.length
      const accounting: unknown[] = []
      const database: NotificationDatabase = { ...storage.database, prepare: sql => {
        const statement = storage.database.prepare(sql)
        const first = statement.first
        statement.first = async <T>() => {
          const result = await first<T>()
          if (result && typeof result === 'object' && 'lifecycle' in result && 'events' in result && 'oldest' in result) accounting.push(result)
          return result
        }
        return statement
      } }
      await withRoutes(async base => {
        const response = await fetch(`${base}/recover`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.65' }, body: JSON.stringify({ channel: 'email', contact: 'absent@example.test' }) })
        assert.equal(response.status, 202)
        bodies.push(await response.text())
        assert.deepEqual(JSON.parse(bodies.at(-1)!), { message: 'Pokud pro tento kontakt existuje správa notifikací, pošleme ti odkaz. Zkus to prosím později, pokud ti už odkaz přišel.' })
        assert.equal(promises.length, 1)
        assert.deepEqual(events[0]!.context.nitro._waitUntilPromises, promises)
        await promises[0]
        assert.deepEqual(accounting, scenario === 'empty' ? [{ lifecycle: 0, events: 0, oldest: null }] : [], 'empty publication completes real database accounting without attempting a send')
        assert.deepEqual(storage.snapshot(), before, 'absent input neither rotates unrelated contacts nor changes their durable pending work')
        const pending = await storage.database.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE status = 'pending'").first<{ count: number }>()
        assert.equal(pending!.count, scenario === 'empty' ? 0 : 1)
        const attempts = await storage.database.prepare('SELECT COUNT(*) AS count FROM notification_abuse_attempts').first<{ count: number }>()
        assert.equal(attempts!.count, 1, 'the valid request passed its own durable abuse evaluation')
        assert.deepEqual(logs.slice(logCount), scenario === 'empty' ? [] : [['[notifications] Lifecycle pointer publication failed']])
      }, database, { promises, events })
    } finally { storage.close() }
  })
  assert.equal(new Set(bodies).size, 1)
})

test('publication failure or missing binding preserves committed activation and confirmation with fixed private diagnostics', async t => {
  const previous = runtimeConfig
  runtimeConfig = readyEmailRuntime()
  t.after(() => { runtimeConfig = previous })
  const logs: unknown[][] = []
  const error = console.error
  console.error = (...values: unknown[]) => { logs.push(values) }
  t.after(() => { console.error = error })
  for (const operation of ['activate', 'confirm-reactivation'] as const) for (const failure of ['missing', 'send', 'mark'] as const) await t.test(`${operation}/${failure}`, async () => {
    const storage = managementDatabase()
    try {
      const { token } = await seedManagement(storage.database, operation === 'confirm-reactivation')
      let marked = false
      const database: NotificationDatabase = failure !== 'mark' ? storage.database : { ...storage.database, prepare: sql => {
        const statement = storage.database.prepare(sql)
        if (sql.startsWith('UPDATE notification_outbox SET status')) statement.run = async () => { marked = true; throw Error('private SQL detail') }
        return statement
      } }
      const promises: Promise<unknown>[] = []
      const logCount = logs.length
      await withRoutes(async base => {
        const response = await fetch(operation === 'activate' ? `${base}/activate` : `${base}/manage/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.62' }, body: JSON.stringify(operation === 'activate' ? { ...activation, contact: 'new@example.test' } : { action: operation }) })
        assert.equal(response.status, 200)
        if (operation === 'activate') assert.deepEqual(await response.json(), { state: 'active' })
        else assert.equal((await response.json() as { outcome: string }).outcome, 'reactivated')
        assert.equal(promises.length, 1)
        await Promise.all(promises)
        assert.deepEqual(logs.slice(logCount), [['[notifications] Lifecycle pointer publication failed']])
        assert.ok(storage.snapshot()[0]!.every(row => row.state === 'active'))
        assert.deepEqual(storage.snapshot()[2], [])
        assert.ok(storage.snapshot()[3]!.some(row => row.status === 'pending' && typeof row.payload_ciphertext === 'string'))
        assert.equal(marked, failure === 'mark')
      }, database, { promises, queue: failure === 'missing' ? undefined : { send: async () => { if (failure === 'send') throw Error('new@example.test private Queue detail') } } })
    } finally { storage.close() }
  })
})

test('bare H3 fallback awaits publication rather than dropping a promise when Nitro waitUntil is absent', async t => {
  const storage = managementDatabase()
  t.after(storage.close)
  const previous = runtimeConfig
  runtimeConfig = readyEmailRuntime()
  t.after(() => { runtimeConfig = previous })
  const promises: Promise<unknown>[] = []
  let completed = false
  await withRoutes(async base => {
    const response = await fetch(`${base}/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.63' }, body: JSON.stringify(activation) })
    assert.equal(response.status, 200)
    assert.equal(completed, true)
    assert.equal(promises.length, 0)
    assert.equal(storage.snapshot()[3]![0]!.status, 'queued')
  }, storage.database, { promises, register: false, queue: { send: async () => { await new Promise<void>(resolve => setTimeout(resolve, 20)); completed = true } } })
})

test('real H3 registration rejection awaits the exact promise and cannot erase a committed producer outcome', async t => {
  const previous = runtimeConfig
  runtimeConfig = readyEmailRuntime()
  t.after(() => { runtimeConfig = previous })
  const logs: unknown[][] = []
  const error = console.error
  console.error = (...values: unknown[]) => { logs.push(values) }
  t.after(() => { console.error = error })
  for (const operation of ['activate', 'recover', 'confirm-reactivation'] as const) await t.test(operation, async () => {
    const storage = managementDatabase()
    try {
      const { token } = await seedManagement(storage.database, operation === 'confirm-reactivation')
      const promises: Promise<unknown>[] = []
      const events: H3Event[] = []
      const before = logs.length
      let completed = false
      await withRoutes(async base => {
        const body = operation === 'activate' ? { ...activation, contact: 'new@example.test' } : operation === 'recover' ? { channel: 'email', contact: 'Alice@example.com' } : { action: operation }
        const response = await fetch(operation === 'confirm-reactivation' ? `${base}/manage/${token}` : `${base}/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.64' }, body: JSON.stringify(body) })
        assert.equal(response.status, operation === 'recover' ? 202 : 200)
        const result = await response.json() as { state?: string, outcome?: string, message?: string }
        if (operation === 'activate') assert.equal(result.state, 'active')
        if (operation === 'confirm-reactivation') assert.equal(result.outcome, 'reactivated')
        if (operation === 'recover') assert.ok(result.message?.includes('Pokud pro tento kontakt'))
        assert.equal(completed, true)
        assert.equal(promises.length, 0)
        assert.equal(events[0]!.context.nitro._waitUntilPromises!.length, 1)
        await events[0]!.context.nitro._waitUntilPromises![0]
        assert.deepEqual(logs.slice(before), [['[notifications] Lifecycle pointer publication registration failed']])
        assert.ok(storage.snapshot()[3]!.filter(row => row.payload_ciphertext !== null).every(row => row.status === 'queued'))
      }, storage.database, { promises, events, rejectRegistration: true, queue: { send: async () => { await new Promise<void>(resolve => setTimeout(resolve, 10)); completed = true } } })
    } finally { storage.close() }
  })
})
