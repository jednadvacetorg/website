import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWebPushSubscription, serializeWebPushSubscription } from '../server/utils/webPushSubscriptions.ts'

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const subscription = { endpoint: 'https://push.example.test/subscription', keys: { p256dh: encode(new Uint8Array(65).fill(1)), auth: encode(new Uint8Array(16).fill(2)) } }

test('canonicalizes one exact HTTPS PushSubscription shape', () => {
  assert.deepEqual(parseWebPushSubscription(subscription), subscription)
  assert.equal(serializeWebPushSubscription({ keys: { auth: subscription.keys.auth, p256dh: subscription.keys.p256dh }, endpoint: subscription.endpoint }), serializeWebPushSubscription(subscription))
})

test('rejects credentialed, malformed, and extra PushSubscription fields', () => {
  assert.throws(() => parseWebPushSubscription({ ...subscription, endpoint: 'https://user:pass@push.example.test/subscription' }))
  assert.throws(() => parseWebPushSubscription({ ...subscription, keys: { ...subscription.keys, extra: 'x' } }))
  assert.throws(() => parseWebPushSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'bad!' } }))
})
