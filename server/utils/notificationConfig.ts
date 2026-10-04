import type { NotificationChannel, NotificationCrypto, NotificationLifecycleConfig } from './notifications.ts'
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

const day = 86_400_000
const hashPattern = /^[a-f0-9]{64}$/
const evidenceGates = {
  email: ['artifacts', 'deployment', 'bindings', 'migration', 'sender', 'dns', 'callbackMetadata', 'https', 'sandbox', 'callback', 'liveCanary', 'humanInbox', 'humanCalendar', 'humanLink', 'humanLogs'],
  sms: ['artifacts', 'deployment', 'bindings', 'migration', 'sender', 'account', 'credits', 'country', 'compliance', 'sharedManagementStop', 'liveCanary'],
  'web-push': ['artifacts', 'deployment', 'bindings', 'migration', 'vapid', 'protocol', 'interoperability', 'sharedManagementStop', 'liveCanary'],
} as const

/** Operator-owned observations use the 06-15 evidence envelope. Never accept local CLI/test proofs. */
export const operationalEvidence = async (channel: NotificationChannel, value: Record<string, unknown>, cryptoApi: NotificationCrypto, now: () => number) => {
  try {
    const name = channel === 'web-push' ? 'WebPush' : channel === 'sms' ? 'Sms' : 'Email'
    const raw = value[`notification${name}Evidence`]
    if (typeof raw !== 'string' || raw.length > 16_384) return () => false
    const evidence: unknown = JSON.parse(raw)
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return () => false
    const row = evidence as Record<string, unknown>
    if (row.channel !== channel || row.evidenceKind !== 'production-observation' || row.mode !== 'readiness' || row.manualSwitch !== true) return () => false
    for (const field of ['targetIdentity', 'bundleHash', 'migrationHash', 'configHash'] as const) {
      const expected = value[`notificationExpected${field[0]!.toUpperCase()}${field.slice(1)}`]
      if (typeof expected !== 'string' || !hashPattern.test(expected) || row[field] !== expected) return () => false
    }
    const deployment = value.notificationExpectedDeploymentId
    if (typeof deployment !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(deployment) || row.deploymentId !== deployment) return () => false
    // Changes to the root/provider/VAPID identity invalidate previously observed evidence.
    const publicConfig = value.public as Record<string, unknown> | undefined
    const material = channel === 'email'
      ? [value.notificationRootKey, value.brevoApiKey, value.brevoCallbackSecret, value.brevoSenderName, value.brevoSenderEmail]
      : channel === 'sms' ? [value.notificationRootKey, value.brevoApiKey, value.brevoSenderName]
        : [value.notificationRootKey, value.notificationVapidPrivateKey, publicConfig?.notificationVapidPublicKey ?? value.notificationVapidPublicKey, value.notificationVapidSubject]
    const keyHash = Array.from(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(material)))), byte => byte.toString(16).padStart(2, '0')).join('')
    if (row.keyHash !== keyHash) return () => false
    const gates = row.gates as Record<string, unknown> | undefined
    if (!gates || [...evidenceGates[channel], 'firstMessage', 'eventDelivery'].some(gate => gates[gate] !== 'passed')) return () => false
    if (channel === 'sms' && exactTrue(value.notificationSmsDeliveryCallbacksConfigured) && gates.deliveryCallbackAuth !== 'passed') return () => false
    // Each claimed browser family has its own observation, rather than a single asserted compatibility flag.
    if (channel === 'web-push') {
      const browsers = row.interoperability
      if (!Array.isArray(browsers) || !browsers.length || browsers.length > 8 || new Set(browsers).size !== browsers.length || !browsers.every(browser => ['chromium', 'firefox', 'safari-macos', 'ios-home-screen'].includes(browser) && gates[`browser:${browser}`] === 'passed')) return () => false
    }
    const verifiedAt = typeof row.verifiedAt === 'string' ? Date.parse(row.verifiedAt) : NaN
    const expiresAt = typeof row.expiresAt === 'string' ? Date.parse(row.expiresAt) : NaN
    // Re-evaluate on every gate read; a long-lived Queue request cannot retain expired authority.
    return () => {
      const current = now()
      return Number.isFinite(verifiedAt) && Number.isFinite(expiresAt) && verifiedAt <= current && current - verifiedAt <= day && expiresAt > current && expiresAt > verifiedAt && expiresAt - verifiedAt <= day
    }
  } catch { return () => false }
}

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
    && value.brevoSenderEmail === 'noreply@jednadvacet.org'
    && exactTrue(value.notificationEmailManualEnabled),
  )
  return { brevoApiKey, brevoCallbackSecret, brevoSenderName, ready: complete }
}

const smsDelivery = (value: Record<string, unknown>) => {
  const apiKey = optionalPrivateText(value.brevoApiKey)
  const sender = optionalPrivateText(value.brevoSenderName)
  return Boolean(apiKey && apiKey.length >= 24
    && sender && /^(?:[A-Za-z0-9]{1,11}|\d{1,15})$/.test(sender))
}

/** Loads only private runtime configuration into non-extractable Worker Web Crypto keys. */
export const notificationConfig = async (value: Record<string, unknown>, cryptoApi = defaultCrypto(), now = Date.now): Promise<NotificationLifecycleConfig> => {
  const email = emailDelivery(value)
  const webPushDelivery = await optionalVapidConfiguration(value, cryptoApi)
  const [emailEvidence, smsEvidence, pushEvidence] = await Promise.all([
    operationalEvidence('email', value, cryptoApi, now),
    operationalEvidence('sms', value, cryptoApi, now),
    operationalEvidence('web-push', value, cryptoApi, now),
  ])
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
    get smsDeliveryReady() { return smsDelivery(value) && smsEvidence() },
    get eventSmsOutboxSupported() { return smsEvidence() },
    get eventWebPushOutboxSupported() { return pushEvidence() },
   get emailDeliveryReady() { return email.ready && emailEvidence() },
  brevoApiKey: email.brevoApiKey,
  brevoSenderName: email.brevoSenderName,
  brevoCallbackSecret: email.brevoCallbackSecret,
   webPushEnabled: asBoolean(value.notificationWebPushEnabled),
   webPushFirstMessageReady: asBoolean(value.notificationWebPushFirstMessageReady),
   webPushEventDeliveryReady: asBoolean(value.notificationWebPushEventDeliveryReady),
   webPushDelivery,
    get webPushDeliveryReady() { return Boolean(webPushDelivery) && pushEvidence() },
   }
}
