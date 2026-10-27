import assert from 'node:assert/strict'
import test from 'node:test'

import { parseWebPushSubscription } from '../server/utils/webPushSubscriptions.ts'

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const subscription = { endpoint: 'https://push.example.test/subscription', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: encode(new Uint8Array(16).fill(2)) } }

test('canonicalizes one exact HTTPS PushSubscription shape', () => {
  assert.deepEqual(parseWebPushSubscription(subscription), subscription)
  assert.deepEqual(parseWebPushSubscription({ keys: { auth: subscription.keys.auth, p256dh: subscription.keys.p256dh }, endpoint: subscription.endpoint }), subscription)
})

test('native browser JSON expiration validates without changing destination identity', () => {
  const now = new Date('2026-10-04T12:00:00Z')
  for (const expirationTime of [null, now.getTime() + 1000]) {
    assert.deepEqual(parseWebPushSubscription({ ...subscription, expirationTime }, now), subscription)
    assert.deepEqual(parseWebPushSubscription({ keys: subscription.keys, expirationTime, endpoint: subscription.endpoint }, now), subscription)
  }
  for (const expirationTime of [undefined, -1, now.getTime(), NaN, Infinity, 'future', {}, 8.64e15 + 1]) assert.throws(() => parseWebPushSubscription({ ...subscription, expirationTime }, now))
  assert.throws(() => parseWebPushSubscription({ ...subscription, expirationTime: null, extra: true }))
})

test('rejects noncanonical key bytes and unsafe endpoints before URL normalization', () => {
  for (const endpoint of ['http://push.example.test/a', 'https://localhost/a', 'https://localhost./a', 'https://foo.localhost/a', 'https://127.0.0.1/a', 'https://127.1/a', 'https://10.0.0.1/a', 'https://172.16.1.1/a', 'https://192.168.1.1/a', 'https://169.254.1.1/a', 'https://0.0.0.0/a', 'https://100.64.0.1/a', 'https://224.0.0.1/a', 'https://[::1]/a', 'https://[fc00::1]/a', 'https://[fe80::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://push.example.test/a#x', ' https://push.example.test/a', 'https://push.example.test/a\n', 'https://push.example.test/\ta', 'https://push.example.test\\a']) assert.throws(() => parseWebPushSubscription({ ...subscription, endpoint }), endpoint)
  for (const auth of [subscription.keys.auth + '=', subscription.keys.auth.slice(0, -1) + 'h', 'bad!', encode(new Uint8Array(17))]) assert.throws(() => parseWebPushSubscription({ ...subscription, keys: { ...subscription.keys, auth } }))
  assert.throws(() => parseWebPushSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: encode(new Uint8Array(65).fill(1)) } }))
  assert.equal(parseWebPushSubscription({ ...subscription, endpoint: 'https://PUSH.EXAMPLE.TEST:443/a' }).endpoint, 'https://push.example.test/a')
  assert.throws(() => parseWebPushSubscription({ ...subscription, endpoint: 'https://push.example.test/a#' }))
})

test('rejects credentialed, malformed, and extra PushSubscription fields', () => {
  assert.throws(() => parseWebPushSubscription({ ...subscription, endpoint: 'https://user:pass@push.example.test/subscription' }))
  assert.throws(() => parseWebPushSubscription({ ...subscription, keys: { ...subscription.keys, extra: 'x' } }))
  assert.throws(() => parseWebPushSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'bad!' } }))
})
