import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { evaluateNotificationAbuse } from '../server/utils/notificationAbuse.ts'
import { activateNotificationChannel, confirmNotificationReactivation, isDeliveryEligible, readNotificationManagement, removeNotificationCommunity, requestNotificationManagementRecovery, stopNotificationChannel, updateNotificationFrequencies, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'
import { notificationUiVerificationDecision, notificationUiVerificationFixtureEnabled, notificationUiVerificationToken } from '../server/utils/notificationUiVerificationFixture.ts'
import { projectNotificationReadiness } from '../server/api/notifications/readiness.get.ts'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => {
  exec(sql: string): void
  prepare(sql: string): { run(...values: unknown[]): unknown, get(...values: unknown[]): unknown, all(...values: unknown[]): unknown[] }
}

const schema = `
  CREATE TABLE notification_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, destination TEXT NOT NULL, destination_hash TEXT NOT NULL, destination_hash_key_version TEXT NOT NULL, management_token_digest TEXT NOT NULL, capability_generation INTEGER NOT NULL, state TEXT NOT NULL, consent_at TEXT NOT NULL, consent_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(channel, destination));
  CREATE TABLE notification_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, community_slug TEXT NOT NULL, frequency TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(contact_id, community_slug, frequency));
  CREATE TABLE notification_suppressions (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, destination_hash TEXT NOT NULL, destination_hash_key_version TEXT NOT NULL, reason TEXT NOT NULL, suppressed_at TEXT NOT NULL, UNIQUE(channel, destination_hash));
   CREATE TABLE notification_outbox (id TEXT PRIMARY KEY, contact_id INTEGER NOT NULL, version INTEGER NOT NULL, expected_capability_generation INTEGER NOT NULL, status TEXT NOT NULL, claim_token TEXT, claim_expires_at TEXT, payload_ciphertext TEXT, payload_iv TEXT, transport_key_version TEXT, kind TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT);
   CREATE TABLE notification_management_capabilities (token_digest TEXT PRIMARY KEY, contact_id INTEGER NOT NULL, expected_capability_generation INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT);
  CREATE TABLE notification_abuse_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, requester_hash TEXT NOT NULL, requester_hash_key_version TEXT NOT NULL, attempted_at TEXT NOT NULL, expires_at TEXT NOT NULL);
`

const disposableDatabase = (failsStatement?: (sql: string) => boolean): { database: NotificationDatabase, query(sql: string): unknown[] } => {
  const sqlite = new Database(':memory:')
  sqlite.exec(schema)
  const statement = (sql: string): NotificationStatement => {
    let values: unknown[] = []
    const result: NotificationStatement = {
      bind: (...bound) => { values = bound; return result },
      first: async <T>() => sqlite.prepare(sql).get(...values) as T ?? null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
      run: async () => {
        if (failsStatement?.(sql)) throw new Error('Injected D1 statement failure')
        sqlite.prepare(sql).run(...values)
      },
    }
    return result
  }
  return {
    database: {
      prepare: statement,
      batch: async (statements) => {
        sqlite.exec('BEGIN')
        try {
          for (const item of statements) await item.run()
          sqlite.exec('COMMIT')
        } catch (error) {
          sqlite.exec('ROLLBACK')
          throw error
        }
      },
    },
    query: sql => sqlite.prepare(sql).all(),
  }
}

const pauseFirstBatch = (database: NotificationDatabase) => {
  let entered!: () => void
  let release!: () => void
  const firstBatchEntered = new Promise<void>(resolve => { entered = resolve })
  const releaseFirstBatch = new Promise<void>(resolve => { release = resolve })
  let batches = 0
  return {
    database: {
      ...database,
      batch: async (statements: NotificationStatement[]) => {
        if (batches++ === 0) {
          entered()
          await releaseFirstBatch
        }
        return database.batch(statements)
      },
    },
    firstBatchEntered,
    release: () => release(),
  }
}

const key = btoa('01234567890123456789012345678901').replace(/=+$/g, '')
const config = {
  communitySlugs: ['brno', 'praha'],
  suppressionHashKeys: { v1: await crypto.subtle.importKey('raw', new TextEncoder().encode('01234567890123456789012345678901'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) },
  currentSuppressionHashKeyVersion: 'v1',
  abuseHashKeys: { v1: await crypto.subtle.importKey('raw', new TextEncoder().encode('12345678901234567890123456789012'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) },
  currentAbuseHashKeyVersion: 'v1',
  turnstile: { secret: 'private-turnstile-secret', expectedHostname: 'jednadvacet.org' },
  outboxTransportKeys: { v1: await crypto.subtle.importKey('raw', Uint8Array.from(atob(key), character => character.charCodeAt(0)), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) },
  currentOutboxTransportKeyVersion: 'v1',
  consentVersion: '2026-09',
  emailSmsEnabled: true,
  emailSmsFirstMessageReady: true,
  emailSmsEventDeliveryReady: true,
  webPushEnabled: false,
  webPushFirstMessageReady: false,
  webPushEventDeliveryReady: false,
}

const predictableCrypto = { randomBytes: (length: number) => new Uint8Array(length), subtle: crypto.subtle }
const tokenForByte = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte))).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0))
const input = { channel: 'email' as const, contact: 'Alice@Example.COM', communitySlugs: ['brno'], frequencies: ['created', 'day-before'] as ('created' | 'day-before')[], consentAt: '2026-09-15T12:00:00.000Z', consentVersion: '2026-09' }

test('activation stores one plaintext contact, one row per frequency, and an encrypted first-activation outbox row', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  assert.deepEqual(query('SELECT channel, destination, capability_generation FROM notification_contacts'), [{ channel: 'email', destination: 'Alice@example.com', capability_generation: 1 }])
  assert.deepEqual(query('SELECT community_slug, frequency FROM notification_subscriptions ORDER BY frequency'), [{ community_slug: 'brno', frequency: 'created' }, { community_slug: 'brno', frequency: 'day-before' }])
  const [outbox] = query('SELECT version, expected_capability_generation, status, kind, payload_ciphertext, payload_iv FROM notification_outbox') as Record<string, unknown>[]
  assert.deepEqual({ version: outbox?.version, expected: outbox?.expected_capability_generation, status: outbox?.status, kind: outbox?.kind }, { version: 1, expected: 1, status: 'pending', kind: 'first-activation' })
  assert.equal(typeof outbox?.payload_ciphertext, 'string')
  assert.equal(typeof outbox?.payload_iv, 'string')
})

test('fresh activation atomically rolls back every lifecycle row after a late outbox failure', async () => {
  const { database, query } = disposableDatabase(sql => sql.startsWith('INSERT INTO notification_outbox'))

  await assert.rejects(activateNotificationChannel(input, { database, config, crypto: predictableCrypto }), /Injected D1 statement failure/)

  assert.equal(query('SELECT * FROM notification_contacts').length, 0)
  assert.equal(query('SELECT * FROM notification_subscriptions').length, 0)
  assert.equal(query('SELECT * FROM notification_outbox').length, 0)
})

test('fresh activation leaves no lifecycle rows when payload encryption fails', async () => {
  const { database, query } = disposableDatabase()
  const failingCrypto = {
    randomBytes: predictableCrypto.randomBytes,
    subtle: {
      digest: crypto.subtle.digest.bind(crypto.subtle),
      sign: crypto.subtle.sign.bind(crypto.subtle),
      encrypt: async () => { throw new Error('Injected payload encryption failure') },
    } as SubtleCrypto,
  }

  await assert.rejects(activateNotificationChannel(input, { database, config, crypto: failingCrypto }), /Injected payload encryption failure/)

  assert.equal(query('SELECT * FROM notification_contacts').length, 0)
  assert.equal(query('SELECT * FROM notification_subscriptions').length, 0)
  assert.equal(query('SELECT * FROM notification_outbox').length, 0)
})

test('private purpose-specific keyrings import a Worker AES-GCM key for an activation outbox write', async () => {
  const { database, query } = disposableDatabase()
  const runtimeConfig = await notificationConfig({
    notificationCommunitySlugs: 'brno,praha',
    notificationSuppressionHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentSuppressionHashKeyVersion: 'v1',
    notificationAbuseHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentAbuseHashKeyVersion: 'v1',
    notificationTurnstileSecret: 'private-turnstile-secret',
    notificationTurnstileExpectedHostname: 'jednadvacet.org',
    notificationOutboxTransportKeys: JSON.stringify({ v1: key }),
    notificationCurrentOutboxTransportKeyVersion: 'v1',
    notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true,
    notificationEmailSmsFirstMessageReady: true,
    notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false,
    notificationWebPushFirstMessageReady: false,
    notificationWebPushEventDeliveryReady: false,
  })

  assert.ok('outboxTransportKeys' in runtimeConfig)
  await activateNotificationChannel(input, { database, config: runtimeConfig, crypto: predictableCrypto })
  const [outbox] = query('SELECT transport_key_version, payload_ciphertext, payload_iv FROM notification_outbox') as { transport_key_version: string, payload_ciphertext: string, payload_iv: string }[]
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(outbox!.payload_iv) },
    runtimeConfig.outboxTransportKeys.v1!,
    fromBase64Url(outbox!.payload_ciphertext),
  )

  assert.equal(outbox!.transport_key_version, 'v1')
  assert.match(new TextDecoder().decode(plaintext), /"destination":"Alice@example.com"/)
})

test('missing, malformed, short, and unknown-current private key material fails before activation', async () => {
  const validRuntimeConfig = {
    notificationCommunitySlugs: 'brno,praha',
    notificationSuppressionHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentSuppressionHashKeyVersion: 'v1',
    notificationAbuseHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentAbuseHashKeyVersion: 'v1',
    notificationTurnstileSecret: 'private-turnstile-secret',
    notificationTurnstileExpectedHostname: 'jednadvacet.org',
    notificationOutboxTransportKeys: JSON.stringify({ v1: key }),
    notificationCurrentOutboxTransportKeyVersion: 'v1',
    notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true,
    notificationEmailSmsFirstMessageReady: true,
    notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false,
    notificationWebPushFirstMessageReady: false,
    notificationWebPushEventDeliveryReady: false,
  }
  const invalidConfigurations = [
    { ...validRuntimeConfig, notificationOutboxTransportKeys: '' },
    { ...validRuntimeConfig, notificationOutboxTransportKeys: '{' },
    { ...validRuntimeConfig, notificationOutboxTransportKeys: JSON.stringify({ v1: 'short' }) },
    { ...validRuntimeConfig, notificationCurrentOutboxTransportKeyVersion: 'v2' },
  ]

  for (const runtimeConfig of invalidConfigurations) await assert.rejects(notificationConfig(runtimeConfig))
})

test('public readiness keeps email false until separate delivery evidence is complete', async () => {
  const runtimeConfig = {
    notificationCommunitySlugs: 'brno',
    notificationSuppressionHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentSuppressionHashKeyVersion: 'v1',
    notificationAbuseHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentAbuseHashKeyVersion: 'v1',
    notificationTurnstileSecret: 'private-turnstile-secret',
    notificationTurnstileExpectedHostname: 'jednadvacet.org',
    notificationOutboxTransportKeys: JSON.stringify({ v1: key }),
    notificationCurrentOutboxTransportKeyVersion: 'v1',
    notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true,
    notificationEmailSmsFirstMessageReady: true,
    notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false,
    notificationWebPushFirstMessageReady: false,
    notificationWebPushEventDeliveryReady: false,
  }

  const { database } = disposableDatabase()
  assert.deepEqual(await projectNotificationReadiness(runtimeConfig, database), { email: false, sms: true, webPush: false })
  assert.deepEqual(await projectNotificationReadiness({ ...runtimeConfig, notificationOutboxTransportKeys: '' }, database), { email: false, sms: false, webPush: false })
})

test('public readiness rejects missing, malformed, and unretained D1 transport-key references', async () => {
  const { database } = disposableDatabase()
  const runtimeConfig = {
    notificationCommunitySlugs: 'brno', notificationSuppressionHashKeys: JSON.stringify({ v1: key }), notificationCurrentSuppressionHashKeyVersion: 'v1',
    notificationAbuseHashKeys: JSON.stringify({ v1: key }), notificationCurrentAbuseHashKeyVersion: 'v1', notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org',
    notificationOutboxTransportKeys: JSON.stringify({ v1: key }), notificationCurrentOutboxTransportKeyVersion: 'v1', notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false, notificationWebPushFirstMessageReady: false, notificationWebPushEventDeliveryReady: false,
  }
  assert.deepEqual(await projectNotificationReadiness(runtimeConfig), { email: false, sms: false, webPush: false })
  await database.batch(['pending', 'queued', 'claimed'].map((status, index) => database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, transport_key_version, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(`outbox-${index}`, 1, 1, 1, status, 'ciphertext', 'iv', index === 1 ? 'retired' : 'v1', 'first-activation', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')))
  assert.deepEqual(await projectNotificationReadiness(runtimeConfig, database), { email: false, sms: false, webPush: false })
  await database.prepare('UPDATE notification_outbox SET transport_key_version = ?').bind('v1').run()
  assert.deepEqual(await projectNotificationReadiness(runtimeConfig, database), { email: false, sms: true, webPush: false })
  await database.prepare('UPDATE notification_outbox SET transport_key_version = NULL WHERE status = ?').bind('queued').run()
  assert.deepEqual(await projectNotificationReadiness(runtimeConfig, database), { email: false, sms: false, webPush: false })
})

test('the deterministic UI fixture is only enabled in opted-in development and accepts only reserved contacts', () => {
  const runtimeConfig = { notificationUiVerificationFixture: true }
  assert.equal(notificationUiVerificationFixtureEnabled(runtimeConfig, false), false)
  assert.equal(notificationUiVerificationDecision(runtimeConfig, 'email', 'guide@example.test', notificationUiVerificationToken, false), null)
  assert.equal(notificationUiVerificationDecision(runtimeConfig, 'email', 'guide@example.test', undefined, true), 'challenge')
  assert.equal(notificationUiVerificationDecision(runtimeConfig, 'email', 'guide@example.test', notificationUiVerificationToken, true), 'success')
  assert.equal(notificationUiVerificationDecision(runtimeConfig, 'email', 'visitor@example.com', notificationUiVerificationToken, true), null)
})

test('private abuse and Turnstile configuration imports a dedicated HMAC key without exposing private values', async () => {
  const runtimeConfig = await notificationConfig({
    notificationCommunitySlugs: 'brno,praha',
    notificationSuppressionHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentSuppressionHashKeyVersion: 'v1',
    notificationOutboxTransportKeys: JSON.stringify({ v1: key }),
    notificationCurrentOutboxTransportKeyVersion: 'v1',
    notificationAbuseHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentAbuseHashKeyVersion: 'v1',
    notificationTurnstileSecret: 'private-turnstile-secret',
    notificationTurnstileExpectedHostname: 'jednadvacet.org',
    notificationTurnstileSiteKey: 'public-turnstile-site-key',
    notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true,
    notificationEmailSmsFirstMessageReady: true,
    notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false,
    notificationWebPushFirstMessageReady: false,
    notificationWebPushEventDeliveryReady: false,
  })

  assert.ok('abuseHashKeys' in runtimeConfig)
  assert.equal(runtimeConfig.currentAbuseHashKeyVersion, 'v1')
  assert.equal(runtimeConfig.turnstile.secret, 'private-turnstile-secret')
  assert.equal(runtimeConfig.turnstile.expectedHostname, 'jednadvacet.org')
  await assert.rejects(notificationConfig({
    notificationCommunitySlugs: 'brno',
    notificationSuppressionHashKeys: JSON.stringify({ v1: key }),
    notificationCurrentSuppressionHashKeyVersion: 'v1',
    notificationOutboxTransportKeys: JSON.stringify({ v1: key }),
    notificationCurrentOutboxTransportKeyVersion: 'v1',
    notificationAbuseHashKeys: '{',
    notificationCurrentAbuseHashKeyVersion: 'v1',
    notificationConsentVersion: '2026-09',
  }))
})

test('an outbox transport key remains mandatory while a nonterminal payload references it', async () => {
  const { database, query } = disposableDatabase()
  let randomCall = 0
  const uniqueCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(randomCall++), subtle: crypto.subtle }
  await activateNotificationChannel(input, { database, config, crypto: uniqueCrypto })
  const v2 = await crypto.subtle.importKey('raw', new TextEncoder().encode('12345678901234567890123456789012'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const retiredV1 = {
    ...config,
    outboxTransportKeys: { v2 },
    currentOutboxTransportKeyVersion: 'v2',
  }

  await assert.rejects(
    activateNotificationChannel({ ...input, contact: 'Bob@example.com' }, { database, config: retiredV1, crypto: uniqueCrypto }),
    { statusCode: 503 },
  )
  assert.deepEqual(query('SELECT transport_key_version FROM notification_outbox'), [{ transport_key_version: 'v1' }])

  const retainedKeyring = {
    ...config,
    outboxTransportKeys: { v1: config.outboxTransportKeys.v1, v2 },
    currentOutboxTransportKeyVersion: 'v2',
  }
  await activateNotificationChannel({ ...input, contact: 'Bob@example.com' }, { database, config: retainedKeyring, crypto: uniqueCrypto })
  assert.deepEqual(query('SELECT transport_key_version FROM notification_outbox ORDER BY transport_key_version'), [{ transport_key_version: 'v1' }, { transport_key_version: 'v2' }])
})

test('repeating activation replaces only submitted community frequencies', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel({ ...input, communitySlugs: ['brno', 'praha'], frequencies: ['created'] }, { database, config, crypto: predictableCrypto })
  await activateNotificationChannel({ ...input, communitySlugs: ['brno'], frequencies: ['week-before'] }, { database, config, crypto: predictableCrypto })
  assert.deepEqual(query('SELECT community_slug, frequency FROM notification_subscriptions ORDER BY community_slug, frequency'), [
    { community_slug: 'brno', frequency: 'week-before' },
    { community_slug: 'praha', frequency: 'created' },
  ])
  assert.equal(query('SELECT * FROM notification_outbox').length, 1)
})

test('stopping a token-scoped contact with queued outbox work suppresses it and scrubs every stale outbox payload', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  database.prepare('UPDATE notification_outbox SET status = ?, claim_token = ?, claim_expires_at = ?').bind('queued', 'queued-claim', '2026-09-18T12:00:00.000Z').run()
  const [contact] = query('SELECT destination_hash FROM notification_contacts') as { destination_hash: string }[]
  assert.equal(await isDeliveryEligible({ channel: 'email', contactFingerprint: contact!.destination_hash, communitySlug: 'brno', frequency: 'created', now: new Date() }, { database, config }), true)
  assert.deepEqual(await stopNotificationChannel(tokenForByte(0), { database, config, crypto: predictableCrypto }), { state: 'unavailable' })
  assert.equal(query('SELECT * FROM notification_contacts').length, 0)
  assert.equal(query('SELECT * FROM notification_suppressions').length, 1)
  assert.deepEqual(query('SELECT version, status, payload_ciphertext, payload_iv, transport_key_version, claim_token, claim_expires_at FROM notification_outbox'), [{ version: 2, status: 'invalidated', payload_ciphertext: null, payload_iv: null, transport_key_version: null, claim_token: null, claim_expires_at: null }])
  assert.equal(await isDeliveryEligible({ channel: 'email', contactFingerprint: contact!.destination_hash, communitySlug: 'brno', frequency: 'created', now: new Date() }, { database, config }), false)
})

test('suppressed activation rotates its bearer and stays pending until only the new bearer confirms', async () => {
  const { database, query } = disposableDatabase()
  let call = 0
  const sequencedCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(call++), subtle: crypto.subtle }
  await activateNotificationChannel(input, { database, config, crypto: sequencedCrypto })
  await stopNotificationChannel(tokenForByte(0), { database, config, crypto: sequencedCrypto })
  assert.deepEqual(await activateNotificationChannel({ ...input, frequencies: ['week-before'] }, { database, config, crypto: sequencedCrypto }), { state: 'pending-reactivation' })
  const [pending] = query('SELECT state, capability_generation FROM notification_contacts') as { state: string, capability_generation: number }[]
  assert.deepEqual(pending, { state: 'pending-reactivation', capability_generation: 1 })
  assert.deepEqual(await readNotificationManagement(tokenForByte(0), { database, config, crypto: sequencedCrypto }), { state: 'unavailable' })
  assert.deepEqual(await confirmNotificationReactivation(tokenForByte(3), { database, config, crypto: sequencedCrypto }), {
    state: 'active', channel: 'email', maskedContact: 'A•••@example.com', communities: [{ slug: 'brno', title: 'brno', frequencies: ['week-before'] }],
  })
  assert.equal(query('SELECT * FROM notification_suppressions').length, 0)
})

test('retained suppression key versions preserve the matched v1 suppression through v2 reactivation', async () => {
  const { database, query } = disposableDatabase()
  let randomCall = 0
  const uniqueCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(randomCall++), subtle: crypto.subtle }
  await activateNotificationChannel(input, { database, config, crypto: uniqueCrypto })
  await stopNotificationChannel(tokenForByte(0), { database, config, crypto: uniqueCrypto })
  const [v1Suppression] = query('SELECT destination_hash, destination_hash_key_version FROM notification_suppressions') as { destination_hash: string, destination_hash_key_version: string }[]
  const v2 = await crypto.subtle.importKey('raw', new TextEncoder().encode('12345678901234567890123456789012'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const rotated = { ...config, suppressionHashKeys: { v1: config.suppressionHashKeys.v1, v2 }, currentSuppressionHashKeyVersion: 'v2' }

  assert.deepEqual(await activateNotificationChannel(input, { database, config: rotated, crypto: uniqueCrypto }), { state: 'pending-reactivation' })
  assert.deepEqual(query('SELECT state, destination_hash, destination_hash_key_version FROM notification_contacts'), [{ state: 'pending-reactivation', destination_hash: v1Suppression!.destination_hash, destination_hash_key_version: 'v1' }])
  assert.equal(await isDeliveryEligible({ channel: 'email', contactFingerprint: v1Suppression!.destination_hash, communitySlug: 'brno', frequency: 'created', now: new Date() }, { database, config: rotated }), false)
  assert.equal((await confirmNotificationReactivation(tokenForByte(3), { database, config: rotated, crypto: uniqueCrypto })).state, 'active')
  assert.deepEqual(query('SELECT destination_hash_key_version FROM notification_suppressions'), [])
  assert.equal(await isDeliveryEligible({ channel: 'email', contactFingerprint: v1Suppression!.destination_hash, communitySlug: 'brno', frequency: 'created', now: new Date() }, { database, config: rotated }), true)
  await assert.rejects(activateNotificationChannel({ ...input, contact: 'Bob@example.com' }, { database, config: { ...rotated, suppressionHashKeys: { v2 } }, crypto: uniqueCrypto }), { statusCode: 503 })
})

test('shared abuse policy counts every attempt, preserves the minute gate, and expires keyed IP state', async () => {
  const { database, query } = disposableDatabase()
  let now = new Date('2026-09-17T12:00:00.000Z')
  const dependencies = { database, config, now: () => now, fetch: async () => new Response(JSON.stringify({ success: true, action: 'notification-operation', hostname: 'jednadvacet.org' })) }
  assert.deepEqual(await evaluateNotificationAbuse('203.0.113.1', undefined, dependencies), { allowed: true })
  assert.deepEqual(await evaluateNotificationAbuse('203.0.113.1', 'valid', dependencies), { allowed: false, reason: 'rate-limited' })
  now = new Date('2026-09-17T12:01:01.000Z')
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.deepEqual(await evaluateNotificationAbuse('203.0.113.1', undefined, dependencies), { allowed: true })
    now = new Date(now.getTime() + 61_000)
  }
  assert.deepEqual(await evaluateNotificationAbuse('203.0.113.1', undefined, dependencies), { allowed: false, reason: 'challenge-required' })
  assert.equal(query('SELECT requester_hash FROM notification_abuse_attempts').every(row => typeof (row as { requester_hash: unknown }).requester_hash === 'string'), true)
  now = new Date('2026-09-18T12:05:00.000Z')
  assert.deepEqual(await evaluateNotificationAbuse('203.0.113.2', undefined, dependencies), { allowed: true })
  assert.equal(query('SELECT * FROM notification_abuse_attempts').length, 1)
})

test('recovery atomically rotates a capability and makes the first encrypted outbox version inert', async () => {
  const { database, query } = disposableDatabase()
  let call = 0
  const sequencedCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(call++), subtle: crypto.subtle }
  await activateNotificationChannel(input, { database, config, crypto: sequencedCrypto })
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database, config, crypto: sequencedCrypto })
  assert.deepEqual(query('SELECT capability_generation FROM notification_contacts'), [{ capability_generation: 2 }])
  const rows = query('SELECT version, status, payload_ciphertext, payload_iv, transport_key_version, kind, expected_capability_generation FROM notification_outbox ORDER BY created_at, id') as { version: number, status: string, payload_ciphertext: string | null, payload_iv: string | null, transport_key_version: string | null, kind: string, expected_capability_generation: number }[]
  assert.deepEqual(rows.map(({ version, status, kind, expected_capability_generation, transport_key_version }) => ({ version, status, kind, expected_capability_generation, transport_key_version })), [
    { version: 2, status: 'invalidated', kind: 'first-activation', expected_capability_generation: 1, transport_key_version: null },
    { version: 1, status: 'pending', kind: 'management-recovery', expected_capability_generation: 2, transport_key_version: 'v1' },
  ])
  assert.equal(rows[0]?.payload_ciphertext, null)
  assert.equal(rows[0]?.payload_iv, null)
  assert.equal(typeof rows[1]?.payload_ciphertext, 'string')
  assert.equal(typeof rows[1]?.payload_iv, 'string')
})

test('management reads are non-destructive and only the newest rotated bearer resolves', async () => {
  const { database, query } = disposableDatabase()
  let call = 0
  const sequencedCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(call++), subtle: crypto.subtle }
  await activateNotificationChannel(input, { database, config, crypto: sequencedCrypto })
  const before = query('SELECT management_token_digest, capability_generation FROM notification_contacts')
  assert.equal((await readNotificationManagement(tokenForByte(0), { database, config, crypto: sequencedCrypto })).state, 'active')
  assert.deepEqual(query('SELECT management_token_digest, capability_generation FROM notification_contacts'), before)
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database, config, crypto: sequencedCrypto })
  assert.deepEqual(await readNotificationManagement(tokenForByte(0), { database, config, crypto: sequencedCrypto }), { state: 'unavailable' })
  assert.equal((await readNotificationManagement(tokenForByte(3), { database, config, crypto: sequencedCrypto })).state, 'active')
})

test('a digest-only event alias resolves only for the matching current generation', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const alias = tokenForByte(9)
  const aliasDigest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(alias))))).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  await database.prepare('INSERT INTO notification_management_capabilities (token_digest, contact_id, expected_capability_generation, created_at) VALUES (?, ?, ?, ?)').bind(aliasDigest, 1, 1, '2026-09-17T00:00:00.000Z').run()
  assert.equal((await readNotificationManagement(alias, { database, config, crypto: predictableCrypto })).state, 'active')
  await database.prepare('UPDATE notification_contacts SET capability_generation = capability_generation + 1').run()
  assert.deepEqual(await readNotificationManagement(alias, { database, config, crypto: predictableCrypto }), { state: 'unavailable' })
  assert.equal(query('SELECT token_digest FROM notification_management_capabilities').length, 1)
})

test('a stale bearer cannot update, remove, or stop subscriptions after recovery', async () => {
  const { database: baseDatabase, query } = disposableDatabase()
  const paused = pauseFirstBatch(baseDatabase)
  let randomCall = 0
  const sequencedCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(randomCall++), subtle: crypto.subtle }
  await activateNotificationChannel({ ...input, communitySlugs: ['brno', 'praha'], frequencies: ['created'] }, { database: baseDatabase, config, crypto: sequencedCrypto })

  const staleUpdate = updateNotificationFrequencies(tokenForByte(0), 'brno', ['day-before'], { database: paused.database, config, crypto: sequencedCrypto })
  await paused.firstBatchEntered
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database: paused.database, config, crypto: sequencedCrypto })
  paused.release()

  assert.deepEqual(await staleUpdate, { state: 'unavailable' })
  const afterRecovery = query('SELECT community_slug, frequency FROM notification_subscriptions ORDER BY community_slug, frequency')
  assert.deepEqual(afterRecovery, [
    { community_slug: 'brno', frequency: 'created' },
    { community_slug: 'praha', frequency: 'created' },
  ])
  assert.deepEqual(await removeNotificationCommunity(tokenForByte(0), 'brno', { database: paused.database, config, crypto: sequencedCrypto }), { state: 'unavailable' })
  assert.deepEqual(await stopNotificationChannel(tokenForByte(0), { database: paused.database, config, crypto: sequencedCrypto }), { state: 'unavailable' })
  assert.deepEqual(query('SELECT community_slug, frequency FROM notification_subscriptions ORDER BY community_slug, frequency'), afterRecovery)
  assert.equal(query('SELECT * FROM notification_suppressions').length, 0)
})

test('a recovered pending bearer cannot confirm after its authority becomes stale', async () => {
  const { database: baseDatabase, query } = disposableDatabase()
  let randomCall = 0
  const sequencedCrypto = { randomBytes: (length: number) => new Uint8Array(length).fill(randomCall++), subtle: crypto.subtle }
  await activateNotificationChannel(input, { database: baseDatabase, config, crypto: sequencedCrypto })
  await stopNotificationChannel(tokenForByte(0), { database: baseDatabase, config, crypto: sequencedCrypto })
  await activateNotificationChannel(input, { database: baseDatabase, config, crypto: sequencedCrypto })
  const paused = pauseFirstBatch(baseDatabase)

  const staleConfirmation = confirmNotificationReactivation(tokenForByte(3), { database: paused.database, config, crypto: sequencedCrypto })
  await paused.firstBatchEntered
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database: paused.database, config, crypto: sequencedCrypto })
  paused.release()

  assert.deepEqual(await staleConfirmation, { state: 'unavailable' })
  assert.deepEqual(query('SELECT state FROM notification_contacts'), [{ state: 'pending-reactivation' }])
  assert.equal(query('SELECT * FROM notification_suppressions').length, 1)
})

test('concurrent final-community removals converge on one suppression and no contact', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel({ ...input, communitySlugs: ['brno', 'praha'], frequencies: ['created'] }, { database, config, crypto: predictableCrypto })

  await Promise.all([
    removeNotificationCommunity(tokenForByte(0), 'brno', { database, config, crypto: predictableCrypto }),
    removeNotificationCommunity(tokenForByte(0), 'praha', { database, config, crypto: predictableCrypto }),
  ])

  assert.equal(query('SELECT * FROM notification_contacts').length, 0)
  assert.equal(query('SELECT * FROM notification_subscriptions').length, 0)
  assert.equal(query('SELECT * FROM notification_suppressions').length, 1)
})
