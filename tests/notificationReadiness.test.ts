import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

import readinessHandler, { projectNotificationReadiness } from '../server/api/notifications/readiness.get.ts'
import { createApp, toWebHandler } from 'h3'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { activateNotificationChannel, isNotificationChannelReady, notificationSchemaReady, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'

test('public readiness fails closed without a database or private configuration', async () => {
  const readiness = await projectNotificationReadiness({})
  assert.deepEqual(readiness, { email: false, sms: false, webPush: false })
  assert.doesNotMatch(JSON.stringify(readiness), /key|secret|bearer/i)
})

const runtime = {
  notificationRootKey: btoa('01234567890123456789012345678901').replace(/=+$/g, ''), notificationCommunitySlugs: 'brno',
  notificationTurnstileSecret: 'synthetic-turnstile', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09',
  notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
  brevoApiKey: 'synthetic-api-key-at-least-24', brevoCallbackSecret: 'synthetic-callback-at-least-24', brevoSenderName: 'Jednadvacet', brevoSenderEmail: 'noreply@jednadvacet.org',
  brevoSenderVerified: true, brevoSpfVerified: true, brevoDkimVerified: true, brevoDmarcVerified: true, brevoCallbackVerified: true,
  notificationProductionBindingsVerified: true, notificationMigrationVerified: true, brevoSandboxVerified: true, brevoLiveCanaryVerified: true, notificationEmailManualEnabled: true,
}

test('every channel readiness prerequisite independently rejects direct activation before database access', async () => {
  const base = { ...await notificationConfig(runtime), emailDeliveryReady: true, smsEnabled: true, smsFirstMessageReady: true, smsEventDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true, webPushEnabled: true, webPushFirstMessageReady: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true }
  const database: NotificationDatabase = { prepare: () => { throw new Error('Unexpected database access') }, batch: async () => { throw new Error('Unexpected database writes') } }
  const gates = {
    email: ['emailSmsEnabled', 'emailSmsFirstMessageReady', 'emailSmsEventDeliveryReady', 'emailDeliveryReady'],
    sms: ['smsEnabled', 'smsFirstMessageReady', 'smsEventDeliveryReady', 'smsDeliveryReady', 'eventSmsOutboxSupported'],
    'web-push': ['webPushEnabled', 'webPushFirstMessageReady', 'webPushEventDeliveryReady', 'webPushDeliveryReady'],
  } as const
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const push = JSON.stringify({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey)).toString('base64url'), auth: Buffer.from(new Uint8Array(16)).toString('base64url') } })
  for (const channel of ['email', 'sms', 'web-push'] as const) {
    assert.equal(isNotificationChannelReady(channel, base), true)
    for (const gate of gates[channel]) {
      const config = { ...base, [gate]: false }
      assert.equal(isNotificationChannelReady(channel, config), false, gate)
      await assert.rejects(activateNotificationChannel({ channel, contact: channel === 'email' ? 'test@example.test' : channel === 'sms' ? '+420777123456' : push, communitySlugs: ['brno'], frequencies: ['created'], consentAt: '2026-09-17T00:00:00Z', consentVersion: '2026-09' }, { database, config }), error => (error as { statusCode: number }).statusCode === 503)
    }
  }
  assert.equal((await notificationConfig(runtime)).eventSmsOutboxSupported, false)
})

test('public readiness rejects boolean-only evidence and an object pretending to be D1', async () => {
  const database = {} as NotificationDatabase
  assert.deepEqual(await projectNotificationReadiness(runtime, database), { email: false, sms: false, webPush: false })
})

test('real applied migration probe rejects old or unavailable D1 before direct activation writes', async t => {
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => { close(): void, exec(sql: string): void, prepare(sql: string): { all(): unknown[] } }
  const sqlite = new Database(':memory:')
  t.after(() => sqlite.close())
  const checkpointSql = (name: string) => execFileSync('git', ['show', `ec1001951d6df22f1e77f68ecd3ab678f0a49208:server/db/migrations/sqlite/${name}.sql`], { encoding: 'utf8' })
  for (const name of ['0000_majestic_lightspeed', '0001_phase_7_columns', '0002_detach_event_callback_fk', '0003_restore_event_ledger_checks', '0004_restore_event_callback_fk']) sqlite.exec(checkpointSql(name))
  let writes = 0
  const database: NotificationDatabase = {
    prepare: sql => ({ all: async () => ({ results: sqlite.prepare(sql).all() }) } as NotificationStatement),
    batch: async () => { writes++; throw new Error('Unexpected write') },
  }
  const config = { ...await notificationConfig(runtime), emailDeliveryReady: true }
  assert.equal(await notificationSchemaReady(database), false)
  await assert.rejects(activateNotificationChannel({ channel: 'email', contact: 'test@example.test', communitySlugs: ['brno'], frequencies: ['created'], consentAt: '2026-10-04', consentVersion: '2026-09' }, { database, config }), error => (error as { statusCode: number }).statusCode === 503)
  assert.equal(writes, 0)
  for (const name of ['0005_lifecycle_email_columns', '0006_lifecycle_email_constraints']) sqlite.exec(checkpointSql(name))
  assert.equal(await notificationSchemaReady(database), true)
  const observed = { ...runtime, notificationExpectedTargetIdentity: '1'.repeat(64), notificationExpectedBundleHash: '2'.repeat(64), notificationExpectedMigrationHash: '3'.repeat(64), notificationExpectedConfigHash: '4'.repeat(64), notificationExpectedDeploymentId: '11111111-1111-1111-1111-111111111111' }
  const now = Date.now()
  const evidence = { channel: 'email', evidenceKind: 'production-observation', mode: 'readiness', manualSwitch: true, targetIdentity: observed.notificationExpectedTargetIdentity, bundleHash: observed.notificationExpectedBundleHash, migrationHash: observed.notificationExpectedMigrationHash, configHash: observed.notificationExpectedConfigHash, deploymentId: observed.notificationExpectedDeploymentId, verifiedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    keyHash: createHash('sha256').update(JSON.stringify([runtime.notificationRootKey, runtime.brevoApiKey, runtime.brevoCallbackSecret, runtime.brevoSenderName, runtime.brevoSenderEmail])).digest('hex'),
    gates: Object.fromEntries(['artifacts', 'deployment', 'bindings', 'migration', 'sender', 'dns', 'callbackMetadata', 'https', 'sandbox', 'callback', 'liveCanary', 'humanInbox', 'humanCalendar', 'humanLink', 'humanLogs', 'firstMessage', 'eventDelivery'].map(gate => [gate, 'passed'])) }
  assert.deepEqual(await projectNotificationReadiness({ ...observed, notificationEmailEvidence: JSON.stringify(evidence) }, database), { email: true, sms: false, webPush: false })
  assert.deepEqual(await projectNotificationReadiness({ ...observed, notificationEmailEvidence: JSON.stringify({ ...evidence, evidenceKind: 'local-candidate' }) }, database), { email: false, sms: false, webPush: false })
  assert.equal(await notificationSchemaReady({ prepare() { throw new Error('D1 down') }, batch: database.batch }), false)
})

test('actual readiness handler returns only three booleans with no-store', async () => {
  const globals = globalThis as typeof globalThis & { useRuntimeConfig?: unknown }
  const previous = globals.useRuntimeConfig
  globals.useRuntimeConfig = () => ({})
  try {
    const app = createApp().use(readinessHandler)
    const response = await toWebHandler(app)(new Request('http://localhost/api/notifications/readiness'))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { email: false, sms: false, webPush: false })
  } finally { globals.useRuntimeConfig = previous }
})
