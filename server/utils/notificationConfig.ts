import type { NotificationCrypto, NotificationLifecycleConfig } from './notifications.ts'
import type { VapidConfiguration } from './webPush.ts'

// Nitro replaces this constant with a literal; runtime secrets cannot relax production.
declare const __PREVIEW_DEPLOY__: boolean
declare const __NOTIFICATION_COMMUNITIES__: readonly { slug: string, title: string }[]
const isPreviewDeploy = typeof __PREVIEW_DEPLOY__ !== 'undefined' && __PREVIEW_DEPLOY__

export class NotificationConfigurationError extends Error {
  readonly reason: 'root-key-invalid' | 'turnstile-secret-invalid' | 'turnstile-hostname-invalid'

  constructor(reason: NotificationConfigurationError['reason'] = 'root-key-invalid') {
    super('Notification configuration is unavailable')
    this.reason = reason
  }
}

const decodeBase64Url = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new NotificationConfigurationError()
  try {
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
    const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
    if (bytes.length !== 32) throw new NotificationConfigurationError()
    return bytes
  } catch {
    throw new NotificationConfigurationError()
  }
}

const hkdfSalt = new TextEncoder().encode('jednadvacet.org/notifications/v1')
const purposeLabels = {
  outbox: 'outbox/aes-gcm-256',
  suppression: 'suppression/hmac-sha-256',
  abuse: 'abuse/hmac-sha-256',
} as const

const derivePurposeKeys = async (material: Uint8Array, subtle: SubtleCrypto) => {
  const root = await subtle.importKey('raw', material as unknown as BufferSource, 'HKDF', false, ['deriveKey'])
  const derive = <T extends KeyAlgorithm>(purpose: string, algorithm: T, usages: KeyUsage[]) => subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt as unknown as BufferSource, info: new TextEncoder().encode(purpose) as unknown as BufferSource },
    root,
    algorithm,
    false,
    usages,
  )
  return {
    outbox: await derive(purposeLabels.outbox, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    suppression: await derive(purposeLabels.suppression, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
    abuse: await derive(purposeLabels.abuse, { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  }
}

const defaultCrypto = (): NotificationCrypto => ({ randomBytes: length => crypto.getRandomValues(new Uint8Array(length)), subtle: crypto.subtle })
const requiredPrivateText = (value: unknown, reason: 'turnstile-secret-invalid' | 'turnstile-hostname-invalid') => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) throw new NotificationConfigurationError(reason)
  return value
}
const requiredHostname = (value: unknown) => {
  const hostname = requiredPrivateText(value, 'turnstile-hostname-invalid').toLowerCase()
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) throw new NotificationConfigurationError('turnstile-hostname-invalid')
  return hostname
}
const optionalPrivateText = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 4_096 ? value : undefined

export const optionalVapidConfiguration = async (value: Record<string, unknown>, cryptoApi: NotificationCrypto): Promise<VapidConfiguration | undefined> => {
  const publicRuntime = value.public && typeof value.public === 'object' && !Array.isArray(value.public)
    ? value.public as Record<string, unknown>
    : undefined
  const publicKey = typeof publicRuntime?.notificationVapidPublicKey === 'string'
    ? publicRuntime.notificationVapidPublicKey
    : typeof value.notificationVapidPublicKey === 'string'
      ? value.notificationVapidPublicKey
      : undefined
  const privateKey = typeof value.notificationVapidPrivateKey === 'string' ? value.notificationVapidPrivateKey : undefined
  const subject = typeof value.notificationVapidSubject === 'string' ? value.notificationVapidSubject : undefined
  if (!publicKey || !privateKey || !subject || !/^(?:mailto:[^\s@/?#]+@[^\s@/?#]+|https:\/\/[^\s/]+(?:\/[^\s]*)?)$/.test(subject)) return undefined
  try {
    if (subject.startsWith('https:')) {
      const url = new URL(subject)
      if (url.username || url.password || url.hash) return undefined
    }
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    const decode = (encoded: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 128) throw new Error('VAPID key is malformed')
      const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)), character => character.charCodeAt(0))
      if (encode(bytes) !== encoded) throw new Error('VAPID key is malformed')
      return bytes
    }
    const publicBytes = decode(publicKey)
    const privateBytes = decode(privateKey)
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) return undefined
    const { subtle } = cryptoApi
    const verificationKey = await subtle.importKey('raw', publicBytes as unknown as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const imported = await subtle.importKey('jwk', {
      kty: 'EC',
      crv: 'P-256',
      x: encode(publicBytes.slice(1, 33)),
      y: encode(publicBytes.slice(33)),
      d: encode(privateBytes),
      ext: false,
      key_ops: ['sign'],
    }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const challenge = cryptoApi.randomBytes(32) as unknown as BufferSource
    const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, imported, challenge)
    if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verificationKey, signature, challenge)) return undefined
    return { privateKey: imported, publicKey, subject }
  } catch {
    return undefined
  }
}

const emailDelivery = (value: Record<string, unknown>) => {
  const brevoApiKey = optionalPrivateText(value.brevoApiKey)
  const brevoCallbackSecret = optionalPrivateText(value.brevoCallbackSecret)
  const brevoSenderName = optionalPrivateText(value.brevoSenderName)
  const complete = Boolean(
    brevoApiKey && brevoApiKey.length >= 24
    && brevoCallbackSecret && brevoCallbackSecret.length >= 24
    && brevoSenderName && brevoSenderName.length <= 96
    && value.brevoSenderEmail === 'noreply@jednadvacet.org',
  )
  return { brevoApiKey, brevoCallbackSecret, brevoSenderName, ready: complete }
}

const smsDelivery = (value: Record<string, unknown>) => {
  const apiKey = optionalPrivateText(value.brevoApiKey)
  const sender = optionalPrivateText(value.brevoSmsSender)
  return Boolean(apiKey && apiKey.length >= 24
    && sender && /^(?:[A-Za-z0-9]{1,11}|\d{1,15})$/.test(sender))
}

/** Loads only private runtime configuration into non-extractable Worker Web Crypto keys. */
export const notificationConfig = async (value: Record<string, unknown>, cryptoApi = defaultCrypto(), report?: (reason: string) => void): Promise<NotificationLifecycleConfig> => {
  const communities = typeof __NOTIFICATION_COMMUNITIES__ !== 'undefined' ? __NOTIFICATION_COMMUNITIES__ : []
  const expectedHostname = requiredHostname(value.notificationTurnstileExpectedHostname)
  if (isPreviewDeploy && !expectedHostname.endsWith('.workers.dev')) throw new NotificationConfigurationError('turnstile-hostname-invalid')
  const turnstileSecret = requiredPrivateText(value.notificationTurnstileSecret, 'turnstile-secret-invalid')
  if (typeof value.notificationRootKey !== 'string') throw new NotificationConfigurationError()
  const keys = await derivePurposeKeys(decodeBase64Url(value.notificationRootKey), cryptoApi.subtle)
  const email = emailDelivery(value)
  const webPushDelivery = await optionalVapidConfiguration(value, cryptoApi)
  // Used only by readiness. These fixed categories never contain runtime values,
  // exception messages, provider responses or subscriber information.
  if (report) {
    const publicConfig = value.public as Record<string, unknown> | undefined
    if (!optionalPrivateText(publicConfig?.notificationTurnstileSiteKey)) report('turnstile-public-site-key-missing-or-invalid')
    if (!email.brevoApiKey || email.brevoApiKey.length < 24) report('brevo-api-key-missing-or-invalid')
    if (!email.brevoCallbackSecret || email.brevoCallbackSecret.length < 24) report('email-callback-secret-missing-or-invalid')
    if (!email.brevoSenderName || email.brevoSenderName.length > 96 || value.brevoSenderEmail !== 'noreply@jednadvacet.org') report('email-sender-missing-or-invalid')
    if (!smsDelivery(value)) report('sms-provider-configuration-invalid')
    if (!webPushDelivery) report('vapid-configuration-missing-invalid-or-mismatched')
  }
  return {
    managementOrigin: isPreviewDeploy ? `https://${expectedHostname}` : 'https://jednadvacet.org',
    communitySlugs: communities.map(community => community.slug),
    communityTitles: Object.fromEntries(communities.map(community => [community.slug, community.title])),
    outboxTransportKey: keys.outbox,
    suppressionHashKey: keys.suppression,
    abuseHashKey: keys.abuse,
    turnstile: {
      secret: turnstileSecret,
      expectedHostname,
    },
    smsDeliveryReady: smsDelivery(value),
    eventSmsOutboxSupported: true,
    eventWebPushOutboxSupported: true,
    emailDeliveryReady: email.ready,
    brevoApiKey: email.brevoApiKey,
    brevoSenderName: email.brevoSenderName,
    brevoCallbackSecret: email.brevoCallbackSecret,
    webPushDelivery,
    webPushDeliveryReady: Boolean(webPushDelivery),
  }
}
