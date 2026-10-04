import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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

const schema = ['0000_majestic_lightspeed', '0001_phase_7_columns', '0002_phase_7_constraints'].map(name => readFileSync(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8')).join('\n')

const disposableDatabase = (failsStatement?: (sql: string) => boolean): { database: NotificationDatabase, query(sql: string): unknown[] } => {
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
const config = { ...await notificationConfig({
  notificationCommunitySlugs: 'brno,praha', notificationRootKey: key,
  notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09',
  notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
  notificationWebPushEnabled: false, notificationWebPushFirstMessageReady: false, notificationWebPushEventDeliveryReady: false,
}), emailDeliveryReady: true }

const predictableCrypto = { randomBytes: (length: number) => new Uint8Array(length), subtle: crypto.subtle }
const tokenForByte = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte))).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0))
const input = { channel: 'email' as const, contact: 'Alice@Example.COM', communitySlugs: ['brno'], frequencies: ['created', 'day-before'] as ('created' | 'day-before')[], consentAt: '2026-09-15T12:00:00.000Z', consentVersion: '2026-09' }

test('native push activation and recovery canonicalize device identity and reject direct-service bypasses', async () => {
  const { database, query } = disposableDatabase()
  const ready = { ...config, webPushEnabled: true, webPushFirstMessageReady: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true }
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const keys = { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey)).toString('base64url'), auth: Buffer.from(new Uint8Array(16).fill(2)).toString('base64url') }
  const contact = { endpoint: 'https://push.example.test/device-one', expirationTime: null, keys }
  const dependencies = { database, config: ready }
  await activateNotificationChannel({ ...input, channel: 'web-push', contact }, dependencies)
  await activateNotificationChannel({ ...input, channel: 'web-push', contact: JSON.stringify({ keys, endpoint: contact.endpoint }) }, dependencies)
  await activateNotificationChannel({ ...input, channel: 'web-push', contact: { ...contact, endpoint: 'https://push.example.test/device-two' } }, dependencies)
  await activateNotificationChannel(input, dependencies)
  const before = query('SELECT id, channel, destination, management_token_digest, capability_generation FROM notification_contacts ORDER BY id') as Record<string, unknown>[]
  assert.equal(before.length, 3)
  await requestNotificationManagementRecovery({ channel: 'web-push', contact: { keys, expirationTime: null, endpoint: contact.endpoint } }, dependencies)
  const after = query('SELECT id, channel, destination, management_token_digest, capability_generation FROM notification_contacts ORDER BY id') as Record<string, unknown>[]
  assert.equal(after[0]!.capability_generation, 2)
  assert.notEqual(after[0]!.management_token_digest, before[0]!.management_token_digest)
  assert.deepEqual(after.slice(1), before.slice(1))
  assert.equal(await requestNotificationManagementRecovery({ channel: 'web-push', contact: { ...contact, endpoint: 'https://push.example.test/unknown' } }, dependencies), undefined)
  for (const invalid of ['arbitrary string', '{}', { ...contact, expirationTime: 1 }, { ...contact, keys: { ...keys, p256dh: Buffer.from(new Uint8Array(65).fill(4)).toString('base64url') } }]) {
    await assert.rejects(activateNotificationChannel({ ...input, channel: 'web-push', contact: invalid }, dependencies))
    await assert.rejects(requestNotificationManagementRecovery({ channel: 'web-push', contact: invalid }, dependencies))
  }
  assert.deepEqual(query('SELECT id, channel, destination, management_token_digest, capability_generation FROM notification_contacts ORDER BY id'), after)
})

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
    } as unknown as SubtleCrypto,
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
    notificationRootKey: key,
    notificationTurnstileSecret: 'private-turnstile-secret',
    notificationTurnstileExpectedHostname: 'jednadvacet.org',
    notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true,
    notificationEmailSmsFirstMessageReady: true,
    notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false,
    notificationWebPushFirstMessageReady: false,
    notificationWebPushEventDeliveryReady: false,
  })

  assert.ok('outboxTransportKey' in runtimeConfig)
  await activateNotificationChannel(input, { database, config: { ...runtimeConfig, emailDeliveryReady: true }, crypto: predictableCrypto })
  const [outbox] = query('SELECT payload_ciphertext, payload_iv FROM notification_outbox') as { payload_ciphertext: string, payload_iv: string }[]
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(outbox!.payload_iv) },
    runtimeConfig.outboxTransportKey,
    fromBase64Url(outbox!.payload_ciphertext),
  )

  assert.match(new TextDecoder().decode(plaintext), /"destination":"Alice@example.com"/)
})

test('missing, malformed, short, and unknown-current private key material fails before activation', async () => {
  const validRuntimeConfig = {
    notificationCommunitySlugs: 'brno,praha',
    notificationRootKey: key,
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
  const invalidConfigurations = [
    { ...validRuntimeConfig, notificationRootKey: '' },
    { ...validRuntimeConfig, notificationRootKey: '{' },
    { ...validRuntimeConfig, notificationRootKey: 'short' },
    { ...validRuntimeConfig, notificationRootKey: undefined },
  ]

  for (const runtimeConfig of invalidConfigurations) await assert.rejects(notificationConfig(runtimeConfig))
})

test('public readiness keeps email false until separate delivery evidence is complete', async () => {
  const runtimeConfig = {
    notificationCommunitySlugs: 'brno',
    notificationRootKey: key,
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

  const { database } = disposableDatabase()
  assert.deepEqual(await projectNotificationReadiness(runtimeConfig, database), { email: false, sms: false, webPush: false })
  assert.deepEqual(await projectNotificationReadiness({ ...runtimeConfig, notificationRootKey: '' }, database), { email: false, sms: false, webPush: false })
})

test('public readiness rejects missing, malformed, and unretained D1 transport-key references', async () => {
  const { database } = disposableDatabase()
  const runtimeConfig = {
    notificationCommunitySlugs: 'brno', notificationRootKey: key,
    notificationTurnstileSecret: 'private-turnstile-secret', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09',
    notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
    notificationWebPushEnabled: false, notificationWebPushFirstMessageReady: false, notificationWebPushEventDeliveryReady: false,
  }
  assert.deepEqual(await projectNotificationReadiness(runtimeConfig), { email: false, sms: false, webPush: false })
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
    notificationRootKey: key,
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

  assert.ok('abuseHashKey' in runtimeConfig)
  assert.equal(runtimeConfig.turnstile.secret, 'private-turnstile-secret')
  assert.equal(runtimeConfig.turnstile.expectedHostname, 'jednadvacet.org')
  await assert.rejects(notificationConfig({
    notificationCommunitySlugs: 'brno',
    notificationRootKey: '{',
    notificationConsentVersion: '2026-09',
  }))
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
  assert.deepEqual(query('SELECT version, status, payload_ciphertext, payload_iv, claim_token, claim_expires_at FROM notification_outbox'), [{ version: 2, status: 'invalidated', payload_ciphertext: null, payload_iv: null, claim_token: null, claim_expires_at: null }])
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
  const rows = query('SELECT version, status, payload_ciphertext, payload_iv, kind, expected_capability_generation FROM notification_outbox ORDER BY created_at, id') as { version: number, status: string, payload_ciphertext: string | null, payload_iv: string | null, kind: string, expected_capability_generation: number }[]
  assert.deepEqual(rows.map(({ version, status, kind, expected_capability_generation }) => ({ version, status, kind, expected_capability_generation })), [
    { version: 2, status: 'invalidated', kind: 'first-activation', expected_capability_generation: 1 },
    { version: 1, status: 'pending', kind: 'management-recovery', expected_capability_generation: 2 },
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

  const paused = pauseFirstBatch(database)
  const first = removeNotificationCommunity(tokenForByte(0), 'brno', { database: paused.database, config, crypto: predictableCrypto })
  await paused.firstBatchEntered
  await removeNotificationCommunity(tokenForByte(0), 'praha', { database, config, crypto: predictableCrypto })
  paused.release()
  await first

  assert.equal(query('SELECT * FROM notification_contacts').length, 0)
  assert.equal(query('SELECT * FROM notification_subscriptions').length, 0)
  assert.equal(query('SELECT * FROM notification_suppressions').length, 1)
})

test('competing recovery rotations preserve the winning generation and only its replacement work', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  const paused = pauseFirstBatch(database)
  const first = requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database: paused.database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(1), subtle: crypto.subtle } })
  await paused.firstBatchEntered
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(2), subtle: crypto.subtle } })
  paused.release()
  await first
  assert.equal((await readNotificationManagement(tokenForByte(2), { database, config })).state, 'active')
  assert.equal((await readNotificationManagement(tokenForByte(1), { database, config })).state, 'unavailable')
  assert.deepEqual(query("SELECT expected_capability_generation FROM notification_outbox WHERE status = 'pending'"), [{ expected_capability_generation: 2 }])
})

test('repeated pending signup invalidates and scrubs queued reactivation work', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  await stopNotificationChannel(tokenForByte(0), { database, config })
  await activateNotificationChannel(input, { database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(1), subtle: crypto.subtle } })
  await database.prepare("UPDATE notification_outbox SET status = 'queued' WHERE status = 'pending'").run()
  await activateNotificationChannel(input, { database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(2), subtle: crypto.subtle } })
  assert.deepEqual(query("SELECT status, payload_ciphertext FROM notification_outbox WHERE expected_capability_generation = 1"), [{ status: 'invalidated', payload_ciphertext: null }, { status: 'invalidated', payload_ciphertext: null }])
  assert.equal((await readNotificationManagement(tokenForByte(1), { database, config })).state, 'unavailable')
  assert.equal((await readNotificationManagement(tokenForByte(2), { database, config })).state, 'pending-reactivation')
})

test('late failures roll back recovery and pending reactivation rotations with all subscriptions and payloads', async () => {
  for (const action of ['recovery', 'reactivation'] as const) {
    let fail = false
    const { database, query } = disposableDatabase(sql => fail && sql.startsWith('INSERT INTO notification_outbox'))
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    if (action === 'reactivation') {
      await stopNotificationChannel(tokenForByte(0), { database, config })
      await activateNotificationChannel(input, { database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(1), subtle: crypto.subtle } })
    }
    const tables = ['notification_contacts', 'notification_subscriptions', 'notification_suppressions', 'notification_outbox']
    const before = tables.map(table => query(`SELECT * FROM ${table}`))
    fail = true
    const dependencies = { database, config, crypto: { randomBytes: (length: number) => new Uint8Array(length).fill(2), subtle: crypto.subtle } }
    await assert.rejects(action === 'recovery' ? requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, dependencies) : activateNotificationChannel({ ...input, frequencies: ['week-before'] }, dependencies), /Injected D1/)
    assert.deepEqual(tables.map(table => query(`SELECT * FROM ${table}`)), before)
  }
})

test('a delayed pending signup cannot overwrite a newer recovery generation or submitted subscriptions', async () => {
  const { database, query } = disposableDatabase()
  await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
  await stopNotificationChannel(tokenForByte(0), { database, config })
  await activateNotificationChannel(input, { database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(1), subtle: crypto.subtle } })
  const paused = pauseFirstBatch(database)
  const first = activateNotificationChannel({ ...input, frequencies: ['week-before'] }, { database: paused.database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(2), subtle: crypto.subtle } })
  await paused.firstBatchEntered
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'Alice@example.com' }, { database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(3), subtle: crypto.subtle } })
  const before = query('SELECT * FROM notification_subscriptions')
  paused.release()
  await first
  assert.deepEqual(query('SELECT * FROM notification_subscriptions'), before)
  assert.equal((await readNotificationManagement(tokenForByte(3), { database, config })).state, 'pending-reactivation')
  assert.equal((await readNotificationManagement(tokenForByte(2), { database, config })).state, 'unavailable')
  assert.deepEqual(query("SELECT expected_capability_generation FROM notification_outbox WHERE status = 'pending'"), [{ expected_capability_generation: 2 }])
})

test('SMS stop and final-community removal use one scoped bearer and preserve email/push even when sending is disabled', async () => {
  for (const action of ['stop', 'last-community'] as const) {
    const { database, query } = disposableDatabase()
    const ready = { ...config, smsEnabled: true, smsFirstMessageReady: true, smsEventDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true, webPushEnabled: true, webPushFirstMessageReady: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true }
    const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const push = JSON.stringify({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey)).toString('base64url'), auth: Buffer.from(new Uint8Array(16)).toString('base64url') } })
    for (const [channel, contact, byte] of [['email', 'Alice@example.com', 1], ['sms', '+420777123456', 2], ['web-push', push, 3]] as const) {
      await activateNotificationChannel({ ...input, channel, contact }, { database, config: ready, crypto: { randomBytes: length => new Uint8Array(length).fill(byte), subtle: crypto.subtle } })
    }
    const otherContacts = query("SELECT * FROM notification_contacts WHERE channel <> 'sms'")
    const otherWork = query('SELECT * FROM notification_outbox WHERE contact_id <> 2')
    const disabled = { ...ready, smsEnabled: false }
    if (action === 'stop') await stopNotificationChannel(tokenForByte(2), { database, config: disabled })
    else await removeNotificationCommunity(tokenForByte(2), 'brno', { database, config: disabled })
    assert.deepEqual(query("SELECT * FROM notification_contacts WHERE channel <> 'sms'"), otherContacts)
    assert.deepEqual(query('SELECT * FROM notification_outbox WHERE contact_id <> 2'), otherWork)
    assert.deepEqual(query('SELECT channel, reason FROM notification_suppressions'), [{ channel: 'sms', reason: 'user-stop' }])
    assert.deepEqual(query('SELECT status, payload_ciphertext FROM notification_outbox WHERE contact_id = 2'), [{ status: 'invalidated', payload_ciphertext: null }])
    assert.equal((await readNotificationManagement(tokenForByte(2), { database, config: disabled })).state, 'unavailable')
    assert.equal((await readNotificationManagement(tokenForByte(1), { database, config: disabled })).state, 'active')
    assert.equal((await readNotificationManagement(tokenForByte(3), { database, config: disabled })).state, 'active')
  }
})

test('token confirmation cannot remove provider suppression from a pending reactivation', async () => {
  for (const reason of ['provider-bounce', 'provider-complaint', 'provider-opt-out']) {
    const { database, query } = disposableDatabase()
    await activateNotificationChannel(input, { database, config, crypto: predictableCrypto })
    await stopNotificationChannel(tokenForByte(0), { database, config })
    await activateNotificationChannel(input, { database, config, crypto: { randomBytes: length => new Uint8Array(length).fill(1), subtle: crypto.subtle } })
    await database.prepare('UPDATE notification_suppressions SET reason = ?').bind(reason).run()
    assert.deepEqual(await confirmNotificationReactivation(tokenForByte(1), { database, config }), { state: 'unavailable' })
    assert.deepEqual(query('SELECT state FROM notification_contacts'), [{ state: 'pending-reactivation' }])
    assert.deepEqual(query('SELECT reason FROM notification_suppressions'), [{ reason }])
  }
})
