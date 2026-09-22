import assert from 'node:assert/strict'
import test from 'node:test'

import { notificationConfig } from '../server/utils/notificationConfig.ts'

const base = {
  notificationCommunitySlugs: 'brno', notificationRootKeys: '{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}', notificationCurrentKeyVersion: 'v1',
  notificationTurnstileSecret: 'secret', notificationTurnstileExpectedHostname: 'example.test', notificationConsentVersion: 'v1',
}

test('email delivery configuration is disabled unless every private and operational gate is exact', async () => {
  const config = await notificationConfig({ ...base, notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true })
  assert.equal(config.emailDeliveryReady, false)
  assert.equal(JSON.stringify(config).includes('undefined'), false)
})

test('one root derives non-extractable, purpose-separated Worker keys and rejects all rotation-era inputs', async () => {
  const config = await notificationConfig(base)
  assert.ok('outboxTransportKey' in config)
  assert.equal(config.outboxTransportKey.extractable, false)
  assert.equal(config.suppressionHashKey.extractable, false)
  assert.equal(config.abuseHashKey.extractable, false)
  const value = new TextEncoder().encode('same input')
  const [suppression, abuse] = await Promise.all([
    crypto.subtle.sign('HMAC', config.suppressionHashKey, value),
    crypto.subtle.sign('HMAC', config.abuseHashKey, value),
  ])
  assert.notDeepEqual(new Uint8Array(suppression), new Uint8Array(abuse))
})

test('email delivery accepts only the verified root-domain sender', async () => {
  const ready = {
    ...base,
    brevoApiKey: 'a'.repeat(24),
    brevoCallbackSecret: 'b'.repeat(24),
    brevoSenderName: 'Jednadvacet.org',
    brevoSenderEmail: 'noreply@jednadvacet.org',
    brevoSenderVerified: true,
    brevoSpfVerified: true,
    brevoDkimVerified: true,
    brevoDmarcVerified: true,
    brevoCallbackVerified: true,
    notificationProductionBindingsVerified: true,
    notificationMigrationVerified: true,
    brevoSandboxVerified: true,
    brevoLiveCanaryVerified: true,
    notificationEmailManualEnabled: true,
  }
  assert.equal((await notificationConfig(ready)).emailDeliveryReady, true)
  assert.equal((await notificationConfig({ ...ready, brevoSenderEmail: 'noreply@b.jednadvacet.org' })).emailDeliveryReady, false)
})
