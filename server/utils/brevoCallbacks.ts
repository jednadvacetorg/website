import type { NotificationDatabase } from './notifications.ts'
import { normalizeBrevoProviderId } from './brevoEmail.ts'

export type BrevoCallbackKind = 'delivered' | 'soft-bounce' | 'hard-bounce' | 'blocked' | 'complaint' | 'unsubscribed'

export interface BrevoCallbackEvent {
  id: string
  deliveryId: string
  kind: BrevoCallbackKind
  providerMessageId?: string
  occurredAt: string
}

interface DeliveryRow {
  id: string
  channel: string
  contact_id: number | null
  expected_capability_generation: number
  destination_hash: string
  provider_message_id: string | null
  status: string
}

const callbackKinds: Record<string, BrevoCallbackKind> = {
  delivered: 'delivered',
  softbounce: 'soft-bounce',
  soft_bounce: 'soft-bounce',
  hardbounce: 'hard-bounce',
  hard_bounce: 'hard-bounce',
  blocked: 'blocked',
  spam: 'complaint',
  unsubscribed: 'unsubscribed',
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const opaque = (value: unknown, maximum = 256) => typeof value === 'string' && /^[A-Za-z0-9_-]{12,}$/.test(value) && value.length <= maximum
const utcEventTime = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 253_402_300_799) return
  return new Date(value * 1_000).toISOString()
}

/** Narrows documented Brevo payload fields into opaque local callback evidence. */
export const normalizeBrevoCallback = (value: unknown): BrevoCallbackEvent | undefined => {
  if (!isRecord(value)) return
  const event = typeof value.event === 'string' ? value.event.toLowerCase() : ''
  const kind = callbackKinds[event]
  const id = value.id
  const deliveryId = value['X-Mailin-custom']
  const providerMessageId = normalizeBrevoProviderId(value['message-id'])
  const occurredAt = utcEventTime(value.ts_event)
  const lifecycle = typeof deliveryId === 'string' && /^lifecycle:v1:[A-Za-z0-9_-]{12,256}:[1-9][0-9]*$/.test(deliveryId) && Number.isSafeInteger(Number(deliveryId.split(':')[3]))
  if (!kind || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof deliveryId !== 'string' || !(lifecycle || opaque(deliveryId)) || !providerMessageId || !occurredAt) return
  return { id: String(id), deliveryId, kind, providerMessageId, occurredAt }
}

const receiptKey = async (event: BrevoCallbackEvent) => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([event.deliveryId, event.providerMessageId, event.kind, event.occurredAt, event.id])))
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('')
}

const terminalRank: Record<BrevoCallbackKind, number> = {
  delivered: 1,
  'soft-bounce': 2,
  blocked: 2,
  'hard-bounce': 3,
  complaint: 3,
  unsubscribed: 3,
}
const suppressionReason: Partial<Record<BrevoCallbackKind, 'provider-bounce' | 'provider-complaint' | 'provider-opt-out'>> = {
  'hard-bounce': 'provider-bounce',
  complaint: 'provider-complaint',
  unsubscribed: 'provider-opt-out',
}

/** Applies a callback by opaque delivery ID only; provider IDs must agree once persisted. */
export const applyBrevoCallback = async (event: BrevoCallbackEvent, database: NotificationDatabase) => {
  if (event.deliveryId.startsWith('lifecycle:')) {
    const match = /^lifecycle:v1:([A-Za-z0-9_-]{12,256}):([1-9][0-9]*)$/.exec(event.deliveryId)
    const version = Number(match?.[2])
    if (!match || !Number.isSafeInteger(version) || !event.providerMessageId || normalizeBrevoProviderId(event.providerMessageId) !== event.providerMessageId) return { applied: false, suppressed: false }
    const now = new Date().toISOString()
    // SQLite/D1 evaluates 'now' at statement execution, including after an awaited
    // batch bridge. Canonical round-trip validation rejects NULL/corrupt terminal
    // metadata; only an owned live pre-terminal claim can legitimately lack it.
    const liveOwner = `((o.status IN ('consumed', 'invalidated')
      AND strftime('%Y-%m-%dT%H:%M:%fZ', o.terminal_at, '+0 seconds') = o.terminal_at
      AND julianday(o.terminal_at) <= julianday('now')
      AND julianday(o.terminal_at) + 30 > julianday('now'))
      OR (o.status = 'claimed' AND o.terminal_at IS NULL AND o.email_attempt_version = o.version
        AND o.claim_token IS NOT NULL
        AND strftime('%Y-%m-%dT%H:%M:%fZ', o.claim_expires_at, '+0 seconds') = o.claim_expires_at
        AND julianday(o.claim_expires_at) > julianday('now')))`
    const row = await database.prepare(`SELECT contact_id, expected_capability_generation, email_destination_hash
      FROM notification_outbox o WHERE id = ? AND kind IN ('first-activation', 'management-recovery', 'reactivation')
      AND email_attempt_version = ? AND email_attempted_at IS NOT NULL AND email_delivery_status IS NOT NULL
      AND email_destination_hash IS NOT NULL AND ${liveOwner}
      AND NOT EXISTS (SELECT 1 FROM notification_contacts c WHERE c.id = o.contact_id AND c.channel <> 'email')
      AND (email_provider_message_id IS NULL OR email_provider_message_id = ?)`)
      .bind(match[1], version, event.providerMessageId).first<{ contact_id: number | null, expected_capability_generation: number, email_destination_hash: string }>()
    if (!row) return { applied: false, suppressed: false }
    const receipt = await receiptKey(event)
    // Repeat the complete retained authority inside every atomic statement. The
    // contact is optional evidence; its replacement is never callback authority.
    const owner = `EXISTS (SELECT 1 FROM notification_outbox o WHERE o.id = ?
      AND o.kind IN ('first-activation', 'management-recovery', 'reactivation')
      AND o.email_attempt_version = ? AND o.email_attempted_at IS NOT NULL AND o.email_delivery_status IS NOT NULL
      AND o.email_destination_hash = ? AND o.expected_capability_generation = ? AND (o.contact_id IS ? OR o.contact_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM notification_contacts c WHERE c.id = o.contact_id AND c.channel <> 'email')
      AND ${liveOwner}
      AND (o.email_provider_message_id IS NULL OR o.email_provider_message_id = ?))`
    const ownerValues = [match[1], version, row.email_destination_hash, row.expected_capability_generation, row.contact_id, event.providerMessageId]
    const guard = `${owner} AND EXISTS (SELECT 1 FROM notification_lifecycle_email_callbacks WHERE receipt_key = ? AND outbox_id = ? AND attempt_version = ? AND event = ? AND provider_message_id = ?)`
    const values = [...ownerValues, receipt, match[1], version, event.kind, event.providerMessageId]
    const statements = [
      database.prepare(`INSERT INTO notification_lifecycle_email_callbacks (receipt_key, outbox_id, attempt_version, event, provider_message_id, received_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${owner} ON CONFLICT(receipt_key) DO NOTHING`).bind(receipt, match[1], version, event.kind, event.providerMessageId, now, ...ownerValues),
      database.prepare(`UPDATE notification_outbox SET email_delivery_status = CASE WHEN
        (CASE email_delivery_status WHEN 'delivered' THEN 1 WHEN 'soft-bounce' THEN 2 WHEN 'blocked' THEN 2 WHEN 'hard-bounce' THEN 3 WHEN 'complaint' THEN 3 WHEN 'unsubscribed' THEN 3 ELSE 0 END) < ? THEN ? ELSE email_delivery_status END,
        email_provider_message_id = COALESCE(email_provider_message_id, ?) WHERE id = ? AND ${guard}`)
        .bind(terminalRank[event.kind], event.kind, event.providerMessageId, match[1], ...values),
    ]
    const reason = suppressionReason[event.kind]
    if (reason) {
      const contact = "id = ? AND channel = 'email' AND capability_generation = ? AND destination_hash = ?"
      const contactValues = [row.contact_id, row.expected_capability_generation, row.email_destination_hash]
      statements.push(
        database.prepare(`INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT 'email', ?, ?, ? WHERE ${guard} ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = CASE WHEN notification_suppressions.reason = 'user-stop' THEN excluded.reason ELSE notification_suppressions.reason END`).bind(row.email_destination_hash, reason, now, ...values),
        database.prepare(`UPDATE notification_outbox SET version = version + 1, status = 'invalidated', payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = COALESCE(terminal_at, ?) WHERE contact_id = ? AND expected_capability_generation = ? AND status IN ('pending', 'queued', 'claimed') AND EXISTS (SELECT 1 FROM notification_contacts WHERE ${contact}) AND ${guard}`).bind(now, now, row.contact_id, row.expected_capability_generation, ...contactValues, ...values),
        database.prepare(`DELETE FROM notification_contacts WHERE ${contact} AND ${guard}`).bind(...contactValues, ...values),
      )
    }
    const committed = await database.batch(statements) as { meta?: { changes?: number } }[]
    const applied = committed[0]?.meta?.changes === 1
    return { applied, suppressed: applied && Boolean(reason) && committed[2]?.meta?.changes === 1 }
  }
  const delivery = await database.prepare('SELECT id, channel, contact_id, expected_capability_generation, destination_hash, provider_message_id, status FROM notification_event_deliveries WHERE id = ?').bind(event.deliveryId).first<DeliveryRow>()
  if (!delivery || delivery.channel !== 'email' || (delivery.provider_message_id && event.providerMessageId && delivery.provider_message_id !== event.providerMessageId)) return { applied: false, suppressed: false }

  const now = new Date().toISOString()
  const receipt = await receiptKey(event)
  const receiptGuard = "EXISTS (SELECT 1 FROM notification_delivery_callbacks WHERE provider_event_id = ? AND delivery_id = ? AND event = ? AND provider_message_id IS ?) AND EXISTS (SELECT 1 FROM notification_event_deliveries WHERE id = ? AND channel = 'email' AND (provider_message_id IS NULL OR ? IS NULL OR provider_message_id = ?))"
  const guardValues = [receipt, event.deliveryId, event.kind, event.providerMessageId ?? null, event.deliveryId, event.providerMessageId ?? null, event.providerMessageId ?? null]
  const statements = [
    database.prepare("INSERT INTO notification_delivery_callbacks (provider_event_id, delivery_id, event, provider_message_id, received_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_event_deliveries WHERE id = ? AND channel = 'email' AND (provider_message_id IS NULL OR ? IS NULL OR provider_message_id = ?)) ON CONFLICT(provider_event_id) DO NOTHING").bind(receipt, event.deliveryId, event.kind, event.providerMessageId ?? null, event.occurredAt, event.deliveryId, event.providerMessageId ?? null, event.providerMessageId ?? null),
    database.prepare(`UPDATE notification_event_deliveries SET status = CASE WHEN (CASE status WHEN 'delivered' THEN 1 WHEN 'soft-bounce' THEN 2 WHEN 'blocked' THEN 2 WHEN 'hard-bounce' THEN 3 WHEN 'complaint' THEN 3 WHEN 'unsubscribed' THEN 3 ELSE 0 END) < ? THEN ? ELSE status END, provider_message_id = COALESCE(provider_message_id, ?), updated_at = ? WHERE id = ? AND ${receiptGuard}`).bind(terminalRank[event.kind], event.kind, event.providerMessageId ?? null, now, event.deliveryId, ...guardValues),
  ]
  const reason = suppressionReason[event.kind]
  if (reason) {
    statements.push(
      database.prepare(`INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT ?, ?, ?, ? WHERE ${receiptGuard} ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = CASE WHEN notification_suppressions.reason = 'user-stop' THEN excluded.reason ELSE notification_suppressions.reason END`).bind('email', delivery.destination_hash, reason, now, ...guardValues),
      database.prepare(`UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND expected_capability_generation = ? AND status IN (?, ?, ?) AND EXISTS (SELECT 1 FROM notification_contacts WHERE id = ? AND capability_generation = ?) AND ${receiptGuard}`).bind('invalidated', now, now, delivery.contact_id, delivery.expected_capability_generation, 'pending', 'queued', 'claimed', delivery.contact_id, delivery.expected_capability_generation, ...guardValues),
      database.prepare(`DELETE FROM notification_contacts WHERE id = ? AND channel = 'email' AND capability_generation = ? AND ${receiptGuard}`).bind(delivery.contact_id, delivery.expected_capability_generation, ...guardValues),
    )
  }
  const committed = await database.batch(statements) as { meta?: { changes?: number } }[]
  const applied = committed[0]?.meta?.changes === 1
  return { applied, suppressed: applied && Boolean(reason) }
}
