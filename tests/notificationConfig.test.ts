import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'

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

test('only the preview build permits credential-backed testing without production evidence', async () => {
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
    notificationEmailManualEnabled: true,
  }
  const preview = await previewConfig(runtime)
  assert.equal(preview.emailDeliveryReady, true)
  assert.equal(preview.smsDeliveryReady, true)
  assert.equal(preview.managementOrigin, 'https://jednadvacetorg-web.learned-mantis.workers.dev')
  assert.equal(preview.emailSmsEnabled, false, 'channel switches still default off')
  assert.equal(preview.smsEnabled, false)
  assert.equal(preview.webPushDeliveryReady, false, 'missing VAPID cannot authorize push')
  for (const changes of [{ brevoApiKey: '' }, { brevoCallbackSecret: '' }, { notificationEmailManualEnabled: false }]) assert.equal((await previewConfig({ ...runtime, ...changes })).emailDeliveryReady, false)
  for (const brevoSmsSender of ['', 'Invalid sender name']) assert.equal((await previewConfig({ ...runtime, brevoSmsSender })).smsDeliveryReady, false)
  await assert.rejects(previewConfig({ ...runtime, notificationTurnstileExpectedHostname: 'jednadvacet.org' }))
  await assert.rejects(previewConfig({ ...runtime, notificationRootKey: '' }))
  const production = await notificationConfig({ ...runtime, notificationEmailEvidence: 'preview', notificationSmsEvidence: 'preview' })
  assert.equal(production.emailDeliveryReady, false, 'production still requires exact operational evidence')
  assert.equal(production.smsDeliveryReady, false)
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

test('legacy verification booleans and sender settings cannot replace operational email evidence', async () => {
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
  assert.equal((await notificationConfig(ready)).emailDeliveryReady, false, 'asserted booleans are not operational evidence')
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
  assert.equal(config.webPushDeliveryReady, false)
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
    notificationSmsEnabled: true,
    notificationSmsFirstMessageReady: true,
    notificationSmsEventDeliveryReady: true,
  })
  assert.equal(config.emailDeliveryReady, false)
  assert.equal(config.smsDeliveryReady, false)
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
  assert.equal(config.webPushDeliveryReady, false)
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

test('observed evidence binds artifacts, target, keys and expiry independently for each channel', async () => {
  let now = Date.parse('2026-10-04T12:00:00Z')
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const ready = { ...base, brevoApiKey: 'a'.repeat(24), brevoCallbackSecret: 'b'.repeat(24), brevoSenderName: 'Jednadvacet.org', brevoSmsSender: 'Jednadvacet', brevoSenderEmail: 'noreply@jednadvacet.org', notificationEmailManualEnabled: true,
    notificationVapidPrivateKey: (await crypto.subtle.exportKey('jwk', pair.privateKey)).d,
    public: { notificationVapidPublicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url') }, notificationVapidSubject: 'mailto:test@example.test',
    notificationExpectedTargetIdentity: '1'.repeat(64), notificationExpectedBundleHash: '2'.repeat(64), notificationExpectedMigrationHash: '3'.repeat(64), notificationExpectedConfigHash: '4'.repeat(64), notificationExpectedDeploymentId: '11111111-1111-1111-1111-111111111111' }
  const gates = Object.fromEntries(['artifacts', 'deployment', 'bindings', 'migration', 'sender', 'dns', 'callbackMetadata', 'https', 'sandbox', 'callback', 'liveCanary', 'humanInbox', 'humanCalendar', 'humanLink', 'humanLogs', 'account', 'credits', 'country', 'compliance', 'sharedManagementStop', 'vapid', 'protocol', 'interoperability', 'browser:chromium', 'firstMessage', 'eventDelivery'].map(gate => [gate, 'passed']))
  const hash = (material: unknown[]) => createHash('sha256').update(JSON.stringify(material)).digest('hex')
  const common = { evidenceKind: 'production-observation', mode: 'readiness', manualSwitch: true, targetIdentity: ready.notificationExpectedTargetIdentity, bundleHash: ready.notificationExpectedBundleHash, migrationHash: ready.notificationExpectedMigrationHash, configHash: ready.notificationExpectedConfigHash, deploymentId: ready.notificationExpectedDeploymentId, verifiedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), gates }
  const email = { ...common, channel: 'email', keyHash: hash([ready.notificationRootKey, ready.brevoApiKey, ready.brevoCallbackSecret, ready.brevoSenderName, ready.brevoSenderEmail]) }
  const sms = { ...common, channel: 'sms', keyHash: hash([ready.notificationRootKey, ready.brevoApiKey, ready.brevoSmsSender]) }
  const push = { ...common, channel: 'web-push', interoperability: ['chromium'], keyHash: hash([ready.notificationRootKey, ready.notificationVapidPrivateKey, ready.public.notificationVapidPublicKey, ready.notificationVapidSubject]) }
  const runtime = { ...ready, notificationEmailEvidence: JSON.stringify(email), notificationSmsEvidence: JSON.stringify(sms), notificationWebPushEvidence: JSON.stringify(push) }
  const load = (overrides = {}) => notificationConfig({ ...runtime, ...overrides }, undefined, () => now)
  const config = await load()
  assert.equal(config.emailDeliveryReady, true)
  assert.equal(config.smsDeliveryReady, true)
  assert.equal(config.webPushDeliveryReady, true)
  assert.equal((await load({ brevoSmsSender: '' })).smsDeliveryReady, false, 'email sender is never an SMS fallback')
  assert.equal((await load({ brevoSmsSender: 'JinySender' })).smsDeliveryReady, false, 'SMS evidence binds the independent sender')
  assert.equal((await load({ brevoSenderName: 'Jiny emailovy nazev' })).smsDeliveryReady, true, 'email name changes do not change SMS identity')
  for (const [field, changed] of Object.entries({ evidenceKind: 'local-candidate', mode: 'preflight', manualSwitch: false, channel: 'sms', targetIdentity: '0'.repeat(64), deploymentId: '22222222-2222-2222-2222-222222222222', bundleHash: '0'.repeat(64), migrationHash: '0'.repeat(64), configHash: '0'.repeat(64), keyHash: '0'.repeat(64), verifiedAt: new Date(now + 1).toISOString(), expiresAt: new Date(now).toISOString() })) {
    const invalid = await load({ notificationEmailEvidence: JSON.stringify({ ...email, [field]: changed }) })
    assert.equal(invalid.emailDeliveryReady, false, field)
    assert.equal(invalid.smsDeliveryReady, true)
    assert.equal(invalid.webPushDeliveryReady, true)
  }
  for (const gate of ['sender', 'dns', 'callback', 'sandbox', 'liveCanary', 'humanInbox', 'firstMessage', 'eventDelivery']) assert.equal((await load({ notificationEmailEvidence: JSON.stringify({ ...email, gates: { ...gates, [gate]: 'pending' } }) })).emailDeliveryReady, false, gate)
  assert.equal((await load({ notificationEmailManualEnabled: false })).emailDeliveryReady, false)
  assert.equal((await load({ notificationRootKey: 'B'.repeat(42) + 'A' })).smsDeliveryReady, false)
  assert.equal((await load({ brevoApiKey: 'c'.repeat(24) })).emailDeliveryReady, false)
  assert.equal((await load({ notificationSmsDeliveryCallbacksConfigured: true })).smsDeliveryReady, false)
  assert.equal((await load({ notificationSmsDeliveryCallbacksConfigured: true, notificationSmsEvidence: JSON.stringify({ ...sms, gates: { ...gates, deliveryCallbackAuth: 'passed' } }) })).smsDeliveryReady, true)
  assert.equal((await load({ notificationWebPushEvidence: JSON.stringify({ ...push, interoperability: ['ios-home-screen'] }) })).webPushDeliveryReady, false)
  for (const invalid of ['', 'not-json', '[]', JSON.stringify({ ...email, expiresAt: new Date(now + 86_400_001).toISOString() })]) assert.equal((await load({ notificationEmailEvidence: invalid })).emailDeliveryReady, false)
  now += 60_000
  assert.equal(config.emailDeliveryReady, false, 'existing config must lose expired authority')
  assert.equal(config.smsDeliveryReady, false)
  assert.equal(config.webPushDeliveryReady, false)
})
