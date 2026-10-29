import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import readinessHandler, { projectNotificationReadiness } from '../server/api/notifications/readiness.get.ts'
import { createApp, toWebHandler } from 'h3'
import { notificationConfig } from '../server/utils/notificationConfig.ts'

Object.assign(globalThis, { __NOTIFICATION_COMMUNITIES__: [{ slug: 'brno', title: 'Brno' }] })
import { activateNotificationChannel, isNotificationChannelReady, notificationSchemaReady, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'

test('public readiness fails closed without a database or private configuration', async () => {
  const readiness = await projectNotificationReadiness({})
  assert.deepEqual(readiness, { email: false, sms: false, webPush: false })
  assert.doesNotMatch(JSON.stringify(readiness), /key|secret|bearer/i)
})

const runtime = {
  notificationRootKey: btoa('01234567890123456789012345678901').replace(/=+$/g, ''),
  notificationTurnstileSecret: 'synthetic-turnstile', notificationTurnstileExpectedHostname: 'jednadvacet.org',
  brevoApiKey: 'synthetic-api-key-at-least-24', brevoCallbackSecret: 'synthetic-callback-at-least-24', brevoSenderName: 'Jednadvacet', brevoSenderEmail: 'noreply@jednadvacet.org',
  brevoSenderVerified: true, brevoSpfVerified: true, brevoDkimVerified: true, brevoDmarcVerified: true, brevoCallbackVerified: true,
  notificationProductionBindingsVerified: true, notificationMigrationVerified: true, brevoSandboxVerified: true, brevoLiveCanaryVerified: true,
}

test('every channel readiness prerequisite independently rejects direct activation before database access', async () => {
  const base = { ...await notificationConfig(runtime), emailDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true, webPushDeliveryReady: true }
  const database: NotificationDatabase = { prepare: () => { throw new Error('Unexpected database access') }, batch: async () => { throw new Error('Unexpected database writes') } }
  const gates = {
    email: ['emailDeliveryReady'],
    sms: ['smsDeliveryReady', 'eventSmsOutboxSupported'],
    'web-push': ['webPushDeliveryReady'],
  } as const
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const push = JSON.stringify({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey)).toString('base64url'), auth: Buffer.from(new Uint8Array(16)).toString('base64url') } })
  for (const channel of ['email', 'sms', 'web-push'] as const) {
    assert.equal(isNotificationChannelReady(channel, base), true)
    for (const gate of gates[channel]) {
      const config = { ...base, [gate]: false }
      assert.equal(isNotificationChannelReady(channel, config), false, gate)
      await assert.rejects(activateNotificationChannel({ channel, contact: channel === 'email' ? 'test@example.test' : channel === 'sms' ? '+420777123456' : push, communitySlugs: ['brno'], frequencies: ['created'], consentAt: '2026-09-17T00:00:00Z' }, { database, config }), error => (error as { statusCode: number }).statusCode === 503)
    }
  }
  assert.equal((await notificationConfig(runtime)).eventSmsOutboxSupported, true)
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
  await assert.rejects(activateNotificationChannel({ channel: 'email', contact: 'test@example.test', communitySlugs: ['brno'], frequencies: ['created'], consentAt: '2026-10-04' }, { database, config }), error => (error as { statusCode: number }).statusCode === 503)
  assert.equal(writes, 0)
  for (const name of ['0005_lifecycle_email_columns', '0006_lifecycle_email_constraints']) sqlite.exec(checkpointSql(name))
  assert.equal(await notificationSchemaReady(database), true)
  assert.deepEqual(await projectNotificationReadiness({ ...runtime, notificationEmailEvidence: 'not-a-runtime-setting' }, database), { email: true, sms: false, webPush: false }, 'operator records are not runtime gates')
  assert.deepEqual(await projectNotificationReadiness(runtime, database), { email: true, sms: false, webPush: false }, 'no evidence required after actual schema probe')
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

test('readiness HTTP logs fixed configuration reasons without exposing credentials or database errors', async t => {
  const globals = globalThis as typeof globalThis & { useRuntimeConfig?: unknown }
  const previous = globals.useRuntimeConfig
  const warn = console.warn
  const info = console.info
  const logs: unknown[][] = []
  console.warn = (...values: unknown[]) => { logs.push(values) }
  console.info = (...values: unknown[]) => { logs.push(values) }
  t.after(() => { globals.useRuntimeConfig = previous; console.warn = warn; console.info = info })
  const sentinel = 'private-database-exception-and-subscriber-sentinel'
  const validDatabase = { prepare: () => ({ all: async () => ({ results: [] }) }) } as unknown as NotificationDatabase
  const brokenDatabase = { prepare() { throw new Error(sentinel) } } as unknown as NotificationDatabase
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', other.publicKey)).toString('base64url')
  const configured = { ...runtime, public: { notificationTurnstileSiteKey: 'synthetic-public-site-key', notificationVapidPublicKey: publicKey }, notificationVapidPrivateKey: privateKey, notificationVapidSubject: 'https://jednadvacet.org' }
  const cases = [
    { override: { notificationRootKey: sentinel }, database: validDatabase, reason: 'root-key-invalid' },
    { override: { notificationTurnstileSecret: '' }, database: validDatabase, reason: 'turnstile-secret-invalid' },
    { override: { notificationTurnstileExpectedHostname: sentinel }, database: validDatabase, reason: 'turnstile-hostname-invalid' },
    { override: { brevoApiKey: '' }, database: validDatabase, reason: 'brevo-api-key-missing-or-invalid' },
    { override: { brevoCallbackSecret: '' }, database: validDatabase, reason: 'email-callback-secret-missing-or-invalid' },
    { override: { brevoSenderEmail: sentinel }, database: validDatabase, reason: 'email-sender-missing-or-invalid' },
    { override: {}, database: validDatabase, reason: 'sms-provider-configuration-invalid' },
    { override: {}, database: validDatabase, reason: 'vapid-configuration-missing-invalid-or-mismatched' },
    { override: {}, database: undefined, reason: 'database-binding-missing' },
    { override: {}, database: brokenDatabase, reason: 'database-schema-unavailable-or-incompatible' },
    { override: { public: {} }, database: validDatabase, reason: 'turnstile-public-site-key-missing-or-invalid' },
  ]
  for (const scenario of cases) {
    logs.length = 0
    globals.useRuntimeConfig = () => ({ ...configured, ...scenario.override })
    const app = createApp().use(event => {
      event.context._platform = { cloudflare: { env: { DB: scenario.database } } }
      return readinessHandler(event)
    })
    const response = await toWebHandler(app)(new Request('https://example.test/api/notifications/readiness'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.deepEqual(Object.keys(body).sort(), ['email', 'sms', 'webPush'])
    assert.ok(Object.values(body).every(value => typeof value === 'boolean'))
    assert.equal(body.webPush, false, 'mismatched VAPID pair cannot become ready')
    assert.ok(logs.some(entry => (entry[1] as { reason?: string })?.reason === scenario.reason), scenario.reason)
    for (const secret of [sentinel, privateKey, publicKey, runtime.notificationRootKey, runtime.notificationTurnstileSecret, runtime.brevoApiKey, runtime.brevoCallbackSecret]) {
      assert.equal(JSON.stringify(logs).includes(secret), false, 'logs never include configured values')
      assert.equal(JSON.stringify(body).includes(secret), false, 'public response never includes configured values')
    }
  }
})
