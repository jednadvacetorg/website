import { isNotificationChannelReady, notificationSchemaReady, type NotificationCrypto, type NotificationDatabase, type NotificationLifecycleConfig } from './notifications.ts'
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
  monotonicNow?: () => number
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
  deliveryId: string
  managementCapability: string
  event: { title: string, description?: string, location?: string, url?: string, communityUrl?: string, start: string, end: string, uid: string, sequence: number, cancelled?: boolean }
  reason: 'created' | 'week-before' | 'day-before' | 'updated' | 'cancelled'
  kind: 'event-email' | 'event-sms' | 'event-web-push'
}

export type NotificationMessagePayload = LifecycleNotificationMessagePayload | EventNotificationMessagePayload
export interface NotificationDeliveryAuthorization { expected_capability_generation: number, channel: 'email' | 'sms' | 'web-push', contact_id: number, lifecycleAttempt?: NotificationOutboxPointer }
export type NotificationDeliveryHook = (payload: NotificationMessagePayload, authorization: NotificationDeliveryAuthorization, authorize: (signal?: AbortSignal) => Promise<boolean>) => Promise<void | BrevoAttemptResult | BrevoSmsAttemptResult | WebPushAttemptResult>

interface PendingOutboxRow {
  id: unknown
  version: unknown
  created_at: string
}

interface ClaimedOutboxRow {
  payload_ciphertext: unknown
  payload_iv: unknown
}

const allowedKinds = new Set<NotificationMessagePayload['kind']>(['first-activation', 'reactivation', 'management-recovery', 'event-email', 'event-sms', 'event-web-push'])
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
  if (value.kind === 'event-email' || value.kind === 'event-sms' || value.kind === 'event-web-push') {
    if (Object.keys(value).length !== 6 || typeof value.deliveryId !== 'string' || !value.deliveryId || typeof value.managementCapability !== 'string' || !value.managementCapability || typeof value.reason !== 'string' || !['created', 'week-before', 'day-before', 'updated', 'cancelled'].includes(value.reason) || !isRecord(value.event) || typeof value.event.title !== 'string' || typeof value.event.start !== 'string' || typeof value.event.end !== 'string' || typeof value.event.uid !== 'string' || !Number.isSafeInteger(value.event.sequence)) throw new Error('Notification outbox payload is invalid')
    if (!Number.isFinite(Date.parse(value.event.start)) || !Number.isFinite(Date.parse(value.event.end)) || (value.event.cancelled !== undefined && typeof value.event.cancelled !== 'boolean') || (value.event.url !== undefined && typeof value.event.url !== 'string')) throw new Error('Notification outbox payload is invalid')
    if ((value.event.location !== undefined && typeof value.event.location !== 'string') || (value.event.communityUrl !== undefined && typeof value.event.communityUrl !== 'string')) throw new Error('Notification outbox payload is invalid')
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

/**
 * Queue acceptance never authorizes delivery. Pages use a local cursor, not a persisted claim.
 * Stop starting reads/sends at the wall deadline; a non-abortable in-flight send and its
 * conditional D1 mark must settle and can exceed it. Never race an untracked send timer.
 */
export const publishPendingNotificationPointers = async (queue: NotificationMessagesQueue, dependencies: Omit<NotificationQueueDependencies, 'config'> & { config?: NotificationLifecycleConfig }, limits: number | { lifecycleLimit: number, eventLimit: number, budgetMs: number } = 25) => {
  const legacy = typeof limits === 'number'
  if (legacy && (!Number.isSafeInteger(limits) || limits < 1 || limits > 100)) throw new Error('Notification Queue batch limit is invalid')
  const lifecycleLimit = legacy ? limits : limits.lifecycleLimit
  const eventLimit = legacy ? limits : limits.eventLimit
  const budgetMs = legacy ? 20000 : limits.budgetMs
  if (!Number.isSafeInteger(lifecycleLimit) || lifecycleLimit < 0 || lifecycleLimit > 100
    || !Number.isSafeInteger(eventLimit) || eventLimit < 0 || eventLimit > 300
    || lifecycleLimit + eventLimit < 1 || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 20000) throw new Error('Notification Queue publication budget is invalid')
  const clock = dependencies.monotonicNow ?? (() => performance.now())
  const started = clock()
  const withinBudget = () => clock() - started < budgetMs
  let published = 0
  let lifecyclePublished = 0
  let eventPublished = 0
  for (const lifecycle of [true, false]) {
    const kind = lifecycle ? "kind IN ('first-activation', 'reactivation', 'management-recovery')" : "kind IN ('event-email', 'event-sms', 'event-web-push')"
    const cap = lifecycle ? lifecycleLimit : eventLimit
    let count = 0
    let cursor: PendingOutboxRow | undefined
    while (count < cap && (!legacy || published < limits) && withinBudget()) {
      const pageSize = Math.min(100, cap - count, legacy ? limits - published : 400)
      const { results } = await dependencies.database.prepare(`SELECT id, version, created_at FROM notification_outbox WHERE status = ? AND ${kind}${cursor ? ' AND (created_at > ? OR (created_at = ? AND id > ?))' : ''} ORDER BY created_at, id LIMIT ?`)
        .bind('pending', ...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []), pageSize).all<PendingOutboxRow>()
      if (!results.length) break
      for (const row of results) {
        if (!withinBudget()) break
        const version = row.version
        if (typeof row.id !== 'string' || !row.id || typeof row.created_at !== 'string' || !Number.isSafeInteger(version) || (version as number) < 1) throw new Error('Notification outbox pointer is invalid')
        const pointer: NotificationOutboxPointer = { outboxId: row.id, version: version as number }
        await queue.send(pointer)
        await dependencies.barriers?.afterPublished?.(pointer)
        await dependencies.database.prepare('UPDATE notification_outbox SET status = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?')
          .bind('queued', (dependencies.now?.() ?? new Date()).toISOString(), pointer.outboxId, pointer.version, 'pending').run()
        // Counts durable Queue acceptances, even when concurrent consumption/revocation wins marking.
        published++
        count++
        if (lifecycle) lifecyclePublished++
        else eventPublished++
        cursor = row
      }
      if (results.length < pageSize) break
    }
  }
  // Do not start even accounting after the deadline. Null metrics mean not observed,
  // never a false zero backlog; an already-started read can itself exceed the budget.
  const pending = withinBudget() ? await dependencies.database.prepare(`SELECT
    COALESCE(SUM(CASE WHEN kind IN ('first-activation', 'reactivation', 'management-recovery') THEN 1 ELSE 0 END), 0) AS lifecycle,
    COALESCE(SUM(CASE WHEN kind IN ('event-email', 'event-sms', 'event-web-push') THEN 1 ELSE 0 END), 0) AS events,
    MIN(created_at) AS oldest FROM notification_outbox WHERE status = 'pending'`).first<{ lifecycle: number, events: number, oldest: string | null }>() : null
  const elapsedMs = clock() - started
  return { published, lifecyclePublished, eventPublished, pendingLifecycle: pending?.lifecycle ?? null, pendingEvents: pending?.events ?? null, oldestPendingAt: pending?.oldest ?? null, elapsedMs, budgetExhausted: elapsedMs >= budgetMs }
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
const removeStaleWebPushContact = async (pointer: NotificationOutboxPointer, token: string, authorization: NotificationDeliveryAuthorization, dependencies: NotificationQueueDependencies) => {
  const now = nowIso(dependencies)
  const guard = "EXISTS (SELECT 1 FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id WHERE o.id = ? AND o.version = ? AND o.status = 'claimed' AND o.claim_token = ? AND o.contact_id = ? AND o.expected_capability_generation = ? AND c.channel = 'web-push' AND c.capability_generation = o.expected_capability_generation)"
  const values = [pointer.outboxId, pointer.version, token, authorization.contact_id, authorization.expected_capability_generation]
  await dependencies.database.batch([
    dependencies.database.prepare(`INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT channel, destination_hash, 'provider-opt-out', ? FROM notification_contacts WHERE id = ? AND ${guard} ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at`).bind(now, authorization.contact_id, ...values),
    dependencies.database.prepare(`UPDATE notification_outbox SET version = version + 1, status = 'invalidated', payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND id <> ? AND status IN ('pending', 'queued', 'claimed') AND ${guard}`).bind(now, now, authorization.contact_id, pointer.outboxId, ...values),
    dependencies.database.prepare(`UPDATE notification_event_deliveries SET status = 'failed', updated_at = ? WHERE contact_id = ? AND expected_capability_generation = ? AND channel = 'web-push' AND status = 'pending' AND ${guard}`).bind(now, authorization.contact_id, authorization.expected_capability_generation, ...values),
    // Keep the owning outbox/claim intact until deletion has checked the same authority.
    dependencies.database.prepare(`DELETE FROM notification_contacts WHERE id = ? AND channel = 'web-push' AND capability_generation = ? AND ${guard}`).bind(authorization.contact_id, authorization.expected_capability_generation, ...values),
    // Last in the atomic batch: retire only the exact still-owned pointer, never rediscover through an invalidated row.
    dependencies.database.prepare("UPDATE notification_outbox SET version = version + 1, status = 'invalidated', payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE id = ? AND version = ? AND status = 'claimed' AND claim_token = ? AND contact_id = ? AND expected_capability_generation = ? AND NOT EXISTS (SELECT 1 FROM notification_contacts WHERE id = ?)").bind(now, now, ...values, authorization.contact_id),
  ])
}

const eligibleFrequencies = (payload: EventNotificationMessagePayload, now: Date) => {
  if (payload.reason === 'updated' || payload.reason === 'cancelled') return ['created', 'week-before', 'day-before']
  const local = (date: Date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    return { day: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)), hour: Number(parts.hour) }
  }
  const current = local(now)
  const start = local(new Date(payload.event.start))
  return ['created', 'week-before', 'day-before'].filter(frequency => {
    if (frequency === 'created') return payload.reason === 'created'
    if (payload.reason !== 'created' && payload.reason !== frequency) return false
    const dueDay = start.day - (frequency === 'week-before' ? 7 : 1) * 86_400_000
    return current.day > dueDay || (current.day === dueDay && current.hour >= 9)
  })
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
  let authorize!: (signal?: AbortSignal) => Promise<boolean>
  let authorizationLost = false
  let authorizationError: unknown
  let lifecycleReserved = false
  try {
    const row = await dependencies.database.prepare('SELECT payload_ciphertext, payload_iv FROM notification_outbox WHERE id = ? AND version = ? AND status = ? AND claim_token = ?')
      .bind(pointer.outboxId, pointer.version, 'claimed', token).first<ClaimedOutboxRow>()
    if (!row || typeof row.payload_ciphertext !== 'string' || typeof row.payload_iv !== 'string') throw new Error('Notification outbox payload is unavailable')
    const plaintext = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(decodeBase64Url(row.payload_iv)) }, dependencies.config.outboxTransportKey, asBufferSource(decodeBase64Url(row.payload_ciphertext)))
    payload = parsePayload(decoder.decode(plaintext))
    await dependencies.barriers?.afterClaimedAndDecrypted?.(pointer)
    const eventPayload = payload.kind === 'event-email' || payload.kind === 'event-sms' || payload.kind === 'event-web-push' ? payload : null
    const capabilityDigest = base64Url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode('capability' in payload ? payload.capability : payload.managementCapability))))
    const authorizationSql = eventPayload
      ? `SELECT o.expected_capability_generation, c.channel, c.id AS contact_id FROM notification_outbox o
        JOIN notification_contacts c ON c.id = o.contact_id AND c.state = 'active' AND c.capability_generation = o.expected_capability_generation
        JOIN notification_event_deliveries d ON d.id = ? AND d.contact_id = c.id AND d.channel = c.channel AND d.destination_hash = c.destination_hash AND d.expected_capability_generation = c.capability_generation AND d.status = 'pending' AND d.submitted_at IS NULL
        JOIN notification_subscriptions sub ON sub.contact_id = c.id AND sub.community_slug = d.community_slug AND sub.frequency = d.eligibility_frequency
        JOIN notification_event_state e ON e.uid = d.event_uid AND e.notification_revision = d.event_revision
          AND CASE WHEN json_valid(e.event_key) THEN json_extract(e.event_key, '$[0]') END = d.community_slug
        JOIN notification_management_capabilities cap ON cap.token_digest = ? AND cap.contact_id = c.id AND cap.expected_capability_generation = c.capability_generation
        WHERE o.id = ? AND o.version = ? AND o.status = 'claimed' AND o.claim_token = ? AND o.claim_expires_at > ?
          AND o.kind = ? AND o.kind = 'event-' || c.channel AND o.id = 'event-' || d.id || '-g' || c.capability_generation
          AND c.destination = ? AND d.event_uid = ? AND d.event_revision = ? AND d.reason = ?
          AND e.starts_at = ? AND e.ends_at = ? AND e.cancelled = ?
          AND CASE WHEN e.cancelled = 1 THEN e.ends_at ELSE e.starts_at END > ? AND cap.expires_at > ?
          AND d.eligibility_frequency IN (SELECT value FROM json_each(?)) AND d.community_slug IN (SELECT value FROM json_each(?))
          AND (d.reason NOT IN ('updated', 'cancelled') OR EXISTS (SELECT 1 FROM notification_event_deliveries prior WHERE prior.contact_id = c.id AND prior.channel = c.channel AND prior.event_uid = d.event_uid AND prior.id <> d.id AND prior.status IN ('submitted', 'delivered')))
          AND NOT EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash) LIMIT 1`
      : `SELECT o.expected_capability_generation, c.channel, c.id AS contact_id FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id AND c.capability_generation = o.expected_capability_generation WHERE o.id = ? AND o.version = ? AND o.status = ? AND o.claim_token = ? AND o.claim_expires_at > ? AND o.kind = ? AND c.destination = ? AND c.management_token_digest = ? AND ((c.state = 'active' AND NOT EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash)) OR (c.state = 'pending-reactivation' AND o.kind IN ('reactivation', 'management-recovery') AND EXISTS (SELECT 1 FROM notification_suppressions s WHERE s.channel = c.channel AND s.destination_hash = c.destination_hash AND s.reason = 'user-stop')))`
    const authorizationValues = () => eventPayload
         ? [eventPayload.deliveryId, capabilityDigest, pointer.outboxId, pointer.version, token, nowIso(dependencies), eventPayload.kind, eventPayload.destination, eventPayload.event.uid, eventPayload.event.sequence, eventPayload.reason, eventPayload.event.start, eventPayload.event.end, Number(eventPayload.reason === 'cancelled' && eventPayload.event.cancelled === true), nowIso(dependencies), nowIso(dependencies), JSON.stringify(eligibleFrequencies(eventPayload, dependencies.now?.() ?? new Date())), JSON.stringify(dependencies.config.communitySlugs)]
         : [pointer.outboxId, pointer.version, 'claimed', token, nowIso(dependencies), payload.kind, payload.destination, capabilityDigest]
    const readAuthorization = () => dependencies.database.prepare(authorizationSql).bind(...authorizationValues()).first<NotificationDeliveryAuthorization>()
    authorization = await readAuthorization()
    if (authorization?.channel === 'email' && !eventPayload) authorization.lifecycleAttempt = pointer
    authorize = async (signal) => {
      try {
        if (signal?.aborted) return false
        // Probes must precede the final subscriber read: awaiting one afterwards
        // would let a concurrent stop invalidate the authority we just read.
        const schemaReady = await notificationSchemaReady(dependencies.database)
        if (signal?.aborted) return false
        if (!schemaReady) { authorizationLost = true; return false }
        const current = await readAuthorization()
        if (signal?.aborted) return false
        if (current && !isNotificationChannelReady(current.channel, dependencies.config)) authorizationLost = true
        if (!current) authorizationLost = true
        if (current && !authorizationLost && eventPayload) {
          // Reserve every event attempt before transport so recovery cannot mistake
          // in-flight work for unsent work. Only an owned SMS/push transient result
          // clears this reservation; a process crash remains deliberately ambiguous.
           const attempt = await dependencies.database.prepare(`UPDATE notification_event_deliveries SET submitted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND submitted_at IS NULL AND EXISTS (${authorizationSql})`).bind(nowIso(dependencies), nowIso(dependencies), eventPayload.deliveryId, ...authorizationValues()).run()
           if (signal?.aborted) return false
          if (changed(attempt) !== 1) authorizationLost = true
        } else if (current?.channel === 'email' && !authorizationLost) {
          // Consume the single email attempt in the final CAS itself. A crash after
          // this commit is ambiguous, never permission to resubmit. All preparation
          // and probes have finished; the next operation at the adapter is fetch.
          const attemptedAt = nowIso(dependencies)
          const attempt = await dependencies.database.prepare(`UPDATE notification_outbox SET
            email_destination_hash = (SELECT destination_hash FROM notification_contacts WHERE id = notification_outbox.contact_id),
            email_attempt_version = version, email_attempted_at = ?, email_delivery_status = 'pending',
            version = version + 1, status = 'consumed', payload_ciphertext = NULL, payload_iv = NULL,
            claim_token = NULL, claim_expires_at = NULL, terminal_at = ?, updated_at = ?
            WHERE id = ? AND version = ? AND email_attempt_version IS NULL
            AND contact_id = ? AND expected_capability_generation = ? AND EXISTS (${authorizationSql})`)
             .bind(attemptedAt, attemptedAt, attemptedAt, pointer.outboxId, pointer.version, current.contact_id, current.expected_capability_generation, ...authorizationValues()).run()
          if (signal?.aborted) return false
          lifecycleReserved = changed(attempt) === 1
          if (!lifecycleReserved) authorizationLost = true
        }
        return Boolean(current) && !authorizationLost
      } catch (error) {
        if (signal?.aborted) return false
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
    if ('deliveryId' in payload) await dependencies.database.prepare("UPDATE notification_event_deliveries SET status = 'failed', updated_at = ? WHERE id = ? AND expected_capability_generation = (SELECT expected_capability_generation FROM notification_outbox WHERE id = ?) AND status = 'pending' AND submitted_at IS NOT NULL").bind(nowIso(dependencies), payload.deliveryId, pointer.outboxId).run()
    return { delivered: false, stale: true }
  }

  try {
    // Unavailable delivery configuration is terminal, not retryable backlog: nothing reaches Brevo.
    if (!isNotificationChannelReady(authorization.channel, dependencies.config) || !await notificationSchemaReady(dependencies.database)) {
      if ('deliveryId' in payload) await dependencies.database.prepare('UPDATE notification_event_deliveries SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
        .bind('failed', nowIso(dependencies), payload.deliveryId, 'pending').run()
      await failClaim(pointer, token, authorization, dependencies)
      return { delivered: false, stale: true }
    } else {
      const result = await deliver(payload, authorization, authorize)
      if (authorizationError) throw authorizationError
      if (authorizationLost) {
        await failClaim(pointer, token, authorization, dependencies)
        return { delivered: false, stale: true }
      }
      if (isProviderAttempt(result) && !result.attempted && result.status !== 'invalid-request') throw new Error('Notification provider invocation is unavailable')
      if (lifecycleReserved && isProviderAttempt(result)) {
        const providerMessageId = 'providerMessageId' in result ? result.providerMessageId : undefined
        await dependencies.database.prepare(`UPDATE notification_outbox SET
          email_delivery_status = CASE WHEN email_delivery_status = 'pending' THEN ? ELSE email_delivery_status END,
          email_provider_message_id = COALESCE(email_provider_message_id, ?),
          status = CASE WHEN email_delivery_status = 'pending' AND ? <> 'submitted' THEN 'invalidated' ELSE status END
          WHERE id = ? AND email_attempt_version = ? AND expected_capability_generation = ?
          AND (email_provider_message_id IS NULL OR ? IS NULL OR email_provider_message_id = ?)`)
          .bind(result.status === 'submitted' ? 'submitted' : 'failed', providerMessageId ?? null, result.status, pointer.outboxId, pointer.version, authorization.expected_capability_generation, providerMessageId ?? null, providerMessageId ?? null).run()
        return { delivered: result.status === 'submitted', stale: false }
      }
      if (isProviderAttempt(result) && result.status === 'stale-endpoint' && authorization.channel === 'web-push') {
        await removeStaleWebPushContact(pointer, token, authorization, dependencies)
        return { delivered: false, stale: false }
      }
      if (isProviderAttempt(result) && authorization.channel !== 'email' && retryableProviderStatuses.has(result.status)) {
        if ('deliveryId' in payload) await dependencies.database.prepare("UPDATE notification_event_deliveries SET submitted_at = NULL WHERE id = ? AND expected_capability_generation = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM notification_outbox o JOIN notification_contacts c ON c.id = o.contact_id AND c.capability_generation = o.expected_capability_generation WHERE o.id = ? AND o.version = ? AND o.status = 'claimed' AND o.claim_token = ? AND o.expected_capability_generation = ?)").bind(payload.deliveryId, authorization.expected_capability_generation, pointer.outboxId, pointer.version, token, authorization.expected_capability_generation).run()
        throw new Error('Notification provider delivery is retryable')
      }
      if ('deliveryId' in payload && isProviderAttempt(result)) {
        const status = result.status === 'submitted' ? 'submitted' : 'failed'
        const providerMessageId = 'providerMessageId' in result ? result.providerMessageId : undefined
        // A callback can commit inside the send promise. Its status and provider ID
        // are already evidence, not provisional values for the response to overwrite.
        await dependencies.database.prepare("UPDATE notification_event_deliveries SET status = CASE WHEN status = 'pending' THEN ? ELSE status END, provider_message_id = COALESCE(provider_message_id, ?), submitted_at = COALESCE(submitted_at, ?), updated_at = ? WHERE id = ? AND channel = ? AND expected_capability_generation = ? AND (provider_message_id IS NULL OR ? IS NULL OR provider_message_id = ?)")
          .bind(status, providerMessageId ?? null, nowIso(dependencies), nowIso(dependencies), payload.deliveryId, authorization.channel, authorization.expected_capability_generation, providerMessageId ?? null, providerMessageId ?? null).run()
      } else if (isProviderAttempt(result) && result.status !== 'submitted') {
        await failClaim(pointer, token, authorization, dependencies)
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
