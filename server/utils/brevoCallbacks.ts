import type { NotificationDatabase } from './notifications.ts'

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
  contact_id: number | null
  expected_capability_generation: number
  destination_hash: string
  provider_message_id: string | null
  status: string
}

const callbackKinds: Record<string, BrevoCallbackKind> = {
  delivered: 'delivered',
  'soft-bounce': 'soft-bounce',
  'hard-bounce': 'hard-bounce',
  blocked: 'blocked',
  complaint: 'complaint',
  unsubscribed: 'unsubscribed',
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const opaque = (value: unknown, maximum = 256) => typeof value === 'string' && /^[A-Za-z0-9_-]{12,}$/.test(value) && value.length <= maximum
const safeDate = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined

/** Narrows documented Brevo payload fields into opaque local callback evidence. */
export const normalizeBrevoCallback = (value: unknown): BrevoCallbackEvent | undefined => {
  if (!isRecord(value)) return
  const event = typeof value.event === 'string' ? value.event.toLowerCase() : ''
  const kind = callbackKinds[event]
  const id = value.id ?? value.eventId
  const deliveryId = value['X-Mailin-custom'] ?? value.deliveryId
  const providerMessageId = value.messageId
  const occurredAt = safeDate(value.date) ?? safeDate(value.occurredAt) ?? new Date().toISOString()
  if (!kind || !opaque(id) || !opaque(deliveryId) || (providerMessageId !== undefined && !opaque(providerMessageId))) return
  return { id: id as string, deliveryId: deliveryId as string, kind, ...(typeof providerMessageId === 'string' ? { providerMessageId } : {}), occurredAt }
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
const currentRank = (status: string) => status in terminalRank ? terminalRank[status as BrevoCallbackKind] : 0

/** Applies a callback by opaque delivery ID only; provider IDs must agree once persisted. */
export const applyBrevoCallback = async (event: BrevoCallbackEvent, database: NotificationDatabase) => {
  const delivery = await database.prepare('SELECT id, contact_id, expected_capability_generation, destination_hash, provider_message_id, status FROM notification_event_deliveries WHERE id = ?').bind(event.deliveryId).first<DeliveryRow>()
  if (!delivery || (delivery.provider_message_id && event.providerMessageId && delivery.provider_message_id !== event.providerMessageId)) return { applied: false, suppressed: false }

  const status = currentRank(delivery.status) > terminalRank[event.kind] ? delivery.status : event.kind
  const now = new Date().toISOString()
  const statements = [
    database.prepare('INSERT INTO notification_delivery_callbacks (provider_event_id, delivery_id, event, provider_message_id, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider_event_id) DO NOTHING').bind(event.id, event.deliveryId, event.kind, event.providerMessageId ?? null, event.occurredAt),
    database.prepare('UPDATE notification_event_deliveries SET status = ?, provider_message_id = COALESCE(provider_message_id, ?), updated_at = ? WHERE id = ?').bind(status, event.providerMessageId ?? null, now, event.deliveryId),
  ]
  const reason = suppressionReason[event.kind]
  if (reason) {
    statements.push(
      database.prepare('INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) VALUES (?, ?, ?, ?) ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = excluded.reason, suppressed_at = excluded.suppressed_at').bind('email', delivery.destination_hash, reason, now),
      database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE contact_id = ? AND expected_capability_generation = ? AND status IN (?, ?, ?)').bind('invalidated', now, now, delivery.contact_id, delivery.expected_capability_generation, 'pending', 'queued', 'claimed'),
      database.prepare('DELETE FROM notification_contacts WHERE id = ? AND capability_generation = ?').bind(delivery.contact_id, delivery.expected_capability_generation),
    )
  }
  await database.batch(statements)
  return { applied: true, suppressed: Boolean(reason) }
}
