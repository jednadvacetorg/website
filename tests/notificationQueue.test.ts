import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createECDH, createDecipheriv, hkdfSync } from 'node:crypto'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createServer } from 'node:http'
import { createApp, eventHandler, toNodeListener } from 'h3'

import { consumeNotificationOutboxPointer, parseNotificationOutboxPointer, publishPendingNotificationPointers } from '../server/utils/notificationMessagesQueue.ts'
import { notificationConfig } from '../server/utils/notificationConfig.ts'

Object.assign(globalThis, { __NOTIFICATION_COMMUNITIES__: [{ slug: 'brno', title: 'Brno' }] })
import { planEventNotifications } from '../server/utils/eventEmailNotifications.ts'
import { applyBrevoCallback, normalizeBrevoCallback } from '../server/utils/brevoCallbacks.ts'
import type { PortalCalendarEvent } from '../server/utils/portalEvents.ts'
import { activateNotificationChannel, confirmNotificationReactivation, notificationSchemaReady, readNotificationManagement, requestNotificationManagementRecovery, stopNotificationChannel, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => {
  exec(sql: string): void
  prepare(sql: string): { run(...values: unknown[]): unknown, get(...values: unknown[]): unknown, all(...values: unknown[]): unknown[] }
}

const schema = ['0000_majestic_lightspeed'].map(name => readFileSync(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8')).join('\n')

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
  notificationRootKey: root,
  notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org',
}), emailDeliveryReady: true }
const predictableCrypto = { randomBytes: (length: number) => new Uint8Array(length), subtle: crypto.subtle }
const input = { channel: 'email' as const, contact: 'alice@example.com', communitySlugs: ['brno'], frequencies: ['created'] as const, consentAt: '2026-09-17T00:00:00.000Z' }
const pointerFor = (query: (sql: string) => Record<string, unknown>[]) => {
  const [outbox] = query('SELECT id, version FROM notification_outbox')
  return { outboxId: outbox!.id as string, version: outbox!.version as number }
}
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const initialToken = encode(new Uint8Array(32))
const pluginGlobals = globalThis as typeof globalThis & { defineNitroPlugin?: unknown }
const previousPlugin = pluginGlobals.defineNitroPlugin
pluginGlobals.defineNitroPlugin = (plugin: unknown) => plugin
const { dispatchNotificationQueueMessage, default: notificationQueuePlugin } = await import('../server/plugins/notificationMessagesQueue.ts')
pluginGlobals.defineNitroPlugin = previousPlugin
const syntheticRuntime = { brevoApiKey: 'synthetic-key', brevoSenderName: 'Jednadvacet', brevoSmsSender: 'Meetupy' }

test('lifecycle activation recovery and reactivation reserve authority through the registered Queue hook before authenticated early callback', async t => {
  for (const kind of ['first-activation', 'management-recovery', 'reactivation']) await t.test(kind, async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    if (kind === 'management-recovery') await requestNotificationManagementRecovery(input, { database, config })
    if (kind === 'reactivation') {
      await stopNotificationChannel(initialToken, { database, config })
      await activateNotificationChannel(input, { database, config })
    }
    const row = query(`SELECT * FROM notification_outbox WHERE kind = '${kind}' AND status = 'pending'`)[0]!
    const pointer = { outboxId: row.id as string, version: row.version as number }
    const globals = globalThis as typeof globalThis & { useRuntimeConfig?: unknown }
    const priorRuntime = globals.useRuntimeConfig, originalFetch = globalThis.fetch
    const runtime = { ...syntheticRuntime, brevoSenderEmail: 'noreply@jednadvacet.org', brevoCallbackSecret: 'synthetic-callback', notificationRootKey: root, notificationTurnstileSecret: 'synthetic', notificationTurnstileExpectedHostname: 'jednadvacet.org' }
    Object.assign(runtime, { brevoApiKey: 'synthetic-api-key-at-least-24-characters', brevoCallbackSecret: 'synthetic-callback-at-least-24-characters' })
    globals.useRuntimeConfig = () => runtime
    const route = (await import('../server/api/notifications/brevo-events.post.ts')).default
    const app = createApp()
    app.use('/callback', eventHandler(event => { event.context._platform = { cloudflare: { env: { DB: database } } }; return route(event) }))
    const server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    let calls = 0
    globalThis.fetch = async (url, request) => {
      calls++
      assert.equal(String(url), 'https://api.brevo.com/v3/smtp/email')
      const body = JSON.parse(request!.body as string)
      assert.equal(body.headers['X-Mailin-custom'], `lifecycle:v1:${pointer.outboxId}:${pointer.version}`)
      const evidence = query(`SELECT * FROM notification_outbox WHERE id = '${pointer.outboxId}'`)[0]!
      assert.equal(evidence.email_attempt_version, pointer.version)
      assert.equal(evidence.email_destination_hash, query('SELECT destination_hash FROM notification_contacts')[0]!.destination_hash)
      const response = await originalFetch(`http://127.0.0.1:${address.port}/callback`, { method: 'POST', headers: { authorization: `Bearer ${runtime.brevoCallbackSecret}` }, body: JSON.stringify({ id: 88, event: 'hard_bounce', 'X-Mailin-custom': body.headers['X-Mailin-custom'], 'message-id': '<synthetic+provider@relay.test>', ts_event: Math.floor(Date.now() / 1000) }) })
      assert.equal(response.status, 202)
      assert.equal(query('SELECT count(*) n FROM notification_contacts')[0]!.n, 0)
      assert.equal(query('SELECT email_delivery_status FROM notification_outbox WHERE email_attempt_version IS NOT NULL')[0]!.email_delivery_status, 'hard-bounce')
      return Response.json({ messageId: '<synthetic+provider@relay.test>' }, { status: 201 })
    }
    try {
      let hook!: (event: unknown) => Promise<void>
      ;(notificationQueuePlugin as unknown as (app: unknown) => void)({ hooks: { hook: (_name: string, handler: typeof hook) => { hook = handler } } })
      const event = { batch: { queue: 'notification-messages', messages: [{ id: 'local-lifecycle', body: pointer }] }, env: { DB: database }, context: { waitUntil: () => {} } }
      await hook(event)
      await hook(event)
      assert.equal(calls, 1)
      assert.equal(query('SELECT count(*) n FROM notification_lifecycle_email_callbacks')[0]!.n, 1)
      assert.equal(query('SELECT email_delivery_status FROM notification_outbox WHERE email_attempt_version IS NOT NULL')[0]!.email_delivery_status, 'hard-bounce')
    } finally {
      globalThis.fetch = originalFetch
      globals.useRuntimeConfig = priorRuntime
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})

test('reserved lifecycle callback evidence converges monotonically across results conflicts rotation deletion expiry and atomic faults', async t => {
  for (const scenario of ['late', 'spam', 'unsubscribed', 'early-failed-response', 'early-conflicting-response', 'rotation', 'stop', 'raced-rotation', 'raced-stop', 'rollback', 'expiry', 'pre-expiry']) await t.test(scenario, async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    const pointer = pointerFor(query)
    // Real sibling channel contacts, outboxes and subscriptions must survive every callback.
    await activateNotificationChannel({ ...input, channel: 'sms', contact: '+420777123456' }, { database, config: { ...config, smsDeliveryReady: true, eventSmsOutboxSupported: true } })
    await database.prepare("INSERT INTO notification_contacts (channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) SELECT 'web-push', 'https://push.example.test/opaque', destination_hash, 'push-sibling-digest', capability_generation, state, consent_at, consent_version, created_at, updated_at FROM notification_contacts WHERE channel = 'sms'").run()
    const siblings = query("SELECT * FROM notification_contacts WHERE channel <> 'email'")
    const siblingWork = query("SELECT * FROM notification_outbox WHERE contact_id IN (SELECT id FROM notification_contacts WHERE channel <> 'email')")
    const correlation = `lifecycle:v1:${pointer.outboxId}:${pointer.version}`
    const callback = (kind: string, overrides: Record<string, unknown> = {}) => {
      const event = normalizeBrevoCallback({ id: 22, event: kind, 'X-Mailin-custom': correlation, 'message-id': '<provider+local@relay.test>', ts_event: 1792000000, ...overrides })
      assert.ok(event)
      return event
    }
    let calls = 0
    await dispatchNotificationQueueMessage({ id: 'lifecycle-matrix', body: pointer }, { database, config }, syntheticRuntime, async () => {
      calls++
      if (scenario.startsWith('early')) assert.equal((await applyBrevoCallback(callback('delivered'), database)).applied, true)
      if (scenario === 'early-failed-response') return new Response(null, { status: 503 })
      return Response.json({ messageId: scenario === 'early-conflicting-response' ? 'conflicting-provider' : '<provider+local@relay.test>' }, { status: 201 })
    })
    assert.equal(calls, 1)
    if (scenario.startsWith('early')) {
      assert.equal(query('SELECT email_delivery_status FROM notification_outbox WHERE email_attempt_version IS NOT NULL')[0]!.email_delivery_status, 'delivered')
      assert.equal(query('SELECT email_provider_message_id FROM notification_outbox WHERE email_attempt_version IS NOT NULL')[0]!.email_provider_message_id, 'provider+local@relay.test')
    }
    for (const overrides of [{ 'message-id': 'wrong-provider' }, { 'X-Mailin-custom': `lifecycle:v1:${pointer.outboxId}:2` }]) assert.deepEqual(await applyBrevoCallback(callback('spam', overrides), database), { applied: false, suppressed: false })
    if (scenario === 'rotation') await requestNotificationManagementRecovery(input, { database, config })
    if (scenario === 'stop') await stopNotificationChannel(initialToken, { database, config })
    if (scenario === 'expiry' || scenario === 'pre-expiry') await database.prepare('UPDATE notification_outbox SET terminal_at = ? WHERE id = ?').bind(new Date(Date.now() - 30 * 86400000 + (scenario === 'expiry' ? -1000 : 10000)).toISOString(), pointer.outboxId).run()
    const before = query('SELECT * FROM notification_outbox')
    const contacts = query('SELECT * FROM notification_contacts')
    const callbacks = query('SELECT * FROM notification_lifecycle_email_callbacks')
    if (scenario === 'rollback') {
      const failing: NotificationDatabase = { ...database, batch: statements => database.batch([...statements, database.prepare("INSERT INTO notification_lifecycle_email_callbacks (receipt_key, outbox_id, attempt_version, event, provider_message_id, received_at) VALUES ('invalid', 'missing', 0, 'bad', 'provider', 'bad')")]) }
      await assert.rejects(applyBrevoCallback(callback('hard_bounce'), failing))
      assert.deepEqual(query('SELECT * FROM notification_outbox'), before)
      assert.deepEqual(query('SELECT * FROM notification_contacts'), contacts)
      assert.deepEqual(query('SELECT * FROM notification_lifecycle_email_callbacks'), callbacks)
      assert.equal(query('SELECT count(*) n FROM notification_suppressions')[0]!.n, 0)
      return
    }
    const strong = scenario === 'spam' || scenario === 'unsubscribed' ? scenario : 'hard_bounce'
    const raced: NotificationDatabase = { ...database, batch: async statements => {
      if (scenario === 'raced-rotation') await requestNotificationManagementRecovery(input, { database, config })
      if (scenario === 'raced-stop') await stopNotificationChannel(initialToken, { database, config })
      return database.batch(statements)
    } }
    const result = await applyBrevoCallback(callback(strong), raced)
    if (scenario === 'expiry') {
      assert.deepEqual(result, { applied: false, suppressed: false })
      assert.deepEqual(query('SELECT * FROM notification_outbox'), before)
      assert.deepEqual(query('SELECT * FROM notification_contacts'), contacts)
      assert.deepEqual(query('SELECT * FROM notification_lifecycle_email_callbacks'), callbacks)
      return
    }
    assert.deepEqual(result, { applied: true, suppressed: true })
    const terminal = query('SELECT terminal_at FROM notification_outbox WHERE email_attempt_version IS NOT NULL')
    assert.deepEqual(await applyBrevoCallback(callback(strong), database), { applied: false, suppressed: false })
    // Same provider configuration ID with a different kind is a distinct composite receipt.
    await applyBrevoCallback(callback('delivered'), database)
    await applyBrevoCallback(callback('soft_bounce'), database)
    assert.equal(query('SELECT email_delivery_status FROM notification_outbox WHERE email_attempt_version IS NOT NULL')[0]!.email_delivery_status, strong === 'spam' ? 'complaint' : strong === 'unsubscribed' ? 'unsubscribed' : 'hard-bounce')
    assert.deepEqual(query('SELECT terminal_at FROM notification_outbox WHERE email_attempt_version IS NOT NULL'), terminal)
    if (scenario === 'rotation' || scenario === 'raced-rotation') {
      if (scenario === 'rotation') {
        assert.deepEqual(query('SELECT * FROM notification_contacts'), contacts)
        assert.deepEqual(query("SELECT * FROM notification_outbox WHERE kind = 'management-recovery'"), before.filter(row => row.kind === 'management-recovery'))
      } else {
        assert.equal(query("SELECT capability_generation FROM notification_contacts WHERE channel = 'email'")[0]!.capability_generation, 2)
        assert.equal(query("SELECT status FROM notification_outbox WHERE kind = 'management-recovery'")[0]!.status, 'pending')
      }
      let forbidden = 0
      const replacement = query("SELECT id, version FROM notification_outbox WHERE kind = 'management-recovery'")[0]!
      await dispatchNotificationQueueMessage({ id: 'replacement', body: { outboxId: replacement.id, version: replacement.version } }, { database, config }, syntheticRuntime, async () => { forbidden++; return Response.json({ messageId: 'forbidden' }, { status: 201 }) })
      assert.equal(forbidden, 0, 'retained old hash denies same destination without deleting replacement generation')
    } else assert.equal(query("SELECT count(*) n FROM notification_contacts WHERE channel = 'email'")[0]!.n, 0)
    assert.deepEqual(query("SELECT * FROM notification_contacts WHERE channel <> 'email'"), siblings)
    assert.deepEqual(query("SELECT * FROM notification_outbox WHERE contact_id IN (SELECT id FROM notification_contacts WHERE channel <> 'email')"), siblingWork)
    assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config }, async () => { throw Error('must never resubmit') }), { delivered: false, stale: true })
  })
})

test('supplied pre-lifecycle schema cannot activate or reach transport', async () => {
  const sqlite = new Database(':memory:')
  for (const name of ['0000_majestic_lightspeed', '0001_phase_7_columns', '0002_detach_event_callback_fk', '0003_restore_event_ledger_checks', '0004_restore_event_callback_fk']) sqlite.exec(execFileSync('git', ['show', `ec1001951d6df22f1e77f68ecd3ab678f0a49208:server/db/migrations/sqlite/${name}.sql`], { encoding: 'utf8' }))
  const old: NotificationDatabase = { prepare: sql => ({ bind() { return this }, all: async <T>() => ({ results: sqlite.prepare(sql).all() as T[] }), first: async <T>() => sqlite.prepare(sql).get() as T, run: async () => sqlite.prepare(sql).run() }), batch: async () => { throw Error('no mutation allowed') } }
  assert.equal(await notificationSchemaReady(old), false)
  await assert.rejects(activateNotificationChannel(input, { database: old, config }), /activation is unavailable/)
})

test('lifecycle callback SQL uses execution-time expiry across the real H3 batch bridge', async t => {
  for (const boundary of ['batch', 'receipt-only', 'all-clear', 'between-statements']) await t.test(boundary, async () => {
    const taskGlobals = globalThis as typeof globalThis & { defineTask?: unknown }
    const oldTask = taskGlobals.defineTask
    taskGlobals.defineTask = (task: unknown) => task
    const { drainNotificationMessages } = await import('../server/tasks/notification-messages.ts')
    taskGlobals.defineTask = oldTask
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config })
    const pointer = pointerFor(query)
    await dispatchNotificationQueueMessage({ id: 'expiry-boundary', body: pointer }, { database, config }, syntheticRuntime, async () => Response.json({ messageId: 'expiry-provider' }, { status: 201 }))
    const event = normalizeBrevoCallback({ id: 100, event: 'delivered', 'X-Mailin-custom': `lifecycle:v1:${pointer.outboxId}:1`, 'message-id': 'expiry-provider', ts_event: 1792000000 })!
    if (boundary === 'receipt-only') await applyBrevoCallback(event, database)
    await database.prepare("UPDATE notification_outbox SET terminal_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days', '+0.3 seconds') WHERE id = ?").bind(pointer.outboxId).run()
    assert.equal(query("SELECT julianday(terminal_at) + 30 > julianday('now') AS live FROM notification_outbox")[0]!.live, 1)
    const original = query('SELECT * FROM notification_outbox')
    const contacts = query('SELECT * FROM notification_contacts')
    const waitExpired = async () => {
      const deadline = performance.now() + 3000
      while (query("SELECT julianday(terminal_at) + 30 <= julianday('now') AS expired FROM notification_outbox")[0]!.expired !== 1) {
        assert.ok(performance.now() < deadline, 'real SQLite clock must cross the seeded expiry')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    const observed: NotificationDatabase = { ...database, batch: async statements => {
      if (boundary === 'between-statements') {
        const first = statements[0]!, run = first.run
        first.run = async () => { const result = await run(); await waitExpired(); return result }
      } else {
        await waitExpired()
        if (boundary === 'receipt-only' || boundary === 'all-clear') {
          if (boundary === 'receipt-only') for (let i = 0; i < 1999; i++) await database.prepare("INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES ('expiry-fixture', '2020-01-01', '2020-01-02')").run()
          const result = await drainNotificationMessages({ notificationDatabase: database, notificationMessagesQueue: { send: async () => {} } }, {}, { planning: false })
          assert.equal(result.lifecycleExpiry?.evidenceCleared, boundary === 'all-clear' ? 1 : 0)
          assert.equal(result.lifecycleExpiry?.receiptsDeleted, boundary === 'receipt-only' ? 1 : 0)
        }
      }
      return database.batch(statements)
    } }
    const globals = globalThis as typeof globalThis & { useRuntimeConfig?: unknown }
    const previous = globals.useRuntimeConfig
    globals.useRuntimeConfig = () => ({ brevoCallbackSecret: 'expiry-callback-secret' })
    const route = (await import('../server/api/notifications/brevo-events.post.ts')).default
    const app = createApp()
    app.use('/', eventHandler(event => { event.context._platform = { cloudflare: { env: { DB: observed } } }; return route(event) }))
    const server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/`, { method: 'POST', headers: { authorization: 'Bearer expiry-callback-secret' }, body: JSON.stringify({ id: 101, event: 'hard_bounce', 'X-Mailin-custom': event.deliveryId, 'message-id': 'expiry-provider', ts_event: 1792000000 }) })
      assert.equal(response.status, 202)
      assert.deepEqual(query('SELECT * FROM notification_contacts'), contacts)
      assert.equal(query('SELECT count(*) n FROM notification_suppressions')[0]!.n, 0)
      assert.equal(query('SELECT count(*) n FROM notification_lifecycle_email_callbacks')[0]!.n, boundary === 'between-statements' ? 1 : 0)
      if (boundary !== 'all-clear') assert.deepEqual(query('SELECT * FROM notification_outbox'), original)
    } finally { globals.useRuntimeConfig = previous; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})

test('terminal lifecycle metadata is fail-closed while a live early claim remains authoritative', async t => {
  for (const terminal of [null, 'invalidated-null', 'missing-attempt', 'not-a-date', '9999-not-a-date', '9999-12-31T00:00:00.000Z', '9999-02-30T00:00:00.000Z', '2026-10-15T25:00:00.000Z', '2026-10-15', 'early-claim']) await t.test(String(terminal), async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config })
    const pointer = pointerFor(query)
    await dispatchNotificationQueueMessage({ id: 'metadata', body: pointer }, { database, config }, syntheticRuntime, async () => Response.json({ messageId: 'metadata-provider' }, { status: 201 }))
    if (terminal !== 'missing-attempt') await database.prepare('UPDATE notification_outbox SET terminal_at = ?').bind(terminal === 'early-claim' || terminal === 'invalidated-null' ? null : terminal).run()
    if (terminal === 'missing-attempt') await database.prepare('UPDATE notification_outbox SET email_attempted_at = NULL').run()
    if (terminal === 'invalidated-null') await database.prepare("UPDATE notification_outbox SET status = 'invalidated'").run()
    if (terminal === 'early-claim') await database.prepare("UPDATE notification_outbox SET status = 'claimed', version = email_attempt_version, claim_token = 'early-claim', claim_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minute')").run()
    const before = query('SELECT * FROM notification_outbox')
    const event = normalizeBrevoCallback({ id: 200, event: 'hard_bounce', 'X-Mailin-custom': `lifecycle:v1:${pointer.outboxId}:1`, 'message-id': 'metadata-provider', ts_event: 1792000000 })!
    const result = await applyBrevoCallback(event, database)
    assert.deepEqual(result, { applied: terminal === 'early-claim', suppressed: terminal === 'early-claim' })
    if (terminal !== 'early-claim') {
      assert.deepEqual(query('SELECT * FROM notification_outbox'), before)
      assert.equal(query('SELECT count(*) n FROM notification_contacts')[0]!.n, 1)
      assert.equal(query('SELECT count(*) n FROM notification_lifecycle_email_callbacks')[0]!.n, 0)
      assert.equal(query('SELECT count(*) n FROM notification_suppressions')[0]!.n, 0)
    }
  })
})

test('minute lifecycle retention shares spare abuse capacity and preserves original evidence owners and unrelated history', async t => {
  const globals = globalThis as typeof globalThis & { defineTask?: unknown }
  const previous = globals.defineTask
  globals.defineTask = (task: unknown) => task
  try {
    const { drainNotificationMessages } = await import('../server/tasks/notification-messages.ts')
    for (const scenario of ['idle', 'all-kinds', 'saturated', 'spare-500', 'spare-one', 'four-pages', 'rollback', 'accounting-failure']) await t.test(scenario, async () => {
      const { database, query } = disposableDatabase()
      const now = new Date('2026-12-01T12:00:00.000Z')
      const owners: { id: string, kind: string }[] = []
      for (const kind of ['first-activation', 'management-recovery', 'reactivation']) {
        const activation = { ...input, contact: `${kind}@example.test` }
        await activateNotificationChannel(activation, { database, config, ...(kind === 'reactivation' ? { crypto: predictableCrypto } : {}) })
        if (kind === 'management-recovery') await requestNotificationManagementRecovery(activation, { database, config })
        if (kind === 'reactivation') { await stopNotificationChannel(initialToken, { database, config }); await activateNotificationChannel(activation, { database, config }) }
        const row = query(`SELECT id, version FROM notification_outbox WHERE kind = '${kind}' AND status = 'pending'`)[0]!
        let capability = ''
        await dispatchNotificationQueueMessage({ id: 'retention', body: { outboxId: row.id, version: row.version } }, { database, config }, syntheticRuntime, async (_url, request) => {
          capability = /manage\/([A-Za-z0-9_-]{43})/.exec(JSON.parse(request!.body as string).textContent)![1]!
          return Response.json({ messageId: 'retention-provider' }, { status: 201 })
        })
        await applyBrevoCallback(normalizeBrevoCallback({ id: 1, event: 'delivered', 'X-Mailin-custom': `lifecycle:v1:${row.id}:1`, 'message-id': 'retention-provider', ts_event: 1792000000 })!, database)
        await stopNotificationChannel(capability, { database, config })
        owners.push({ id: row.id as string, kind })
      }
      for (const [index, owner] of owners.entries()) await database.prepare('UPDATE notification_outbox SET terminal_at = ? WHERE id = ?').bind(new Date(now.getTime() - 30 * 86400000 + (scenario === 'all-kinds' ? -1 : index === 0 ? 1 : index === 1 ? 0 : -1)).toISOString(), owner.id).run()
      // Existing schema permits corrupt terminal metadata: diagnose it, never clear it as expired.
      await database.prepare("INSERT INTO notification_outbox SELECT 'malformed-retention', contact_id, version, expected_capability_generation, status, claim_token, claim_expires_at, payload_ciphertext, payload_iv, kind, created_at, updated_at, 'not-a-date', email_destination_hash, email_provider_message_id, email_delivery_status, email_attempted_at, email_attempt_version FROM notification_outbox WHERE id = ?").bind(owners[2]!.id).run()
      await database.prepare("INSERT INTO notification_outbox (id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at) VALUES ('pending-sentinel', 1, 1, 'queued', 'keep-payload', 'keep-iv', 'first-activation', '2020-01-01', '2020-01-01')").run()
      await database.prepare("UPDATE notification_outbox SET terminal_at = '2020-01-01T00:00:00.000Z', email_destination_hash = (SELECT email_destination_hash FROM notification_outbox WHERE id = ?), email_attempt_version = 1, email_attempted_at = '2020-01-01T00:00:00.000Z', email_delivery_status = 'pending' WHERE id = 'pending-sentinel'").bind(owners[2]!.id).run()
      await database.prepare("INSERT INTO notification_lifecycle_email_callbacks (receipt_key, outbox_id, attempt_version, event, provider_message_id, received_at) VALUES (?, 'pending-sentinel', 1, 'delivered', 'pending-provider', '2020-01-01T00:00:00.000Z')").bind('e'.repeat(64)).run()
      await activateNotificationChannel({ ...input, channel: 'sms', contact: '+420777123456' }, { database, config: { ...config, smsDeliveryReady: true, eventSmsOutboxSupported: true } })
      await database.prepare("UPDATE notification_outbox SET status = 'queued' WHERE contact_id IN (SELECT id FROM notification_contacts WHERE channel = 'sms')").run()
      await database.prepare("INSERT INTO notification_contacts (channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) SELECT 'web-push', 'https://push.example.test/retention', destination_hash, 'push-retention-digest', capability_generation, state, consent_at, consent_version, created_at, updated_at FROM notification_contacts WHERE channel = 'sms'").run()
      await database.prepare("INSERT INTO notification_event_deliveries (id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES ('retention-event', 1, 'event-hash', 'sentinel', 1, 'created', 'delivered', '2020-01-01', '2020-01-01')").run()
      await database.prepare("INSERT INTO notification_delivery_callbacks (provider_event_id, delivery_id, event, received_at) VALUES ('retention-event-receipt', 'retention-event', 'delivered', '2020-01-01')").run()
      const extra = scenario === 'four-pages' ? 2600 : scenario === 'spare-500' || scenario === 'spare-one' ? 600 : 0
      for (let i = 0; i < extra; i++) await database.prepare("INSERT INTO notification_lifecycle_email_callbacks (receipt_key, outbox_id, attempt_version, event, provider_message_id, received_at) VALUES (?, ?, 1, 'delivered', 'retention-provider', '2026-10-01T00:00:00.000Z')").bind(i.toString(16).padStart(64, '0'), owners[2]!.id).run()
      const abuse = scenario === 'saturated' ? 2501 : scenario === 'spare-500' ? 1500 : scenario === 'spare-one' ? 1999 : 0
      for (let i = 0; i < abuse; i++) await database.prepare("INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES ('private-requester-sentinel', '2026-11-29', '2026-11-30')").run()
      const before = query('SELECT * FROM notification_outbox')
      const receiptsBefore = query('SELECT * FROM notification_lifecycle_email_callbacks')
      const suppressions = query('SELECT * FROM notification_suppressions')
      const siblings = query('SELECT * FROM notification_contacts')
      const eventHistory = query('SELECT * FROM notification_event_deliveries'), eventReceipts = query('SELECT * FROM notification_delivery_callbacks')
      let mutations = 0
      const observed: NotificationDatabase = { ...database, prepare: sql => {
        const statement = database.prepare(sql)
        if (sql.startsWith('DELETE FROM notification_lifecycle_email_callbacks') || sql.startsWith('UPDATE notification_outbox SET email_destination_hash = NULL')) {
          mutations++
          if (scenario === 'rollback') {
            const run = statement.run
            statement.run = () => database.batch([{ ...statement, run }, database.prepare("INSERT INTO notification_lifecycle_email_callbacks (receipt_key) VALUES ('invalid')")])
          }
        }
        if (scenario === 'accounting-failure' && sql.includes('AS remaining') && sql.includes('notification_lifecycle_email_callbacks')) statement.first = async () => { throw Error('private accounting failure') }
        return statement
      } }
      const logs: unknown[][] = [], info = console.info, warn = console.warn
      console.info = (...args) => { logs.push(args) }; console.warn = (...args) => { logs.push(args) }
      try {
        const drain = () => drainNotificationMessages({ notificationDatabase: observed, notificationMessagesQueue: { send: async () => {} } }, new Proxy({}, { get() { throw Error('private configuration must not be read') } }), { planning: false, now: () => now })
        if (scenario === 'rollback' || scenario === 'accounting-failure') await assert.rejects(drain(), /Notification lifecycle email expiry failed/)
        else {
          const result = await drain()
          const expectedReceipts = scenario === 'saturated' ? 0 : scenario === 'spare-500' ? 500 : scenario === 'spare-one' ? 1 : scenario === 'four-pages' ? 2000 : scenario === 'all-kinds' ? 3 : 2
          assert.equal(result.lifecycleExpiry?.receiptsDeleted, expectedReceipts)
          assert.equal(result.lifecycleExpiry?.evidenceCleared, scenario === 'idle' ? 2 : scenario === 'all-kinds' ? 3 : 0)
          assert.ok(result.expired! + result.lifecycleExpiry!.receiptsDeleted + result.lifecycleExpiry!.evidenceCleared <= 2000)
          assert.equal(result.expired, Math.min(abuse, 2000))
          assert.equal(result.remainingExpired, Math.max(abuse - 2000, 0))
          assert.equal(result.lifecycleExpiry?.malformedOwnersAtLeast, 1)
          assert.equal(result.lifecycleExpiry?.remainingReceiptsAtLeast, Math.min(extra + (scenario === 'all-kinds' ? 3 : 2) - expectedReceipts, 501))
          assert.equal(result.lifecycleExpiry?.receiptBacklogTruncated, scenario === 'four-pages' || scenario === 'spare-one')
          assert.equal(result.lifecycleExpiry?.remainingEvidenceAtLeast, scenario === 'idle' || scenario === 'all-kinds' ? 0 : 2)
        }
        if (scenario === 'rollback') {
          assert.deepEqual(query('SELECT * FROM notification_outbox'), before)
          assert.deepEqual(query('SELECT * FROM notification_lifecycle_email_callbacks'), receiptsBefore)
        }
        assert.ok(mutations <= 4)
        for (const row of query('SELECT * FROM notification_outbox')) {
          const old = before.find(candidate => candidate.id === row.id)!
          for (const field of Object.keys(old).filter(field => !field.startsWith('email_'))) assert.equal(row[field], old[field], `${row.id}/${field}`)
          if (row.id === owners[0]!.id && scenario !== 'all-kinds' || row.id === 'malformed-retention' || !['idle', 'all-kinds', 'accounting-failure'].includes(scenario)) assert.deepEqual(row, old)
        }
        assert.equal(query('SELECT count(*) n FROM notification_outbox')[0]!.n, before.length)
        assert.deepEqual(query('SELECT * FROM notification_suppressions'), suppressions)
        assert.deepEqual(query('SELECT * FROM notification_contacts'), siblings)
        assert.deepEqual(query('SELECT * FROM notification_event_deliveries'), eventHistory)
        assert.deepEqual(query('SELECT * FROM notification_delivery_callbacks'), eventReceipts)
        const logged = JSON.stringify(logs)
        assert.ok(logged.includes('Lifecycle email expiry backlog'))
        const report = logs.find(entry => String(entry[0]).includes('Lifecycle email expiry backlog'))![1] as { failed: boolean, remainingWorkRows: number | null, remainingReceiptsAtLeast: number | null, receiptsDeleted: number, evidenceCleared: number }
        if (scenario === 'rollback' || scenario === 'accounting-failure') {
          assert.equal(report.failed, true)
          assert.equal(report.remainingWorkRows, null)
          assert.equal(report.remainingReceiptsAtLeast, scenario === 'accounting-failure' ? null : 2)
          assert.equal(report.receiptsDeleted, scenario === 'rollback' ? 0 : 2)
          assert.equal(report.evidenceCleared, scenario === 'rollback' ? 0 : 2)
        }
        for (const secret of ['private-requester-sentinel', 'retention-provider', 'example.test', 'email_destination_hash', 'keep-payload']) assert.ok(!logged.includes(secret))
      } finally { console.info = info; console.warn = warn }
    })
  } finally { globals.defineTask = previous }
})

test('lifecycle final reservation loses to stop and an ambiguous reserved crash never resubmits', async t => {
  for (const scenario of ['stop-before-cas', 'crash-after-cas']) await t.test(scenario, async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    const pointer = pointerFor(query)
    let reserved = false, calls = 0
    const observed: NotificationDatabase = { ...database, prepare: sql => {
      const statement = database.prepare(sql)
      if (sql.includes('email_attempt_version = version')) {
        const run = statement.run
        statement.run = async () => {
          if (scenario === 'stop-before-cas') await stopNotificationChannel(initialToken, { database, config })
          const result = await run()
          if (scenario === 'crash-after-cas') { reserved = true; throw Error('synthetic post-commit process loss') }
          return result
        }
      }
      return statement
    } }
    const dispatch = () => dispatchNotificationQueueMessage({ id: scenario, body: pointer }, { database: observed, config }, syntheticRuntime, async () => { calls++; return Response.json({ messageId: 'unexpected' }, { status: 201 }) })
    if (scenario === 'crash-after-cas') await assert.rejects(dispatch(), /post-commit process loss/)
    else await dispatch()
    await dispatch()
    assert.equal(calls, 0)
    assert.equal(reserved, scenario === 'crash-after-cas')
    const row = query('SELECT * FROM notification_outbox')[0]!
    assert.equal(row.payload_ciphertext, null)
    assert.equal(row.email_attempt_version, reserved ? pointer.version : null)
    assert.ok(row.terminal_at)
  })
})

test('Portal plugin plans against top-level DB and publishes committed pointers before unrelated Google configuration', async () => {
  const globals = globalThis as typeof globalThis & { defineNitroPlugin?: unknown, useStorage?: unknown, useRuntimeConfig?: unknown, $fetch?: unknown }
  const previous = { defineNitroPlugin: globals.defineNitroPlugin, useStorage: globals.useStorage, useRuntimeConfig: globals.useRuntimeConfig, $fetch: globals.$fetch }
  globals.defineNitroPlugin = (plugin: unknown) => plugin
  try {
    const { default: plugin } = await import('../server/plugins/portalEventsQueue.ts')
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config })
    const snapshots = new Map<string, unknown>()
    globals.useStorage = () => ({ getItem: async (key: string) => snapshots.get(key), setItem: async (key: string, value: unknown) => { snapshots.set(key, value) } })
    const runtime = { notificationRootKey: root, notificationTurnstileSecret: 'synthetic', notificationTurnstileExpectedHostname: 'jednadvacet.org' }
    let googleReads = 0
    globals.useRuntimeConfig = () => new Proxy(runtime, { get(target, key) {
      if (String(key).startsWith('google')) {
        googleReads++
        assert.ok(query("SELECT id FROM notification_outbox WHERE status = 'queued'").length > 0, 'publication precedes Google config')
        throw Error('synthetic unrelated Google failure')
      }
      return Reflect.get(target, key)
    } })
    globals.$fetch = async (url: string) => {
      const request = new URL(url)
      assert.equal(request.pathname, '/api/meetup-events')
      assert.equal(request.searchParams.get('meetup_id'), '360')
      assert.equal(request.searchParams.get('from'), 'today')
      return [{ id: 12, meetup_id: 360, title: 'Synthetic future meetup', start: new Date(Date.now() + 86400000).toISOString().slice(0, 16).replace('T', ' '), end: null }]
    }
    let hook!: (event: unknown) => Promise<void>
    ;(plugin as unknown as (app: unknown) => void)({ hooks: { hook: (_name: string, handler: typeof hook) => { hook = handler } } })
    const sent: unknown[] = []
    await assert.rejects(hook({ batch: { queue: 'portal-events', messages: [{ id: 'portal-synthetic', body: { kind: 'refresh-all' } }] }, env: { DB: database, NOTIFICATION_MESSAGES_QUEUE: { send: async (pointer: unknown) => {
      assert.ok(query('SELECT uid FROM notification_event_state').length > 0, 'planner committed before wake')
      sent.push(pointer)
    } } }, context: { waitUntil: () => {}, portalCommunities: [{ id: 'brno', path: '/brno', title: 'Brno', portalMeetupId: 360 }] } }), /synthetic unrelated Google failure/)
    assert.equal(googleReads, 1)
    assert.deepEqual(sent, [pointerFor(query)])
    assert.equal(snapshots.size, 1)
    assert.equal(query('SELECT count(*) n FROM notification_event_state')[0]!.n, 1)
  } finally { Object.assign(globals, previous) }
})

const calendarEvent: PortalCalendarEvent = {
  event: { id: '12', title: 'Synthetic meetup', start: '2026-10-12T12:00:00.000Z', end: null, location: 'Synthetic venue', tags: [] },
  community: { id: 'brno', path: '/brno', title: 'Brno' }, sequence: 4, changedAt: '2026-10-04T00:00:00.000Z', cancelled: false,
}

test('minute drain expires idle attempts at the exact 24h edge without reading calendar or private configuration', async t => {
  const globals = globalThis as typeof globalThis & { defineTask?: unknown }
  const previous = globals.defineTask
  globals.defineTask = (task: unknown) => task
  try {
    const { drainNotificationMessages } = await import('../server/tasks/notification-messages.ts')
    for (const count of [0, 500, 2000, 2001]) await t.test(String(count), async () => {
      const { database, query } = disposableDatabase()
      const now = new Date('2026-10-14T12:00:00.000Z')
      for (let i = 0; i < count; i++) await database.prepare('INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES (?, ?, ?)').bind('synthetic-private-requester', '2026-10-13T11:59:59.999Z', '2026-10-14T11:59:59.999Z').run()
      for (const expires of ['2026-10-14T12:00:00.000Z', '2026-10-14T12:00:00.001Z']) await database.prepare('INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES (?, ?, ?)').bind('synthetic-edge', new Date(Date.parse(expires) - 86400000).toISOString(), expires).run()
      let reads = 0
      let pages = 0
      const observed: NotificationDatabase = { ...database, prepare: sql => {
        if (sql.startsWith('DELETE FROM notification_abuse_attempts')) pages++
        return database.prepare(sql)
      } }
      const logs: unknown[][] = []
      const info = console.info, warn = console.warn
      console.info = (...args) => { logs.push(args) }; console.warn = (...args) => { logs.push(args) }
      try {
        const result = await drainNotificationMessages({ notificationDatabase: observed, notificationMessagesQueue: { send: async () => {} }, portalStorage: { getItem: async () => { reads++; throw Error('calendar must not be read') }, setItem: async () => {} } }, new Proxy({}, { get() { throw Error('private configuration must not be read') } }), { planning: false, now: () => now })
        assert.equal(result.planned, null, 'disabled planning is distinct from successful zero planning')
        assert.equal(result.expired, Math.min(count + 1, 2000))
        assert.equal(result.remainingExpired, Math.max(count + 1 - 2000, 0))
        assert.equal(result.oldestExpiredAt, count === 2001 ? '2026-10-14T11:59:59.999Z' : count === 2000 ? '2026-10-14T12:00:00.000Z' : null)
        assert.ok(pages <= 4)
        assert.equal(reads, 0)
        assert.deepEqual(query('SELECT expires_at FROM notification_abuse_attempts ORDER BY expires_at').map(row => row.expires_at), [...(count === 2001 ? ['2026-10-14T11:59:59.999Z'] : []), ...(count >= 2000 ? ['2026-10-14T12:00:00.000Z'] : []), '2026-10-14T12:00:00.001Z'])
        assert.ok(JSON.stringify(logs).includes('Attempt expiry backlog'))
        assert.ok(!JSON.stringify(logs).includes('synthetic-private-requester'))
      } finally { console.info = info; console.warn = warn }
    })
  } finally { globals.defineTask = previous }
})

test('minute cleanup commits before missing Queue/config and partial publisher failures, retaining exact unfinished rows', async t => {
  const globals = globalThis as typeof globalThis & { defineTask?: unknown }
  const previous = globals.defineTask
  globals.defineTask = (task: unknown) => task
  try {
    const { drainNotificationMessages } = await import('../server/tasks/notification-messages.ts')
    for (const failure of ['missing-queue', 'send', 'cleanup']) await t.test(failure, async () => {
      const { database, query } = disposableDatabase()
      await activateNotificationChannel(input, { database, config })
      const original = pointerFor(query)
      await database.prepare("INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at) SELECT 'second', contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, '2099-01-01T00:00:00.000Z', updated_at FROM notification_outbox").run()
      const before = query("SELECT * FROM notification_outbox WHERE id = 'second'")
      for (let i = 0; i < 501; i++) await database.prepare('INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES (?, ?, ?)').bind('synthetic', '2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z').run()
      let pages = 0, sends = 0
      const failing: NotificationDatabase = { ...database, prepare: sql => {
        const statement = database.prepare(sql)
        if (failure === 'cleanup' && sql.startsWith('DELETE FROM notification_abuse_attempts') && ++pages === 2) statement.run = async () => { throw Error('private SQL failure') }
        return statement
      } }
      await assert.rejects(drainNotificationMessages({ notificationDatabase: failing, ...(failure === 'missing-queue' ? {} : { notificationMessagesQueue: { send: async () => { if (++sends === 2) throw Error('private Queue failure') } } }) }, {}, { planning: false, now: () => new Date('2026-10-14T00:00:00Z') }), /Notification (messages queue is not configured|pointer publication failed|attempt expiry failed)/)
      assert.equal(query('SELECT count(*) n FROM notification_abuse_attempts')[0]!.n, failure === 'cleanup' ? 1 : 0)
      assert.deepEqual(query("SELECT * FROM notification_outbox WHERE id = 'second'"), before)
      assert.equal(query(`SELECT status FROM notification_outbox WHERE id = '${original.outboxId}'`)[0]!.status, failure === 'send' ? 'queued' : 'pending')
      assert.equal(sends, failure === 'send' ? 2 : 0)
    })
    await assert.rejects(drainNotificationMessages({}, {}, { planning: false }), /^Error: Notification database is not configured$/)
  } finally { globals.defineTask = previous }
})

test('notification plugin accepts installed top-level env and reads supplied SQL while legacy flags cannot authorize send', async () => {
  const globals = globalThis as typeof globalThis & { useRuntimeConfig?: unknown, fetch: typeof fetch }
  const previous = globals.useRuntimeConfig, previousFetch = globals.fetch
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config })
  let reads = 0, calls = 0
  const observed: NotificationDatabase = { ...database, prepare: sql => { reads++; return database.prepare(sql) } }
  let hook!: (event: unknown) => Promise<void>
  // This directly registered plugin boundary is not emitted Worker proof.
  ;(notificationQueuePlugin as unknown as (app: unknown) => void)({ hooks: { hook: (_name: string, handler: typeof hook) => { hook = handler } } })
  globals.useRuntimeConfig = () => ({ notificationRootKey: root, notificationTurnstileSecret: 'synthetic', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationProductionBindingsVerified: true, notificationMigrationVerified: true, brevoSenderVerified: true })
  globals.fetch = async () => { calls++; throw Error('provider must not be called') }
  try {
    await hook({ batch: { queue: 'notification-messages', messages: [{ id: 'synthetic', body: pointerFor(query) }] }, env: { DB: observed }, context: { waitUntil: () => {} } })
    assert.ok(reads > 0)
    assert.equal(calls, 0)
    assert.deepEqual(query('SELECT status, payload_ciphertext FROM notification_outbox'), [{ status: 'invalidated', payload_ciphertext: null }])
    await assert.rejects(hook({ batch: { queue: 'notification-messages', messages: [] }, env: {}, context: { waitUntil: () => {} } }), /Notification database is not configured/)
  } finally { globals.useRuntimeConfig = previous; globals.fetch = previousFetch }
})

test('registered minute framework task preserves the rolling abuse window and never obtains runtime configuration', async () => {
  const globals = globalThis as typeof globalThis & { defineTask?: unknown, useRuntimeConfig?: unknown }
  const previous = { defineTask: globals.defineTask, useRuntimeConfig: globals.useRuntimeConfig }
  globals.defineTask = (task: unknown) => task
  globals.useRuntimeConfig = () => { throw Error('minute task must not obtain runtime configuration') }
  try {
    const { default: task } = await import('../server/tasks/notification-publication.ts')
    const { evaluateNotificationAbuse } = await import('../server/utils/notificationAbuse.ts')
    const { database, query } = disposableDatabase()
    const current = new Date()
    // Real policy writes five attempts that will still be inside their 24h window
    // while the framework task's real clock runs (no scheduledTime clock shortcut).
    for (let i = 0; i < 5; i++) assert.deepEqual(await evaluateNotificationAbuse('192.0.2.23', undefined, { database, config, now: () => new Date(current.getTime() - 86400000 + 600000 + i * 61000) }), { allowed: true })
    const before = query('SELECT * FROM notification_abuse_attempts')
    const result = await task.run({ payload: {}, context: { cloudflare: { env: { DB: database, NOTIFICATION_MESSAGES_QUEUE: { send: async () => {} } }, context: { waitUntil: () => {} } } } })
    assert.equal(result.result?.planned, null)
    assert.deepEqual(query('SELECT * FROM notification_abuse_attempts'), before)
    assert.deepEqual(await evaluateNotificationAbuse('192.0.2.23', undefined, { database, config, now: () => current }), { allowed: false, reason: 'challenge-required' })
    assert.equal(query('SELECT count(*) n FROM notification_abuse_attempts')[0]!.n, 6)
  } finally { Object.assign(globals, previous) }
})

const jointFixture = async () => {
  const fixture = disposableDatabase()
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const contact = { endpoint: 'https://push.example.test/subscription', keys: { p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))), auth: encode(new Uint8Array(16)) } }
  const ready = { ...config, smsDeliveryReady: true, eventSmsOutboxSupported: true, webPushDeliveryReady: true, eventWebPushOutboxSupported: true, webPushDelivery: { privateKey: vapid.privateKey, publicKey: encode(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey))), subject: 'mailto:test@example.test' } }
  const dependencies = { database: fixture.database, config: ready, now: () => new Date('2026-10-04T10:00:00Z') }
  for (const channel of ['email', 'sms', 'web-push'] as const) await activateNotificationChannel({ ...input, channel, contact: channel === 'email' ? input.contact : channel === 'sms' ? '+420777123456' : contact }, dependencies)
  return { ...fixture, dependencies, receiver, contact }
}

test('first Web Push confirms the subscribed community and only provider submission is recorded', async () => {
  const { query, dependencies, receiver, contact } = await jointFixture()
  const config = { ...dependencies.config, communitySlugs: ['brno', 'praha'], communityTitles: { brno: 'Brno' } }
  const row = query("SELECT o.id, o.version FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id WHERE c.channel = 'web-push'")[0]!
  let calls = 0
  const result = await dispatchNotificationQueueMessage({ id: 'first-push', body: { outboxId: row.id, version: row.version } }, { ...dependencies, config }, {}, async (_url, request) => {
    calls++
    assert.equal(request?.redirect, 'manual')
    const body = Buffer.from(request!.body as ArrayBuffer)
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from((await crypto.subtle.exportKey('jwk', receiver.privateKey)).d!, 'base64url'))
    const shared = ecdh.computeSecret(body.subarray(21, 86))
    const ikm = hkdfSync('sha256', shared, Buffer.from(contact.keys.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(contact.keys.p256dh, 'base64url'), body.subarray(21, 86)]), 32)
    const key = hkdfSync('sha256', Buffer.from(ikm), body.subarray(0, 16), Buffer.from('Content-Encoding: aes128gcm\0'), 16)
    const nonce = hkdfSync('sha256', Buffer.from(ikm), body.subarray(0, 16), Buffer.from('Content-Encoding: nonce\0'), 12)
    const decipher = createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce))
    decipher.setAuthTag(body.subarray(-16))
    const plaintext = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()])
    const message = JSON.parse(plaintext.subarray(0, -1).toString())
    assert.equal(message.body, 'Odebíráš upozornění pro Brno.')
    assert.ok(message.url.startsWith('/notifications/manage/'))
    return new Response(null, { status: 201 })
  })
  assert.equal(result.delivered, true)
  assert.equal(calls, 1)
})

test('an edited event rejects its published stale pointer and authorizes its carried replacement once', async () => {
  const { database, query, dependencies } = await jointFixture()
  await planEventNotifications([calendarEvent], dependencies)
  const published: { outboxId: string, version: number }[] = []
  await publishPendingNotificationPointers({ send: async pointer => { published.push(pointer) } }, dependencies)
  const original = published.find(pointer => pointer.outboxId === query("SELECT id FROM notification_outbox WHERE kind = 'event-email'")[0]!.id)!
  const changed = { ...calendarEvent, changedAt: '2026-10-05T00:00:00.000Z', event: { ...calendarEvent.event, location: 'Replacement venue' } }
  assert.equal((await planEventNotifications([changed], dependencies)).planned, 3)
  await publishPendingNotificationPointers({ send: async pointer => { published.push(pointer) } }, dependencies)
  const replacementId = query("SELECT id FROM notification_outbox WHERE kind = 'event-email' AND status = 'queued'")[0]!.id as string
  const replacement = published.find(pointer => pointer.outboxId === replacementId)!
  let calls = 0
  const deliver = async (_payload: Parameters<typeof consumeNotificationOutboxPointer>[2] extends (payload: infer Payload, ...args: never[]) => unknown ? Payload : never, _authorization: never, authorize: (signal?: AbortSignal) => Promise<boolean>) => {
    if (await authorize()) calls++
    return { attempted: true, status: 'submitted' as const, providerMessageId: 'replacement' }
  }
  assert.deepEqual(await consumeNotificationOutboxPointer(original, dependencies, deliver), { delivered: false, stale: true })
  assert.deepEqual(await consumeNotificationOutboxPointer(replacement, dependencies, deliver), { delivered: true, stale: false })
  assert.deepEqual(await consumeNotificationOutboxPointer(replacement, dependencies, deliver), { delivered: false, stale: true })
  assert.equal(calls, 1)
})

test('a missed same-day reminder publishes and authorizes one catch-up delivery', async () => {
  const { database, query, dependencies } = await jointFixture()
  await database.prepare("UPDATE notification_subscriptions SET frequency = 'day-before'").run()
  await planEventNotifications([calendarEvent], dependencies)
  const catchUp = { ...dependencies, now: () => new Date('2026-10-11T08:15:00.000Z') }
  assert.equal((await planEventNotifications([calendarEvent], catchUp)).planned, 3)
  const published: { outboxId: string, version: number }[] = []
  await publishPendingNotificationPointers({ send: async pointer => { published.push(pointer) } }, catchUp)
  const email = published.find(pointer => pointer.outboxId === query("SELECT id FROM notification_outbox WHERE kind = 'event-email' AND status = 'queued'")[0]!.id)!
  let calls = 0
  const deliver = async (_payload: Parameters<typeof consumeNotificationOutboxPointer>[2] extends (payload: infer Payload, ...args: never[]) => unknown ? Payload : never, _authorization: never, authorize: (signal?: AbortSignal) => Promise<boolean>) => {
    if (await authorize()) calls++
    return { attempted: true, status: 'submitted' as const, providerMessageId: 'catch-up' }
  }
  assert.deepEqual(await consumeNotificationOutboxPointer(email, catchUp, deliver), { delivered: true, stale: false })
  assert.deepEqual(await consumeNotificationOutboxPointer(email, catchUp, deliver), { delivered: false, stale: true })
  assert.equal(calls, 1)
})

for (const channel of ['email', 'sms'] as const) for (const work of ['lifecycle', 'event']) for (const phase of (channel === 'sms' && work === 'lifecycle' ? ['schema', 'read'] : ['schema', 'read', 'reservation'])) test(`deadline during ${work} ${channel} final ${phase} cannot resume provider or new SQL`, { timeout: 10000 }, async t => {
  const { database, query, dependencies } = await jointFixture()
  if (work === 'event') await planEventNotifications([calendarEvent], dependencies)
  const row = query(`SELECT id, version FROM notification_outbox WHERE kind = '${work === 'event' ? `event-${channel}` : 'first-activation'}' AND contact_id IN (SELECT id FROM notification_contacts WHERE channel = '${channel}')`)[0]!
  const pointer = { outboxId: row.id, version: row.version }
  let schemas = 0, reads = 0, operations = 0, calls = 0
  let entered = false
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const delayed: NotificationDatabase = { ...database, prepare: sql => {
    operations++
    const statement = database.prepare(sql)
    if (sql.startsWith('SELECT d.channel')) {
      const all = statement.all
      statement.all = async <T>() => {
        if (++schemas === 2 && phase === 'schema') { entered = true; await paused }
        return all<T>()
      }
    }
    if (sql.startsWith('SELECT o.expected_capability_generation')) {
      const first = statement.first
      statement.first = async <T>() => {
        const result = await first<T>()
        if (++reads === 2 && phase === 'read') { entered = true; await paused }
        return result
      }
    }
    if (sql.startsWith('UPDATE notification_event_deliveries SET submitted_at = ?') || sql.startsWith('UPDATE notification_outbox SET\n')) {
      const run = statement.run
      statement.run = async () => {
        const result = await run()
        if (phase === 'reservation') { entered = true; await paused }
        return result
      }
    }
    return statement
  } }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let settled = false
  const dispatch = dispatchNotificationQueueMessage({ id: 'deadline-authority', body: pointer }, { ...dependencies, database: delayed }, syntheticRuntime, async () => { calls++; return Response.json({ messageId: 123 }, { status: 201 }) }).then(result => { settled = true; return result }, error => { settled = true; return error })
  while (!entered && !settled) await setImmediate()
  assert.equal(entered, true)
  t.mock.timers.tick(10_000)
  await setImmediate()
  assert.equal(settled, true, 'adapter settles while an already issued database operation is pending')
  await dispatch
  const count = operations
  const evidence = query('SELECT * FROM notification_outbox')
  release()
  await setImmediate()
  await setImmediate()
  assert.equal(calls, 0, 'late authorization must not invoke the real provider')
  assert.equal(operations, count, 'late I/O completion cannot start further SQL')
  assert.deepEqual(query('SELECT * FROM notification_outbox'), evidence)
})

test('registered default Queue hook bounds real lifecycle/event transports, preserves callbacks and advances following healthy pointers', { timeout: 20000 }, async t => {
  const globals = globalThis as typeof globalThis & { useRuntimeConfig?: unknown }
  const priorRuntime = globals.useRuntimeConfig, priorFetch = globalThis.fetch
  // Unit-boundary inputs only: no native/production evidence is written or claimed.
  const runtime = {
    ...syntheticRuntime, brevoApiKey: 'synthetic-key-at-least-24-characters', brevoCallbackSecret: 'synthetic-callback-at-least-24', brevoSenderEmail: 'noreply@jednadvacet.org', brevoSandbox: true,
    notificationRootKey: root, notificationTurnstileSecret: 'synthetic', notificationTurnstileExpectedHostname: 'jednadvacet.org',
  }
  const configured: Record<string, unknown> = { ...runtime }
  globals.useRuntimeConfig = () => configured
  try {
    for (const channel of ['email', 'sms'] as const) for (const work of ['lifecycle', 'event']) for (const stall of ['headers', 'body']) for (const earlyCallback of (channel === 'email' && stall === 'body' ? [false, true] : [false])) await t.test(`${work} ${channel} ${stall} callback=${earlyCallback}`, async t => {
      const { database, query } = disposableDatabase()
      const ready = await notificationConfig(configured)
      const dependencies = { database, config: ready }
      for (const contact of (channel === 'email' ? ['stalled@example.test', 'healthy@example.test'] : ['+420777123456', '+420777123457'])) await activateNotificationChannel({ ...input, channel, contact }, dependencies)
      if (work === 'event') await planEventNotifications([{ ...calendarEvent, event: { ...calendarEvent.event, start: new Date(Date.now() + 86400000).toISOString() }, changedAt: new Date().toISOString() }], dependencies)
      const rows = query(`SELECT id, version, contact_id FROM notification_outbox WHERE kind = '${work === 'event' ? `event-${channel}` : 'first-activation'}' ORDER BY contact_id`)
      assert.equal(rows.length, 2)
      const [stalled, healthy] = rows.map(row => ({ id: 'synthetic-pointer', body: { outboxId: row.id, version: row.version } }))
      let hook!: (event: unknown) => Promise<void>
      ;(notificationQueuePlugin as unknown as (app: unknown) => void)({ hooks: { hook: (_name: string, handler: typeof hook) => { hook = handler } } })
      const event = (messages: unknown[]) => ({ batch: { queue: 'notification-messages', messages }, env: { DB: database } })
      let calls = 0, cancels = 0, release!: (response: Response) => void
      let signal: AbortSignal | undefined
      const stream = new ReadableStream<Uint8Array>({ cancel() { cancels++; return new Promise(() => {}) } })
      const lateResponse = new Response(stream, { status: 201 })
      globalThis.fetch = async (_url, request) => {
        calls++
        if (calls > 1) return Response.json({ messageId: channel === 'sms' ? 456 : '<healthy@relay.test>' }, { status: 201 })
        signal = request?.signal ?? undefined
        const body = JSON.parse(request!.body as string)
        if (channel === 'email') assert.equal((request!.headers as Record<string, string>)['X-Sib-Sandbox'], 'drop')
        else assert.ok(body.content.length <= 160)
        if (earlyCallback) {
          const callback = normalizeBrevoCallback({ id: 99, event: 'hard_bounce', 'X-Mailin-custom': body.headers['X-Mailin-custom'], 'message-id': '<early@relay.test>', ts_event: Math.floor(Date.now() / 1000) })!
          assert.deepEqual(await applyBrevoCallback(callback, database), { applied: true, suppressed: true })
        }
        return stall === 'body' ? lateResponse : new Promise(resolve => { release = resolve })
      }
      t.mock.timers.enable({ apis: ['setTimeout'] })
      let settled = false
      const run = hook(event(channel === 'email' ? [stalled, healthy] : [stalled])).then(() => { settled = true; return null }, error => { settled = true; return error })
      while (calls === 0 && !settled) await setImmediate()
      assert.equal(calls, 1)
      await setImmediate()
      t.mock.timers.tick(9999)
      await setImmediate()
      assert.equal(settled, false)
      t.mock.timers.tick(1)
      const error = await run
      assert.equal(settled, true)
      assert.equal(signal?.aborted, true)
      if (channel === 'sms') {
        assert.match(String(error), /retryable/)
        assert.equal(query(`SELECT status FROM notification_outbox WHERE id = '${stalled!.body.outboxId}'`)[0]!.status, 'queued')
        if (work === 'event') assert.equal(query("SELECT submitted_at FROM notification_event_deliveries WHERE channel = 'sms' ORDER BY contact_id")[0]!.submitted_at, null)
        await hook(event([healthy]))
        await hook(event([stalled]))
        assert.equal(calls, 3, 'owned SMS transient reservation permits ordinary Queue retry')
      } else {
        assert.equal(error, null)
        await hook(event([stalled]))
        assert.equal(calls, 2, 'attempted email timeout never causes a second provider request')
        assert.equal(query(work === 'event' ? "SELECT status FROM notification_event_deliveries WHERE channel = 'email' ORDER BY contact_id" : "SELECT email_delivery_status AS status FROM notification_outbox WHERE kind = 'first-activation' ORDER BY email_destination_hash").some(row => row.status === (earlyCallback ? 'hard-bounce' : 'failed')), true)
      }
      assert.equal(query(`SELECT status FROM notification_outbox WHERE id = '${healthy!.body.outboxId}'`)[0]!.status, 'consumed')
      const evidence = query('SELECT * FROM notification_outbox'), deliveries = query('SELECT * FROM notification_event_deliveries')
      if (stall === 'headers') release(lateResponse)
      await setImmediate()
      assert.equal(cancels, 1)
      assert.equal(stream.locked, false)
      assert.deepEqual(query('SELECT * FROM notification_outbox'), evidence)
      assert.deepEqual(query('SELECT * FROM notification_event_deliveries'), deliveries)
      assert.equal(query('SELECT count(*) n FROM notification_suppressions')[0]!.n, Number(earlyCallback))
    })
  } finally { globalThis.fetch = priorFetch; globals.useRuntimeConfig = priorRuntime }
})

for (const channel of ['email', 'sms'] as const) for (const work of ['lifecycle', 'event']) for (const change of ['stop', 'lease', 'schema-failure']) test(`${work} ${channel} pending final schema cannot authorize after ${change}`, { timeout: 10000 }, async () => {
  const { database, query, dependencies } = await jointFixture()
  if (work === 'event') await planEventNotifications([calendarEvent], dependencies)
  const row = query(`SELECT * FROM notification_outbox WHERE kind = '${work === 'event' ? `event-${channel}` : 'first-activation'}' AND contact_id IN (SELECT id FROM notification_contacts WHERE channel = '${channel}')`)[0]!
  const payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.payload_iv as string, 'base64url') }, config.outboxTransportKey, Buffer.from(row.payload_ciphertext as string, 'base64url'))))
  let schemas = 0, entered = false, release!: () => void, calls = 0
  const paused = new Promise<void>(resolve => { release = resolve })
  const delayed: NotificationDatabase = { ...database, prepare: sql => {
    const statement = database.prepare(sql)
    if (sql.startsWith('SELECT d.channel')) {
      const all = statement.all
      statement.all = async <T>() => {
        if (++schemas === 2) { entered = true; await paused; if (change === 'schema-failure') throw Error('synthetic schema fault') }
        return all<T>()
      }
    }
    return statement
  } }
  const attempt = dispatchNotificationQueueMessage({ id: 'final-authority', body: { outboxId: row.id, version: row.version } }, { ...dependencies, database: delayed }, syntheticRuntime, async () => { calls++; return Response.json({ messageId: 123 }, { status: 201 }) })
  while (!entered) await setImmediate()
  assert.equal(entered, true)
  if (change === 'stop') await stopNotificationChannel(payload.capability ?? payload.managementCapability, dependencies)
  if (change === 'lease') await database.prepare('UPDATE notification_outbox SET claim_expires_at = ? WHERE id = ?').bind('2026-10-03T00:00:00Z', row.id).run()
  release()
  assert.deepEqual(await attempt, { delivered: false, stale: true })
  assert.equal(calls, 0)
})

for (const work of ['lifecycle', 'event']) for (const change of ['stop', 'recovery']) test(`SMS ${work} timeout only releases still-owned transient work after concurrent ${change}`, { timeout: 10000 }, async t => {
  const { database, query, dependencies } = await jointFixture()
  if (work === 'event') await planEventNotifications([calendarEvent], dependencies)
  const row = query(`SELECT * FROM notification_outbox WHERE kind = '${work === 'event' ? 'event-sms' : 'first-activation'}' AND contact_id IN (SELECT id FROM notification_contacts WHERE channel = 'sms')`)[0]!
  let called = false, calls = 0
  let payload!: Record<string, string>
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const attempt = dispatchNotificationQueueMessage({ id: 'owned-transient', body: { outboxId: row.id, version: row.version } }, dependencies, syntheticRuntime, async (_url, request) => {
    calls++
    payload = JSON.parse(request!.body as string)
    called = true
    return new Promise(() => {})
  })
  const rejected = assert.rejects(attempt, /retryable/)
  while (!called) await setImmediate()
  assert.equal(called, true)
  if (change === 'stop') {
    const encrypted = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.payload_iv as string, 'base64url') }, config.outboxTransportKey, Buffer.from(row.payload_ciphertext as string, 'base64url'))))
    await stopNotificationChannel(encrypted.capability ?? encrypted.managementCapability, dependencies)
  } else await requestNotificationManagementRecovery({ channel: 'sms', contact: '+420777123456' }, dependencies)
  assert.ok(payload.content)
  const evidence = query('SELECT * FROM notification_outbox'), deliveries = query('SELECT * FROM notification_event_deliveries')
  t.mock.timers.tick(10000)
  await rejected
  assert.deepEqual(query('SELECT * FROM notification_outbox'), evidence)
  assert.deepEqual(query('SELECT * FROM notification_event_deliveries'), deliveries, 'lost ownership cannot clear another generation or retired reservation')
  await dispatchNotificationQueueMessage({ id: 'duplicate', body: { outboxId: row.id, version: row.version } }, dependencies, syntheticRuntime, async () => { calls++; return Response.json({ messageId: 123 }, { status: 201 }) })
  assert.equal(calls, 1)
})

test('actual single planner dispatches three transports, encrypted push is independently visible and SMS stop leaves siblings', async () => {
  const { database, query, dependencies, receiver, contact } = await jointFixture()
  const managementOrigin = 'https://jednadvacet.org'
  Object.assign(dependencies.config, { managementOrigin })
  const describedEvent = { ...calendarEvent, event: { ...calendarEvent.event, description: 'Přijď si popovídat o Bitcoinu.' } }
  assert.equal((await planEventNotifications([describedEvent], dependencies)).planned, 3)
  const rows = query("SELECT id, version, kind, payload_ciphertext, payload_iv FROM notification_outbox WHERE kind LIKE 'event-%'")
  assert.equal(rows.length, 3)
  const called: string[] = []
  let smsToken = ''
  for (const row of rows) {
    const outbox = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row.payload_iv as string, 'base64url') }, config.outboxTransportKey, Buffer.from(row.payload_ciphertext as string, 'base64url'))))
    assert.equal((await readNotificationManagement(outbox.managementCapability, dependencies)).state, 'active')
    if (row.kind === 'event-sms') smsToken = outbox.managementCapability
    const fetcher: typeof fetch = async (url, request) => {
      called.push(row.kind as string)
      if (row.kind === 'event-web-push') {
        assert.equal(String(url), contact.endpoint)
        const body = Buffer.from(request!.body as Uint8Array)
        const ecdh = createECDH('prime256v1')
        ecdh.setPrivateKey(Buffer.from((await crypto.subtle.exportKey('jwk', receiver.privateKey)).d!, 'base64url'))
        const shared = ecdh.computeSecret(body.subarray(21, 86))
        const ikm = hkdfSync('sha256', shared, Buffer.from(contact.keys.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(contact.keys.p256dh, 'base64url'), body.subarray(21, 86)]), 32)
        const cek = hkdfSync('sha256', Buffer.from(ikm), body.subarray(0, 16), Buffer.from('Content-Encoding: aes128gcm\0'), 16)
        const nonce = hkdfSync('sha256', Buffer.from(ikm), body.subarray(0, 16), Buffer.from('Content-Encoding: nonce\0'), 12)
        const decipher = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce))
        decipher.setAuthTag(body.subarray(-16))
        const plaintext = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()])
        assert.equal(plaintext.at(-1), 2)
        assert.deepEqual(JSON.parse(plaintext.subarray(0, -1).toString()), { title: calendarEvent.event.title, body: '12. 10. 2026 14:00\nPřijď si popovídat o Bitcoinu.', url: `/${calendarEvent.community.id}` })
        return new Response(null, { status: 201 })
      }
      const body = JSON.parse(request!.body as string)
      if (row.kind === 'event-sms') { assert.equal(body.sender, syntheticRuntime.brevoSmsSender); assert.equal(body.type, 'transactional'); assert.ok(body.content.length <= 160); return new Response(JSON.stringify({ messageId: 12345 }), { status: 201 }) }
      assert.equal(body.sender.name, syntheticRuntime.brevoSenderName)
      assert.ok(body.textContent.includes(`${managementOrigin}/notifications/manage/`))
      assert.equal(body.attachment.length, 1)
      return new Response(JSON.stringify({ messageId: 'synthetic_message_123' }), { status: 201 })
    }
    assert.equal((await dispatchNotificationQueueMessage({ id: 'joint', body: { outboxId: row.id, version: row.version } }, dependencies, syntheticRuntime, fetcher)).delivered, true)
    await dispatchNotificationQueueMessage({ id: 'duplicate', body: { outboxId: row.id, version: row.version } }, dependencies, syntheticRuntime, fetcher)
  }
  assert.deepEqual(called.sort(), ['event-email', 'event-sms', 'event-web-push'])
  assert.deepEqual(query('SELECT channel, status FROM notification_event_deliveries ORDER BY channel'), ['email', 'sms', 'web-push'].map(channel => ({ channel, status: 'submitted' })))
  await requestNotificationManagementRecovery({ channel: 'sms', contact: '+420777123456' }, dependencies)
  const [recovery] = query("SELECT id, version FROM notification_outbox WHERE kind = 'management-recovery' AND status = 'pending'")
  await dispatchNotificationQueueMessage({ id: 'recovery', body: { outboxId: recovery!.id, version: recovery!.version } }, dependencies, syntheticRuntime, async (_url, request) => {
    smsToken = JSON.parse(request!.body as string).content.match(/\/manage\/([A-Za-z0-9_-]+)/)[1]
    return new Response(JSON.stringify({ messageId: 12346 }), { status: 201 })
  })
  await planEventNotifications([{ ...calendarEvent, event: { ...calendarEvent.event, location: 'New venue' }, changedAt: '2026-10-05T00:00:00Z' }], dependencies)
  await database.prepare("UPDATE notification_outbox SET status = 'queued' WHERE kind = 'event-sms' AND status = 'pending'").run()
  await stopNotificationChannel(smsToken, dependencies)
  assert.deepEqual(query('SELECT channel FROM notification_contacts ORDER BY channel'), [{ channel: 'email' }, { channel: 'web-push' }])
  assert.deepEqual(query('SELECT channel, reason FROM notification_suppressions'), [{ channel: 'sms', reason: 'user-stop' }])
  assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE kind = 'event-sms' AND status IN ('pending', 'queued', 'claimed')")[0]!.n, 0)
  assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE kind IN ('event-email', 'event-web-push') AND status = 'pending'")[0]!.n, 2)
})

test('SMS and push event retries reserve each attempt, clear only owned transient attempts and retire current stale devices', async () => {
  for (const kind of ['event-sms', 'event-web-push']) {
    const { query, dependencies } = await jointFixture()
    await planEventNotifications([calendarEvent], dependencies)
    const [row] = query(`SELECT id, version FROM notification_outbox WHERE kind = '${kind}'`)
    const pointer = { outboxId: row!.id, version: row!.version }
    let calls = 0
    await assert.rejects(dispatchNotificationQueueMessage({ id: 'retry', body: pointer }, dependencies, syntheticRuntime, async () => { calls++; return new Response(null, { status: 429 }) }), /retryable/)
    assert.equal(query(`SELECT submitted_at FROM notification_event_deliveries WHERE channel = '${kind === 'event-sms' ? 'sms' : 'web-push'}'`)[0]!.submitted_at, null)
    const result = await dispatchNotificationQueueMessage({ id: 'second', body: pointer }, dependencies, syntheticRuntime, async () => { calls++; return kind === 'event-sms' ? new Response(JSON.stringify({ messageId: 456 }), { status: 201 }) : new Response(null, { status: 410 }) })
    assert.equal(calls, 2)
    assert.equal(result.delivered, kind === 'event-sms')
    if (kind === 'event-web-push') {
      assert.deepEqual(query('SELECT channel FROM notification_contacts ORDER BY channel'), [{ channel: 'email' }, { channel: 'sms' }])
      assert.deepEqual(query('SELECT channel, reason FROM notification_suppressions'), [{ channel: 'web-push', reason: 'provider-opt-out' }])
    }
  }
})

test('all event channels deny stopped, expired and exact-frequency work at the final actual fetch boundary', async () => {
  for (const kind of ['event-email', 'event-sms', 'event-web-push']) for (const change of ['frequency', 'lease', 'expired', 'stop', 'generation']) {
    const { database, query, dependencies, contact } = await jointFixture()
    await planEventNotifications([calendarEvent], dependencies)
    const [row] = query(`SELECT id, version, contact_id, payload_ciphertext, payload_iv FROM notification_outbox WHERE kind = '${kind}'`)
    const payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row!.payload_iv as string, 'base64url') }, config.outboxTransportKey, Buffer.from(row!.payload_ciphertext as string, 'base64url'))))
    let calls = 0
    const result = await dispatchNotificationQueueMessage({ id: 'race', body: { outboxId: row!.id, version: row!.version } }, { ...dependencies, now: change === 'expired' ? () => new Date('2026-10-13T00:00:00Z') : dependencies.now, barriers: { afterClaimedAndDecrypted: async () => {
      if (change === 'frequency') await database.prepare("UPDATE notification_subscriptions SET frequency = 'day-before' WHERE contact_id = ?").bind(row!.contact_id).run()
      if (change === 'lease') await database.prepare("UPDATE notification_outbox SET claim_expires_at = '2026-10-03T00:00:00Z' WHERE id = ?").bind(row!.id).run()
      if (change === 'stop') await stopNotificationChannel(payload.managementCapability, dependencies)
      if (change === 'generation') await requestNotificationManagementRecovery({ channel: kind === 'event-email' ? 'email' : kind === 'event-sms' ? 'sms' : 'web-push', contact: kind === 'event-email' ? input.contact : kind === 'event-sms' ? '+420777123456' : contact }, dependencies)
    } } }, syntheticRuntime, async () => { calls++; return new Response(null, { status: 201 }) })
    assert.equal(calls, 0, `${kind} ${change}`)
    assert.deepEqual(result, { delivered: false, stale: true })
  }
})

test('actual 404/410 delayed after recovery or stop cannot retire a replacement generation or sibling channel', async () => {
  for (const status of [404, 410]) for (const kind of ['first-activation', 'event-web-push']) for (const action of ['recovery', 'stop']) {
    const { query, dependencies, contact } = await jointFixture()
    await planEventNotifications([calendarEvent], dependencies)
    const [row] = query(`SELECT o.id, o.version, o.payload_ciphertext, o.payload_iv FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id WHERE c.channel = 'web-push' AND o.kind = '${kind}'`)
    const payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row!.payload_iv as string, 'base64url') }, config.outboxTransportKey, Buffer.from(row!.payload_ciphertext as string, 'base64url'))))
    let calls = 0
    await dispatchNotificationQueueMessage({ id: 'late', body: { outboxId: row!.id, version: row!.version } }, dependencies, syntheticRuntime, async () => {
      calls++
      if (action === 'recovery') await requestNotificationManagementRecovery({ channel: 'web-push', contact }, dependencies)
      else await stopNotificationChannel(payload.capability ?? payload.managementCapability, dependencies)
      return new Response(null, { status })
    })
    assert.equal(calls, 1)
    if (action === 'recovery') {
      assert.deepEqual(query("SELECT capability_generation FROM notification_contacts WHERE channel = 'web-push'"), [{ capability_generation: 2 }])
      assert.deepEqual(query('SELECT channel FROM notification_suppressions'), [])
      assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE kind = 'management-recovery' AND status = 'pending'")[0]!.n, 1)
    } else assert.deepEqual(query('SELECT channel, reason FROM notification_suppressions'), [{ channel: 'web-push', reason: 'user-stop' }])
    assert.equal(query("SELECT count(*) n FROM notification_contacts WHERE channel IN ('email', 'sms')")[0]!.n, 2)
    assert.equal((await planEventNotifications([calendarEvent], dependencies)).planned, kind === 'first-activation' && action === 'recovery' ? 1 : 0, 'only never-invoked event work may repair after recovery')
  }
})

test('push event stop while awaiting VAPID signs denies fetch after encryption, and stale retirement rolls back atomically', async () => {
  const { query, dependencies } = await jointFixture()
  await planEventNotifications([calendarEvent], dependencies)
  const [row] = query("SELECT id, version, payload_ciphertext, payload_iv FROM notification_outbox WHERE kind = 'event-web-push'")
  const payload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(row!.payload_iv as string, 'base64url') }, config.outboxTransportKey, Buffer.from(row!.payload_ciphertext as string, 'base64url'))))
  const sign = crypto.subtle.sign
  let calls = 0
  crypto.subtle.sign = async (...args) => { await stopNotificationChannel(payload.managementCapability, dependencies); return sign.apply(crypto.subtle, args) }
  try {
    assert.deepEqual(await dispatchNotificationQueueMessage({ id: 'crypto-stop', body: { outboxId: row!.id, version: row!.version } }, dependencies, syntheticRuntime, async () => { calls++; return new Response(null, { status: 201 }) }), { delivered: false, stale: true })
    assert.equal(calls, 0)
  } finally { crypto.subtle.sign = sign }
  const next = await jointFixture()
  await planEventNotifications([calendarEvent], next.dependencies)
  const [event] = next.query("SELECT id, version FROM notification_outbox WHERE kind = 'event-web-push'")
  const failing: NotificationDatabase = { ...next.database, prepare: sql => {
    const statement = next.database.prepare(sql)
    if (sql.startsWith('DELETE FROM notification_contacts')) statement.run = async () => { throw new Error('Synthetic retirement failure') }
    return statement
  } }
  await assert.rejects(dispatchNotificationQueueMessage({ id: 'rollback', body: { outboxId: event!.id, version: event!.version } }, { ...next.dependencies, database: failing }, syntheticRuntime, async () => new Response(null, { status: 410 })), /Synthetic retirement failure/)
  assert.equal(next.query('SELECT count(*) n FROM notification_contacts')[0]!.n, 3)
  assert.deepEqual(next.query('SELECT channel FROM notification_suppressions'), [])
  assert.equal(next.query("SELECT status FROM notification_outbox WHERE kind = 'event-web-push'")[0]!.status, 'queued')
})

test('exact event authority rejects scope, frequency, revision, start, kind, generation and expiration changes', async () => {
  for (const mutation of [
    "UPDATE notification_subscriptions SET community_slug = 'praha'",
    "UPDATE notification_subscriptions SET frequency = 'day-before'",
    'UPDATE notification_event_state SET notification_revision = 9',
    "UPDATE notification_event_state SET starts_at = '2026-10-13T12:00:00.000Z'",
    'UPDATE notification_event_state SET cancelled = 1',
    "UPDATE notification_event_deliveries SET channel = 'sms'",
    "UPDATE notification_event_deliveries SET community_slug = NULL",
    "UPDATE notification_management_capabilities SET expires_at = '2026-10-03T00:00:00Z'",
    "UPDATE notification_outbox SET kind = 'event-sms' WHERE kind = 'event-email'",
    'UPDATE notification_contacts SET capability_generation = 9',
  ]) {
    const { database, query } = disposableDatabase()
    const dependencies = { database, config, now: () => new Date('2026-10-04T10:00:00Z') }
    await activateNotificationChannel(input, dependencies)
    await planEventNotifications([calendarEvent], dependencies)
    const [row] = query("SELECT id, version FROM notification_outbox WHERE kind = 'event-email'")
    let calls = 0
    const result = await dispatchNotificationQueueMessage({ id: 'exact', body: { outboxId: row!.id, version: row!.version } }, { ...dependencies, barriers: { afterClaimedAndDecrypted: async () => { await database.prepare(mutation).run() } } }, syntheticRuntime, async () => { calls++; return new Response(null, { status: 201 }) })
    assert.equal(calls, 0, mutation)
    assert.deepEqual(result, { delivered: false, stale: true })
  }
})

test('late stale push response cannot suppress a recovered device generation', async () => {
  for (const eventWork of [false, true]) {
    const { database, query } = disposableDatabase()
    const contact = { endpoint: 'https://push.example.test/subscription', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }
    const ready = { ...config, webPushDeliveryReady: true, eventWebPushOutboxSupported: true }
    const dependencies = { database, config: ready, now: () => new Date('2026-10-04T10:00:00Z') }
    await activateNotificationChannel({ ...input, channel: 'web-push', contact }, dependencies)
    if (eventWork) await planEventNotifications([calendarEvent], dependencies)
    const [row] = query(`SELECT id, version FROM notification_outbox WHERE kind = '${eventWork ? 'event-web-push' : 'first-activation'}'`)
    await consumeNotificationOutboxPointer({ outboxId: row!.id as string, version: row!.version as number }, dependencies, async (_payload, _authorization, authorize) => {
      assert.equal(await authorize(), true)
      await requestNotificationManagementRecovery({ channel: 'web-push', contact }, dependencies)
      return { attempted: true, status: 'stale-endpoint', httpStatus: 410 }
    })
    assert.deepEqual(query('SELECT channel, capability_generation FROM notification_contacts'), [{ channel: 'web-push', capability_generation: 2 }])
    assert.deepEqual(query('SELECT channel FROM notification_suppressions'), [])
    assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE kind = 'management-recovery' AND status = 'pending'")[0]!.n, 1)
  }
})

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
  const managementOrigin = 'https://jednadvacetorg-web.learned-mantis.workers.dev'
  const previewConfig = { ...config, managementOrigin }
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const pointers: unknown[] = []
  await publishPendingNotificationPointers({ send: async pointer => { pointers.push(pointer) } }, { database, config })
  const requests: RequestInit[] = []
  const result = await dispatchNotificationQueueMessage({ id: 'synthetic-message', body: pointers[0] }, { database, config: previewConfig }, { brevoApiKey: 'synthetic-key', brevoSenderName: 'Jednadvacet' }, async (_url, request) => {
    requests.push(request!)
    return new Response(JSON.stringify({ messageId: 'synthetic-provider-id' }), { status: 201 })
  })
  assert.deepEqual(result, { delivered: true, stale: false })
  assert.equal(requests.length, 1)
  const body = JSON.parse(requests[0]!.body as string)
  assert.deepEqual(body.to, [{ email: input.contact }])
  assert.deepEqual(body.sender, { name: 'Jednadvacet', email: 'noreply@jednadvacet.org' })
  assert.equal(body.attachment, undefined)
  assert.ok(body.textContent.includes(`${managementOrigin}/notifications/manage/${initialToken}`))
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
    const dependencies = { database, config, now: () => new Date('2026-10-04T12:00:00Z') }
    assert.equal((await planEventNotifications([calendarEvent], dependencies)).planned, 0)
    assert.equal(query("SELECT id FROM notification_outbox WHERE kind = 'event-email'").length, 0)
    assert.equal(query('SELECT id FROM notification_suppressions').length, 1)
    if (kind === 'management-recovery') {
      const confirmation = await confirmNotificationReactivation(capability, { database, config })
      assert.equal(confirmation.outcome, 'reactivated')
      assert.equal(confirmation.outcome === 'reactivated' ? confirmation.management.state : undefined, 'active')
      assert.equal(query('SELECT id FROM notification_suppressions').length, 0)
      assert.equal((await planEventNotifications([{ ...calendarEvent, event: { ...calendarEvent.event, id: 'after-confirmation' } }], dependencies)).planned, 1)
      const event = query("SELECT id, version FROM notification_outbox WHERE kind = 'event-email'")[0]!
      let calls = 0
      assert.deepEqual(await dispatchNotificationQueueMessage({ id: 'confirmed-event', body: { outboxId: event.id, version: event.version } }, dependencies, syntheticRuntime, async () => {
        calls++
        return Response.json({ messageId: 'confirmed-event' }, { status: 201 })
      }), { delivered: true, stale: false })
      assert.equal(calls, 1)
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
  const pushConfig = { ...config, webPushDeliveryReady: true, webPushDelivery: { privateKey: vapid.privateKey, publicKey, subject: 'mailto:test@example.test' } }
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
    const ready = { ...config, webPushDeliveryReady: true }
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
  const managementOrigin = 'https://jednadvacet.org'
  const ready = { ...config, managementOrigin, emailDeliveryReady: false, smsDeliveryReady: true, eventSmsOutboxSupported: true }
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
      assert.equal(body.sender, syntheticRuntime.brevoSmsSender)
      assert.equal(body.type, 'transactional')
      assert.ok(body.content.includes(`${managementOrigin}/notifications/manage/`))
      token = body.content.match(/\/notifications\/manage\/([A-Za-z0-9_-]+)/)[1]
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

  assert.equal((await publishPendingNotificationPointers({ send: async pointer => { sent.push(pointer) } }, { database, config, crypto: predictableCrypto })).published, 1)
  assert.deepEqual(sent, [pointerFor(query)])
  const [outbox] = query('SELECT status, payload_ciphertext, payload_iv FROM notification_outbox')
  assert.equal(outbox!.status, 'queued')
  assert.equal(typeof outbox!.payload_ciphertext, 'string')
  assert.equal(typeof outbox!.payload_iv, 'string')
})

test('hourly task drains committed lifecycle work despite calendar or planning failure and retains failed task evidence', async (t) => {
  const globals = globalThis as typeof globalThis & { defineTask?: unknown }
  const previous = globals.defineTask
  globals.defineTask = (task: unknown) => task
  try {
    const { drainNotificationMessages } = await import('../server/tasks/notification-messages.ts')
    for (const scenario of ['missing-one', 'empty-registry', 'malformed', 'planner-read', 'planner-batch'] as const) await t.test(scenario, async scenarioTest => {
      const { database, query } = disposableDatabase()
      await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
      const pointer = pointerFor(query)
      const snapshot = { schemaVersion: 1, community: { id: 'brno', path: '/brno', title: 'Brno' }, events: [{ event: calendarEvent.event, fingerprint: 'synthetic', sequence: 4, changedAt: calendarEvent.changedAt }], cancellations: [], signals: {}, fetchedAt: '2026-10-04T00:00:00.000Z' }
      const reads: string[] = []
      const portalStorage = { getItem: async (key: string) => { reads.push(key); return scenario === 'malformed' ? { secret: input.contact } : key === 'community:brno' ? snapshot : null }, setItem: async () => {}, getKeys: async () => [] }
      let injected = false
      const planningDatabase: NotificationDatabase = {
        ...database,
        prepare: sql => {
          if (scenario === 'planner-read' && sql.startsWith('SELECT') && sql.includes('notification_event_state')) { injected = true; throw new Error(`Private D1 failure ${input.contact} ${initialToken}`) }
          return database.prepare(sql)
        },
        batch: async statements => {
          if (scenario === 'planner-batch') { injected = true; throw new Error(`Private D1 failure ${input.contact} ${initialToken}`) }
          return database.batch(statements)
        },
      }
      const sent: unknown[] = []
      Object.assign(globalThis, { __NOTIFICATION_COMMUNITIES__: (scenario === 'empty-registry' ? [] : scenario === 'missing-one' ? ['brno', 'praha'] : ['brno']).map(slug => ({ slug, title: slug })) })
      scenarioTest.after(() => Object.assign(globalThis, { __NOTIFICATION_COMMUNITIES__: [{ slug: 'brno', title: 'Brno' }] }))
      await assert.rejects(drainNotificationMessages({ notificationDatabase: planningDatabase, notificationMessagesQueue: { send: async value => { sent.push(value) } }, portalStorage }, {
        notificationRootKey: root,
        notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org',
      }), (error: Error) => {
        assert.deepEqual(sent, [pointer], scenario)
        assert.match(error.message, /Notification event planning failed \((calendar-404|calendar-503|planner)\)/)
        assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), new RegExp(`${input.contact}|${initialToken}|Private D1`))
        return true
      })
      assert.equal(injected, scenario.startsWith('planner-'), scenario)
      assert.equal(reads.includes('community:praha'), scenario === 'missing-one')
      assert.deepEqual(query('SELECT id, version, status FROM notification_outbox'), [{ id: pointer.outboxId, version: pointer.version, status: 'queued' }])
      assert.equal(typeof query('SELECT payload_ciphertext FROM notification_outbox')[0]!.payload_ciphertext, 'string')
      assert.deepEqual(query('SELECT * FROM notification_event_state'), [], 'failed planning never commits event state')
    })
  } finally { globals.defineTask = previous }
})

test('hourly task retains pending rows and reports publication failure alone or together with planning failure', async (t) => {
  const globals = globalThis as typeof globalThis & { defineTask?: unknown }
  const previous = globals.defineTask
  globals.defineTask = (task: unknown) => task
  try {
    const { drainNotificationMessages } = await import('../server/tasks/notification-messages.ts')
    for (const missing of [false, true]) await t.test(missing ? 'planning-and-publication' : 'publication-only', async () => {
      const { database, query } = disposableDatabase()
      await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
      const before = query('SELECT * FROM notification_outbox')
      let calls = 0
      await assert.rejects(drainNotificationMessages({ notificationDatabase: database, notificationMessagesQueue: { send: async () => { calls++; throw new Error(`Private Queue failure ${input.contact}`) } }, portalStorage: {
        getItem: async () => missing ? null : { schemaVersion: 1, community: { id: 'brno', path: '/brno', title: 'Brno' }, events: [], cancellations: [], signals: {}, fetchedAt: '2026-10-04T00:00:00.000Z' }, setItem: async () => {}, getKeys: async () => [],
      } }, { notificationRootKey: root, notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org' }), (error: Error) => {
        const errors = error instanceof AggregateError ? error.errors : [error]
        assert.deepEqual(errors.map(item => item.message), [...(missing ? ['Notification event planning failed (calendar-404)'] : []), 'Notification pointer publication failed'])
        assert.doesNotMatch(JSON.stringify(error, Object.getOwnPropertyNames(error)), /alice@example.com|Private Queue/)
        return true
      })
      assert.equal(calls, 1)
      assert.deepEqual(query('SELECT * FROM notification_outbox'), before)
    })
  } finally { globals.defineTask = previous }
})

test('existing publisher no longer starves lifecycle behind 100 older event rows', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config })
  const lifecycle = pointerFor(query)
  for (let i = 0; i < 100; i++) await database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at)
    SELECT ?, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, 'event-email', '2020-01-01T00:00:00Z', updated_at FROM notification_outbox WHERE id = ?`)
    .bind(`older-${i}`, lifecycle.outboxId).run()
  const sent: unknown[] = []
  await publishPendingNotificationPointers({ send: async pointer => { sent.push(pointer) } }, { database, config }, 100)
  assert.deepEqual(sent[0], lifecycle)
  assert.equal(query(`SELECT status FROM notification_outbox WHERE id = '${lifecycle.outboxId}'`)[0]!.status, 'queued')
})

test('bounded publisher prioritizes lifecycle behind 100 events and retains 101/400/401 burst excess', async t => {
  for (const count of [101, 400, 401]) await t.test(String(count), async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config })
    const initial = pointerFor(query)
    for (let i = 0; i < count - 1; i++) await database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at)
      SELECT ?, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, ?, ?, updated_at FROM notification_outbox WHERE id = ?`)
      .bind(`burst-${String(i).padStart(4, '0')}`, i < 100 ? 'event-email' : 'management-recovery', '2020-01-01T00:00:00Z', initial.outboxId).run()
    const sent: Array<{ outboxId: string, version: number }> = []
    const queue = { send: async (pointer: { outboxId: string, version: number }) => { sent.push(pointer) } }
    const immediate = await publishPendingNotificationPointers(queue, { database, config }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
    assert.equal(immediate.published, Math.min(count - 100, 100))
    assert.ok(sent.every(pointer => query(`SELECT kind FROM notification_outbox WHERE id = '${pointer.outboxId}'`)[0]!.kind !== 'event-email'))
    assert.ok(sent.some(pointer => pointer.outboxId === initial.outboxId) || count > 200)
    sent.length = 0
    const fallback = await publishPendingNotificationPointers(queue, { database, config }, { lifecycleLimit: 100, eventLimit: 300, budgetMs: 20000 })
    assert.equal(fallback.published, Math.min(count - immediate.published, 200))
    assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE status = 'pending'")[0]!.n, Math.max(0, count - 300))
    assert.ok(sent.every(pointer => Object.keys(pointer).sort().join(',') === 'outboxId,version'))
  })
})

test('bounded continuing publisher accepts exactly 400 and leaves pointer 401 pending', async t => {
  for (const count of [400, 401]) await t.test(String(count), async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config })
    const initial = pointerFor(query)
    for (let i = 1; i < count; i++) await database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at)
      SELECT ?, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, ?, created_at, updated_at FROM notification_outbox WHERE id = ?`)
      .bind(`page-${String(i).padStart(4, '0')}`, i < 100 ? 'management-recovery' : 'event-email', initial.outboxId).run()
    const sent: string[] = []
    const result = await publishPendingNotificationPointers({ send: async pointer => { sent.push(pointer.outboxId) } }, { database, config }, { lifecycleLimit: 100, eventLimit: 300, budgetMs: 20000 })
    assert.equal(result.published, 400)
    assert.equal(result.lifecyclePublished, 100)
    assert.equal(result.eventPublished, 300)
    assert.equal(new Set(sent).size, 400)
    assert.equal(result.pendingEvents, count - 400)
    assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE status = 'pending'")[0]!.n, count - 400)
  })
})

test('publisher counts awaited read/send/mark time and starts no next send after deadline', async t => {
  for (const stage of ['read', 'send', 'mark'] as const) await t.test(stage, async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config })
    await database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, claim_token, claim_expires_at, created_at, updated_at, terminal_at) SELECT 'second', contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, claim_token, claim_expires_at, created_at, updated_at, terminal_at FROM notification_outbox`).run()
    let clock = 0
    let sends = 0
    const delayed: NotificationDatabase = { ...database, prepare: sql => {
      const statement = database.prepare(sql)
      if (sql.startsWith('SELECT id, version')) { const all = statement.all; statement.all = async <T>() => { const result = await all<T>(); if (stage === 'read') clock = 5001; return result } }
      if (sql.startsWith('UPDATE notification_outbox SET status')) { const run = statement.run; statement.run = async () => { const result = await run(); if (stage === 'mark') clock = 5001; return result } }
      return statement
    } }
    const result = await publishPendingNotificationPointers({ send: async () => { sends++; await Promise.resolve(); if (stage === 'send') clock = 5001 } }, { database: delayed, config, monotonicNow: () => clock }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
    assert.equal(sends, stage === 'read' ? 0 : 1)
    assert.equal(result.published, sends)
    assert.equal(result.budgetExhausted, true)
    assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE status = 'pending'")[0]!.n, 2 - sends)
  })
})

test('partial acceptance and accepted-before-mark SQL failure preserve exact pending pointers for replay', async t => {
  for (const stage of ['send', 'mark'] as const) await t.test(stage, async () => {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config })
    await database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, claim_token, claim_expires_at, created_at, updated_at, terminal_at) SELECT 'second', contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, claim_token, claim_expires_at, created_at, updated_at, terminal_at FROM notification_outbox`).run()
    const before = query('SELECT id, version, payload_ciphertext, payload_iv FROM notification_outbox ORDER BY id')
    let calls = 0
    const accepted: unknown[] = []
    const failing: NotificationDatabase = { ...database, prepare: sql => { const statement = database.prepare(sql); if (stage === 'mark' && sql.startsWith('UPDATE notification_outbox SET status')) statement.run = async () => { throw Error('Synthetic mark failure') }; return statement } }
    await assert.rejects(publishPendingNotificationPointers({ send: async pointer => { calls++; if (stage === 'send' && calls === 2) throw Error('Synthetic send failure'); accepted.push(pointer) } }, { database: failing, config }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 }), /Synthetic/)
    assert.equal(accepted.length, 1)
    assert.deepEqual(query('SELECT id, version, payload_ciphertext, payload_iv FROM notification_outbox ORDER BY id'), before)
    const replay: unknown[] = []
    await publishPendingNotificationPointers({ send: async pointer => { replay.push(pointer) } }, { database, config }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
    assert.equal(replay.length, stage === 'send' ? 1 : 2)
    if (stage === 'mark') assert.ok(replay.some(pointer => JSON.stringify(pointer) === JSON.stringify(accepted[0])))
  })
})

test('overlapping publishers keep accepted pointers inert and conditional marking cannot resurrect consumed work', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config })
  const pointer = pointerFor(query)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const sent: unknown[] = []
  const first = publishPendingNotificationPointers({ send: async value => { sent.push(value); entered(); await held } }, { database, config }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
  await started
  try {
    await publishPendingNotificationPointers({ send: async value => { sent.push(value) } }, { database, config }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
    assert.equal((await consumeNotificationOutboxPointer(pointer, { database, config }, async (_payload, _authority, authorize) => { assert.equal(await authorize(), true); return { attempted: true, status: 'submitted', providerMessageId: 'synthetic-publisher' } })).delivered, true)
  } finally { release(); await first }
  assert.deepEqual(sent, [pointer, pointer])
  assert.deepEqual(query('SELECT version, status, payload_ciphertext FROM notification_outbox'), [{ version: 2, status: 'consumed', payload_ciphertext: null }])
  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config }, async () => { throw Error('Duplicate must not deliver') }), { delivered: false, stale: true })
})

test('local asynchronous sequential publication measures admitted immediate and fallback envelope', async t => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config })
  const initial = pointerFor(query)
  for (let i = 1; i < 400; i++) await database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at)
    SELECT ?, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, ?, created_at, updated_at FROM notification_outbox WHERE id = ?`)
    .bind(`measure-${String(i).padStart(4, '0')}`, i < 100 ? 'management-recovery' : 'event-email', initial.outboxId).run()
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 2))
  const asynchronous: NotificationDatabase = { ...database, prepare: sql => {
    const statement = database.prepare(sql)
    const all = statement.all; const run = statement.run; const first = statement.first
    statement.all = async <T>() => { await delay(); return all<T>() }
    statement.run = async () => { await delay(); return run() }
    statement.first = async <T>() => { await delay(); return first<T>() }
    return statement
  } }
  const queue = { send: async () => { await new Promise<void>(resolve => setTimeout(resolve, 10)) } }
  const immediate = await publishPendingNotificationPointers(queue, { database: asynchronous, config }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
  assert.equal(immediate.published, 100)
  assert.ok(immediate.elapsedMs < 5000)
  // Re-admit 100 lifecycle rows to measure the entire 100+300 fallback, not just its event remainder.
  await database.prepare("UPDATE notification_outbox SET status = 'pending' WHERE status = 'queued'").run()
  const fallback = await publishPendingNotificationPointers(queue, { database: asynchronous, config }, { lifecycleLimit: 100, eventLimit: 300, budgetMs: 20000 })
  assert.equal(fallback.published, 400)
  assert.ok(fallback.elapsedMs < 20000)
  assert.equal(query("SELECT count(*) n FROM notification_outbox WHERE status = 'pending'")[0]!.n, 0)
  t.diagnostic(JSON.stringify({ boundary: 'local synthetic Queue 10ms / D1 2ms, real SQLite', immediate, fallback }))
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
  const dependencies = { database, config: eventConfig, now: () => new Date('2026-10-04T10:00:00Z') }
  await activateNotificationChannel(input, dependencies)
  await planEventNotifications([calendarEvent], dependencies)
  const [row] = query("SELECT id, version FROM notification_outbox WHERE kind = 'event-email'")
  const pointer = { outboxId: row!.id as string, version: row!.version as number }
  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, dependencies, async () => ({ attempted: true, status: 'rate-limited' })), { delivered: true, stale: false })
  assert.deepEqual(query('SELECT status FROM notification_event_deliveries'), [{ status: 'failed' }])
  assert.deepEqual(query("SELECT status, payload_ciphertext FROM notification_outbox WHERE kind = 'event-email'"), [{ status: 'consumed', payload_ciphertext: null }])
})

test('SMS lifecycle provider failures retry transient results and retain terminal failure evidence', async () => {
  const { database, query } = disposableDatabase()
  const smsConfig = { ...config, smsDeliveryReady: true, eventSmsOutboxSupported: true }
  await activateNotificationChannel({ ...input, channel: 'sms', contact: '+420777123456' }, { database, config: smsConfig, crypto: predictableCrypto })
  const pointer = pointerFor(query)

  await assert.rejects(consumeNotificationOutboxPointer(pointer, { database, config: smsConfig, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'provider-5xx' })))
  const [retryable] = query('SELECT status, payload_ciphertext, claim_token FROM notification_outbox')
  assert.equal(retryable!.status, 'queued')
  assert.equal(typeof retryable!.payload_ciphertext, 'string')
  assert.equal(retryable!.claim_token, null)

  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config: smsConfig, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'auth' })), { delivered: false, stale: false })
  const [terminal] = query('SELECT status, payload_ciphertext, terminal_at FROM notification_outbox')
  assert.equal(terminal!.status, 'invalidated')
  assert.equal(terminal!.payload_ciphertext, null)
  assert.equal(typeof terminal!.terminal_at, 'string')
})

test('lifecycle delivery rechecks independent readiness after composition before transport', async () => {
  for (const changeAfterComposition of [false, true]) {
    const { database, query } = disposableDatabase()
    const ready = { ...config }
    await activateNotificationChannel(input, { database, config: ready, crypto: predictableCrypto })
    if (!changeAfterComposition) ready.emailDeliveryReady = false
    let transports = 0
    const result = await consumeNotificationOutboxPointer(pointerFor(query), { database, config: ready }, async (_payload, _authority, authorize) => {
      ready.emailDeliveryReady = false
      if (await authorize()) transports++
    })
    assert.equal(result.delivered, false)
    assert.equal(transports, 0)
    assert.equal(query('SELECT payload_ciphertext FROM notification_outbox')[0]!.payload_ciphertext, null)
  }
})

test('a stop committed during the awaited schema probe precedes the final transport authority read', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  let probes = 0
  const interrupted: NotificationDatabase = { ...database, prepare(sql) {
    const statement = database.prepare(sql)
    if (!sql.startsWith('SELECT d.channel, d.community_slug')) return statement
    return { ...statement, all: async <T>() => {
      const results = await statement.all<T>()
      if (++probes === 2) await stopNotificationChannel(initialToken, { database, config })
      return results
    } }
  } }
  let calls = 0
  const result = await dispatchNotificationQueueMessage({ id: 'probe-stop', body: pointerFor(query) }, { database: interrupted, config }, syntheticRuntime, async () => { calls++; return new Response(null, { status: 201 }) })
  assert.equal(probes, 2)
  assert.equal(calls, 0)
  assert.deepEqual(result, { delivered: false, stale: true })
})

test('a stale lifecycle Web Push endpoint is suppressed and removed', async () => {
  const { database, query } = disposableDatabase()
  const webPushConfig = { ...config, webPushDeliveryReady: true }
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const webPushInput = { ...input, channel: 'web-push' as const, contact: JSON.stringify({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))), auth: encode(new Uint8Array(16)) } }) }
  await activateNotificationChannel(webPushInput, { database, config: webPushConfig, crypto: predictableCrypto })
  const pointer = pointerFor(query)

  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config: webPushConfig, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'stale-endpoint', httpStatus: 410 })), { delivered: false, stale: false })
  assert.deepEqual(query('SELECT status, payload_ciphertext FROM notification_outbox'), [{ status: 'invalidated', payload_ciphertext: null }])
  assert.deepEqual(query('SELECT channel, reason FROM notification_suppressions'), [{ channel: 'web-push', reason: 'provider-opt-out' }])
  assert.deepEqual(query('SELECT id FROM notification_contacts'), [])
})

test('SMS activation rejects missing database schema despite provider flags', async () => {
  const { database, query } = disposableDatabase()
  await database.prepare('DROP TABLE notification_lifecycle_email_callbacks').run()
  const smsConfig = { ...config, emailDeliveryReady: false, smsDeliveryReady: true }
  await assert.rejects(activateNotificationChannel({ ...input, channel: 'sms', contact: '+420777123456' }, { database, config: smsConfig, crypto: predictableCrypto }), error => (error as { statusCode: number }).statusCode === 503)
  assert.deepEqual(query('SELECT id FROM notification_contacts'), [])
})

test('scheduled drain publishes bounded pointers and consumer failures remain retryable', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const runtimeConfig = {
    notificationRootKey: root,
    notificationTurnstileSecret: 'private-turnstile-secret',
    notificationTurnstileExpectedHostname: 'jednadvacet.org',
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
