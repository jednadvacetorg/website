import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createApp, eventHandler, toNodeListener } from 'h3'

import { applyBrevoCallback, normalizeBrevoCallback } from '../server/utils/brevoCallbacks.ts'
import type { NotificationDatabase, NotificationStatement } from '../server/utils/notifications.ts'
import { requestNotificationManagementRecovery } from '../server/utils/notifications.ts'
import { notificationConfig } from '../server/utils/notificationConfig.ts'

let runtimeConfig: Record<string, unknown> = { brevoCallbackSecret: 'callback-secret-for-tests' }
;(globalThis as typeof globalThis & { useRuntimeConfig: () => Record<string, unknown> }).useRuntimeConfig = () => runtimeConfig

const callbackRoute = (await import('../server/api/notifications/brevo-events.post.ts')).default

const createDatabase = () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(readFileSync(new URL('../server/db/migrations/sqlite/0000_majestic_lightspeed.sql', import.meta.url), 'utf8'))
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

const seedDelivery = (sqlite: Database.Database, status = 'pending') => {
  sqlite.prepare("INSERT INTO notification_contacts (id, channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (1, 'email', 'synthetic@example.test', 'hash_123456789', 'synthetic_digest', 7, 'active', '2026-09-21', '2026-09', '2026-09-21', '2026-09-21')").run()
  sqlite.prepare("INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, 1, 7, 'hash_123456789', 'event@jednadvacet.org', 0, 'created', ?, '2026-09-21', '2026-09-21')").run('delivery_123456789', status)
  sqlite.prepare("INSERT INTO notification_outbox (id, contact_id, expected_capability_generation, version, status, payload_ciphertext, payload_iv, claim_token, claim_expires_at, kind, created_at, updated_at) VALUES ('outbox_123456789', 1, 7, 1, 'claimed', 'ciphertext', 'iv', 'claim', '2026-09-21T01:00:00.000Z', 'event-email', '2026-09-21', '2026-09-21')").run()
}

const callbackBody = (event: string, id = 'event_123456789') => JSON.stringify({
  id,
  event,
  'X-Mailin-custom': 'delivery_123456789',
  messageId: 'message_123456789',
  email: 'not-authoritative@example.test',
  date: '2026-09-21T10:00:00.000Z',
})

const postCallback = (baseUrl: string, body: string, authorization?: string) => fetch(`${baseUrl}/brevo`, {
  method: 'POST',
  headers: authorization ? { authorization } : undefined,
  body,
})

test('Brevo callbacks retain only opaque correlation and fixed categories', () => {
  const callback = normalizeBrevoCallback({ id: 'event_123456789', event: 'hardBounce', 'X-Mailin-custom': 'delivery_123456789', messageId: 'message_123456789', email: 'must-not-be-used@example.test', date: '2026-09-21T10:00:00.000Z' })
  assert.deepEqual(callback, { id: 'event_123456789', deliveryId: 'delivery_123456789', kind: 'hard-bounce', providerMessageId: 'message_123456789', occurredAt: '2026-09-21T10:00:00.000Z' })
  assert.equal(normalizeBrevoCallback({ event: 'delivered', email: 'not-authority@example.test' }), undefined)
  assert.equal(normalizeBrevoCallback({ id: 'event_123456789', event: 'unknown', 'X-Mailin-custom': 'delivery_123456789' }), undefined)
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
    { event: 'softBounce', status: 'soft-bounce' },
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

test('receipt replay cannot mutate a different delivery and provider ID mismatch cannot overwrite evidence', async () => {
  const { sqlite, database } = createDatabase()
  seedDelivery(sqlite)
  await applyBrevoCallback(callback('delivered'), database)
  sqlite.exec("INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES ('delivery_other_123', 1, 7, 'hash_123456789', 'other@jednadvacet.org', 0, 'created', 'pending', '2026-09-21', '2026-09-21')")
  assert.deepEqual(await applyBrevoCallback(callback('hard-bounce', 'event_123456789', 'delivery_other_123'), database), { applied: false, suppressed: false })
  assert.equal(sqlite.prepare("SELECT status FROM notification_event_deliveries WHERE id = 'delivery_other_123'").get().status, 'pending')
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_suppressions').get().n, 0)
  assert.deepEqual(await applyBrevoCallback({ ...callback('hard-bounce', 'event_conflict_123'), providerMessageId: 'message_conflict_123' }, database), { applied: false, suppressed: false })
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_delivery_callbacks').get().n, 1)
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
