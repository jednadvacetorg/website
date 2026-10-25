import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createApp, eventHandler, toNodeListener } from 'h3'

import { applyBrevoCallback, normalizeBrevoCallback } from '../server/utils/brevoCallbacks.ts'
import { sendBrevoEventEmail } from '../server/utils/brevoEmail.ts'
import type { NotificationDatabase, NotificationStatement } from '../server/utils/notifications.ts'
import { requestNotificationManagementRecovery } from '../server/utils/notifications.ts'
import { notificationConfig } from '../server/utils/notificationConfig.ts'

let runtimeConfig: Record<string, unknown> = { brevoCallbackSecret: 'callback-secret-for-tests' }
;(globalThis as typeof globalThis & { useRuntimeConfig: () => Record<string, unknown> }).useRuntimeConfig = () => runtimeConfig

const callbackRoute = (await import('../server/api/notifications/brevo-events.post.ts')).default

const createDatabase = () => {
  const sqlite = new Database(':memory:')
  for (const name of ['0000_majestic_lightspeed', '0001_phase_7_columns', '0002_detach_event_callback_fk', '0003_restore_event_ledger_checks', '0004_restore_event_callback_fk', '0005_lifecycle_email_columns', '0006_lifecycle_email_constraints']) sqlite.exec(readFileSync(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8'))
  sqlite.exec('PRAGMA foreign_keys = ON')
  const executions = new WeakMap<NotificationStatement, () => unknown>()
  const database: NotificationDatabase = {
    prepare: query => {
      let values: unknown[] = []
      const execute = () => ({ meta: { changes: sqlite.prepare(query).run(...values).changes } })
      const statement: NotificationStatement = {
        bind: (...nextValues: unknown[]) => {
          values = nextValues
          return statement
        },
        first: async <T>() => sqlite.prepare(query).get(...values) as T | null,
        all: async <T>() => ({ results: sqlite.prepare(query).all(...values) as T[] }),
        run: async () => execute(),
      }
      executions.set(statement, execute)
      return statement
    },
    batch: async statements => {
      return sqlite.transaction(() => statements.map(statement => executions.get(statement)!()))()
    },
  }
  return { sqlite, database }
}

const withCallbackRoute = async (database: NotificationDatabase, run: (baseUrl: string) => Promise<void>) => {
  const app = createApp()
  app.use('/brevo', eventHandler(event => {
    event.context._platform = { cloudflare: { env: { DB: database } } }
    return callbackRoute(event)
  }))
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

const seedDelivery = (sqlite: Database.Database, status = 'pending', providerMessageId: string | null = null) => {
  sqlite.prepare("INSERT INTO notification_contacts (id, channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (1, 'email', 'synthetic@example.test', 'hash_123456789', 'synthetic_digest', 7, 'active', '2026-09-21', '2026-09', '2026-09-21', '2026-09-21')").run()
  sqlite.prepare("INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, provider_message_id, created_at, updated_at) VALUES (?, 1, 7, 'hash_123456789', 'event@jednadvacet.org', 0, 'created', ?, ?, '2026-09-21', '2026-09-21')").run('delivery_123456789', status, providerMessageId)
  sqlite.prepare("INSERT INTO notification_outbox (id, contact_id, expected_capability_generation, version, status, payload_ciphertext, payload_iv, claim_token, claim_expires_at, kind, created_at, updated_at) VALUES ('outbox_123456789', 1, 7, 1, 'claimed', 'ciphertext', 'iv', 'claim', '2026-09-21T01:00:00.000Z', 'event-email', '2026-09-21', '2026-09-21')").run()
}

test('email callback cannot mutate SMS or push delivery evidence or contacts', async () => {
  for (const channel of ['sms', 'web-push']) {
    const { sqlite, database } = createDatabase()
    seedDelivery(sqlite)
    sqlite.prepare('UPDATE notification_contacts SET channel = ?').run(channel)
    sqlite.prepare('UPDATE notification_event_deliveries SET channel = ?').run(channel)
    assert.deepEqual(await applyBrevoCallback({ id: 'event_123456789', deliveryId: 'delivery_123456789', kind: 'unsubscribed', occurredAt: '2026-10-04' }, database), { applied: false, suppressed: false })
    assert.equal(sqlite.prepare('SELECT status FROM notification_event_deliveries').get().status, 'pending')
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_contacts').get().n, 1)
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 0)
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_suppressions').get().n, 0)
    sqlite.close()
  }
  assert.equal(normalizeBrevoCallback({ event: 'sms_opt_out', id: 'event_123456789', deliveryId: 'delivery_123456789' }), undefined)
})

const callbackBody = (event: string) => JSON.stringify({
  id: 26224,
  event,
  'X-Mailin-custom': 'delivery_123456789',
  'message-id': '<201798300811.5787683@relay.domain.com>',
  email: 'not-authoritative@example.test',
  ts_event: 1_604_933_654,
})

const postCallback = (baseUrl: string, body: string, authorization?: string) => fetch(`${baseUrl}/brevo`, {
  method: 'POST',
  headers: authorization ? { authorization } : undefined,
  body,
})

test('Brevo callbacks retain only documented opaque correlation and fixed categories', () => {
  const callback = normalizeBrevoCallback({ id: 26224, event: 'hardBounce', 'X-Mailin-custom': 'delivery_123456789', 'message-id': '<message_123456789>', ts_event: 1_604_933_654, email: 'must-not-be-used@example.test' })
  assert.deepEqual(callback, { id: '26224', deliveryId: 'delivery_123456789', kind: 'hard-bounce', providerMessageId: 'message_123456789', occurredAt: '2020-11-09T14:54:14.000Z' })
  assert.equal(normalizeBrevoCallback({ event: 'delivered', email: 'not-authority@example.test' }), undefined)
  assert.equal(normalizeBrevoCallback({ id: 'event_123456789', event: 'unknown', 'X-Mailin-custom': 'delivery_123456789' }), undefined)
})

test('normalizes the documented numeric webhook, message-id, custom header and UTC event timestamp', () => {
  const callback = normalizeBrevoCallback({
    id: 26224,
    event: 'hard_bounce',
    'X-Mailin-custom': 'delivery_123456789',
    'message-id': '<201798300811.5787683@relay.domain.com>',
    ts_event: 1_604_933_654,
    email: 'must-not-be-used@example.test',
  })
  assert.deepEqual(callback, {
    id: '26224',
    deliveryId: 'delivery_123456789',
    kind: 'hard-bounce',
    providerMessageId: '201798300811.5787683@relay.domain.com',
    occurredAt: '2020-11-09T14:54:14.000Z',
  })
})

test('callback authority rejects missing local headers and malformed documented identifiers', () => {
  const base = { id: 26224, event: 'delivered', 'X-Mailin-custom': 'delivery_123456789', 'message-id': '<provider.id+Case@relay.domain.com>', ts_event: 1_604_933_654 }
  assert.equal(normalizeBrevoCallback(base)?.providerMessageId, 'provider.id+Case@relay.domain.com')
  for (const value of [
    { ...base, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, id: 0 },
    { ...base, 'message-id': '<provider' },
    { ...base, 'message-id': '<<provider>>' },
    { ...base, 'message-id': `p${'x'.repeat(256)}` },
    { ...base, 'message-id': 'provider\nheader' },
    { ...base, ts_event: undefined },
    { ...base, 'X-Mailin-custom': undefined },
  ]) assert.equal(normalizeBrevoCallback(value), undefined)
})

test('lifecycle namespace is strict and cannot alias event delivery identifiers', () => {
  const base = { id: 1, event: 'delivered', 'message-id': '<provider@relay.test>', ts_event: 1792000000 }
  const valid = 'lifecycle:v1:outbox_123456789:7'
  assert.equal(normalizeBrevoCallback({ ...base, 'X-Mailin-custom': valid })?.deliveryId, valid)
  for (const header of ['lifecycle:v2:outbox_123456789:7', 'lifecycle:v1:outbox_123456789:07', 'lifecycle:v1:outbox_123456789:0', 'lifecycle:v1:outbox_123456789:9007199254740992', 'lifecycle:v1:outbox_123456789:7:extra', 'lifecycle:v1:short:7']) assert.equal(normalizeBrevoCallback({ ...base, 'X-Mailin-custom': header }), undefined)
})

test('an authenticated hardBounce callback suppresses the matching delivery generation', async () => {
  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)

  await withCallbackRoute(database, async baseUrl => {
    const response = await postCallback(baseUrl, callbackBody('hardBounce'), 'Bearer callback-secret-for-tests')
    assert.equal(response.status, 202)
  })

  assert.equal(sqlite.prepare('SELECT status FROM notification_event_deliveries WHERE id = ?').get('delivery_123456789').status, 'hard-bounce')
  assert.deepEqual(sqlite.prepare('SELECT reason FROM notification_suppressions').all(), [{ reason: 'provider-bounce' }])
  assert.equal(sqlite.prepare('SELECT id FROM notification_contacts').get(), undefined)
  assert.deepEqual(sqlite.prepare('SELECT status, payload_ciphertext, payload_iv, claim_token, claim_expires_at FROM notification_outbox').get(), {
    status: 'invalidated',
    payload_ciphertext: null,
    payload_iv: null,
    claim_token: null,
    claim_expires_at: null,
  })
})

test('the authenticated route maps each selected Brevo event and only suppresses terminal lifecycle events', async () => {
  const cases = [
    { event: 'delivered', status: 'delivered' },
    { event: 'hardBounce', status: 'hard-bounce', reason: 'provider-bounce' },
    { event: 'hard_bounce', status: 'hard-bounce', reason: 'provider-bounce' },
    { event: 'softBounce', status: 'soft-bounce' },
    { event: 'soft_bounce', status: 'soft-bounce' },
    { event: 'blocked', status: 'blocked' },
    { event: 'spam', status: 'complaint', reason: 'provider-complaint' },
    { event: 'unsubscribed', status: 'unsubscribed', reason: 'provider-opt-out' },
  ] as const

  for (const item of cases) {
    const { sqlite, database } = createDatabase()
    seedDelivery(sqlite)
    await withCallbackRoute(database, async baseUrl => {
      const response = await postCallback(baseUrl, callbackBody(item.event), 'Bearer callback-secret-for-tests')
      assert.equal(response.status, 202, item.event)
    })

    assert.equal(sqlite.prepare('SELECT status FROM notification_event_deliveries WHERE id = ?').get('delivery_123456789').status, item.status, item.event)
    assert.deepEqual(sqlite.prepare('SELECT reason FROM notification_suppressions').all(), item.reason ? [{ reason: item.reason }] : [], item.event)
    assert.deepEqual(sqlite.prepare('SELECT id FROM notification_contacts').get(), item.reason ? undefined : { id: 1 }, item.event)
    assert.equal(sqlite.prepare('SELECT status FROM notification_outbox').get().status, item.reason ? 'invalidated' : 'claimed', item.event)
  }
})

for (const [label, wireId, canonicalId] of [
  ['provider-id', 'provider-id', 'provider-id'],
  ['official bracketed', '<201798300811.5787683@relay.domain.com>', '201798300811.5787683@relay.domain.com'],
  ['official plain', '201798300811.5787683@relay.domain.com', '201798300811.5787683@relay.domain.com'],
  ['punctuation and case', '<Provider.ID+Case/Part:tag=@Relay.Domain>', 'Provider.ID+Case/Part:tag=@Relay.Domain'],
  ['256 UTF-8 bytes', 'ž'.repeat(128), 'ž'.repeat(128)],
  ['256 wrapped UTF-8 bytes', `<${'ž'.repeat(127)}>`, 'ž'.repeat(127)],
] as const) test(`adapter-to-H3 correlation and bracket replay: ${label}`, async t => {
  const sent = await sendBrevoEventEmail({ apiKey: 'synthetic', senderName: 'Jednadvacet', senderEmail: 'noreply@jednadvacet.org' }, {
    deliveryId: 'delivery_123456789', recipient: 'synthetic@example.test', managementUrl: 'https://example.test/manage', uid: 'event@jednadvacet.org', sequence: 0,
    event: { title: 'Synthetic', start: '2026-10-16T12:00:00Z', end: '2026-10-16T13:00:00Z' },
  }, async () => Response.json({ messageId: wireId }, { status: 201 }))
  assert.equal(sent.status, 'submitted')
  assert.equal(sent.providerMessageId, canonicalId)
  const { sqlite, database } = createDatabase()
  t.after(() => sqlite.close())
  seedDelivery(sqlite, 'submitted', sent.providerMessageId)
  await withCallbackRoute(database, async baseUrl => {
    const base = { ...JSON.parse(callbackBody('delivered')), 'message-id': wireId }
    for (const value of [base, { ...base, 'message-id': canonicalId }]) {
      assert.equal((await postCallback(baseUrl, JSON.stringify(value), 'Bearer callback-secret-for-tests')).status, 202)
      assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 1)
    }
    // Same kind/webhook/delivery, a different UTC second: a distinct receipt.
    assert.equal((await postCallback(baseUrl, JSON.stringify({ ...base, ts_event: base.ts_event + 1 }), 'Bearer callback-secret-for-tests')).status, 202)
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 2)
    // Only event kind changes, so delivery+webhook alone must not deduplicate the bounce.
    const bounce = { ...base, event: 'hard_bounce' }
    assert.equal((await postCallback(baseUrl, JSON.stringify(bounce), 'Bearer callback-secret-for-tests')).status, 202)
    assert.deepEqual(sqlite.prepare('SELECT event, provider_message_id, received_at FROM notification_delivery_callbacks ORDER BY event, received_at').all(), [
      { event: 'delivered', provider_message_id: canonicalId, received_at: '2020-11-09T14:54:14.000Z' },
      { event: 'delivered', provider_message_id: canonicalId, received_at: '2020-11-09T14:54:15.000Z' },
      { event: 'hard-bounce', provider_message_id: canonicalId, received_at: '2020-11-09T14:54:14.000Z' },
    ])
    for (const value of [bounce, { ...bounce, 'message-id': canonicalId }, base]) {
      assert.equal((await postCallback(baseUrl, JSON.stringify(value), 'Bearer callback-secret-for-tests')).status, 202)
      assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 3)
    }
  })
  assert.deepEqual(sqlite.prepare('SELECT status, provider_message_id FROM notification_event_deliveries').get(), { status: 'hard-bounce', provider_message_id: canonicalId })
  assert.deepEqual(sqlite.prepare('SELECT channel, destination_hash, reason FROM notification_suppressions').all(), [{ channel: 'email', destination_hash: 'hash_123456789', reason: 'provider-bounce' }])
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_contacts').get().n, 0)
  assert.deepEqual(sqlite.prepare('SELECT status, payload_ciphertext, payload_iv, claim_token, claim_expires_at FROM notification_outbox').get(), { status: 'invalidated', payload_ciphertext: null, payload_iv: null, claim_token: null, claim_expires_at: null })
})

test('H3 numeric webhook reuse across two messages and deliveries retains both receipts', async t => {
  const { sqlite, database } = createDatabase()
  t.after(() => sqlite.close())
  seedDelivery(sqlite)
  sqlite.exec("INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES ('delivery_other_123', 1, 7, 'hash_123456789', 'other@jednadvacet.org', 0, 'created', 'pending', '2026-09-21', '2026-09-21')")
  await withCallbackRoute(database, async baseUrl => {
    const base = JSON.parse(callbackBody('delivered'))
    for (const value of [base, { ...base, 'X-Mailin-custom': 'delivery_other_123', 'message-id': 'Second.Message+Case@Relay.Domain' }]) {
      assert.equal((await postCallback(baseUrl, JSON.stringify(value), 'Bearer callback-secret-for-tests')).status, 202)
    }
  })
  assert.deepEqual(sqlite.prepare('SELECT delivery_id, event, provider_message_id FROM notification_delivery_callbacks ORDER BY delivery_id').all(), [
    { delivery_id: 'delivery_123456789', event: 'delivered', provider_message_id: '201798300811.5787683@relay.domain.com' },
    { delivery_id: 'delivery_other_123', event: 'delivered', provider_message_id: 'Second.Message+Case@Relay.Domain' },
  ])
  assert.equal(sqlite.prepare("SELECT count(*) n FROM notification_event_deliveries WHERE status = 'delivered'").get().n, 2)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_suppressions').get().n, 0)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_contacts').get().n, 1)
  assert.equal(sqlite.prepare('SELECT status FROM notification_outbox').get().status, 'claimed')
})

for (const [label, mutation] of [
  ['missing ts_event', { ts_event: undefined }],
  ['string ts_event', { ts_event: '1604933654' }],
  ['fraction ts_event', { ts_event: 1_604_933_654.5 }],
  ['unsafe ts_event', { ts_event: Number.MAX_SAFE_INTEGER + 1 }],
  ['out-of-range ts_event', { ts_event: 253_402_300_800 }],
  ['zero ts_event', { ts_event: 0 }],
  ['negative ts_event', { ts_event: -1 }],
  ['null ts_event', { ts_event: null }],
  ['naive date cannot replace ts_event', { ts_event: undefined, date: '2020-11-09 15:54:14' }],
  ['UTC date cannot replace ts_event', { ts_event: undefined, date: '2020-11-09T14:54:14Z' }],
  ['ts alias cannot replace ts_event', { ts_event: undefined, ts: 1_604_933_654, ts_epoch: 1_604_933_654_000 }],
  ['missing custom header with matching provider and recipient', { 'X-Mailin-custom': undefined }],
  ['deliveryId alias only', { 'X-Mailin-custom': undefined, deliveryId: 'delivery_123456789' }],
  ['messageId alias only', { 'message-id': undefined, messageId: '<201798300811.5787683@relay.domain.com>' }],
  ['both aliases only', { 'X-Mailin-custom': undefined, deliveryId: 'delivery_123456789', 'message-id': undefined, messageId: '<201798300811.5787683@relay.domain.com>' }],
  ['unknown local ID', { 'X-Mailin-custom': 'delivery_unknown_123' }],
  ['bracketed local ID', { 'X-Mailin-custom': '<delivery_123456789>' }],
  ['punctuated local ID', { 'X-Mailin-custom': 'delivery.123456789' }],
  ['wrong provider message with matching alias', { 'message-id': 'wrong-provider-id', messageId: '201798300811.5787683@relay.domain.com' }],
  ['provider case conflict', { 'message-id': '201798300811.5787683@Relay.domain.com' }],
  ['unsafe webhook ID', { id: Number.MAX_SAFE_INTEGER + 1 }],
  ['string webhook ID', { id: '26224' }],
  ['zero webhook ID', { id: 0 }],
  ['fraction webhook ID', { id: 26224.5 }],
  ['257 UTF-8 byte ID', { 'message-id': `${'ž'.repeat(128)}x` }],
  ['257 wrapped UTF-8 byte ID', { 'message-id': `<${'ž'.repeat(127)}x>` }],
  ['empty provider ID', { 'message-id': '' }],
  ['empty bracket ID', { 'message-id': '<>' }],
  ['unclosed bracket ID', { 'message-id': '<provider-id' }],
  ['unopened bracket ID', { 'message-id': 'provider-id>' }],
  ['nested bracket ID', { 'message-id': '<<provider-id>>' }],
  ['C0 control ID', { 'message-id': 'provider\u0000id' }],
  ['newline ID', { 'message-id': 'provider\nid' }],
  ['DEL control ID', { 'message-id': 'provider\u007fid' }],
  ['C1 control ID', { 'message-id': 'provider\u0085id' }],
] as const) test(`H3 rejects isolated callback authority defect without writes: ${label}`, async t => {
  const { sqlite, database } = createDatabase()
  t.after(() => sqlite.close())
  // Malformed provider IDs start without a stored ID so agreement guards cannot
  // mask a validation defect. Authority/conflict cases have an exact stored ID.
  const malformedProviderId = 'message-id' in mutation && mutation['message-id'] !== undefined && !label.includes('conflict') && !label.startsWith('wrong provider')
  seedDelivery(sqlite, 'submitted', malformedProviderId ? null : '201798300811.5787683@relay.domain.com')
  const tables = ['notification_event_deliveries', 'notification_delivery_callbacks', 'notification_suppressions', 'notification_contacts', 'notification_outbox']
  const before = tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all())
  await withCallbackRoute(database, async baseUrl => {
    const value = { ...JSON.parse(callbackBody('hard_bounce')), email: 'synthetic@example.test', ...mutation }
    assert.equal((await postCallback(baseUrl, JSON.stringify(value), 'Bearer callback-secret-for-tests')).status, 202)
  })
  assert.deepEqual(tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all()), before)
})

test('unrelated and obsolete provider events are acknowledged without lifecycle mutation', async () => {
  for (const event of ['request', 'opened', 'click', 'complaint', 'hard-bounce', 'soft-bounce']) {
    const { sqlite, database } = createDatabase()
    seedDelivery(sqlite)
    await withCallbackRoute(database, async baseUrl => {
      const response = await postCallback(baseUrl, callbackBody(event), 'Bearer callback-secret-for-tests')
      assert.equal(response.status, 202, event)
    })

    assert.deepEqual(sqlite.prepare('SELECT status, provider_message_id FROM notification_event_deliveries').get(), { status: 'pending', provider_message_id: null }, event)
    assert.deepEqual(sqlite.prepare('SELECT * FROM notification_delivery_callbacks').all(), [], event)
    assert.deepEqual(sqlite.prepare('SELECT * FROM notification_suppressions').all(), [], event)
    assert.deepEqual(sqlite.prepare('SELECT id, capability_generation FROM notification_contacts').get(), { id: 1, capability_generation: 7 }, event)
    assert.deepEqual(sqlite.prepare('SELECT status, version, payload_ciphertext FROM notification_outbox').get(), { status: 'claimed', version: 1, payload_ciphertext: 'ciphertext' }, event)
  }

  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)
  await withCallbackRoute(database, async baseUrl => {
    const response = await postCallback(baseUrl, JSON.stringify({ event: 'hardBounce', id: 'not-opaque', 'X-Mailin-custom': 'delivery_123456789' }), 'Bearer callback-secret-for-tests')
    assert.equal(response.status, 202)
  })
  assert.deepEqual(sqlite.prepare('SELECT status, provider_message_id FROM notification_event_deliveries').get(), { status: 'pending', provider_message_id: null })
  assert.deepEqual(sqlite.prepare('SELECT * FROM notification_delivery_callbacks').all(), [])
})

test('only an exact callback bearer reaches route processing', async () => {
  for (const authorization of [undefined, 'Basic callback-secret-for-tests', 'Bearer wrong-callback-secret']) {
    const { sqlite, database } = createDatabase()
    seedDelivery(sqlite)
    await withCallbackRoute(database, async baseUrl => {
      const response = await postCallback(baseUrl, callbackBody('hardBounce'), authorization)
      assert.equal(response.status, 401, authorization ?? 'missing authorization')
      assert.equal((await response.json() as { statusMessage: string }).statusMessage, 'Invalid callback authorization')
    })

    assert.deepEqual(sqlite.prepare('SELECT status, provider_message_id FROM notification_event_deliveries').get(), { status: 'pending', provider_message_id: null })
    assert.deepEqual(sqlite.prepare('SELECT * FROM notification_delivery_callbacks').all(), [])
    assert.deepEqual(sqlite.prepare('SELECT * FROM notification_suppressions').all(), [])
    assert.deepEqual(sqlite.prepare('SELECT id FROM notification_contacts').get(), { id: 1 })
    assert.equal(sqlite.prepare('SELECT status FROM notification_outbox').get().status, 'claimed')
  }
})

const callback = (kind: Parameters<typeof applyBrevoCallback>[0]['kind'], id = 'event_123456789', deliveryId = 'delivery_123456789') => ({ id, deliveryId, kind, providerMessageId: 'message_123456789', occurredAt: '2026-09-21T10:00:00Z' })

test('receipt identity admits distinct delivery events sharing a webhook ID while provider conflicts remain inert', async () => {
  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)
  await applyBrevoCallback(callback('delivered'), database)
  sqlite.exec("INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES ('delivery_other_123', 1, 7, 'hash_123456789', 'other@jednadvacet.org', 0, 'created', 'pending', '2026-09-21', '2026-09-21')")
  assert.deepEqual(await applyBrevoCallback(callback('hard-bounce', 'event_123456789', 'delivery_other_123'), database), { applied: true, suppressed: true })
  assert.equal(sqlite.prepare("SELECT status FROM notification_event_deliveries WHERE id = 'delivery_other_123'").get().status, 'hard-bounce')
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_suppressions').get().n, 1)
  assert.deepEqual(await applyBrevoCallback({ ...callback('hard-bounce', 'event_conflict_123'), providerMessageId: 'message_conflict_123' }, database), { applied: false, suppressed: false })
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 2)
  assert.equal(sqlite.prepare("SELECT provider_message_id FROM notification_event_deliveries WHERE id = 'delivery_123456789'").get().provider_message_id, 'message_123456789')
})

test('overlapping lower-rank callback never downgrades a committed terminal callback', async () => {
  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  const lower = applyBrevoCallback(callback('delivered', 'event_lower_123'), { ...database, batch: async statements => { entered(); await paused; return database.batch(statements) } })
  await ready
  await applyBrevoCallback(callback('hard-bounce', 'event_upper_123'), database)
  release()
  await lower
  assert.equal(sqlite.prepare('SELECT status FROM notification_event_deliveries').get().status, 'hard-bounce')
  assert.equal(sqlite.prepare('SELECT reason FROM notification_suppressions').get().reason, 'provider-bounce')
})

test('both callback rank orders, duplicates, and deleted contacts retain monotonic privacy-safe evidence', async () => {
  for (const kinds of [['hard-bounce', 'delivered'], ['delivered', 'hard-bounce'], ['soft-bounce', 'delivered'], ['delivered', 'soft-bounce']] as const) {
    const { sqlite, database } = createDatabase()
    seedDelivery(sqlite)
    for (const [index, kind] of kinds.entries()) await applyBrevoCallback(callback(kind, `event_order_${index}`), database)
    await applyBrevoCallback(callback(kinds[0], 'event_order_0'), database)
    assert.equal(sqlite.prepare('SELECT status FROM notification_event_deliveries').get().status, kinds.includes('hard-bounce') ? 'hard-bounce' : 'soft-bounce')
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 2)
  }
  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)
  sqlite.exec('DELETE FROM notification_contacts')
  assert.deepEqual(await applyBrevoCallback(callback('complaint'), database), { applied: true, suppressed: true })
  assert.equal(sqlite.prepare('SELECT reason FROM notification_suppressions').get().reason, 'provider-complaint')
})

test('callback racing generation recovery cannot delete or invalidate replacement-generation work', async () => {
  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  const raced = applyBrevoCallback(callback('hard-bounce'), { ...database, batch: async statements => { entered(); await paused; return database.batch(statements) } })
  await ready
  const config = await notificationConfig({ notificationCommunitySlugs: 'brno', notificationRootKey: btoa('01234567890123456789012345678901').replace(/=+$/g, ''), notificationTurnstileSecret: 'synthetic', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09' })
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'synthetic@example.test' }, { database, config })
  release()
  await raced
  assert.equal(sqlite.prepare('SELECT capability_generation FROM notification_contacts').get().capability_generation, 8)
  assert.equal(sqlite.prepare("SELECT status FROM notification_outbox WHERE expected_capability_generation = 8").get().status, 'pending')
  assert.equal(sqlite.prepare("SELECT status FROM notification_outbox WHERE expected_capability_generation = 7").get().status, 'invalidated')
  assert.equal(sqlite.prepare('SELECT reason FROM notification_suppressions').get().reason, 'provider-bounce')
})

test('actual H3 route rejects duplicate bearer, oversized body, invalid JSON and overlarge batches without writes', async () => {
  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)
  await withCallbackRoute(database, async baseUrl => {
    for (const [body, authorization, expected] of [
      [callbackBody('hardBounce'), 'Bearer callback-secret-for-tests, Bearer callback-secret-for-tests', 401],
      ['x'.repeat(65_537), 'Bearer callback-secret-for-tests', 413],
      [JSON.stringify({ ignored: 'ž'.repeat(33_000) }), 'Bearer callback-secret-for-tests', 413],
      ['{', 'Bearer callback-secret-for-tests', 400],
      [JSON.stringify(Array(51).fill(JSON.parse(callbackBody('hardBounce')))), 'Bearer callback-secret-for-tests', 400],
    ] as const) {
      const response = await postCallback(baseUrl, body, authorization)
      assert.equal(response.status, expected)
      assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 0)
    }
  })
})
