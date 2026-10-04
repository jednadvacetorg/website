import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { consumeNotificationOutboxPointer, parseNotificationOutboxPointer, publishPendingNotificationPointers } from '../server/utils/notificationMessagesQueue.ts'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { planEventNotifications } from '../server/utils/eventEmailNotifications.ts'
import { applyBrevoCallback } from '../server/utils/brevoCallbacks.ts'
import type { PortalCalendarEvent } from '../server/utils/portalEvents.ts'
import { activateNotificationChannel, confirmNotificationReactivation, isDeliveryEligible, readNotificationManagement, requestNotificationManagementRecovery, stopNotificationChannel, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => {
  exec(sql: string): void
  prepare(sql: string): { run(...values: unknown[]): unknown, get(...values: unknown[]): unknown, all(...values: unknown[]): unknown[] }
}

const schema = readFileSync(new URL('../server/db/migrations/sqlite/0000_majestic_lightspeed.sql', import.meta.url), 'utf8')

const disposableDatabase = (): { database: NotificationDatabase, query(sql: string): Record<string, unknown>[] } => {
  const sqlite = new Database(':memory:')
  sqlite.exec(schema)
  sqlite.exec('PRAGMA foreign_keys = ON')
  const statement = (sql: string): NotificationStatement => {
    let values: unknown[] = []
    const result: NotificationStatement = {
      bind: (...bound) => { values = bound; return result },
      first: async <T>() => sqlite.prepare(sql).get(...values) as T ?? null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
      run: async () => {
        const run = sqlite.prepare(sql).run(...values) as { changes: number }
        return { meta: { changes: run.changes } }
      },
    }
    return result
  }
  return { database: { prepare: statement, batch: async statements => {
    sqlite.exec('BEGIN')
    try { const results = []; for (const item of statements) results.push(await item.run()); sqlite.exec('COMMIT'); return results }
    catch (error) { sqlite.exec('ROLLBACK'); throw error }
  } }, query: sql => sqlite.prepare(sql).all() as Record<string, unknown>[] }
}

const keyMaterial = new TextEncoder().encode('01234567890123456789012345678901')
const root = btoa(String.fromCharCode(...keyMaterial)).replace(/=+$/g, '')
const config = { ...await notificationConfig({
  notificationCommunitySlugs: 'brno', notificationRootKey: root,
  notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09',
  notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
}), emailDeliveryReady: true }
const predictableCrypto = { randomBytes: (length: number) => new Uint8Array(length), subtle: crypto.subtle }
const input = { channel: 'email' as const, contact: 'alice@example.com', communitySlugs: ['brno'], frequencies: ['created'] as const, consentAt: '2026-09-17T00:00:00.000Z', consentVersion: '2026-09' }
const pointerFor = (query: (sql: string) => Record<string, unknown>[]) => {
  const [outbox] = query('SELECT id, version FROM notification_outbox')
  return { outboxId: outbox!.id as string, version: outbox!.version as number }
}
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const initialToken = encode(new Uint8Array(32))
const pluginGlobals = globalThis as typeof globalThis & { defineNitroPlugin?: unknown }
const previousPlugin = pluginGlobals.defineNitroPlugin
pluginGlobals.defineNitroPlugin = () => undefined
const { dispatchNotificationQueueMessage } = await import('../server/plugins/notificationMessagesQueue.ts')
pluginGlobals.defineNitroPlugin = previousPlugin
const syntheticRuntime = { brevoApiKey: 'synthetic-key', brevoSenderName: 'Jednadvacet' }

const calendarEvent: PortalCalendarEvent = {
  event: { id: '12', title: 'Synthetic meetup', start: '2026-10-12T12:00:00.000Z', end: null, location: 'Synthetic venue', tags: [] },
  community: { id: 'brno', path: '/brno', title: 'Brno' }, sequence: 4, changedAt: '2026-10-04T00:00:00.000Z', cancelled: false,
}

test('actual event dispatch and callbacks converge in both orders without overwriting terminal evidence or retrying', async () => {
  for (const callbackKind of ['delivered', 'hard-bounce', 'complaint', 'unsubscribed'] as const) {
    for (const early of [true, false]) {
      const { database, query } = disposableDatabase()
      const dependencies = { database, config, now: () => new Date('2026-10-04T10:00:00Z') }
      await activateNotificationChannel(input, dependencies)
      await planEventNotifications([calendarEvent], dependencies)
      const [row] = query("SELECT id, version FROM notification_outbox WHERE kind = 'event-email'")
      const pointer = { outboxId: row!.id as string, version: row!.version as number }
      let calls = 0
      let deliveryId = ''
      const receive = () => applyBrevoCallback({ id: 'synthetic_event_123', deliveryId, kind: callbackKind, providerMessageId: 'synthetic_message_123', occurredAt: '2026-10-04T10:00:00Z' }, database)
      const fetcher: typeof fetch = async (_url, request) => {
        calls++
        const body = JSON.parse(request!.body as string)
        deliveryId = body.headers['X-Mailin-custom']
        assert.equal(body.attachment.length, 1)
        assert.equal((await readNotificationManagement(body.textContent.match(/\/manage\/([A-Za-z0-9_-]+)/)[1], dependencies)).state, 'active')
        if (early) await receive()
        return new Response(JSON.stringify({ messageId: 'synthetic_message_123' }), { status: 201 })
      }
      await dispatchNotificationQueueMessage({ id: 'send', body: pointer }, dependencies, syntheticRuntime, fetcher)
      if (!early) await receive()
      await dispatchNotificationQueueMessage({ id: 'duplicate', body: pointer }, dependencies, syntheticRuntime, fetcher)
      assert.equal(calls, 1)
      assert.equal(query('SELECT status FROM notification_event_deliveries')[0]!.status, callbackKind)
      assert.equal(query('SELECT provider_message_id FROM notification_event_deliveries')[0]!.provider_message_id, 'synthetic_message_123')
      assert.equal(query("SELECT payload_ciphertext FROM notification_outbox WHERE kind = 'event-email'")[0]!.payload_ciphertext, null)
    }
  }
})

test('early callback provider ID conflicts and attempted HTTP/fetch failures retain evidence and end email work', async () => {
  for (const outcome of [201, 429, 503, 'transport'] as const) {
    const { database, query } = disposableDatabase()
    const dependencies = { database, config, now: () => new Date('2026-10-04T10:00:00Z') }
    await activateNotificationChannel(input, dependencies)
    await planEventNotifications([calendarEvent], dependencies)
    const [row] = query("SELECT id, version FROM notification_outbox WHERE kind = 'event-email'")
    const pointer = { outboxId: row!.id as string, version: row!.version as number }
    let calls = 0
    const fetcher: typeof fetch = async (_url, request) => {
      calls++
      const body = JSON.parse(request!.body as string)
      await applyBrevoCallback({ id: 'synthetic_event_123', deliveryId: body.headers['X-Mailin-custom'], kind: 'delivered', providerMessageId: 'callback_message_123', occurredAt: '2026-10-04T10:00:00Z' }, database)
      if (outcome === 'transport') throw new TypeError('synthetic transport')
      return new Response(JSON.stringify({ messageId: 'different_message_123' }), { status: outcome })
    }
    await dispatchNotificationQueueMessage({ id: 'send', body: pointer }, dependencies, syntheticRuntime, fetcher)
    await dispatchNotificationQueueMessage({ id: 'duplicate', body: pointer }, dependencies, syntheticRuntime, fetcher)
    assert.equal(calls, 1)
    assert.deepEqual(query('SELECT status, provider_message_id FROM notification_event_deliveries'), [{ status: 'delivered', provider_message_id: 'callback_message_123' }])
  }
})

test('recovery inside the provider call cannot repair or resend an already attempted event', async () => {
  const { database, query } = disposableDatabase()
  const dependencies = { database, config, now: () => new Date('2026-10-04T10:00:00Z') }
  await activateNotificationChannel(input, dependencies)
  await planEventNotifications([calendarEvent], dependencies)
  const [row] = query("SELECT id, version FROM notification_outbox WHERE kind = 'event-email'")
  let calls = 0
  const pointer = { outboxId: row!.id as string, version: row!.version as number }
  await dispatchNotificationQueueMessage({ id: 'send', body: pointer }, dependencies, syntheticRuntime, async () => {
    calls++
    await requestNotificationManagementRecovery({ channel: 'email', contact: input.contact }, dependencies)
    assert.equal((await planEventNotifications([calendarEvent], dependencies)).planned, 0)
    return new Response(JSON.stringify({ messageId: 'synthetic_message_123' }), { status: 201 })
  })
  await dispatchNotificationQueueMessage({ id: 'duplicate', body: pointer }, dependencies, syntheticRuntime, async () => { calls++; throw new Error('must not resend') })
  assert.equal(calls, 1)
  assert.equal(query('SELECT status FROM notification_event_deliveries')[0]!.status, 'submitted')
  assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE kind = 'event-email'")[0]!.n, 1)
})

test('a crash after the final email attempt reservation is terminally retired instead of making a second call', async () => {
  const { database, query } = disposableDatabase()
  const dependencies = { database, config, now: () => new Date('2026-10-04T10:00:00Z') }
  await activateNotificationChannel(input, dependencies)
  await planEventNotifications([calendarEvent], dependencies)
  const [row] = query("SELECT id, version FROM notification_outbox WHERE kind = 'event-email'")
  const pointer = { outboxId: row!.id as string, version: row!.version as number }
  await assert.rejects(consumeNotificationOutboxPointer(pointer, dependencies, async (_payload, _authorization, authorize) => {
    assert.equal(await authorize(), true)
    throw new Error('Synthetic process-crash ambiguity')
  }), /process-crash ambiguity/)
  let calls = 0
  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, dependencies, async () => { calls++ }), { delivered: false, stale: true })
  assert.equal(calls, 0)
  assert.equal(query('SELECT status FROM notification_event_deliveries')[0]!.status, 'failed')
  assert.equal(query("SELECT payload_ciphertext FROM notification_outbox WHERE kind = 'event-email'")[0]!.payload_ciphertext, null)
})

test('real Queue dispatch sends a usable channel-scoped first email after durable signup and publication', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointers: unknown[] = []
  await publishPendingNotificationPointers({ send: async pointer => { pointers.push(pointer) } }, { database, config })
  const requests: RequestInit[] = []
  const result = await dispatchNotificationQueueMessage({ id: 'synthetic-message', body: pointers[0] }, { database, config }, { brevoApiKey: 'synthetic-key', brevoSenderName: 'Jednadvacet' }, async (_url, request) => {
    requests.push(request!)
    return new Response(JSON.stringify({ messageId: 'synthetic-provider-id' }), { status: 201 })
  })
  assert.deepEqual(result, { delivered: true, stale: false })
  assert.equal(requests.length, 1)
  const body = JSON.parse(requests[0]!.body as string)
  assert.deepEqual(body.to, [{ email: input.contact }])
  assert.deepEqual(body.sender, { name: 'Jednadvacet', email: 'noreply@jednadvacet.org' })
  assert.equal(body.attachment, undefined)
  assert.ok(body.textContent.includes(`https://jednadvacet.org/notifications/manage/${initialToken}`))
  assert.equal((await readNotificationManagement(initialToken, { database, config })).state, 'active')
  assert.equal(query('SELECT payload_ciphertext FROM notification_outbox')[0]!.payload_ciphertext, null)
})

test('real dispatch reaches pending reactivation and recovery without unsuppressing event work', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  await stopNotificationChannel(initialToken, { database, config })
  await activateNotificationChannel(input, { database, config })
  for (const kind of ['reactivation', 'management-recovery'] as const) {
    if (kind === 'management-recovery') await requestNotificationManagementRecovery({ channel: 'email', contact: input.contact }, { database, config })
    const [row] = query("SELECT id, version FROM notification_outbox WHERE status = 'pending'")
    let capability = ''
    await dispatchNotificationQueueMessage({ id: kind, body: { outboxId: row!.id, version: row!.version } }, { database, config }, syntheticRuntime, async (_url, request) => {
      const body = JSON.parse(request!.body as string)
      capability = body.textContent.match(/\/notifications\/manage\/([A-Za-z0-9_-]+)/)[1]
      assert.doesNotMatch(body.textContent, /je aktivní/)
      return new Response(JSON.stringify({ messageId: 'synthetic' }), { status: 201 })
    })
    assert.equal((await readNotificationManagement(capability, { database, config })).state, 'pending-reactivation')
    const [contact] = query('SELECT destination_hash FROM notification_contacts')
    assert.equal(await isDeliveryEligible({ channel: 'email', contactFingerprint: contact!.destination_hash as string, communitySlug: 'brno', frequency: 'created', now: new Date() }, { database, config }), false)
    assert.equal(query('SELECT id FROM notification_suppressions').length, 1)
    if (kind === 'management-recovery') {
      assert.equal((await confirmNotificationReactivation(capability, { database, config })).state, 'active')
      assert.equal(query('SELECT id FROM notification_suppressions').length, 0)
    }
  }
})

test('production email dispatch makes one attempt for every HTTP/fetch outcome and none after stop', async () => {
  for (const status of [201, 202, 400, 401, 403, 429, 503, 'transport'] as const) {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    const pointer = pointerFor(query)
    let calls = 0
    const fetcher: typeof fetch = async () => {
      calls++
      if (status === 'transport') throw new TypeError('synthetic transport')
      return new Response(JSON.stringify({ messageId: 'synthetic' }), { status })
    }
    await dispatchNotificationQueueMessage({ id: 'attempt', body: pointer }, { database, config }, syntheticRuntime, fetcher)
    assert.equal(calls, 1)
    assert.deepEqual(await dispatchNotificationQueueMessage({ id: 'duplicate', body: pointer }, { database, config }, syntheticRuntime, fetcher), { delivered: false, stale: true })
    assert.equal(calls, 1)
    assert.equal(query('SELECT payload_ciphertext FROM notification_outbox')[0]!.payload_ciphertext, null)
  }
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointer = pointerFor(query)
  let calls = 0
  assert.deepEqual(await dispatchNotificationQueueMessage({ id: 'stopped', body: pointer }, { database, config, barriers: { afterClaimedAndDecrypted: async () => { await stopNotificationChannel(initialToken, { database, config }) } } }, syntheticRuntime, async () => { calls++; throw new Error('must not send') }), { delivered: false, stale: true })
  assert.equal(calls, 0)
})

test('missing production adapter configuration and unattempted outcomes retain retryable work', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointer = pointerFor(query)
  await assert.rejects(dispatchNotificationQueueMessage({ id: 'missing', body: pointer }, { database, config }, {}, async () => { throw new Error('must not send') }))
  await assert.rejects(consumeNotificationOutboxPointer(pointer, { database, config }, async () => ({ attempted: false, status: 'auth' })))
  assert.equal(query('SELECT status FROM notification_outbox')[0]!.status, 'queued')
  assert.equal(typeof query('SELECT payload_ciphertext FROM notification_outbox')[0]!.payload_ciphertext, 'string')
})

test('duplicate live leases retry, expired crashed claims reclaim, and terminal/version-stale pointers acknowledge', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointer = pointerFor(query)
  let entered!: () => void
  let release!: () => void
  const claimed = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  let now = new Date('2026-10-04T00:00:00Z')
  let calls = 0
  const dependencies = { database, config, now: () => now }
  const first = consumeNotificationOutboxPointer(pointer, { ...dependencies, barriers: { afterClaimedAndDecrypted: async () => { entered(); await paused } } }, async () => { calls++ })
  await claimed
  await assert.rejects(consumeNotificationOutboxPointer(pointer, dependencies, async () => { calls++ }), /live claim/)
  now = new Date('2026-10-04T00:06:00Z')
  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, dependencies, async () => { calls++ }), { delivered: true, stale: false })
  release()
  assert.deepEqual(await first, { delivered: false, stale: true })
  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, dependencies, async () => { calls++ }), { delivered: false, stale: true })
  assert.equal(calls, 1)
  assert.equal(query('SELECT payload_ciphertext FROM notification_outbox')[0]!.payload_ciphertext, null)
})

test('lost final authority retires only the owned stale ciphertext and a post-call stop never resends', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointer = pointerFor(query)
  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config, now: () => new Date('2026-10-04T00:00:00Z'), barriers: { afterClaimedAndDecrypted: async () => { await database.prepare("UPDATE notification_outbox SET claim_expires_at = '2026-10-03T00:00:00Z'").run() } } }, async () => { throw new Error('must not send') }), { delivered: false, stale: true })
  assert.deepEqual(query('SELECT status, payload_ciphertext, claim_token FROM notification_outbox'), [{ status: 'invalidated', payload_ciphertext: null, claim_token: null }])
  await requestNotificationManagementRecovery({ channel: 'email', contact: input.contact }, { database, config })
  const [row] = query("SELECT id, version FROM notification_outbox WHERE status = 'pending'")
  const next = { outboxId: row!.id as string, version: row!.version as number }
  let calls = 0
  await dispatchNotificationQueueMessage({ id: 'post-call-stop', body: next }, { database, config }, syntheticRuntime, async (_url, request) => {
    calls++
    const capability = JSON.parse(request!.body as string).textContent.match(/\/manage\/([A-Za-z0-9_-]+)/)[1]
    await stopNotificationChannel(capability, { database, config })
    return new Response(JSON.stringify({ messageId: 'synthetic' }), { status: 201 })
  })
  await dispatchNotificationQueueMessage({ id: 'duplicate', body: next }, { database, config }, syntheticRuntime, async () => { calls++; throw new Error('must not send') })
  assert.equal(calls, 1)
})

test('Web Push stop during awaited VAPID preparation denies the real transport boundary', async () => {
  const { database, query } = disposableDatabase()
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicKey = encode(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey)))
  const contact = JSON.stringify({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))), auth: encode(new Uint8Array(16)) } })
  const pushConfig = { ...config, webPushEnabled: true, webPushFirstMessageReady: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true, webPushDelivery: { privateKey: vapid.privateKey, publicKey, subject: 'mailto:test@example.test' } }
  await activateNotificationChannel({ ...input, channel: 'web-push', contact }, { database, config: pushConfig, crypto: predictableCrypto })
  const sign = crypto.subtle.sign
  let calls = 0
  let signatures = 0
  crypto.subtle.sign = async (...args) => {
    signatures++
    await stopNotificationChannel(initialToken, { database, config: pushConfig })
    return sign.apply(crypto.subtle, args)
  }
  try {
    assert.deepEqual(await dispatchNotificationQueueMessage({ id: 'push', body: pointerFor(query) }, { database, config: pushConfig }, {}, async () => { calls++; return new Response(null, { status: 201 }) }), { delivered: false, stale: true })
    assert.equal(signatures, 1)
    assert.equal(calls, 0)
    assert.equal(query('SELECT payload_ciphertext FROM notification_outbox')[0]!.payload_ciphertext, null)
  } finally { crypto.subtle.sign = sign }
})

test('final transport authorization infrastructure failure retries without an email attempt', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  let reads = 0
  const failingDatabase: NotificationDatabase = { ...database, prepare: sql => {
    const statement = database.prepare(sql)
    if (sql.startsWith('SELECT o.expected_capability_generation')) {
      const first = statement.first
      statement.first = async <T>() => {
        if (++reads === 2) throw new Error('Synthetic D1 outage')
        return first<T>()
      }
    }
    return statement
  } }
  let calls = 0
  await assert.rejects(dispatchNotificationQueueMessage({ id: 'outage', body: pointerFor(query) }, { database: failingDatabase, config }, syntheticRuntime, async () => { calls++; return new Response(null, { status: 201 }) }), /Synthetic D1 outage/)
  assert.equal(calls, 0)
  assert.equal(query('SELECT status FROM notification_outbox')[0]!.status, 'queued')
})

test('provider suppression, pending event work, and mismatched outbox/payload kinds fail final authorization and scrub', async () => {
  for (const reason of ['provider-bounce', 'provider-complaint', 'provider-opt-out', 'event-pending', 'kind-mismatch'] as const) {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    await stopNotificationChannel(initialToken, { database, config })
    await activateNotificationChannel(input, { database, config })
    const [row] = query("SELECT id, version FROM notification_outbox WHERE status = 'pending'")
    const pointer = { outboxId: row!.id as string, version: row!.version as number }
    if (reason.startsWith('provider-')) await database.prepare('UPDATE notification_suppressions SET reason = ?').bind(reason).run()
    if (reason === 'kind-mismatch') await database.prepare("UPDATE notification_outbox SET kind = 'first-activation' WHERE id = ?").bind(pointer.outboxId).run()
    if (reason === 'event-pending') {
      const encrypted = await encryptedEventPayload('pending-event')
      const [contact] = query('SELECT id, destination_hash FROM notification_contacts')
      await database.prepare("UPDATE notification_outbox SET kind = 'event-email', payload_ciphertext = ?, payload_iv = ? WHERE id = ?").bind(encrypted.ciphertext, encrypted.iv, pointer.outboxId).run()
      await database.prepare('INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('pending-event', contact!.id, 1, contact!.destination_hash, 'pending@jednadvacet.org', 1, 'created', 'pending', '2026-10-04', '2026-10-04').run()
    }
    let calls = 0
    assert.deepEqual(await dispatchNotificationQueueMessage({ id: reason, body: pointer }, { database, config }, syntheticRuntime, async () => { calls++; throw new Error('must not send') }), { delivered: false, stale: true })
    assert.equal(calls, 0)
    assert.deepEqual(query(`SELECT status, payload_ciphertext, claim_token FROM notification_outbox WHERE id = '${pointer.outboxId}'`), [{ status: 'invalidated', payload_ciphertext: null, claim_token: null }])
  }
})

test('pending recovery/repeated signup at decrypt barriers revoke claimed and queued work atomically', async () => {
  for (const transition of ['recovery', 'signup'] as const) {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    await stopNotificationChannel(initialToken, { database, config })
    await activateNotificationChannel(input, { database, config })
    let published!: { outboxId: string, version: number }
    await publishPendingNotificationPointers({ send: async pointer => { published = pointer } }, { database, config })
    assert.deepEqual(await consumeNotificationOutboxPointer(published, { database, config, barriers: { afterClaimedAndDecrypted: async () => {
      if (transition === 'recovery') await requestNotificationManagementRecovery({ channel: 'email', contact: input.contact }, { database, config })
      else await activateNotificationChannel(input, { database, config })
    } } }, async () => { throw new Error('must not send') }), { delivered: false, stale: true })
    assert.deepEqual(query(`SELECT status, payload_ciphertext FROM notification_outbox WHERE id = '${published.outboxId}'`), [{ status: 'invalidated', payload_ciphertext: null }])
    assert.deepEqual(query("SELECT expected_capability_generation FROM notification_outbox WHERE status = 'pending'"), [{ expected_capability_generation: 2 }])
  }
})

test('Web Push transient provider outcomes retain the ciphertext for Queue retry', async () => {
  for (const status of ['rate-limited', 'provider-5xx', 'transport'] as const) {
    const { database, query } = disposableDatabase()
    const ready = { ...config, webPushEnabled: true, webPushFirstMessageReady: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true }
    const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const contact = JSON.stringify({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))), auth: encode(new Uint8Array(16)) } })
    await activateNotificationChannel({ ...input, channel: 'web-push', contact }, { database, config: ready, crypto: predictableCrypto })
    await assert.rejects(consumeNotificationOutboxPointer(pointerFor(query), { database, config: ready }, async () => ({ attempted: true, status })), /retryable/)
    const [row] = query('SELECT status, payload_ciphertext, claim_token FROM notification_outbox')
    assert.equal(row!.status, 'queued')
    assert.equal(typeof row!.payload_ciphertext, 'string')
    assert.equal(row!.claim_token, null)
  }
})

test('real SMS signup/recovery dispatch carries a usable SMS-only management link and stop revokes it', async () => {
  const { database, query } = disposableDatabase()
  const ready = { ...config, emailSmsEnabled: false, emailDeliveryReady: false, smsEnabled: true, smsFirstMessageReady: true, smsEventDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true }
  const contact = '+420777123456'
  await activateNotificationChannel({ ...input, channel: 'sms', contact }, { database, config: ready })
  let firstToken = ''
  for (const kind of ['first-activation', 'management-recovery'] as const) {
    if (kind === 'management-recovery') await requestNotificationManagementRecovery({ channel: 'sms', contact }, { database, config: ready })
    const [row] = query("SELECT id, version FROM notification_outbox WHERE status = 'pending'")
    let token = ''
    let calls = 0
    await dispatchNotificationQueueMessage({ id: kind, body: { outboxId: row!.id, version: row!.version } }, { database, config: ready }, syntheticRuntime, async (url, request) => {
      calls++
      assert.equal(url, 'https://api.brevo.com/v3/transactionalSMS/send')
      const body = JSON.parse(request!.body as string)
      assert.equal(body.recipient, contact)
      assert.equal(body.type, 'transactional')
      token = body.content.match(/https:\/\/jednadvacet.org\/notifications\/manage\/([A-Za-z0-9_-]+)/)[1]
      return new Response(JSON.stringify({ messageId: 'synthetic-sms' }), { status: 201 })
    })
    assert.equal(calls, 1)
    const management = await readNotificationManagement(token, { database, config: ready })
    assert.equal(management.state, 'active')
    assert.equal(management.channel, 'sms')
    if (kind === 'first-activation') firstToken = token
    else {
      assert.equal((await readNotificationManagement(firstToken, { database, config: ready })).state, 'unavailable')
      await stopNotificationChannel(token, { database, config: ready })
      assert.equal((await readNotificationManagement(token, { database, config: ready })).state, 'unavailable')
    }
  }
  assert.deepEqual(query('SELECT channel, reason FROM notification_suppressions'), [{ channel: 'sms', reason: 'user-stop' }])
})
const encryptedEventPayload = async (deliveryId: string, kind: 'event-email' | 'event-sms' = 'event-email') => {
  const iv = new Uint8Array(12)
  const plaintext = new TextEncoder().encode(JSON.stringify({
    destination: 'alice@example.com',
    deliveryId,
    managementCapability: 'capability',
    event: { title: 'Meetup', start: '2026-10-01T17:00:00.000Z', end: '2026-10-01T19:00:00.000Z', uid: 'brno-1@jednadvacet.org', sequence: 1 },
    reason: 'created',
    kind,
  }))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, config.outboxTransportKey, plaintext)
  return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv) }
}

test('notification Queue accepts only exact inert outbox ID/version pointers', () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(schema)

  assert.deepEqual(parseNotificationOutboxPointer({ outboxId: 'opaque-outbox-id', version: 1 }), { outboxId: 'opaque-outbox-id', version: 1 })
  assert.throws(() => parseNotificationOutboxPointer({ outboxId: 'opaque-outbox-id', version: 1, destination: 'alice@example.com' }))
  assert.throws(() => parseNotificationOutboxPointer({ outboxId: 'opaque-outbox-id', version: 0 }))
  assert.throws(() => parseNotificationOutboxPointer({ outboxId: 'opaque-outbox-id' }))
})

test('producer publishes inert pointers, marks accepted work queued, and retains payload', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const sent: unknown[] = []

  assert.deepEqual(await publishPendingNotificationPointers({ send: async pointer => { sent.push(pointer) } }, { database, config, crypto: predictableCrypto }), { published: 1 })
  assert.deepEqual(sent, [pointerFor(query)])
  const [outbox] = query('SELECT status, payload_ciphertext, payload_iv FROM notification_outbox')
  assert.equal(outbox!.status, 'queued')
  assert.equal(typeof outbox!.payload_ciphertext, 'string')
  assert.equal(typeof outbox!.payload_iv, 'string')
})

test('producer rejection leaves pending work recoverable', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })

  await assert.rejects(publishPendingNotificationPointers({ send: async () => { throw new Error('Queue unavailable') } }, { database, config }))
  assert.deepEqual(query('SELECT status FROM notification_outbox'), [{ status: 'pending' }])
})

test('stop or rotation committed after Queue acceptance makes the original pointer stale', async () => {
  for (const transition of ['stop', 'rotation'] as const) {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    const sent: unknown[] = []
    let calls = 0

    await publishPendingNotificationPointers({ send: async pointer => { sent.push(pointer) } }, {
      database,
      config,
      crypto: predictableCrypto,
      barriers: {
        afterPublished: async pointer => {
          if (transition === 'stop') await stopNotificationChannel(initialToken, { database, config })
          else await requestNotificationManagementRecovery({ channel: 'email', contact: input.contact }, { database, config })
        },
      },
    })

    let decrypts = 0
    const cryptoWithDecryptSpy = {
      randomBytes: predictableCrypto.randomBytes,
      subtle: {
        ...crypto.subtle,
        decrypt: async (...args: Parameters<SubtleCrypto['decrypt']>) => {
          decrypts += 1
          return crypto.subtle.decrypt(...args)
        },
      } as SubtleCrypto,
    }
    assert.deepEqual(await consumeNotificationOutboxPointer(sent[0] as { outboxId: string, version: number }, { database, config, crypto: cryptoWithDecryptSpy }, async () => { calls += 1 }), { delivered: false, stale: true })
    assert.equal(calls, 0)
    assert.equal(decrypts, 0, `${transition} committed after enqueue must prevent decryption`)
    assert.deepEqual(query(`SELECT status, payload_ciphertext FROM notification_outbox WHERE id = '${(sent[0] as { outboxId: string }).outboxId}'`), [{ status: 'invalidated', payload_ciphertext: null }])
  }
})

test('consumer decrypts only after claim, final-authorizes, then CAS-scrubs successful work', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointer = pointerFor(query)
  const delivered: unknown[] = []

  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config, crypto: predictableCrypto }, async payload => { delivered.push(payload) }), { delivered: true, stale: false })
  assert.deepEqual(delivered, [{ destination: 'alice@example.com', capability: btoa(String.fromCharCode(...new Uint8Array(32))).replace(/=+$/g, ''), kind: 'first-activation' }])
  assert.deepEqual(query('SELECT version, status, payload_ciphertext, payload_iv, claim_token FROM notification_outbox'), [{ version: 2, status: 'consumed', payload_ciphertext: null, payload_iv: null, claim_token: null }])
})

test('stop committed after claim and decryption denies the provider hook', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  let calls = 0
  let decrypts = 0

  const result = await consumeNotificationOutboxPointer(pointerFor(query), {
    database,
    config,
    crypto: {
      randomBytes: predictableCrypto.randomBytes,
      subtle: { digest: crypto.subtle.digest.bind(crypto.subtle), decrypt: async (...args: Parameters<SubtleCrypto['decrypt']>) => { decrypts += 1; return crypto.subtle.decrypt(...args) } } as SubtleCrypto,
    },
    barriers: {
      afterClaimedAndDecrypted: async () => {
        await stopNotificationChannel(initialToken, { database, config })
      },
    },
  }, async () => { calls += 1 })

  assert.deepEqual(result, { delivered: false, stale: true })
  assert.equal(calls, 0)
  assert.equal(decrypts, 1, 'claim-stale work may decrypt only into ephemeral memory before it is discarded')
})

test('rotation committed after claim and decryption denies the provider hook', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  let calls = 0
  let decrypts = 0

  const result = await consumeNotificationOutboxPointer(pointerFor(query), {
    database,
    config,
    crypto: {
      randomBytes: predictableCrypto.randomBytes,
      subtle: { digest: crypto.subtle.digest.bind(crypto.subtle), decrypt: async (...args: Parameters<SubtleCrypto['decrypt']>) => { decrypts += 1; return crypto.subtle.decrypt(...args) } } as SubtleCrypto,
    },
    barriers: {
      afterClaimedAndDecrypted: async () => {
        await requestNotificationManagementRecovery({ channel: 'email', contact: input.contact }, { database, config })
      },
    },
  }, async () => { calls += 1 })

  assert.deepEqual(result, { delivered: false, stale: true })
  assert.equal(calls, 0)
  assert.equal(decrypts, 1, 'claim-stale work may decrypt only into ephemeral memory before it is discarded')
})

test('pre-delivery failures release the exact claim so repeated Queue pointers remain retryable', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointer = pointerFor(query)

  await assert.rejects(consumeNotificationOutboxPointer(pointer, { database, config, crypto: predictableCrypto }, async () => { throw new Error('Provider unavailable') }))
  const [outbox] = query('SELECT status, claim_token, payload_ciphertext FROM notification_outbox')
  assert.equal(outbox!.status, 'queued')
  assert.equal(outbox!.claim_token, null)
  assert.equal(typeof outbox!.payload_ciphertext, 'string')
})

test('attempted event email rate limiting is terminal and never writes unsupported delivery statuses', async () => {
  const { database, query } = disposableDatabase()
  const eventConfig = { ...config, emailDeliveryReady: true }
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointer = pointerFor(query)
  const deliveryId = 'event-delivery-id'
  const encrypted = await encryptedEventPayload(deliveryId)
  await database.batch([
    database.prepare('UPDATE notification_outbox SET kind = ?, payload_ciphertext = ?, payload_iv = ? WHERE id = ?').bind('event-email', encrypted.ciphertext, encrypted.iv, pointer.outboxId),
    database.prepare('INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(deliveryId, 1, 1, 'hash', 'brno-1@jednadvacet.org', 1, 'created', 'pending', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'),
  ])

  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config: eventConfig, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'rate-limited' })), { delivered: true, stale: false })
  assert.deepEqual(query('SELECT status FROM notification_event_deliveries'), [{ status: 'failed' }])
  assert.deepEqual(query('SELECT status, payload_ciphertext FROM notification_outbox'), [{ status: 'consumed', payload_ciphertext: null }])
})

test('SMS lifecycle provider failures retry transient results and retain terminal failure evidence', async () => {
  const { database, query } = disposableDatabase()
  const smsConfig = { ...config, smsEnabled: true, smsFirstMessageReady: true, smsEventDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true }
  await activateNotificationChannel({ ...input, channel: 'sms', contact: '+420777123456' }, { database, config: smsConfig, crypto: predictableCrypto })
  const pointer = pointerFor(query)

  await assert.rejects(consumeNotificationOutboxPointer(pointer, { database, config, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'provider-5xx' })))
  const [retryable] = query('SELECT status, payload_ciphertext, claim_token FROM notification_outbox')
  assert.equal(retryable!.status, 'queued')
  assert.equal(typeof retryable!.payload_ciphertext, 'string')
  assert.equal(retryable!.claim_token, null)

  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'auth' })), { delivered: false, stale: false })
  const [terminal] = query('SELECT status, payload_ciphertext, terminal_at FROM notification_outbox')
  assert.equal(terminal!.status, 'invalidated')
  assert.equal(terminal!.payload_ciphertext, null)
  assert.equal(typeof terminal!.terminal_at, 'string')
})

test('a stale lifecycle Web Push endpoint is suppressed and removed', async () => {
  const { database, query } = disposableDatabase()
  const webPushConfig = { ...config, webPushEnabled: true, webPushFirstMessageReady: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true }
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const webPushInput = { ...input, channel: 'web-push' as const, contact: JSON.stringify({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))), auth: encode(new Uint8Array(16)) } }) }
  await activateNotificationChannel(webPushInput, { database, config: webPushConfig, crypto: predictableCrypto })
  const pointer = pointerFor(query)

  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config: webPushConfig, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'stale-endpoint', httpStatus: 410 })), { delivered: false, stale: false })
  assert.deepEqual(query('SELECT status, payload_ciphertext FROM notification_outbox'), [{ status: 'invalidated', payload_ciphertext: null }])
  assert.deepEqual(query('SELECT channel, reason FROM notification_suppressions'), [{ channel: 'web-push', reason: 'provider-opt-out' }])
  assert.deepEqual(query('SELECT id FROM notification_contacts'), [])
})

test('SMS activation is blocked by the actual unsupported event schema despite provider flags', async () => {
  const { database, query } = disposableDatabase()
  const smsConfig = { ...config, emailSmsEnabled: false, emailSmsEventDeliveryReady: false, emailDeliveryReady: false, smsEnabled: true, smsFirstMessageReady: true, smsEventDeliveryReady: true, smsDeliveryReady: true }
  await assert.rejects(activateNotificationChannel({ ...input, channel: 'sms', contact: '+420777123456' }, { database, config: smsConfig, crypto: predictableCrypto }), error => (error as { statusCode: number }).statusCode === 503)
  assert.deepEqual(query('SELECT id FROM notification_contacts'), [])
})

test('scheduled drain publishes bounded pointers and consumer failures remain retryable', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const runtimeConfig = {
    notificationCommunitySlugs: 'brno',
    notificationRootKey: root,
    notificationTurnstileSecret: 'private-turnstile-secret',
    notificationTurnstileExpectedHostname: 'jednadvacet.org',
    notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true,
    notificationEmailSmsFirstMessageReady: true,
    notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false,
    notificationWebPushFirstMessageReady: false,
    notificationWebPushEventDeliveryReady: false,
  }
  const globals = globalThis as typeof globalThis & { defineTask?: unknown, defineNitroPlugin?: unknown }
  const previousTask = globals.defineTask
  const previousPlugin = globals.defineNitroPlugin
  globals.defineTask = (task: unknown) => task
  globals.defineNitroPlugin = () => undefined
  try {
    const { drainNotificationMessages } = await import('../server/tasks/notification-messages.ts')
    const { processNotificationQueueMessage } = await import('../server/plugins/notificationMessagesQueue.ts')
    const sent: unknown[] = []
    const portalStorage = { getItem: async () => ({ schemaVersion: 1, community: { id: 'brno', path: '/brno', title: 'Brno' }, events: [], cancellations: [], signals: {}, fetchedAt: '2026-09-17T00:00:00.000Z' }), setItem: async () => {}, getKeys: async () => [] }
    assert.deepEqual(await drainNotificationMessages({ notificationDatabase: database, notificationMessagesQueue: { send: async pointer => { sent.push(pointer) } }, portalStorage }, runtimeConfig), { published: 1, planned: 0 })
    await assert.rejects(processNotificationQueueMessage({ id: 'opaque-message-id', body: sent[0] }, { database, config }))
    assert.deepEqual(query('SELECT status FROM notification_outbox'), [{ status: 'queued' }])
  } finally {
    globals.defineTask = previousTask
    globals.defineNitroPlugin = previousPlugin
  }
})
