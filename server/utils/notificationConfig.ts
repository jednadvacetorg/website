import type { NotificationCrypto, NotificationLifecycleConfig } from './notifications.ts'

export class NotificationConfigurationError extends Error {
  constructor() {
    super('Notification configuration is unavailable')
  }
}

const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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

const parseKeyring = async (value: unknown, currentVersion: unknown, importKey: (material: Uint8Array) => Promise<CryptoKey>) => {
  if (typeof value !== 'string' || typeof currentVersion !== 'string' || !versionPattern.test(currentVersion)) throw new NotificationConfigurationError()
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new NotificationConfigurationError()
  }
  if (!isRecord(parsed) || !Object.keys(parsed).length || !Object.entries(parsed).every(([version, key]) => versionPattern.test(version) && typeof key === 'string')) throw new NotificationConfigurationError()
  const keyring = Object.fromEntries(await Promise.all(Object.entries(parsed).map(async ([version, key]) => [
    version,
    await importKey(decodeBase64Url(key as string)),
  ]))) as Record<string, CryptoKey>
  if (!keyring[currentVersion]) throw new NotificationConfigurationError()
  return keyring
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

const emailDelivery = (value: Record<string, unknown>) => {
  const brevoApiKey = optionalPrivateText(value.brevoApiKey)
  const brevoCallbackSecret = optionalPrivateText(value.brevoCallbackSecret)
  const brevoSenderName = optionalPrivateText(value.brevoSenderName)
  const complete = Boolean(
    brevoApiKey && brevoApiKey.length >= 24
    && brevoCallbackSecret && brevoCallbackSecret.length >= 24
    && brevoSenderName && brevoSenderName.length <= 96
    && value.brevoSenderEmail === 'noreply@b.jednadvacet.org'
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

/** Loads only private runtime configuration into non-extractable Worker Web Crypto keys. */
export const notificationConfig = async (value: Record<string, unknown>, cryptoApi = defaultCrypto()): Promise<NotificationLifecycleConfig> => {
  const email = emailDelivery(value)
  return {
  communitySlugs: typeof value.notificationCommunitySlugs === 'string'
    ? value.notificationCommunitySlugs.split(',').map(slug => slug.trim()).filter(Boolean)
    : [],
  suppressionHashKeys: await parseKeyring(value.notificationSuppressionHashKeys, value.notificationCurrentSuppressionHashKeyVersion, material => cryptoApi.subtle.importKey('raw', material as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])),
  currentSuppressionHashKeyVersion: value.notificationCurrentSuppressionHashKeyVersion as string,
  abuseHashKeys: await parseKeyring(value.notificationAbuseHashKeys, value.notificationCurrentAbuseHashKeyVersion, material => cryptoApi.subtle.importKey('raw', material as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])),
  currentAbuseHashKeyVersion: value.notificationCurrentAbuseHashKeyVersion as string,
  turnstile: {
    secret: requiredPrivateText(value.notificationTurnstileSecret),
    expectedHostname: requiredHostname(value.notificationTurnstileExpectedHostname),
  },
  outboxTransportKeys: await parseKeyring(value.notificationOutboxTransportKeys, value.notificationCurrentOutboxTransportKeyVersion, material => cryptoApi.subtle.importKey('raw', material as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])),
  currentOutboxTransportKeyVersion: value.notificationCurrentOutboxTransportKeyVersion as string,
  consentVersion: typeof value.notificationConsentVersion === 'string' ? value.notificationConsentVersion : '',
  emailSmsEnabled: asBoolean(value.notificationEmailSmsEnabled),
  emailSmsFirstMessageReady: asBoolean(value.notificationEmailSmsFirstMessageReady),
  emailSmsEventDeliveryReady: asBoolean(value.notificationEmailSmsEventDeliveryReady),
  emailDeliveryReady: email.ready,
  brevoApiKey: email.brevoApiKey,
  brevoSenderName: email.brevoSenderName,
  brevoCallbackSecret: email.brevoCallbackSecret,
  webPushEnabled: asBoolean(value.notificationWebPushEnabled),
  webPushFirstMessageReady: asBoolean(value.notificationWebPushFirstMessageReady),
  webPushEventDeliveryReady: asBoolean(value.notificationWebPushEventDeliveryReady),
  }
}
