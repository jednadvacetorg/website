import type { NotificationCrypto, NotificationDatabase, NotificationLifecycleConfig } from './notifications.ts'
import type { BrevoAttemptResult } from './brevoEmail.ts'

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
  kind: 'event-email'
}

export type NotificationMessagePayload = LifecycleNotificationMessagePayload | EventNotificationMessagePayload
export type NotificationDeliveryHook = (payload: NotificationMessagePayload) => Promise<void | BrevoAttemptResult>

interface PendingOutboxRow {
  id: unknown
  version: unknown
}

interface ClaimedOutboxRow {
  payload_ciphertext: unknown
  payload_iv: unknown
  transport_key_version: unknown
}

const allowedKinds = new Set<NotificationMessagePayload['kind']>(['first-activation', 'reactivation', 'management-recovery', 'event-email'])
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
  if (value.kind === 'event-email') {
    if (Object.keys(value).length !== 7 || typeof value.deliveryId !== 'string' || !value.deliveryId || typeof value.managementCapability !== 'string' || !value.managementCapability || typeof value.reason !== 'string' || !['created', 'week-before', 'day-before', 'updated', 'cancelled'].includes(value.reason) || !isRecord(value.event) || typeof value.event.title !== 'string' || typeof value.event.start !== 'string' || typeof value.event.end !== 'string' || typeof value.event.uid !== 'string' || !Number.isSafeInteger(value.event.sequence)) throw new Error('Notification outbox payload is invalid')
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
  if (changed(claim) !== 1) return { delivered: false, stale: true }

  let payload: NotificationMessagePayload
  let authorization: { expected_capability_generation: number } | null
  try {
    const row = await dependencies.database.prepare('SELECT payload_ciphertext, payload_iv, transport_key_version FROM notification_outbox WHERE id = ? AND version = ? AND status = ? AND claim_token = ?')
      .bind(pointer.outboxId, pointer.version, 'claimed', token).first<ClaimedOutboxRow>()
    if (!row || typeof row.payload_ciphertext !== 'string' || typeof row.payload_iv !== 'string' || typeof row.transport_key_version !== 'string') throw new Error('Notification outbox payload is unavailable')
    // Durable version labels are root versions; this is the outbox HKDF purpose key.
    const key = dependencies.config.outboxTransportKeys[row.transport_key_version]
    if (!key) throw new Error('Notification outbox transport key is unavailable')
    const plaintext = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(decodeBase64Url(row.payload_iv)) }, key, asBufferSource(decodeBase64Url(row.payload_ciphertext)))
    payload = parsePayload(decoder.decode(plaintext))
    await dependencies.barriers?.afterClaimedAndDecrypted?.(pointer)
    authorization = await dependencies.database.prepare(payload.kind === 'event-email'
      ? 'SELECT o.expected_capability_generation FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id AND c.state = ? AND c.capability_generation = o.expected_capability_generation JOIN notification_event_deliveries d ON d.id = ? AND d.contact_id = c.id AND d.expected_capability_generation = c.capability_generation AND d.status = ? JOIN notification_subscriptions sub ON sub.contact_id = c.id WHERE o.id = ? AND o.version = ? AND o.status = ? AND o.claim_token = ? AND o.claim_expires_at > ? AND NOT EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash AND s.destination_hash_key_version = c.destination_hash_key_version) LIMIT 1'
      : 'SELECT o.expected_capability_generation FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id AND c.state = ? AND c.capability_generation = o.expected_capability_generation WHERE o.id = ? AND o.version = ? AND o.status = ? AND o.claim_token = ? AND o.claim_expires_at > ? AND o.kind IN (?, ?, ?) AND NOT EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash AND s.destination_hash_key_version = c.destination_hash_key_version)')
      .bind(...(payload.kind === 'event-email'
        ? ['active', payload.deliveryId, 'pending', pointer.outboxId, pointer.version, 'claimed', token, nowIso(dependencies)]
        : ['active', pointer.outboxId, pointer.version, 'claimed', token, nowIso(dependencies), 'first-activation', 'reactivation', 'management-recovery'])).first<{ expected_capability_generation: number }>()
  } catch (error) {
    await releaseClaim(pointer, token, dependencies)
    throw error
  }
  if (!authorization) return { delivered: false, stale: true }

  try {
    // A manual switch-off is terminal, not retryable backlog: nothing reaches Brevo.
    if (payload.kind === 'event-email' && !dependencies.config.emailDeliveryReady) {
      await dependencies.database.prepare('UPDATE notification_event_deliveries SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .bind('failed', nowIso(dependencies), payload.deliveryId, 'pending').run()
    } else {
      const result = await deliver(payload)
      if (payload.kind === 'event-email' && result && 'attempted' in result) {
      await dependencies.database.prepare('UPDATE notification_event_deliveries SET status = ?, provider_message_id = COALESCE(?, provider_message_id), submitted_at = ?, updated_at = ? WHERE id = ?')
        .bind(result.status, result.providerMessageId ?? null, nowIso(dependencies), nowIso(dependencies), payload.deliveryId).run()
      }
    }
  } catch (error) {
    await releaseClaim(pointer, token, dependencies)
    throw error
  }

  const consumed = await dependencies.database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, transport_key_version = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE id = ? AND version = ? AND status = ? AND claim_token = ? AND expected_capability_generation = ?')
    .bind('consumed', nowIso(dependencies), nowIso(dependencies), pointer.outboxId, pointer.version, 'claimed', token, authorization.expected_capability_generation).run()
  if (changed(consumed) !== 1) throw new Error('Notification outbox consumption lost its claim')
  return { delivered: true, stale: false }
}
