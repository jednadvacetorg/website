import assert from 'node:assert/strict'
import test from 'node:test'

import { sendWebPush } from '../server/utils/webPush.ts'

test('submits exactly one encrypted aes128gcm Web Push request', async () => {
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const p256dh = new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey))
  const encoded = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  let calls = 0
  const result = await sendWebPush({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: encoded(p256dh), auth: encoded(crypto.getRandomValues(new Uint8Array(16))) } }, { title: 'Nová akce', body: 'Podrobnosti', url: 'https://jednadvacet.org/kalendar' }, { privateKey: vapid.privateKey, publicKey: encoded(publicKey), subject: 'mailto:notifications@jednadvacet.org' }, async (_url: string, request: RequestInit) => {
    calls += 1
    assert.equal(request.headers instanceof Headers ? request.headers.get('content-encoding') : undefined, 'aes128gcm')
    assert.ok(request.body instanceof Uint8Array)
    return new Response(null, { status: 201 })
  })
  assert.deepEqual(result, { attempted: true, status: 'submitted', httpStatus: 201 })
  assert.equal(calls, 1)
})
