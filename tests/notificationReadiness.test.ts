import assert from 'node:assert/strict'
import test from 'node:test'

import readinessHandler, { projectNotificationReadiness } from '../server/api/notifications/readiness.get.ts'
import { createApp, toWebHandler } from 'h3'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { activateNotificationChannel, isNotificationChannelReady, type NotificationDatabase } from '../server/utils/notifications.ts'

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
  const base = { ...await notificationConfig(runtime), smsEnabled: true, smsFirstMessageReady: true, smsEventDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true, webPushEnabled: true, webPushFirstMessageReady: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true }
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

test('public email readiness agrees with complete private gates and SMS schema stays unsupported', async () => {
  const database = {} as NotificationDatabase
  assert.deepEqual(await projectNotificationReadiness(runtime, database), { email: true, sms: false, webPush: false })
  for (const gate of ['notificationEmailSmsEnabled', 'notificationEmailSmsFirstMessageReady', 'notificationEmailSmsEventDeliveryReady', 'brevoSenderVerified', 'brevoSpfVerified', 'brevoDkimVerified', 'brevoDmarcVerified', 'brevoCallbackVerified', 'notificationProductionBindingsVerified', 'notificationMigrationVerified', 'brevoSandboxVerified', 'brevoLiveCanaryVerified', 'notificationEmailManualEnabled']) {
    assert.deepEqual(await projectNotificationReadiness({ ...runtime, [gate]: false }, database), { email: false, sms: false, webPush: false }, gate)
  }
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
