import { parseWebPushSubscription, validateWebPushSubscriptionPoint, type CanonicalWebPushSubscription } from './webPushSubscriptions.ts'

export type NotificationChannel = 'email' | 'sms' | 'web-push'
export type NotificationFrequency = 'created' | 'week-before' | 'day-before'

export interface ActivationInput { channel: NotificationChannel, contact: string | CanonicalWebPushSubscription, communitySlugs: string[], frequencies: NotificationFrequency[], consentAt: string }
export interface ActivationResult { state: 'active' | 'updated' | 'pending-reactivation' }
export interface NotificationManagementRequestInput { channel: NotificationChannel, contact: string | CanonicalWebPushSubscription }
export class NotificationLifecycleError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}
export interface NotificationStatement { bind(...values: unknown[]): NotificationStatement, first<T>(): Promise<T | null>, all<T>(): Promise<{ results: T[] }>, run(): Promise<unknown> }
export interface NotificationDatabase { prepare(query: string): NotificationStatement, batch(statements: NotificationStatement[]): Promise<unknown> }
export interface NotificationCrypto { randomBytes(length: number): Uint8Array, subtle: SubtleCrypto }
export interface NotificationLifecycleConfig {
  communitySlugs: readonly string[]
  communityTitles?: Record<string, string>
  suppressionHashKey: CryptoKey
  abuseHashKey: CryptoKey
  turnstile: { secret: string, expectedHostname: string }
  outboxTransportKey: CryptoKey
  /** Set by the build-specific configuration, never from an HTTP request origin. */
  managementOrigin?: string
  smsDeliveryReady: boolean
  /** Implemented outbox capability; the actual D1 schema is probed at authorization. */
  eventSmsOutboxSupported: boolean
  /** Implemented outbox capability; the actual D1 schema is probed at authorization. */
  eventWebPushOutboxSupported?: boolean
  /** Complete private email provider configuration. */
  emailDeliveryReady: boolean
  brevoApiKey?: string
  brevoSenderName?: string
  brevoCallbackSecret?: string
  /** Present only when the private VAPID material is valid and importable. */
  webPushDelivery?: import('./webPush.ts').VapidConfiguration
  webPushDeliveryReady: boolean
}
export interface NotificationDependencies { database: NotificationDatabase, config: NotificationLifecycleConfig, now?: () => Date, crypto?: NotificationCrypto, onWebPushActivated?: (token: string) => void }

interface ContactRow { id: number, channel: NotificationChannel, destination: string, destination_hash: string, management_token_digest: string, state: 'active' | 'pending-reactivation', capability_generation: number }
interface SubscriptionRow { community_slug: string, frequency: NotificationFrequency }
interface SuppressionRow { id: number, destination_hash: string }
export interface NotificationManagementCommunity { slug: string, title: string, frequencies: NotificationFrequency[] }
export type NotificationManagementResult = { state: 'active' | 'pending-reactivation', channel: NotificationChannel, maskedContact: string, communities: NotificationManagementCommunity[], confirmation?: 'pending' | 'submitted' | 'unavailable' | 'unknown' } | { state: 'unavailable' }
export type NotificationManagementMutationResult =
  | { outcome: 'saved' | 'removed' | 'reactivated', management: Exclude<NotificationManagementResult, { state: 'unavailable' }> }
  | { outcome: 'stopped' }
  | { outcome: 'unavailable' }

const encoder = new TextEncoder()
const channels = new Set<NotificationChannel>(['email', 'sms', 'web-push'])
const frequencies = new Set<NotificationFrequency>(['created', 'week-before', 'day-before'])
const controlPattern = /[\u0000-\u001F\u007F]/
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const defaultCrypto = (): NotificationCrypto => ({ randomBytes: length => crypto.getRandomValues(new Uint8Array(length)), subtle: crypto.subtle })
const asBufferSource = (value: Uint8Array) => value as unknown as BufferSource
const nowIso = (dependencies: NotificationDependencies) => (dependencies.now?.() ?? new Date()).toISOString()
const unavailable: NotificationManagementResult = { state: 'unavailable' }
const unavailableMutation: NotificationManagementMutationResult = { outcome: 'unavailable' }
const changed = (results: unknown, index: number) => {
  const result = Array.isArray(results) ? results[index] : undefined
  if (!result || typeof result !== 'object' || !('meta' in result)) return 0
  const meta = result.meta
  return meta && typeof meta === 'object' && 'changes' in meta && typeof meta.changes === 'number' ? meta.changes : 0
}

export const normalizeNotificationContact = (channel: NotificationChannel, value: unknown, now = new Date()) => {
  if (channel === 'web-push') {
    try {
      if (typeof value === 'string' && value.length > 4_096) throw new Error('Invalid push subscription')
      return JSON.stringify(parseWebPushSubscription(typeof value === 'string' ? JSON.parse(value) : value, now))
    } catch { throw new NotificationLifecycleError('Invalid notification activation') }
  }
  if (typeof value !== 'string') throw new NotificationLifecycleError('Invalid notification activation')
  const contact = value.trim()
  if (!contact || controlPattern.test(contact)) throw new NotificationLifecycleError('Invalid notification activation')
  if (channel === 'email') {
    const [local, domain, extra] = contact.split('@')
    if (!local || !domain || extra || /\s/.test(contact) || domain.startsWith('.') || domain.endsWith('.')) throw new NotificationLifecycleError('Invalid notification activation')
    return `${local}@${domain.toLowerCase()}`
  }
  if (channel === 'sms' && /^\+[1-9]\d{7,14}$/.test(contact)) return contact
  throw new NotificationLifecycleError('Invalid notification activation')
}

export const isNotificationChannelReady = (channel: NotificationChannel, config: NotificationLifecycleConfig) => channel === 'web-push'
  ? config.webPushDeliveryReady
  : channel === 'sms'
    ? config.smsDeliveryReady && config.eventSmsOutboxSupported
    : config.emailDeliveryReady

/** Read the supplied binding, not a schema file or a claimed migration boolean. No subscriber data is loaded. */
export const notificationSchemaReady = async (database: NotificationDatabase) => {
  try {
    await database.prepare(`SELECT d.channel, d.community_slug, d.eligibility_frequency, d.expected_capability_generation,
      o.kind, o.version, o.claim_token, o.claim_expires_at, c.capability_generation,
      cap.token_digest, cap.expires_at, e.notification_revision,
      o.email_destination_hash, o.email_provider_message_id, o.email_delivery_status,
      o.email_attempted_at, o.email_attempt_version, cb.receipt_key, cb.outbox_id,
      cb.attempt_version, cb.event, cb.provider_message_id, cb.received_at
      FROM notification_event_deliveries d, notification_outbox o, notification_contacts c,
      notification_management_capabilities cap, notification_event_state e,
      notification_lifecycle_email_callbacks cb WHERE 0`).all()
    return true
  } catch { return false }
}
const keyedHash = async (value: string, key: CryptoKey, cryptoApi: NotificationCrypto) => toBase64Url(new Uint8Array(await cryptoApi.subtle.sign('HMAC', key, encoder.encode(value))))
const digest = async (value: string, cryptoApi: NotificationCrypto) => toBase64Url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(value))))
const encrypt = async (value: string, key: CryptoKey, cryptoApi: NotificationCrypto) => {
  const iv = cryptoApi.randomBytes(12)
  const payload = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, encoder.encode(value))
  return { ciphertext: toBase64Url(new Uint8Array(payload)), iv: toBase64Url(iv) }
}
const opaqueId = (cryptoApi: NotificationCrypto) => toBase64Url(cryptoApi.randomBytes(24))
const maskContact = (channel: NotificationChannel, contact: string) => channel === 'email' ? `${contact.slice(0, 1)}•••@${contact.split('@')[1]}` : channel === 'sms' ? `${contact.slice(0, 4)} ••• ••• •••` : 'Prohlížečové upozornění'

export const validateNotificationActivation = (input: unknown, config: NotificationLifecycleConfig, now = new Date()) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NotificationLifecycleError('Invalid notification activation')
  const activation = input as Partial<ActivationInput>
  if (!channels.has(activation.channel as NotificationChannel) || typeof activation.consentAt !== 'string' || Number.isNaN(Date.parse(activation.consentAt)) || !Array.isArray(activation.communitySlugs) || !Array.isArray(activation.frequencies)) throw new NotificationLifecycleError('Invalid notification activation')
  const channel = activation.channel as NotificationChannel
  const communitySlugs = [...new Set(activation.communitySlugs)].sort()
  const selectedFrequencies = [...new Set(activation.frequencies)].sort()
  if (!communitySlugs.length || !selectedFrequencies.length || !communitySlugs.every(slug => config.communitySlugs.includes(slug)) || !selectedFrequencies.every(frequency => frequencies.has(frequency))) throw new NotificationLifecycleError('Invalid notification activation')
  // Retain the historical consent record, but its wording revision belongs to
  // the deployed code, not an operator variable or an untrusted form field.
  return { channel, contact: normalizeNotificationContact(channel, activation.contact, now), communitySlugs, selectedFrequencies, consentAt: activation.consentAt, consentVersion: '2026-09' }
}
const outboxStatement = async (contact: ContactRow, token: string, kind: 'first-activation' | 'reactivation' | 'management-recovery', dependencies: NotificationDependencies, now: string) => {
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  const encrypted = await encrypt(JSON.stringify({ destination: contact.destination, capability: token, kind }), dependencies.config.outboxTransportKey, cryptoApi)
  const authority = contactAuthority(contact, contact.state)
  return dependencies.database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`)
    .bind(opaqueId(cryptoApi), contact.id, 1, contact.capability_generation, 'pending', encrypted.ciphertext, encrypted.iv, kind, now, now, ...authority.values)
}

export const activateNotificationChannel = async (input: unknown, dependencies: NotificationDependencies): Promise<ActivationResult> => {
  const { config, database } = dependencies
  const parsed = validateNotificationActivation(input, config, dependencies.now?.() ?? new Date())
  if (!isNotificationChannelReady(parsed.channel, config) || !await notificationSchemaReady(database)) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  if (parsed.channel === 'web-push') {
    try { await validateWebPushSubscriptionPoint(JSON.parse(parsed.contact), cryptoApi.subtle) }
    catch { throw new NotificationLifecycleError('Invalid notification activation') }
  }
  const destinationHash = await keyedHash(parsed.contact, config.suppressionHashKey, cryptoApi)
  const now = nowIso(dependencies)
  const suppression = await database.prepare('SELECT id, destination_hash FROM notification_suppressions WHERE channel = ? AND destination_hash = ?').bind(parsed.channel, destinationHash).first<SuppressionRow>()
  const existing = await database.prepare('SELECT id, channel, destination, destination_hash, management_token_digest, state, capability_generation FROM notification_contacts WHERE channel = ? AND destination = ?').bind(parsed.channel, parsed.contact).first<ContactRow>()
  if (existing && !suppression) {
    const authority = contactAuthority(existing, existing.state)
    const results = await database.batch([
      database.prepare(`UPDATE notification_contacts SET updated_at = updated_at WHERE ${authority.clause}`).bind(...authority.values),
      ...parsed.communitySlugs.flatMap(community => authorizedSubscriptionReplacement(existing, community, parsed.selectedFrequencies, database, now)),
    ])
    if (changed(results, 0) !== 1) throw new NotificationLifecycleError('Notification activation is unavailable', 409)
    return { state: existing.state === 'active' ? 'updated' : 'pending-reactivation' }
  }
  const token = toBase64Url(cryptoApi.randomBytes(32))
  const tokenDigest = await digest(token, cryptoApi)
  if (existing) {
    const generation = existing.capability_generation + 1
    const rotating: ContactRow = { ...existing, management_token_digest: tokenDigest, state: 'pending-reactivation', capability_generation: generation }
    const previous = contactAuthority(existing, existing.state)
    const current = contactAuthority(rotating, rotating.state)
    const results = await database.batch([
      database.prepare(`UPDATE notification_contacts SET management_token_digest = ?, capability_generation = ?, state = ?, consent_at = ?, consent_version = ?, updated_at = ? WHERE ${previous.clause}`).bind(tokenDigest, generation, 'pending-reactivation', parsed.consentAt, parsed.consentVersion, now, ...previous.values),
      database.prepare(`UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?, ?) AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${current.clause})`).bind('invalidated', now, now, existing.id, 'pending', 'queued', 'claimed', ...current.values),
      ...parsed.communitySlugs.flatMap(community => authorizedSubscriptionReplacement(rotating, community, parsed.selectedFrequencies, database, now)),
      await outboxStatement(rotating, token, 'reactivation', dependencies, now),
    ])
    if (changed(results, 0) !== 1) throw new NotificationLifecycleError('Notification activation is unavailable', 409)
    return { state: 'pending-reactivation' }
  }
  const firstActivation = await encrypt(JSON.stringify({ destination: parsed.contact, capability: token, kind: 'first-activation' }), config.outboxTransportKey, cryptoApi)
  const reactivation = await encrypt(JSON.stringify({ destination: parsed.contact, capability: token, kind: 'reactivation' }), config.outboxTransportKey, cryptoApi)
  const results = await database.batch([
    database.prepare(`INSERT INTO notification_contacts (channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM notification_suppressions WHERE channel = ? AND destination_hash = ?) THEN 'pending-reactivation' ELSE 'active' END, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM notification_contacts WHERE channel = ? AND destination = ?)`)
      .bind(parsed.channel, parsed.contact, destinationHash, tokenDigest, 1, parsed.channel, destinationHash, parsed.consentAt, parsed.consentVersion, now, now, parsed.channel, parsed.contact),
    ...parsed.communitySlugs.flatMap(community => parsed.selectedFrequencies.map(frequency => database.prepare(`INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at)
      SELECT id, ?, ?, ?, ? FROM notification_contacts WHERE channel = ? AND destination = ? AND management_token_digest = ?`).bind(community, frequency, now, now, parsed.channel, parsed.contact, tokenDigest))),
    database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at)
      SELECT ?, id, ?, ?, ?, CASE WHEN state = 'pending-reactivation' THEN ? ELSE ? END, CASE WHEN state = 'pending-reactivation' THEN ? ELSE ? END,
      CASE WHEN state = 'pending-reactivation' THEN 'reactivation' ELSE 'first-activation' END, ?, ?
      FROM notification_contacts WHERE channel = ? AND destination = ? AND management_token_digest = ?`)
      .bind(opaqueId(cryptoApi), 1, 1, 'pending', reactivation.ciphertext, firstActivation.ciphertext, reactivation.iv, firstActivation.iv, now, now, parsed.channel, parsed.contact, tokenDigest),
  ])
  if (changed(results, 0) !== 1) throw new NotificationLifecycleError('Notification activation is unavailable', 409)
  const activated = await database.prepare('SELECT state FROM notification_contacts WHERE channel = ? AND destination = ? AND management_token_digest = ?').bind(parsed.channel, parsed.contact, tokenDigest).first<{ state: ContactRow['state'] }>()
  if (!activated) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  if (parsed.channel === 'web-push' && activated.state === 'active') dependencies.onWebPushActivated?.(token)
  return { state: activated.state === 'pending-reactivation' ? 'pending-reactivation' : 'active' }
}

/** Validates the public recovery payload before its shared abuse policy can reach subscriber state. */
export const validateNotificationManagementRequest = (input: unknown, now = new Date()) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NotificationLifecycleError('Invalid notification recovery')
  const request = input as Partial<NotificationManagementRequestInput>
  if (!channels.has(request.channel as NotificationChannel)) throw new NotificationLifecycleError('Invalid notification recovery')
  const channel = request.channel as NotificationChannel
  return { channel, contact: normalizeNotificationContact(channel, request.contact, now) }
}

/** Rotates an eligible contact's digest and capability generation with one encrypted recovery outbox row. */
export const requestNotificationManagementRecovery = async (input: unknown, dependencies: NotificationDependencies) => {
  const parsed = validateNotificationManagementRequest(input, dependencies.now?.() ?? new Date())
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  if (parsed.channel === 'web-push') {
    try { await validateWebPushSubscriptionPoint(JSON.parse(parsed.contact), cryptoApi.subtle) }
    catch { throw new NotificationLifecycleError('Invalid notification recovery') }
  }
  // Keep the current management capability usable while its replacement cannot
  // be delivered. The HTTP boundary still returns its non-enumerating response.
  if (!isNotificationChannelReady(parsed.channel, dependencies.config) || !await notificationSchemaReady(dependencies.database)) return
  const existing = await dependencies.database.prepare('SELECT id, channel, destination, destination_hash, management_token_digest, state, capability_generation FROM notification_contacts WHERE channel = ? AND destination = ?')
    .bind(parsed.channel, parsed.contact).first<ContactRow>()
  if (!existing || (existing.state !== 'active' && existing.state !== 'pending-reactivation')) return
  const token = toBase64Url(cryptoApi.randomBytes(32))
  const tokenDigest = await digest(token, cryptoApi)
  const now = nowIso(dependencies)
  const rotating = { ...existing, management_token_digest: tokenDigest, capability_generation: existing.capability_generation + 1 }
  const previous = contactAuthority(existing, existing.state)
  const current = contactAuthority(rotating, rotating.state)
  await dependencies.database.batch([
    dependencies.database.prepare(`UPDATE notification_contacts SET management_token_digest = ?, capability_generation = ?, updated_at = ? WHERE ${previous.clause}`).bind(tokenDigest, rotating.capability_generation, now, ...previous.values),
    dependencies.database.prepare(`UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?, ?) AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${current.clause})`).bind('invalidated', now, now, existing.id, 'pending', 'queued', 'claimed', ...current.values),
    await outboxStatement(rotating, token, 'management-recovery', dependencies, now),
  ])
}

const findContact = async (token: unknown, dependencies: NotificationDependencies) => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null
  const tokenDigest = await digest(token, dependencies.crypto ?? defaultCrypto())
  const primary = await dependencies.database.prepare('SELECT id, channel, destination, destination_hash, management_token_digest, state, capability_generation FROM notification_contacts WHERE management_token_digest = ?').bind(tokenDigest).first<ContactRow>()
  if (primary) return primary
  // Event mail capabilities are digest-only aliases. Their expected generation must
  // still match the current contact, so recovery, stop, and reactivation invalidate
  // old links without adding a second management mutation path.
  return dependencies.database.prepare('SELECT c.id, c.channel, c.destination, c.destination_hash, c.management_token_digest, c.state, c.capability_generation FROM notification_management_capabilities a JOIN notification_contacts c ON c.id = a.contact_id AND c.capability_generation = a.expected_capability_generation WHERE a.token_digest = ? AND (a.expires_at IS NULL OR a.expires_at > ?)').bind(tokenDigest, nowIso(dependencies)).first<ContactRow>()
}
const communitiesFor = async (contactId: number, dependencies: NotificationDependencies) => {
  const { results } = await dependencies.database.prepare('SELECT community_slug, frequency FROM notification_subscriptions WHERE contact_id = ? ORDER BY community_slug, frequency').bind(contactId).all<SubscriptionRow>()
  const grouped = new Map<string, NotificationFrequency[]>()
  for (const row of results) grouped.set(row.community_slug, [...(grouped.get(row.community_slug) ?? []), row.frequency])
  return [...grouped].map(([slug, selected]) => ({ slug, title: dependencies.config.communityTitles?.[slug] ?? slug, frequencies: selected }))
}
export const readNotificationManagement = async (token: unknown, dependencies: NotificationDependencies): Promise<NotificationManagementResult> => {
  const contact = await findContact(token, dependencies)
  if (!contact) return unavailable
  const communities = await communitiesFor(contact.id, dependencies)
  if (contact.channel !== 'web-push') return { state: contact.state, channel: contact.channel, maskedContact: maskContact(contact.channel, contact.destination), communities }
  const message = await dependencies.database.prepare(`SELECT status FROM notification_outbox WHERE contact_id = ? AND expected_capability_generation = ? AND kind IN ('first-activation', 'reactivation', 'management-recovery') ORDER BY created_at DESC, id DESC LIMIT 1`)
    .bind(contact.id, contact.capability_generation).first<{ status: string }>()
  const confirmation = !message ? 'unknown' : message.status === 'consumed' ? 'submitted' : message.status === 'invalidated' ? 'unavailable' : 'pending'
  return { state: contact.state, channel: contact.channel, maskedContact: maskContact(contact.channel, contact.destination), communities, confirmation }
}
const parseManagement = (community: unknown, selected: unknown, config: NotificationLifecycleConfig) => {
  if (typeof community !== 'string' || !config.communitySlugs.includes(community) || !Array.isArray(selected)) throw new NotificationLifecycleError('Invalid notification management action')
  const frequenciesInput = [...new Set(selected)]
  if (!frequenciesInput.length || !frequenciesInput.every(value => typeof value === 'string' && frequencies.has(value as NotificationFrequency))) throw new NotificationLifecycleError('Invalid notification management action')
  return { community, frequencies: frequenciesInput as NotificationFrequency[] }
}
const contactAuthority = (contact: ContactRow, state: ContactRow['state']) => ({
  clause: 'id = ? AND management_token_digest = ? AND capability_generation = ? AND state = ?',
  values: [contact.id, contact.management_token_digest, contact.capability_generation, state] as const,
})
const authorizedSubscriptionReplacement = (contact: ContactRow, community: string, selectedFrequencies: NotificationFrequency[], database: NotificationDatabase, now: string) => {
  const authority = contactAuthority(contact, contact.state)
  return [
    database.prepare(`DELETE FROM notification_subscriptions WHERE contact_id = ? AND community_slug = ? AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, community, ...authority.values),
    ...selectedFrequencies.map(frequency => database.prepare(`INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, community, frequency, now, now, ...authority.values)),
  ]
}
export const updateNotificationFrequencies = async (token: unknown, community: unknown, selected: unknown, dependencies: NotificationDependencies): Promise<NotificationManagementMutationResult> => {
  const input = parseManagement(community, selected, dependencies.config)
  const contact = await findContact(token, dependencies)
  if (!contact || contact.state !== 'active') return unavailableMutation
  const authority = contactAuthority(contact, contact.state)
  const results = await dependencies.database.batch([
    dependencies.database.prepare(`UPDATE notification_contacts SET updated_at = updated_at WHERE ${authority.clause}`).bind(...authority.values),
    ...authorizedSubscriptionReplacement(contact, input.community, input.frequencies, dependencies.database, nowIso(dependencies)),
  ])
  if (changed(results, 0) !== 1) return unavailableMutation
  const management = await readNotificationManagement(token, dependencies)
  return management.state === 'unavailable' ? unavailableMutation : { outcome: 'saved', management }
}
export const stopNotificationChannel = async (token: unknown, dependencies: NotificationDependencies): Promise<NotificationManagementMutationResult> => {
  const contact = await findContact(token, dependencies)
  if (!contact) return unavailableMutation
  const now = nowIso(dependencies)
  const authority = contactAuthority(contact, contact.state)
  const results = await dependencies.database.batch([
    dependencies.database.prepare(`UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?, ?) AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind('invalidated', now, now, contact.id, 'pending', 'queued', 'claimed', ...authority.values),
    dependencies.database.prepare(`INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT channel, destination_hash, ?, ? FROM notification_contacts WHERE ${authority.clause} ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at`).bind('user-stop', now, ...authority.values),
    dependencies.database.prepare(`DELETE FROM notification_subscriptions WHERE contact_id = ? AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, ...authority.values),
    dependencies.database.prepare(`DELETE FROM notification_contacts WHERE ${authority.clause}`).bind(...authority.values),
  ])
  return changed(results, 3) === 1 ? { outcome: 'stopped' } : unavailableMutation
}
export const removeNotificationCommunity = async (token: unknown, community: unknown, dependencies: NotificationDependencies) => {
  if (typeof community !== 'string' || !dependencies.config.communitySlugs.includes(community)) throw new NotificationLifecycleError('Invalid notification management action')
  const contact = await findContact(token, dependencies)
  if (!contact || contact.state !== 'active') return unavailableMutation
  const now = nowIso(dependencies)
  const authority = contactAuthority(contact, 'active')
  const results = await dependencies.database.batch([
    dependencies.database.prepare(`DELETE FROM notification_subscriptions WHERE contact_id = ? AND community_slug = ? AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, community, ...authority.values),
    dependencies.database.prepare(`UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?, ?) AND NOT EXISTS (SELECT 1 FROM notification_subscriptions WHERE contact_id = ?) AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind('invalidated', now, now, contact.id, 'pending', 'queued', 'claimed', contact.id, ...authority.values),
    dependencies.database.prepare(`INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT channel, destination_hash, ?, ? FROM notification_contacts WHERE ${authority.clause} AND NOT EXISTS (SELECT 1 FROM notification_subscriptions WHERE contact_id = ?) ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at`).bind('user-stop', now, ...authority.values, contact.id),
    dependencies.database.prepare(`DELETE FROM notification_contacts WHERE ${authority.clause} AND NOT EXISTS (SELECT 1 FROM notification_subscriptions WHERE contact_id = ?)`).bind(...authority.values, contact.id),
  ])
  if (changed(results, 3) === 1) return { outcome: 'stopped' } as const
  if (changed(results, 0) < 1) return unavailableMutation
  const management = await readNotificationManagement(token, dependencies)
  return management.state === 'unavailable' ? unavailableMutation : { outcome: 'removed', management }
}
export const confirmNotificationReactivation = async (token: unknown, dependencies: NotificationDependencies): Promise<NotificationManagementMutationResult> => {
  const contact = await findContact(token, dependencies)
  if (!contact || contact.state !== 'pending-reactivation') return unavailableMutation
  const suppression = await dependencies.database.prepare("SELECT id FROM notification_suppressions WHERE channel = ? AND destination_hash = ? AND reason = 'user-stop'").bind(contact.channel, contact.destination_hash).first<{ id: number }>()
  if (!suppression) return unavailableMutation
  const now = nowIso(dependencies)
  const authority = contactAuthority(contact, 'pending-reactivation')
  const results = await dependencies.database.batch([
    dependencies.database.prepare(`UPDATE notification_contacts SET state = ?, updated_at = ? WHERE ${authority.clause} AND EXISTS (SELECT 1 FROM notification_suppressions WHERE channel = ? AND destination_hash = ? AND reason = 'user-stop')`).bind('active', now, ...authority.values, contact.channel, contact.destination_hash),
    dependencies.database.prepare(`DELETE FROM notification_suppressions WHERE channel = ? AND destination_hash = ? AND reason = 'user-stop' AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${contactAuthority({ ...contact, state: 'active' }, 'active').clause})`).bind(contact.channel, contact.destination_hash, ...contactAuthority({ ...contact, state: 'active' }, 'active').values),
  ])
  if (changed(results, 0) !== 1) return unavailableMutation
  const management = await readNotificationManagement(token, dependencies)
  return management.state === 'unavailable' ? unavailableMutation : { outcome: 'reactivated', management }
}
