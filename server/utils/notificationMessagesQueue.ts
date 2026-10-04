import type { NotificationCrypto, NotificationDatabase, NotificationLifecycleConfig } from './notifications.ts'
import type { BrevoAttemptResult } from './brevoEmail.ts'
import type { BrevoSmsAttemptResult } from './brevoSms.ts'
import type { WebPushAttemptResult } from './webPush.ts'

export const notificationMessagesQueueName = 'notification-messages'

export interface NotificationOutboxPointer {
  outboxId: string
  version: number
}

export interface NotificationMessagesQueue {
  send(message: NotificationOutboxPointer): Promise<unknown>
}

export interface NotificationQueueDependencies {
  database: NotificationDatabase
  config: NotificationLifecycleConfig
  crypto?: NotificationCrypto
  now?: () => Date
  barriers?: NotificationQueueBarriers
}

export interface NotificationQueueBarriers {
  afterPublished?: (pointer: NotificationOutboxPointer) => Promise<void>
  afterClaimedAndDecrypted?: (pointer: NotificationOutboxPointer) => Promise<void>
}

export interface LifecycleNotificationMessagePayload {
  destination: string
  capability: string
  kind: 'first-activation' | 'reactivation' | 'management-recovery'
}

export interface EventNotificationMessagePayload {
  destination: string
  capability: string
  deliveryId: string
  managementCapability: string
  event: { title: string, description?: string, location?: string, url?: string, start: string, end: string, uid: string, sequence: number, cancelled?: boolean }
  reason: 'created' | 'week-before' | 'day-before' | 'updated' | 'cancelled'
  kind: 'event-email' | 'event-sms'
}

export type NotificationMessagePayload = LifecycleNotificationMessagePayload | EventNotificationMessagePayload
export interface NotificationDeliveryAuthorization { expected_capability_generation: number, channel: 'email' | 'sms' | 'web-push' }
export type NotificationDeliveryHook = (payload: NotificationMessagePayload, authorization: NotificationDeliveryAuthorization, authorize: () => Promise<boolean>) => Promise<void | BrevoAttemptResult | BrevoSmsAttemptResult | WebPushAttemptResult>

interface PendingOutboxRow {
  id: unknown
  version: unknown
}

interface ClaimedOutboxRow {
  payload_ciphertext: unknown
  payload_iv: unknown
}

const allowedKinds = new Set<NotificationMessagePayload['kind']>(['first-activation', 'reactivation', 'management-recovery', 'event-email', 'event-sms'])
const retryableProviderStatuses = new Set(['rate-limited', 'provider-5xx', 'transport'])
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const leaseDurationMs = 5 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nowIso = (dependencies: NotificationQueueDependencies) => (dependencies.now?.() ?? new Date()).toISOString()
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const decodeBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0))
const asBufferSource = (value: Uint8Array) => value as unknown as BufferSource
const claimToken = (cryptoApi: NotificationCrypto) => base64Url(cryptoApi.randomBytes(24))
const defaultCrypto = (): NotificationCrypto => ({ randomBytes: length => crypto.getRandomValues(new Uint8Array(length)), subtle: crypto.subtle })

const changed = (result: unknown) => {
  if (!isRecord(result) || !isRecord(result.meta) || typeof result.meta.changes !== 'number') return 0
  return result.meta.changes
}

const parsePayload = (plaintext: string): NotificationMessagePayload => {
  let value: unknown
  try {
    value = JSON.parse(plaintext)
  } catch {
    throw new Error('Notification outbox payload is invalid')
  }
  if (!isRecord(value)
    || typeof value.destination !== 'string' || !value.destination || !allowedKinds.has(value.kind as NotificationMessagePayload['kind'])) {
    throw new Error('Notification outbox payload is invalid')
  }
  if (value.kind === 'event-email' || value.kind === 'event-sms') {
    if (Object.keys(value).length !== 6 || typeof value.deliveryId !== 'string' || !value.deliveryId || typeof value.managementCapability !== 'string' || !value.managementCapability || typeof value.reason !== 'string' || !['created', 'week-before', 'day-before', 'updated', 'cancelled'].includes(value.reason) || !isRecord(value.event) || typeof value.event.title !== 'string' || typeof value.event.start !== 'string' || typeof value.event.end !== 'string' || typeof value.event.uid !== 'string' || !Number.isSafeInteger(value.event.sequence)) throw new Error('Notification outbox payload is invalid')
    return value as unknown as EventNotificationMessagePayload
  }
  if (Object.keys(value).length !== 3 || typeof value.capability !== 'string' || !value.capability) throw new Error('Notification outbox payload is invalid')
  return value as unknown as NotificationMessagePayload
}

export const parseNotificationOutboxPointer = (value: unknown): NotificationOutboxPointer => {
  const version = isRecord(value) ? value.version : undefined
  if (!isRecord(value)
    || Object.keys(value).length !== 2
    || typeof value.outboxId !== 'string' || !value.outboxId
    || !Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error('Notification Queue pointer is invalid')
  }
  return { outboxId: value.outboxId, version: version as number }
}

/** Publishes durable work as inert pointers; Queue acceptance never deletes or authorizes D1 payloads. */
export const publishPendingNotificationPointers = async (queue: NotificationMessagesQueue, dependencies: NotificationQueueDependencies, limit = 25) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Notification Queue batch limit is invalid')
  const { results } = await dependencies.database.prepare('SELECT id, version FROM notification_outbox WHERE status = ? ORDER BY created_at, id LIMIT ?')
    .bind('pending', limit).all<PendingOutboxRow>()
  let published = 0
  for (const row of results) {
    const version = row.version
    if (typeof row.id !== 'string' || !row.id || !Number.isSafeInteger(version) || (version as number) < 1) throw new Error('Notification outbox pointer is invalid')
    const pointer: NotificationOutboxPointer = { outboxId: row.id, version: row.version as number }
    await queue.send(pointer)
    await dependencies.barriers?.afterPublished?.(pointer)
    await dependencies.database.prepare('UPDATE notification_outbox SET status = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?')
      .bind('queued', nowIso(dependencies), pointer.outboxId, pointer.version, 'pending').run()
    published += 1
  }
  return { published }
}

const releaseClaim = async (pointer: NotificationOutboxPointer, token: string, dependencies: NotificationQueueDependencies) => {
  await dependencies.database.prepare('UPDATE notification_outbox SET status = ?, claim_token = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ? AND version = ? AND status = ? AND claim_token = ?')
    .bind('queued', nowIso(dependencies), pointer.outboxId, pointer.version, 'claimed', token).run()
}

/** Records a terminal provider rejection without retaining the encrypted payload. */
const failClaim = async (pointer: NotificationOutboxPointer, token: string, authorization: NotificationDeliveryAuthorization, dependencies: NotificationQueueDependencies) => {
  const now = nowIso(dependencies)
  await dependencies.database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE id = ? AND version = ? AND status = ? AND claim_token = ? AND expected_capability_generation = ?')
    .bind('invalidated', now, now, pointer.outboxId, pointer.version, 'claimed', token, authorization.expected_capability_generation).run()
}

/** A 404/410 PushSubscription cannot recover; suppress and remove it with all pending work. */
const removeStaleWebPushContact = async (pointer: NotificationOutboxPointer, authorization: NotificationDeliveryAuthorization, dependencies: NotificationQueueDependencies) => {
  const now = nowIso(dependencies)
  await dependencies.database.batch([
    dependencies.database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = (SELECT contact_id FROM notification_outbox WHERE id = ? AND version = ? AND status = ?) AND expected_capability_generation = ? AND status IN (?, ?, ?)')
      .bind('invalidated', now, now, pointer.outboxId, pointer.version, 'claimed', authorization.expected_capability_generation, 'pending', 'queued', 'claimed'),
    dependencies.database.prepare('INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT channel, destination_hash, ?, ? FROM notification_contacts WHERE id = (SELECT contact_id FROM notification_outbox WHERE id = ? AND status = ?) AND channel = ? ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at')
      .bind('provider-opt-out', now, pointer.outboxId, 'invalidated', 'web-push'),
    dependencies.database.prepare('DELETE FROM notification_contacts WHERE id = (SELECT contact_id FROM notification_outbox WHERE id = ? AND status = ?) AND channel = ?')
      .bind(pointer.outboxId, 'invalidated', 'web-push'),
  ])
}

const isProviderAttempt = (result: Awaited<ReturnType<NotificationDeliveryHook>>): result is Exclude<Awaited<ReturnType<NotificationDeliveryHook>>, void> =>
  Boolean(result && typeof result === 'object' && 'attempted' in result)

/**
 * Claims, decrypts, then re-authorizes one pointer. Claims and plaintext are deliberately
 * non-authorizing: only the final D1 query immediately before `deliver` grants one call.
 */
export const consumeNotificationOutboxPointer = async (pointer: NotificationOutboxPointer, dependencies: NotificationQueueDependencies, deliver: NotificationDeliveryHook) => {
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  const now = dependencies.now?.() ?? new Date()
  const claimedUntil = new Date(now.getTime() + leaseDurationMs).toISOString()
  const token = claimToken(cryptoApi)
  const claim = await dependencies.database.prepare('UPDATE notification_outbox SET status = ?, claim_token = ?, claim_expires_at = ?, updated_at = ? WHERE id = ? AND version = ? AND (status IN (?, ?) OR (status = ? AND claim_expires_at <= ?))')
    .bind('claimed', token, claimedUntil, now.toISOString(), pointer.outboxId, pointer.version, 'pending', 'queued', 'claimed', now.toISOString()).run()
  if (changed(claim) !== 1) {
    const live = await dependencies.database.prepare('SELECT id FROM notification_outbox WHERE id = ? AND version = ? AND status = ? AND claim_expires_at > ?').bind(pointer.outboxId, pointer.version, 'claimed', nowIso(dependencies)).first()
    if (live) throw new Error('Notification outbox has a live claim')
    return { delivered: false, stale: true }
  }

  let payload: NotificationMessagePayload
  let authorization: NotificationDeliveryAuthorization | null
  let authorize!: () => Promise<boolean>
  let authorizationLost = false
  let authorizationError: unknown
  try {
    const row = await dependencies.database.prepare('SELECT payload_ciphertext, payload_iv FROM notification_outbox WHERE id = ? AND version = ? AND status = ? AND claim_token = ?')
      .bind(pointer.outboxId, pointer.version, 'claimed', token).first<ClaimedOutboxRow>()
    if (!row || typeof row.payload_ciphertext !== 'string' || typeof row.payload_iv !== 'string') throw new Error('Notification outbox payload is unavailable')
    const plaintext = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(decodeBase64Url(row.payload_iv)) }, dependencies.config.outboxTransportKey, asBufferSource(decodeBase64Url(row.payload_ciphertext)))
    payload = parsePayload(decoder.decode(plaintext))
    await dependencies.barriers?.afterClaimedAndDecrypted?.(pointer)
    const eventPayload = payload.kind === 'event-email' || payload.kind === 'event-sms' ? payload : null
    const capabilityDigest = eventPayload ? null : base64Url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(payload.capability))))
    const readAuthorization = () => dependencies.database.prepare(eventPayload
      ? 'SELECT o.expected_capability_generation, c.channel FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id AND c.state = ? AND c.capability_generation = o.expected_capability_generation JOIN notification_event_deliveries d ON d.id = ? AND d.contact_id = c.id AND d.expected_capability_generation = c.capability_generation AND d.status = ? JOIN notification_subscriptions sub ON sub.contact_id = c.id WHERE o.id = ? AND o.version = ? AND o.status = ? AND o.claim_token = ? AND o.claim_expires_at > ? AND o.kind = ? AND c.channel = ? AND c.destination = ? AND NOT EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash) LIMIT 1'
      : `SELECT o.expected_capability_generation, c.channel FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id AND c.capability_generation = o.expected_capability_generation WHERE o.id = ? AND o.version = ? AND o.status = ? AND o.claim_token = ? AND o.claim_expires_at > ? AND o.kind = ? AND c.destination = ? AND c.management_token_digest = ? AND ((c.state = 'active' AND NOT EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash)) OR (c.state = 'pending-reactivation' AND o.kind IN ('reactivation', 'management-recovery') AND EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash AND s.reason = 'user-stop')))`)
      .bind(...(eventPayload
        ? ['active', eventPayload.deliveryId, 'pending', pointer.outboxId, pointer.version, 'claimed', token, nowIso(dependencies), payload.kind, payload.kind === 'event-email' ? 'email' : 'sms', payload.destination]
        : [pointer.outboxId, pointer.version, 'claimed', token, nowIso(dependencies), payload.kind, payload.destination, capabilityDigest])).first<NotificationDeliveryAuthorization>()
    authorization = await readAuthorization()
    authorize = async () => {
      try {
        const current = await readAuthorization()
        if (!current) authorizationLost = true
        return Boolean(current)
      } catch (error) {
        authorizationError = error
        throw error
      }
    }
  } catch (error) {
    await releaseClaim(pointer, token, dependencies)
    throw error
  }
  if (!authorization) {
    await dependencies.database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE id = ? AND version = ? AND status = ? AND claim_token = ?').bind('invalidated', nowIso(dependencies), nowIso(dependencies), pointer.outboxId, pointer.version, 'claimed', token).run()
    return { delivered: false, stale: true }
  }

  try {
    // A manual switch-off is terminal, not retryable backlog: nothing reaches Brevo.
    if ((payload.kind === 'event-email' && !dependencies.config.emailDeliveryReady) || (payload.kind === 'event-sms' && !(dependencies.config.smsEnabled && dependencies.config.smsEventDeliveryReady && dependencies.config.smsDeliveryReady))) {
      await dependencies.database.prepare('UPDATE notification_event_deliveries SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .bind('failed', nowIso(dependencies), payload.deliveryId, 'pending').run()
    } else {
      const result = await deliver(payload, authorization, authorize)
      if (authorizationError) throw authorizationError
      if (authorizationLost) {
        await failClaim(pointer, token, authorization, dependencies)
        return { delivered: false, stale: true }
      }
      if (isProviderAttempt(result) && !result.attempted) throw new Error('Notification provider invocation is unavailable')
      if ((payload.kind === 'event-email' || payload.kind === 'event-sms') && isProviderAttempt(result)) {
        if (authorization.channel !== 'email' && retryableProviderStatuses.has(result.status)) throw new Error('Notification provider delivery is retryable')
        const status = result.status === 'submitted' ? 'submitted' : 'failed'
        const providerMessageId = 'providerMessageId' in result ? result.providerMessageId : undefined
        await dependencies.database.prepare('UPDATE notification_event_deliveries SET status = ?, provider_message_id = COALESCE(?, provider_message_id), submitted_at = ?, updated_at = ? WHERE id = ?')
          .bind(status, providerMessageId ?? null, nowIso(dependencies), nowIso(dependencies), payload.deliveryId).run()
      } else if (isProviderAttempt(result) && result.status !== 'submitted') {
        if (authorization.channel !== 'email' && retryableProviderStatuses.has(result.status)) throw new Error('Notification provider delivery is retryable')
        if (result.status === 'stale-endpoint' && authorization.channel === 'web-push') {
          await removeStaleWebPushContact(pointer, authorization, dependencies)
        } else {
          await failClaim(pointer, token, authorization, dependencies)
        }
        return { delivered: false, stale: false }
      }
    }
  } catch (error) {
    await releaseClaim(pointer, token, dependencies)
    throw error
  }

  const consumed = await dependencies.database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE id = ? AND version = ? AND status = ? AND claim_token = ? AND expected_capability_generation = ?')
    .bind('consumed', nowIso(dependencies), nowIso(dependencies), pointer.outboxId, pointer.version, 'claimed', token, authorization.expected_capability_generation).run()
  if (changed(consumed) !== 1) return { delivered: false, stale: true }
  return { delivered: true, stale: false }
}
