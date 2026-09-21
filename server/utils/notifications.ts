export type NotificationChannel = 'email' | 'sms' | 'web-push'
export type NotificationFrequency = 'created' | 'week-before' | 'day-before'

export interface ActivationInput { channel: NotificationChannel, contact: string, communitySlugs: string[], frequencies: NotificationFrequency[], consentAt: string, consentVersion: string }
export interface ActivationResult { state: 'active' | 'updated' | 'pending-reactivation' }
export interface NotificationManagementRequestInput { channel: NotificationChannel, contact: string }
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
  suppressionHashKeys: Record<string, CryptoKey>
  currentSuppressionHashKeyVersion: string
  abuseHashKeys: Record<string, CryptoKey>
  currentAbuseHashKeyVersion: string
  turnstile: { secret: string, expectedHostname: string }
  outboxTransportKeys: Record<string, CryptoKey>
  currentOutboxTransportKeyVersion: string
  consentVersion: string
  emailSmsEnabled: boolean
  emailSmsFirstMessageReady: boolean
  emailSmsEventDeliveryReady: boolean
  /** Complete, private, deployment-bound authority for external event email. */
  emailDeliveryReady: boolean
  brevoApiKey?: string
  brevoSenderName?: string
  brevoCallbackSecret?: string
  webPushEnabled: boolean
  webPushFirstMessageReady: boolean
  webPushEventDeliveryReady: boolean
}
export interface NotificationDependencies { database: NotificationDatabase, config: NotificationLifecycleConfig, now?: () => Date, crypto?: NotificationCrypto }

interface ContactRow { id: number, channel: NotificationChannel, destination: string, destination_hash: string, destination_hash_key_version: string, management_token_digest: string, state: 'active' | 'pending-reactivation', capability_generation: number }
interface SubscriptionRow { community_slug: string, frequency: NotificationFrequency }
interface TransportKeyVersionRow { transport_key_version: unknown }
interface SuppressionKeyVersionRow { destination_hash_key_version: unknown }
interface SuppressionRow { id: number, destination_hash: string, destination_hash_key_version: string }
export interface NotificationManagementCommunity { slug: string, title: string, frequencies: NotificationFrequency[] }
export type NotificationManagementResult = { state: 'active' | 'pending-reactivation', channel: NotificationChannel, maskedContact: string, communities: NotificationManagementCommunity[] } | { state: 'unavailable' }
export interface DeliveryEligibilityInput { channel: NotificationChannel, contactFingerprint: string, communitySlug: string, frequency: NotificationFrequency, now: Date }

const encoder = new TextEncoder()
const channels = new Set<NotificationChannel>(['email', 'sms', 'web-push'])
const frequencies = new Set<NotificationFrequency>(['created', 'week-before', 'day-before'])
const controlPattern = /[\u0000-\u001F\u007F]/
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const defaultCrypto = (): NotificationCrypto => ({ randomBytes: length => crypto.getRandomValues(new Uint8Array(length)), subtle: crypto.subtle })
const asBufferSource = (value: Uint8Array) => value as unknown as BufferSource
const nowIso = (dependencies: NotificationDependencies) => (dependencies.now?.() ?? new Date()).toISOString()
const unavailable: NotificationManagementResult = { state: 'unavailable' }

export const normalizeNotificationContact = (channel: NotificationChannel, value: unknown) => {
  if (typeof value !== 'string') throw new NotificationLifecycleError('Invalid notification activation')
  const contact = value.trim()
  if (!contact || controlPattern.test(contact)) throw new NotificationLifecycleError('Invalid notification activation')
  if (channel === 'email') {
    const [local, domain, extra] = contact.split('@')
    if (!local || !domain || extra || /\s/.test(contact) || domain.startsWith('.') || domain.endsWith('.')) throw new NotificationLifecycleError('Invalid notification activation')
    return `${local}@${domain.toLowerCase()}`
  }
  if (channel === 'sms' && /^\+[1-9]\d{7,14}$/.test(contact)) return contact
  if (channel === 'web-push' && contact.length <= 4_096) return contact
  throw new NotificationLifecycleError('Invalid notification activation')
}

const isEnabled = (channel: NotificationChannel, config: NotificationLifecycleConfig) => channel === 'web-push'
  ? config.webPushEnabled && config.webPushFirstMessageReady && config.webPushEventDeliveryReady
  : config.emailSmsEnabled && config.emailSmsFirstMessageReady && config.emailSmsEventDeliveryReady
const keyedHash = async (value: string, key: CryptoKey, cryptoApi: NotificationCrypto) => toBase64Url(new Uint8Array(await cryptoApi.subtle.sign('HMAC', key, encoder.encode(value))))
const digest = async (value: string, cryptoApi: NotificationCrypto) => toBase64Url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(value))))
const encrypt = async (value: string, key: CryptoKey, cryptoApi: NotificationCrypto) => {
  const iv = cryptoApi.randomBytes(12)
  const payload = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(iv) }, key, encoder.encode(value))
  return { ciphertext: toBase64Url(new Uint8Array(payload)), iv: toBase64Url(iv) }
}
const opaqueId = (cryptoApi: NotificationCrypto) => toBase64Url(cryptoApi.randomBytes(24))
const maskContact = (channel: NotificationChannel, contact: string) => channel === 'email' ? `${contact.slice(0, 1)}•••@${contact.split('@')[1]}` : channel === 'sms' ? `${contact.slice(0, 4)} ••• ••• •••` : 'Prohlížečové upozornění'

export const validateNotificationActivation = (input: unknown, config: NotificationLifecycleConfig) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NotificationLifecycleError('Invalid notification activation')
  const activation = input as Partial<ActivationInput>
  if (!channels.has(activation.channel as NotificationChannel) || activation.consentVersion !== config.consentVersion || typeof activation.consentAt !== 'string' || Number.isNaN(Date.parse(activation.consentAt)) || !Array.isArray(activation.communitySlugs) || !Array.isArray(activation.frequencies)) throw new NotificationLifecycleError('Invalid notification activation')
  const channel = activation.channel as NotificationChannel
  const communitySlugs = [...new Set(activation.communitySlugs)].sort()
  const selectedFrequencies = [...new Set(activation.frequencies)].sort()
  if (!communitySlugs.length || !selectedFrequencies.length || !communitySlugs.every(slug => config.communitySlugs.includes(slug)) || !selectedFrequencies.every(frequency => frequencies.has(frequency))) throw new NotificationLifecycleError('Invalid notification activation')
  return { channel, contact: normalizeNotificationContact(channel, activation.contact), communitySlugs, selectedFrequencies, consentAt: activation.consentAt, consentVersion: activation.consentVersion }
}
const transportKey = (config: NotificationLifecycleConfig) => {
  const key = config.outboxTransportKeys[config.currentOutboxTransportKeyVersion]
  if (!key) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  return key
}
/** Returns server-only retention evidence for encrypted nonterminal outbox payloads. */
export const getReferencedOutboxTransportKeyVersions = async (database: NotificationDatabase) => {
  const { results } = await database.prepare('SELECT DISTINCT transport_key_version FROM notification_outbox WHERE status IN (?, ?, ?) AND payload_ciphertext IS NOT NULL AND payload_iv IS NOT NULL')
    .bind('pending', 'queued', 'claimed').all<TransportKeyVersionRow>()
  if (!results.every(row => typeof row.transport_key_version === 'string' && row.transport_key_version)) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  return [...new Set(results.map(row => row.transport_key_version as string))].sort()
}
export const assertOutboxTransportKeyRetention = async (dependencies: Pick<NotificationDependencies, 'database' | 'config'>) => {
  transportKey(dependencies.config)
  const referencedVersions = await getReferencedOutboxTransportKeyVersions(dependencies.database)
  if (!referencedVersions.every(version => dependencies.config.outboxTransportKeys[version])) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  return referencedVersions
}
/** Retired suppression HMAC keys remain mandatory while any contact or suppression retains their hash. */
export const getReferencedSuppressionHashKeyVersions = async (database: NotificationDatabase) => {
  const { results } = await database.prepare('SELECT destination_hash_key_version FROM notification_contacts UNION SELECT destination_hash_key_version FROM notification_suppressions')
    .all<SuppressionKeyVersionRow>()
  if (!results.every(row => typeof row.destination_hash_key_version === 'string' && row.destination_hash_key_version)) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  return [...new Set(results.map(row => row.destination_hash_key_version as string))].sort()
}
export const assertSuppressionHashKeyRetention = async (dependencies: Pick<NotificationDependencies, 'database' | 'config'>) => {
  if (!dependencies.config.suppressionHashKeys[dependencies.config.currentSuppressionHashKeyVersion]) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  const referencedVersions = await getReferencedSuppressionHashKeyVersions(dependencies.database)
  if (!referencedVersions.every(version => dependencies.config.suppressionHashKeys[version])) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  return referencedVersions
}
const outboxStatement = async (contact: Pick<ContactRow, 'id' | 'capability_generation' | 'destination'>, token: string, kind: 'first-activation' | 'reactivation' | 'management-recovery', dependencies: NotificationDependencies, now: string) => {
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  const encrypted = await encrypt(JSON.stringify({ destination: contact.destination, capability: token, kind }), transportKey(dependencies.config), cryptoApi)
  return dependencies.database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, transport_key_version, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(opaqueId(cryptoApi), contact.id, 1, contact.capability_generation, 'pending', encrypted.ciphertext, encrypted.iv, dependencies.config.currentOutboxTransportKeyVersion, kind, now, now)
}
const replaceSubmittedSubscriptions = (contactId: number, communities: string[], selectedFrequencies: NotificationFrequency[], database: NotificationDatabase, now: string) => [
  ...communities.map(community => database.prepare('DELETE FROM notification_subscriptions WHERE contact_id = ? AND community_slug = ?').bind(contactId, community)),
  ...communities.flatMap(community => selectedFrequencies.map(frequency => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(contactId, community, frequency, now, now))),
]

export const activateNotificationChannel = async (input: unknown, dependencies: NotificationDependencies): Promise<ActivationResult> => {
  const { config, database } = dependencies
  const parsed = validateNotificationActivation(input, config)
  if (!isEnabled(parsed.channel, config)) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  await assertOutboxTransportKeyRetention(dependencies)
  await assertSuppressionHashKeyRetention(dependencies)
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  const destinationHashes = await Promise.all(Object.entries(config.suppressionHashKeys).map(async ([version, key]) => ({ version, hash: await keyedHash(parsed.contact, key, cryptoApi) })))
  const currentDestinationHash = destinationHashes.find(entry => entry.version === config.currentSuppressionHashKeyVersion)?.hash
  if (!currentDestinationHash) throw new NotificationLifecycleError('Notification activation is unavailable', 503)
  const now = nowIso(dependencies)
  const suppressionWhere = destinationHashes.map(() => '(destination_hash = ? AND destination_hash_key_version = ?)').join(' OR ')
  const suppression = await database.prepare(`SELECT id, destination_hash, destination_hash_key_version FROM notification_suppressions WHERE channel = ? AND (${suppressionWhere})`).bind(parsed.channel, ...destinationHashes.flatMap(entry => [entry.hash, entry.version])).first<SuppressionRow>()
  const existing = await database.prepare('SELECT id, channel, destination, destination_hash, destination_hash_key_version, management_token_digest, state, capability_generation FROM notification_contacts WHERE channel = ? AND destination = ?').bind(parsed.channel, parsed.contact).first<ContactRow>()
  if (existing && !suppression) {
    await database.batch(replaceSubmittedSubscriptions(existing.id, parsed.communitySlugs, parsed.selectedFrequencies, database, now))
    return { state: existing.state === 'active' ? 'updated' : 'pending-reactivation' }
  }
  const token = toBase64Url(cryptoApi.randomBytes(32))
  const tokenDigest = await digest(token, cryptoApi)
  if (existing) {
    const generation = existing.capability_generation + 1
    const rotating = { ...existing, capability_generation: generation }
    await database.batch([
      database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, transport_key_version = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?)').bind('invalidated', now, now, existing.id, 'pending', 'claimed'),
      database.prepare('UPDATE notification_contacts SET management_token_digest = ?, capability_generation = ?, state = ?, consent_at = ?, consent_version = ?, updated_at = ? WHERE id = ?').bind(tokenDigest, generation, 'pending-reactivation', parsed.consentAt, parsed.consentVersion, now, existing.id),
      ...replaceSubmittedSubscriptions(existing.id, parsed.communitySlugs, parsed.selectedFrequencies, database, now),
      await outboxStatement(rotating, token, 'reactivation', dependencies, now),
    ])
    return { state: 'pending-reactivation' }
  }
  const kind = suppression ? 'reactivation' : 'first-activation'
  const encrypted = await encrypt(JSON.stringify({ destination: parsed.contact, capability: token, kind }), transportKey(config), cryptoApi)
  await database.batch([
    database.prepare('INSERT INTO notification_contacts (channel, destination, destination_hash, destination_hash_key_version, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(parsed.channel, parsed.contact, suppression?.destination_hash ?? currentDestinationHash, suppression?.destination_hash_key_version ?? config.currentSuppressionHashKeyVersion, tokenDigest, 1, suppression ? 'pending-reactivation' : 'active', parsed.consentAt, parsed.consentVersion, now, now),
    ...parsed.communitySlugs.flatMap(community => parsed.selectedFrequencies.map(frequency => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) SELECT id, ?, ?, ?, ? FROM notification_contacts WHERE channel = ? AND destination = ?').bind(community, frequency, now, now, parsed.channel, parsed.contact))),
    database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, transport_key_version, kind, created_at, updated_at) SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM notification_contacts WHERE channel = ? AND destination = ?').bind(opaqueId(cryptoApi), 1, 1, 'pending', encrypted.ciphertext, encrypted.iv, config.currentOutboxTransportKeyVersion, kind, now, now, parsed.channel, parsed.contact),
  ])
  return { state: suppression ? 'pending-reactivation' : 'active' }
}

/** Validates the public recovery payload before its shared abuse policy can reach subscriber state. */
export const validateNotificationManagementRequest = (input: unknown): NotificationManagementRequestInput => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NotificationLifecycleError('Invalid notification recovery')
  const request = input as Partial<NotificationManagementRequestInput>
  if (!channels.has(request.channel as NotificationChannel)) throw new NotificationLifecycleError('Invalid notification recovery')
  const channel = request.channel as NotificationChannel
  return { channel, contact: normalizeNotificationContact(channel, request.contact) }
}

/** Rotates an eligible contact's digest and capability generation with one encrypted recovery outbox row. */
export const requestNotificationManagementRecovery = async (input: NotificationManagementRequestInput, dependencies: NotificationDependencies) => {
  await assertOutboxTransportKeyRetention(dependencies)
  const existing = await dependencies.database.prepare('SELECT id, channel, destination, destination_hash, destination_hash_key_version, management_token_digest, state, capability_generation FROM notification_contacts WHERE channel = ? AND destination = ?')
    .bind(input.channel, input.contact).first<ContactRow>()
  if (!existing || (existing.state !== 'active' && existing.state !== 'pending-reactivation')) return
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  const token = toBase64Url(cryptoApi.randomBytes(32))
  const tokenDigest = await digest(token, cryptoApi)
  const now = nowIso(dependencies)
  const rotating = { ...existing, capability_generation: existing.capability_generation + 1 }
  await dependencies.database.batch([
    dependencies.database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, transport_key_version = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?, ?)').bind('invalidated', now, now, existing.id, 'pending', 'queued', 'claimed'),
    dependencies.database.prepare('UPDATE notification_contacts SET management_token_digest = ?, capability_generation = ?, updated_at = ? WHERE id = ?').bind(tokenDigest, rotating.capability_generation, now, existing.id),
    await outboxStatement(rotating, token, 'management-recovery', dependencies, now),
  ])
}

const findContact = async (token: unknown, dependencies: NotificationDependencies) => {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null
  const tokenDigest = await digest(token, dependencies.crypto ?? defaultCrypto())
  const primary = await dependencies.database.prepare('SELECT id, channel, destination, destination_hash, destination_hash_key_version, management_token_digest, state, capability_generation FROM notification_contacts WHERE management_token_digest = ?').bind(tokenDigest).first<ContactRow>()
  if (primary) return primary
  // Event mail capabilities are digest-only aliases. Their expected generation must
  // still match the current contact, so recovery, stop, and reactivation invalidate
  // old links without adding a second management mutation path.
  return dependencies.database.prepare('SELECT c.id, c.channel, c.destination, c.destination_hash, c.destination_hash_key_version, c.management_token_digest, c.state, c.capability_generation FROM notification_management_capabilities a JOIN notification_contacts c ON c.id = a.contact_id AND c.capability_generation = a.expected_capability_generation WHERE a.token_digest = ? AND (a.expires_at IS NULL OR a.expires_at > ?)').bind(tokenDigest, nowIso(dependencies)).first<ContactRow>()
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
  return { state: contact.state, channel: contact.channel, maskedContact: maskContact(contact.channel, contact.destination), communities: await communitiesFor(contact.id, dependencies) }
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
  const authority = contactAuthority(contact, 'active')
  return [
    database.prepare(`DELETE FROM notification_subscriptions WHERE contact_id = ? AND community_slug = ? AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, community, ...authority.values),
    ...selectedFrequencies.map(frequency => database.prepare(`INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, community, frequency, now, now, ...authority.values)),
  ]
}
export const updateNotificationFrequencies = async (token: unknown, community: unknown, selected: unknown, dependencies: NotificationDependencies) => {
  const input = parseManagement(community, selected, dependencies.config)
  const contact = await findContact(token, dependencies)
  if (!contact || contact.state !== 'active') return unavailable
  await dependencies.database.batch(authorizedSubscriptionReplacement(contact, input.community, input.frequencies, dependencies.database, nowIso(dependencies)))
  return readNotificationManagement(token, dependencies)
}
export const stopNotificationChannel = async (token: unknown, dependencies: NotificationDependencies): Promise<NotificationManagementResult> => {
  const contact = await findContact(token, dependencies)
  if (!contact) return unavailable
  const now = nowIso(dependencies)
  const authority = contactAuthority(contact, contact.state)
  await dependencies.database.batch([
    dependencies.database.prepare(`UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, transport_key_version = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?, ?) AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind('invalidated', now, now, contact.id, 'pending', 'queued', 'claimed', ...authority.values),
    dependencies.database.prepare(`INSERT INTO notification_suppressions (channel, destination_hash, destination_hash_key_version, reason, suppressed_at) SELECT channel, destination_hash, destination_hash_key_version, ?, ? FROM notification_contacts WHERE ${authority.clause} ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at`).bind('user-stop', now, ...authority.values),
    dependencies.database.prepare(`DELETE FROM notification_subscriptions WHERE contact_id = ? AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, ...authority.values),
    dependencies.database.prepare(`DELETE FROM notification_contacts WHERE ${authority.clause}`).bind(...authority.values),
  ])
  return unavailable
}
export const removeNotificationCommunity = async (token: unknown, community: unknown, dependencies: NotificationDependencies) => {
  if (typeof community !== 'string' || !dependencies.config.communitySlugs.includes(community)) throw new NotificationLifecycleError('Invalid notification management action')
  const contact = await findContact(token, dependencies)
  if (!contact || contact.state !== 'active') return unavailable
  const now = nowIso(dependencies)
  const authority = contactAuthority(contact, 'active')
  await dependencies.database.batch([
    dependencies.database.prepare(`DELETE FROM notification_subscriptions WHERE contact_id = ? AND community_slug = ? AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind(contact.id, community, ...authority.values),
    dependencies.database.prepare(`UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, transport_key_version = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND status IN (?, ?, ?) AND NOT EXISTS (SELECT 1 FROM notification_subscriptions WHERE contact_id = ?) AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${authority.clause})`).bind('invalidated', now, now, contact.id, 'pending', 'queued', 'claimed', contact.id, ...authority.values),
    dependencies.database.prepare(`INSERT INTO notification_suppressions (channel, destination_hash, destination_hash_key_version, reason, suppressed_at) SELECT channel, destination_hash, destination_hash_key_version, ?, ? FROM notification_contacts WHERE ${authority.clause} AND NOT EXISTS (SELECT 1 FROM notification_subscriptions WHERE contact_id = ?) ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at`).bind('user-stop', now, ...authority.values, contact.id),
    dependencies.database.prepare(`DELETE FROM notification_contacts WHERE ${authority.clause} AND NOT EXISTS (SELECT 1 FROM notification_subscriptions WHERE contact_id = ?)`).bind(...authority.values, contact.id),
  ])
  return readNotificationManagement(token, dependencies)
}
export const confirmNotificationReactivation = async (token: unknown, dependencies: NotificationDependencies): Promise<NotificationManagementResult> => {
  const contact = await findContact(token, dependencies)
  if (!contact || contact.state !== 'pending-reactivation') return unavailable
  const suppression = await dependencies.database.prepare('SELECT id FROM notification_suppressions WHERE channel = ? AND destination_hash = ? AND destination_hash_key_version = ?').bind(contact.channel, contact.destination_hash, contact.destination_hash_key_version).first<{ id: number }>()
  if (!suppression) return unavailable
  const now = nowIso(dependencies)
  const authority = contactAuthority(contact, 'pending-reactivation')
  await dependencies.database.batch([
    dependencies.database.prepare(`UPDATE notification_contacts SET state = ?, updated_at = ? WHERE ${authority.clause}`).bind('active', now, ...authority.values),
    dependencies.database.prepare(`DELETE FROM notification_suppressions WHERE channel = ? AND destination_hash = ? AND destination_hash_key_version = ? AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${contactAuthority({ ...contact, state: 'active' }, 'active').clause})`).bind(contact.channel, contact.destination_hash, contact.destination_hash_key_version, ...contactAuthority({ ...contact, state: 'active' }, 'active').values),
  ])
  return readNotificationManagement(token, dependencies)
}
export const isDeliveryEligible = async ({ channel, contactFingerprint, communitySlug, frequency }: DeliveryEligibilityInput, dependencies: NotificationDependencies) => {
  if (!channels.has(channel) || !frequencies.has(frequency) || !dependencies.config.communitySlugs.includes(communitySlug) || !isEnabled(channel, dependencies.config)) return false
  try {
    await assertOutboxTransportKeyRetention(dependencies)
    await assertSuppressionHashKeyRetention(dependencies)
  } catch {
    return false
  }
  const contact = await dependencies.database.prepare('SELECT id, destination_hash_key_version FROM notification_contacts WHERE channel = ? AND destination_hash = ? AND state = ?').bind(channel, contactFingerprint, 'active').first<{ id: number, destination_hash_key_version: string }>()
  if (!contact) return false
  if (await dependencies.database.prepare('SELECT id FROM notification_suppressions WHERE channel = ? AND destination_hash = ? AND destination_hash_key_version = ?').bind(channel, contactFingerprint, contact.destination_hash_key_version).first<{ id: number }>()) return false
  return Boolean(await dependencies.database.prepare('SELECT id FROM notification_subscriptions WHERE contact_id = ? AND community_slug = ? AND frequency = ?').bind(contact.id, communitySlug, frequency).first<{ id: number }>())
}
export const isNotificationDeliveryEligible = async (channel: NotificationChannel, contactFingerprint: string, communitySlug: string, frequency: NotificationFrequency, dependencies: NotificationDependencies) => isDeliveryEligible({ channel, contactFingerprint, communitySlug, frequency, now: dependencies.now?.() ?? new Date() }, dependencies)
