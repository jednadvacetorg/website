export interface CanonicalWebPushSubscription {
  endpoint: string
  keys: { auth: string, p256dh: string }
}

const decodeBase64Url = (value: unknown, expectedLength: number) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) throw new Error('Web Push subscription is invalid')
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0))
    if (bytes.length !== expectedLength) throw new Error('Web Push subscription is invalid')
    return value
  } catch { throw new Error('Web Push subscription is invalid') }
}

/** Validates the exact browser PushSubscription JSON shape before durable storage. */
export const parseWebPushSubscription = (value: unknown): CanonicalWebPushSubscription => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Web Push subscription is invalid')
  const subscription = value as Record<string, unknown>
  if (Object.keys(subscription).length !== 2 || typeof subscription.endpoint !== 'string' || !subscription.keys || typeof subscription.keys !== 'object' || Array.isArray(subscription.keys)) throw new Error('Web Push subscription is invalid')
  const keys = subscription.keys as Record<string, unknown>
  if (Object.keys(keys).length !== 2) throw new Error('Web Push subscription is invalid')
  let endpoint: URL
  try { endpoint = new URL(subscription.endpoint) } catch { throw new Error('Web Push subscription is invalid') }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.toString().length > 2_048 || /[\u0000-\u001F\u007F]/.test(endpoint.toString())) throw new Error('Web Push subscription is invalid')
  return { endpoint: endpoint.toString(), keys: { auth: decodeBase64Url(keys.auth, 16), p256dh: decodeBase64Url(keys.p256dh, 65) } }
}

export const serializeWebPushSubscription = (value: unknown) => JSON.stringify(parseWebPushSubscription(value))
