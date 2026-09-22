import type { NotificationCrypto, NotificationLifecycleConfig } from './notifications.ts'
import type { VapidConfiguration } from './webPush.ts'

export class NotificationConfigurationError extends Error {
  constructor() {
    super('Notification configuration is unavailable')
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

const asBoolean = (value: unknown) => value === true || value === 'true'
const defaultCrypto = (): NotificationCrypto => ({ randomBytes: length => crypto.getRandomValues(new Uint8Array(length)), subtle: crypto.subtle })
const requiredPrivateText = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) throw new NotificationConfigurationError()
  return value
}
const requiredHostname = (value: unknown) => {
  const hostname = requiredPrivateText(value).toLowerCase()
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) throw new NotificationConfigurationError()
  return hostname
}
const optionalPrivateText = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 4_096 ? value : undefined
const exactTrue = (value: unknown) => value === true || value === 'true'

const optionalVapidConfiguration = async (value: Record<string, unknown>): Promise<VapidConfiguration | undefined> => {
  const publicKey = typeof value.notificationVapidPublicKey === 'string' ? value.notificationVapidPublicKey : undefined
  const privateKey = typeof value.notificationVapidPrivateKey === 'string' ? value.notificationVapidPrivateKey : undefined
  const subject = typeof value.notificationVapidSubject === 'string' ? value.notificationVapidSubject : undefined
  if (!publicKey || !privateKey || !subject || !/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+(?:\/[^\s]*)?)$/.test(subject)) return undefined
  try {
    const decode = (encoded: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('VAPID key is malformed')
      return Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4)), character => character.charCodeAt(0))
    }
    const publicBytes = decode(publicKey)
    const privateBytes = decode(privateKey)
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) return undefined
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    const imported = await crypto.subtle.importKey('jwk', {
      kty: 'EC',
      crv: 'P-256',
      x: encode(publicBytes.slice(1, 33)),
      y: encode(publicBytes.slice(33)),
      d: encode(privateBytes),
      ext: false,
      key_ops: ['sign'],
    }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
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
    && value.brevoSenderEmail === 'noreply@jednadvacet.org'
    && exactTrue(value.brevoSenderVerified)
    && exactTrue(value.brevoSpfVerified)
    && exactTrue(value.brevoDkimVerified)
    && exactTrue(value.brevoDmarcVerified)
    && exactTrue(value.brevoCallbackVerified)
    && exactTrue(value.notificationProductionBindingsVerified)
    && exactTrue(value.notificationMigrationVerified)
    && exactTrue(value.brevoSandboxVerified)
    && exactTrue(value.brevoLiveCanaryVerified)
    && exactTrue(value.notificationEmailManualEnabled),
  )
  return { brevoApiKey, brevoCallbackSecret, brevoSenderName, ready: complete }
}

const smsDelivery = (value: Record<string, unknown>) => {
  const apiKey = optionalPrivateText(value.brevoApiKey)
  const sender = optionalPrivateText(value.brevoSenderName)
  return Boolean(apiKey && apiKey.length >= 24
    && sender && /^(?:[A-Za-z0-9]{1,11}|\d{1,15})$/.test(sender)
    && exactTrue(value.notificationProductionBindingsVerified))
}

/** Loads only private runtime configuration into non-extractable Worker Web Crypto keys. */
export const notificationConfig = async (value: Record<string, unknown>, cryptoApi = defaultCrypto()): Promise<NotificationLifecycleConfig> => {
  const email = emailDelivery(value)
  const webPushDelivery = await optionalVapidConfiguration(value)
  return {
  communitySlugs: typeof value.notificationCommunitySlugs === 'string'
    ? value.notificationCommunitySlugs.split(',').map(slug => slug.trim()).filter(Boolean)
    : [],
   ...await (async () => {
     if (typeof value.notificationRootKey !== 'string') throw new NotificationConfigurationError()
     const keys = await derivePurposeKeys(decodeBase64Url(value.notificationRootKey), cryptoApi.subtle)
     return {
       outboxTransportKey: keys.outbox,
       suppressionHashKey: keys.suppression,
       abuseHashKey: keys.abuse,
     }
   })(),
  turnstile: {
    secret: requiredPrivateText(value.notificationTurnstileSecret),
    expectedHostname: requiredHostname(value.notificationTurnstileExpectedHostname),
  },
  consentVersion: typeof value.notificationConsentVersion === 'string' ? value.notificationConsentVersion : '',
  emailSmsEnabled: asBoolean(value.notificationEmailSmsEnabled),
  emailSmsFirstMessageReady: asBoolean(value.notificationEmailSmsFirstMessageReady),
   emailSmsEventDeliveryReady: asBoolean(value.notificationEmailSmsEventDeliveryReady),
   smsEnabled: asBoolean(value.notificationSmsEnabled),
   smsFirstMessageReady: asBoolean(value.notificationSmsFirstMessageReady),
   smsEventDeliveryReady: asBoolean(value.notificationSmsEventDeliveryReady),
   smsDeliveryReady: smsDelivery(value),
   eventSmsOutboxSupported: false,
  emailDeliveryReady: email.ready,
  brevoApiKey: email.brevoApiKey,
  brevoSenderName: email.brevoSenderName,
  brevoCallbackSecret: email.brevoCallbackSecret,
   webPushEnabled: asBoolean(value.notificationWebPushEnabled),
   webPushFirstMessageReady: asBoolean(value.notificationWebPushFirstMessageReady),
   webPushEventDeliveryReady: asBoolean(value.notificationWebPushEventDeliveryReady),
   webPushDelivery,
   webPushDeliveryReady: Boolean(webPushDelivery),
   }
}
