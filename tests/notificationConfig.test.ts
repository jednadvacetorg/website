import assert from 'node:assert/strict'
import test from 'node:test'

import { notificationConfig } from '../server/utils/notificationConfig.ts'

const base = {
  notificationCommunitySlugs: 'brno', notificationRootKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
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

test('Web Push VAPID configuration keeps the private key server-only and requires a matching public key shape', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  const config = await notificationConfig({
    ...base,
    notificationVapidPrivateKey: jwk.d,
    public: { notificationVapidPublicKey: encode(publicBytes) },
    notificationVapidSubject: 'mailto:notifications@jednadvacet.org',
  })
  assert.equal(config.webPushDeliveryReady, true)
  assert.equal(config.webPushDelivery?.privateKey.extractable, false)
  assert.equal(config.webPushDelivery?.publicKey, encode(publicBytes))
  assert.equal((await notificationConfig({ ...base, notificationVapidPrivateKey: 'bad' })).webPushDeliveryReady, false)
})

test('SMS provider readiness does not inherit email callback or DNS gates', async () => {
  const config = await notificationConfig({
    ...base,
    brevoApiKey: 'a'.repeat(24),
    brevoSenderName: 'Jednadvacet',
    notificationProductionBindingsVerified: true,
    notificationSmsEnabled: true,
    notificationSmsFirstMessageReady: true,
    notificationSmsEventDeliveryReady: true,
  })
  assert.equal(config.emailDeliveryReady, false)
  assert.equal(config.smsDeliveryReady, true)
  assert.equal(config.eventSmsOutboxSupported, false)
})

test('VAPID rejects mismatched pairs, noncanonical encodings and invalid subjects through injected crypto', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  const ready = { ...base, public: { notificationVapidPublicKey: publicKey }, notificationVapidPrivateKey: jwk.d, notificationVapidSubject: 'mailto:notifications@jednadvacet.org' }
  const signCalls: string[] = []
  const subtle = new Proxy(crypto.subtle, { get(target, property) { return property === 'sign' ? (...args: Parameters<SubtleCrypto['sign']>) => { signCalls.push(String((args[0] as Algorithm).name)); return target.sign(...args) } : Reflect.get(target, property).bind(target) } })
  const config = await notificationConfig(ready, { subtle, randomBytes: length => new Uint8Array(length) })
  assert.equal(config.webPushDeliveryReady, true)
  assert.ok(signCalls.includes('ECDSA'))
  const data = new TextEncoder().encode('independent correspondence')
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, config.webPushDelivery!.privateKey, data)
  assert.equal(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, data), true)
  const last = publicKey.at(-1)!
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const noncanonical = publicKey.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]
  for (const invalid of [
    { notificationVapidPrivateKey: (await crypto.subtle.exportKey('jwk', other.privateKey)).d },
    { public: { notificationVapidPublicKey: noncanonical } },
    { public: { notificationVapidPublicKey: publicKey + '=' } },
    { public: { notificationVapidPublicKey: Buffer.from(new Uint8Array(65).fill(4)).toString('base64url') } },
    { notificationVapidPrivateKey: jwk.d + '=' },
    { notificationVapidSubject: 'https://user:password@example.test/' },
    { notificationVapidSubject: 'mailto:a@example.test\n' },
  ]) {
    const rejected = await notificationConfig({ ...ready, ...invalid })
    assert.equal(rejected.webPushDeliveryReady, false)
    assert.equal(rejected.webPushDelivery, undefined)
  }
})
