import assert from 'node:assert/strict'
import test from 'node:test'

import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { isNotificationChannelReady } from '../server/utils/notifications.ts'

Object.assign(globalThis, { __NOTIFICATION_COMMUNITIES__: [{ slug: 'brno', title: 'Brno' }] })

const base = {
  notificationRootKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  notificationTurnstileSecret: 'secret', notificationTurnstileExpectedHostname: 'example.test',
}

test('email delivery is unavailable without complete private provider configuration', async () => {
  const config = await notificationConfig(base)
  assert.equal(config.emailDeliveryReady, false)
  assert.equal(JSON.stringify(config).includes('undefined'), false)
})

test('both builds use concrete credentials without runtime evidence while keeping management origins isolated', async () => {
  const globals = globalThis as typeof globalThis & { __PREVIEW_DEPLOY__?: boolean }
  const previous = globals.__PREVIEW_DEPLOY__
  globals.__PREVIEW_DEPLOY__ = true
  let previewConfig: typeof notificationConfig
  try {
    previewConfig = (await import(new URL('../server/utils/notificationConfig.ts?preview-policy', import.meta.url).href)).notificationConfig
  } finally {
    if (previous === undefined) delete globals.__PREVIEW_DEPLOY__
    else globals.__PREVIEW_DEPLOY__ = previous
  }
  const runtime = {
    ...base, notificationTurnstileExpectedHostname: 'jednadvacetorg-web.learned-mantis.workers.dev',
    brevoApiKey: 'a'.repeat(24), brevoCallbackSecret: 'b'.repeat(24),
    brevoSenderName: 'Jednadvacet.org', brevoSmsSender: 'Jednadvacet', brevoSenderEmail: 'noreply@jednadvacet.org',
  }
  const preview = await previewConfig(runtime)
  assert.equal(preview.emailDeliveryReady, true)
  assert.equal(preview.smsDeliveryReady, true)
  assert.equal(preview.managementOrigin, 'https://jednadvacetorg-web.learned-mantis.workers.dev')
  assert.equal(preview.webPushDeliveryReady, false, 'missing VAPID cannot authorize push')
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const push = await previewConfig({ ...runtime,
    notificationVapidPrivateKey: (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d,
    public: { notificationVapidPublicKey: Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url') },
    notificationVapidSubject: 'https://jednadvacet.org',
  })
  assert.equal(isNotificationChannelReady('web-push', push), true, 'valid VAPID credentials need no additional rollout switches')
  assert.equal(push.eventWebPushOutboxSupported, true)
  for (const changes of [{ brevoApiKey: '' }, { brevoCallbackSecret: '' }]) assert.equal((await previewConfig({ ...runtime, ...changes })).emailDeliveryReady, false)
  for (const brevoSmsSender of ['', 'Invalid sender name']) assert.equal((await previewConfig({ ...runtime, brevoSmsSender })).smsDeliveryReady, false)
  await assert.rejects(previewConfig({ ...runtime, notificationTurnstileExpectedHostname: 'jednadvacet.org' }))
  await assert.rejects(previewConfig({ ...runtime, notificationRootKey: '' }))
  const production = await notificationConfig({ ...runtime, notificationEmailEvidence: 'preview', notificationSmsEvidence: 'preview' })
  assert.equal(production.emailDeliveryReady, true, 'production does not depend on operator evidence records')
  assert.equal(production.smsDeliveryReady, true)
  assert.equal(production.managementOrigin, 'https://jednadvacet.org', 'test hostname cannot redirect production management links')
})

test('one root derives non-extractable, purpose-separated Worker keys', async () => {
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

test('notification scopes and titles come from the deployed content catalog', async () => {
  const config = await notificationConfig(base)
  assert.deepEqual(config.communitySlugs, ['brno'])
  assert.deepEqual(config.communityTitles, { brno: 'Brno' })
})

test('email and SMS need credentials, not rollout settings; retired false settings cannot disable them', async () => {
  const credentials = { ...base, brevoApiKey: 'a'.repeat(24), brevoCallbackSecret: 'b'.repeat(24), brevoSenderName: 'Jednadvacet', brevoSenderEmail: 'noreply@jednadvacet.org', brevoSmsSender: 'Jednadvacet' }
  const retired = ['notificationEmailManualEnabled', 'notificationEmailSmsEnabled', 'notificationEmailSmsFirstMessageReady', 'notificationEmailSmsEventDeliveryReady', 'notificationSmsEnabled', 'notificationSmsFirstMessageReady', 'notificationSmsEventDeliveryReady']
  for (const value of [undefined, false, 'false']) {
    const config = await notificationConfig({ ...credentials, ...Object.fromEntries(retired.map(name => [name, value])) })
    assert.equal(isNotificationChannelReady('email', config), true)
    assert.equal(isNotificationChannelReady('sms', config), true)
  }
  const noApiKey = await notificationConfig({ ...credentials, brevoApiKey: '' })
  assert.equal(isNotificationChannelReady('email', noApiKey), false)
  assert.equal(isNotificationChannelReady('sms', noApiKey), false)
  const noCallbackSecret = await notificationConfig({ ...credentials, brevoCallbackSecret: '' })
  assert.equal(isNotificationChannelReady('email', noCallbackSecret), false)
  assert.equal(isNotificationChannelReady('sms', noCallbackSecret), true)
  const noSmsSender = await notificationConfig({ ...credentials, brevoSmsSender: '' })
  assert.equal(isNotificationChannelReady('sms', noSmsSender), false)
  assert.equal(isNotificationChannelReady('email', noSmsSender), true)
})

test('email readiness requires real private configuration, not legacy assertions', async () => {
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
  }
  assert.equal((await notificationConfig(ready)).emailDeliveryReady, true)
  assert.equal((await notificationConfig({ ...ready, brevoApiKey: '' })).emailDeliveryReady, false)
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
    brevoSenderName: 'Jednadvacet.org',
    brevoSmsSender: 'Jednadvacet',
    notificationProductionBindingsVerified: true,
  })
  assert.equal(config.emailDeliveryReady, false)
  assert.equal(config.smsDeliveryReady, true)
  assert.equal(config.eventSmsOutboxSupported, true)
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
