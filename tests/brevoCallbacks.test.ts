import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createApp, eventHandler, toNodeListener } from 'h3'

import { normalizeBrevoCallback } from '../server/utils/brevoCallbacks.ts'
import type { NotificationDatabase } from '../server/utils/notifications.ts'

let runtimeConfig: Record<string, unknown> = { brevoCallbackSecret: 'callback-secret-for-tests' }
;(globalThis as typeof globalThis & { useRuntimeConfig: () => Record<string, unknown> }).useRuntimeConfig = () => runtimeConfig

const callbackRoute = (await import('../server/api/notifications/brevo-events.post.ts')).default

const createDatabase = () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE notification_event_deliveries (
      id TEXT PRIMARY KEY,
      contact_id INTEGER,
      expected_capability_generation INTEGER NOT NULL,
      destination_hash TEXT NOT NULL,
      provider_message_id TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE notification_delivery_callbacks (
      provider_event_id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      event TEXT NOT NULL,
      provider_message_id TEXT,
      received_at TEXT NOT NULL
    );
    CREATE TABLE notification_suppressions (
      channel TEXT NOT NULL,
      destination_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      suppressed_at TEXT NOT NULL,
      PRIMARY KEY (channel, destination_hash)
    );
    CREATE TABLE notification_outbox (
      id TEXT PRIMARY KEY,
      contact_id INTEGER,
      expected_capability_generation INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_ciphertext TEXT,
      payload_iv TEXT,
      claim_token TEXT,
      claim_expires_at TEXT,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );
    CREATE TABLE notification_contacts (
      id INTEGER PRIMARY KEY,
      capability_generation INTEGER NOT NULL
    );
  `)
  const database: NotificationDatabase = {
    prepare: query => {
      let values: unknown[] = []
      const statement = {
        bind: (...nextValues: unknown[]) => {
          values = nextValues
          return statement
        },
        first: async <T>() => sqlite.prepare(query).get(...values) as T | null,
        all: async <T>() => ({ results: sqlite.prepare(query).all(...values) as T[] }),
        run: async () => sqlite.prepare(query).run(...values),
      }
      return statement
    },
    batch: async statements => {
      const transaction = sqlite.transaction(() => {
        for (const statement of statements) {
          const query = statement as unknown as { run?: () => unknown }
          query.run?.()
        }
      })
      transaction()
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

test('Brevo callbacks retain only opaque correlation and fixed categories', () => {
  const callback = normalizeBrevoCallback({ id: 'event_123456789', event: 'hardBounce', 'X-Mailin-custom': 'delivery_123456789', messageId: 'message_123456789', email: 'must-not-be-used@example.test', date: '2026-09-21T10:00:00.000Z' })
  assert.deepEqual(callback, { id: 'event_123456789', deliveryId: 'delivery_123456789', kind: 'hard-bounce', providerMessageId: 'message_123456789', occurredAt: '2026-09-21T10:00:00.000Z' })
  assert.equal(normalizeBrevoCallback({ event: 'delivered', email: 'not-authority@example.test' }), undefined)
  assert.equal(normalizeBrevoCallback({ id: 'event_123456789', event: 'unknown', 'X-Mailin-custom': 'delivery_123456789' }), undefined)
})

test('an authenticated hardBounce callback suppresses the matching delivery generation', async () => {
  const { sqlite, database } = createDatabase()
  sqlite.prepare('INSERT INTO notification_contacts (id, capability_generation) VALUES (?, ?)').run(1, 7)
  sqlite.prepare('INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('delivery_123456789', 1, 7, 'hash_123456789', 'pending', '2026-09-21T00:00:00.000Z')
  sqlite.prepare('INSERT INTO notification_outbox (id, contact_id, expected_capability_generation, version, status, payload_ciphertext, payload_iv, claim_token, claim_expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('outbox_123456789', 1, 7, 1, 'claimed', 'ciphertext', 'iv', 'claim', '2026-09-21T01:00:00.000Z', '2026-09-21T00:00:00.000Z')

  await withCallbackRoute(database, async baseUrl => {
    const response = await fetch(`${baseUrl}/brevo`, {
      method: 'POST',
      headers: { authorization: 'Bearer callback-secret-for-tests' },
      body: JSON.stringify({
        id: 'event_123456789',
        event: 'hardBounce',
        'X-Mailin-custom': 'delivery_123456789',
        messageId: 'message_123456789',
        email: 'not-authoritative@example.test',
        date: '2026-09-21T10:00:00.000Z',
      }),
    })
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
