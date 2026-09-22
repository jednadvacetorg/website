import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { consumeNotificationOutboxPointer, parseNotificationOutboxPointer, publishPendingNotificationPointers } from '../server/utils/notificationMessagesQueue.ts'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { activateNotificationChannel, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => {
  exec(sql: string): void
  prepare(sql: string): { run(...values: unknown[]): unknown, get(...values: unknown[]): unknown, all(...values: unknown[]): unknown[] }
}

const schema = `
  CREATE TABLE notification_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, destination TEXT NOT NULL, destination_hash TEXT NOT NULL, management_token_digest TEXT NOT NULL, capability_generation INTEGER NOT NULL, state TEXT NOT NULL, consent_at TEXT NOT NULL, consent_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(channel, destination));
  CREATE TABLE notification_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, community_slug TEXT NOT NULL, frequency TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(contact_id, community_slug, frequency));
   CREATE TABLE notification_suppressions (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, destination_hash TEXT NOT NULL, reason TEXT NOT NULL, suppressed_at TEXT NOT NULL, UNIQUE(channel, destination_hash));
   CREATE TABLE notification_abuse_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_hash TEXT NOT NULL, attempted_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE notification_outbox (id TEXT PRIMARY KEY, contact_id INTEGER NOT NULL, version INTEGER NOT NULL, expected_capability_generation INTEGER NOT NULL, status TEXT NOT NULL, claim_token TEXT, claim_expires_at TEXT, payload_ciphertext TEXT, payload_iv TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT);
   CREATE TABLE notification_event_deliveries (id TEXT PRIMARY KEY, contact_id INTEGER NOT NULL, expected_capability_generation INTEGER NOT NULL, destination_hash TEXT NOT NULL, event_uid TEXT NOT NULL, event_revision INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed')), provider_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT);
 `

const disposableDatabase = (): { database: NotificationDatabase, query(sql: string): Record<string, unknown>[] } => {
  const sqlite = new Database(':memory:')
  sqlite.exec(schema)
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
  return { database: { prepare: statement, batch: async statements => { for (const item of statements) await item.run() } }, query: sql => sqlite.prepare(sql).all() as Record<string, unknown>[] }
}

const keyMaterial = new TextEncoder().encode('01234567890123456789012345678901')
const root = btoa(String.fromCharCode(...keyMaterial)).replace(/=+$/g, '')
const config = await notificationConfig({
  notificationCommunitySlugs: 'brno', notificationRootKey: root,
  notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09',
  notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
})
const predictableCrypto = { randomBytes: (length: number) => new Uint8Array(length), subtle: crypto.subtle }
const input = { channel: 'email' as const, contact: 'alice@example.com', communitySlugs: ['brno'], frequencies: ['created'] as const, consentAt: '2026-09-17T00:00:00.000Z', consentVersion: '2026-09' }
const pointerFor = (query: (sql: string) => Record<string, unknown>[]) => {
  const [outbox] = query('SELECT id, version FROM notification_outbox')
  return { outboxId: outbox!.id as string, version: outbox!.version as number }
}
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const encryptedEventPayload = async (deliveryId: string) => {
  const iv = new Uint8Array(12)
  const plaintext = new TextEncoder().encode(JSON.stringify({
    destination: 'alice@example.com',
    deliveryId,
    managementCapability: 'capability',
    event: { title: 'Meetup', start: '2026-10-01T17:00:00.000Z', end: '2026-10-01T19:00:00.000Z', uid: 'brno-1@jednadvacet.org', sequence: 1 },
    reason: 'created',
    kind: 'event-email',
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
          if (transition === 'stop') await database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL WHERE id = ? AND version = ?').bind('invalidated', pointer.outboxId, pointer.version).run()
          else {
            await database.prepare('UPDATE notification_contacts SET capability_generation = capability_generation + 1').run()
            await database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL WHERE id = ? AND version = ?').bind('invalidated', pointer.outboxId, pointer.version).run()
          }
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
    assert.deepEqual(query('SELECT status, payload_ciphertext FROM notification_outbox'), [{ status: 'invalidated', payload_ciphertext: null }])
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
      subtle: { ...crypto.subtle, decrypt: async (...args: Parameters<SubtleCrypto['decrypt']>) => { decrypts += 1; return crypto.subtle.decrypt(...args) } } as SubtleCrypto,
    },
    barriers: {
      afterClaimedAndDecrypted: async () => {
        await database.prepare('INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT channel, destination_hash, ?, ? FROM notification_contacts').bind('user-stop', '2026-09-17T00:00:01.000Z').run()
        await database.prepare('DELETE FROM notification_contacts').run()
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
      subtle: { ...crypto.subtle, decrypt: async (...args: Parameters<SubtleCrypto['decrypt']>) => { decrypts += 1; return crypto.subtle.decrypt(...args) } } as SubtleCrypto,
    },
    barriers: {
      afterClaimedAndDecrypted: async () => {
        await database.prepare('UPDATE notification_contacts SET capability_generation = capability_generation + 1').run()
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

test('retryable and terminal provider results never write unsupported delivery statuses', async () => {
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

  await assert.rejects(consumeNotificationOutboxPointer(pointer, { database, config: eventConfig, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'rate-limited' })))
  assert.deepEqual(query('SELECT status FROM notification_event_deliveries'), [{ status: 'pending' }])
  assert.deepEqual(query('SELECT status FROM notification_outbox'), [{ status: 'queued' }])

  assert.deepEqual(await consumeNotificationOutboxPointer(pointer, { database, config: eventConfig, crypto: predictableCrypto }, async () => ({ attempted: true, status: 'invalid-request' })), { delivered: true, stale: false })
  assert.deepEqual(query('SELECT status FROM notification_event_deliveries'), [{ status: 'failed' }])
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
