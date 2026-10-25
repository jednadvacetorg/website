export interface CanonicalWebPushSubscription {
  endpoint: string
  keys: { auth: string, p256dh: string }
}

const decodeBase64Url = (value: unknown, expectedLength: number) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) throw new Error('Web Push subscription is invalid')
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0))
    const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    if (bytes.length !== expectedLength || canonical !== value || (expectedLength === 65 && bytes[0] !== 4)) throw new Error('Web Push subscription is invalid')
    return value
  } catch { throw new Error('Web Push subscription is invalid') }
}

/** Validates the exact browser PushSubscription JSON shape before durable storage. */
export const parseWebPushSubscription = (value: unknown, now = new Date()): CanonicalWebPushSubscription => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Web Push subscription is invalid')
  const subscription = value as Record<string, unknown>
  if (!Object.keys(subscription).every(key => ['endpoint', 'keys', 'expirationTime'].includes(key)) || typeof subscription.endpoint !== 'string' || !subscription.keys || typeof subscription.keys !== 'object' || Array.isArray(subscription.keys)) throw new Error('Web Push subscription is invalid')
  if ('expirationTime' in subscription && subscription.expirationTime !== null && (typeof subscription.expirationTime !== 'number' || !Number.isFinite(subscription.expirationTime) || subscription.expirationTime <= now.getTime() || subscription.expirationTime > 8.64e15)) throw new Error('Web Push subscription is invalid')
  const keys = subscription.keys as Record<string, unknown>
  if (Object.keys(keys).length !== 2) throw new Error('Web Push subscription is invalid')
  let endpoint: URL
  if (subscription.endpoint !== subscription.endpoint.trim() || /[\u0000-\u0020\u007F\\#]/.test(subscription.endpoint) || subscription.endpoint.length > 2_048) throw new Error('Web Push subscription is invalid')
  try { endpoint = new URL(subscription.endpoint) } catch { throw new Error('Web Push subscription is invalid') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.toString().length > 2_048 || /[\u0000-\u001F\u007F]/.test(endpoint.toString())) throw new Error('Web Push subscription is invalid')
  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, '')
  if ((!hostname.includes('.') && !hostname.startsWith('[')) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('Web Push subscription is invalid')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const [a, b, c] = hostname.split('.').map(Number) as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113) throw new Error('Web Push subscription is invalid')
  }
  // Only global unicast IPv6 literals; DNS resolution/network egress remains a release gate.
  if (hostname.startsWith('[') && (!/^\[[23][0-9a-f]{3}:/.test(hostname) || hostname.startsWith('[2001:db8:'))) throw new Error('Web Push subscription is invalid')
  return { endpoint: endpoint.toString(), keys: { auth: decodeBase64Url(keys.auth, 16), p256dh: decodeBase64Url(keys.p256dh, 65) } }
}

/** Async point validation is required before activation/recovery writes, not in synchronous dispatch parsing. */
export const validateWebPushSubscriptionPoint = async (subscription: CanonicalWebPushSubscription, subtle: SubtleCrypto) => {
  const encoded = subscription.keys.p256dh
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)), character => character.charCodeAt(0))
  await subtle.importKey('raw', bytes as unknown as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}
