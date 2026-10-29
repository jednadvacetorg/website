import type { NotificationCrypto } from './notifications.ts'
import { parseWebPushSubscription } from './webPushSubscriptions.ts'

export interface WebPushSubscription {
  endpoint: string
  keys: { p256dh: string, auth: string }
}

export interface WebPushMessage {
  title: string
  body: string
  url: string
}

export interface VapidConfiguration {
  privateKey: CryptoKey
  publicKey: string
  subject: string
}

export type WebPushAttemptResult = {
  attempted: boolean
  status: 'submitted' | 'invalid-request' | 'auth' | 'rate-limited' | 'provider-5xx' | 'transport' | 'stale-endpoint'
  httpStatus?: number
}

const encoder = new TextEncoder()
const defaultCrypto = (): NotificationCrypto => ({ subtle: crypto.subtle, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) })
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const decode = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Web Push key is invalid')
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0))
}
const buffer = (value: Uint8Array) => value as unknown as BufferSource
const concat = (...values: Uint8Array[]) => {
  const result = new Uint8Array(values.reduce((size, value) => size + value.length, 0))
  let offset = 0
  for (const value of values) { result.set(value, offset); offset += value.length }
  return result
}
const hkdf = async (material: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number, subtle: SubtleCrypto) => {
  const key = await subtle.importKey('raw', buffer(material), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buffer(salt), info: buffer(info) }, key, length * 8))
}

/** Encrypts a single RFC 8291 aes128gcm record with fresh ECDH and salt material. */
export const encryptWebPushPayload = async (input: WebPushSubscription, message: WebPushMessage | Uint8Array, cryptoApi = defaultCrypto()) => {
  const subscription = parseWebPushSubscription(input)
  const endpoint = new URL(subscription.endpoint)
  const { subtle } = cryptoApi
  const receiverPublic = decode(subscription.keys.p256dh)
  const auth = decode(subscription.keys.auth)
  if (receiverPublic.length !== 65 || receiverPublic[0] !== 4 || auth.length !== 16) throw new Error('Web Push subscription is invalid')
  const plaintext = message instanceof Uint8Array ? message : encoder.encode(JSON.stringify(message))
  if (plaintext.length > 3993) throw new Error('Web Push payload exceeds the RFC limit')
  const receiver = await subtle.importKey('raw', buffer(receiverPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const sender = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const senderPublic = new Uint8Array(await subtle.exportKey('raw', sender.publicKey))
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: receiver }, sender.privateKey, 256))
  const ikm = await hkdf(shared, auth, concat(encoder.encode('WebPush: info'), new Uint8Array([0]), receiverPublic, senderPublic), 32, subtle)
  const salt = cryptoApi.randomBytes(16)
  if (salt.length !== 16) throw new Error('Web Push salt is invalid')
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16, subtle)
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12, subtle)
  const key = await subtle.importKey('raw', buffer(cek), { name: 'AES-GCM' }, false, ['encrypt'])
  const encrypted = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: buffer(nonce) }, key, buffer(concat(plaintext, new Uint8Array([2])))))
  const recordSize = new Uint8Array([0, 0, 16, 0])
  return { endpoint: endpoint.toString(), body: concat(salt, recordSize, new Uint8Array([senderPublic.length]), senderPublic, encrypted) }
}

const vapidAuthorization = async (endpoint: URL, config: VapidConfiguration, now: Date, subtle: SubtleCrypto) => {
  if (!/^(?:mailto:[^\s@/?#]+@[^\s@/?#]+|https:\/\/[^\s/]+(?:\/[^\s]*)?)$/.test(config.subject) || !Number.isFinite(now.getTime())) throw new Error('VAPID subject or clock is invalid')
  if (config.subject.startsWith('https:')) {
    const subject = new URL(config.subject)
    if (subject.username || subject.password || subject.hash) throw new Error('VAPID subject is invalid')
  }
  const header = base64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = base64Url(encoder.encode(JSON.stringify({ aud: endpoint.origin, exp: Math.floor(now.getTime() / 1000) + 23 * 60 * 60, sub: config.subject })))
  const publicBytes = decode(config.publicKey)
  if (publicBytes.length !== 65 || publicBytes[0] !== 4 || base64Url(publicBytes) !== config.publicKey) throw new Error('VAPID public key is invalid')
  const publicKey = await subtle.importKey('raw', buffer(publicBytes), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const signed = encoder.encode(`${header}.${payload}`)
  const signature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, config.privateKey, signed))
  if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, buffer(signature), signed)) throw new Error('VAPID keys do not match')
  return `vapid t=${header}.${payload}.${base64Url(signature)}, k=${config.publicKey}`
}

/** Performs one privacy-safe native Web Push submission without consuming provider response bodies. */
export const sendWebPush = async (subscription: WebPushSubscription, message: WebPushMessage, config: VapidConfiguration, fetcher: typeof fetch = fetch, now = new Date(), cryptoApi = defaultCrypto()): Promise<WebPushAttemptResult> => {
  let encrypted: Awaited<ReturnType<typeof encryptWebPushPayload>>
  let authorization: string
  try {
    if (!message || ![message.title, message.body, message.url].every(value => typeof value === 'string') || !message.title) throw new Error('Invalid Web Push message')
    encrypted = await encryptWebPushPayload(subscription, message, cryptoApi)
    authorization = await vapidAuthorization(new URL(encrypted.endpoint), config, now, cryptoApi.subtle)
  } catch { return { attempted: false, status: 'invalid-request' } }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  try {
    // Workers supports manual redirects, not redirect: 'error'. Never follow a
    // provider redirect with the subscription payload or VAPID authorization.
    const response = await fetcher(new URL(encrypted.endpoint), { method: 'POST', redirect: 'manual', signal: controller.signal, headers: new Headers({ authorization, 'content-encoding': 'aes128gcm', ttl: '60', 'content-type': 'application/octet-stream' }), body: buffer(encrypted.body) })
    if (response.status >= 200 && response.status < 300) return { attempted: true, status: 'submitted', httpStatus: response.status }
    console.warn('[notifications] Web Push provider rejected a request', { httpStatus: response.status })
    return { attempted: true, status: response.status === 404 || response.status === 410 ? 'stale-endpoint' : response.status === 429 ? 'rate-limited' : response.status === 401 || response.status === 403 ? 'auth' : response.status >= 500 ? 'provider-5xx' : 'invalid-request', httpStatus: response.status }
  } catch (error) {
    console.warn('[notifications] Web Push transport failed', { timedOut: controller.signal.aborted, errorType: error instanceof Error ? error.name : typeof error })
    return { attempted: true, status: 'transport' }
  }
  finally { clearTimeout(timeout) }
}
