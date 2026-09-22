import { projectCalendarEvent } from './calendarEventProjection.ts'
import type { NotificationCrypto, NotificationDatabase, NotificationLifecycleConfig } from './notifications.ts'
import type { PortalCalendarEvent } from './portalEvents.ts'

export type EventEmailReason = 'created' | 'week-before' | 'day-before'

const encoder = new TextEncoder()
const parts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
}).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value])) as Record<string, string>
const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const buffer = (value: Uint8Array) => value as unknown as BufferSource
const defaultCrypto = (): NotificationCrypto => ({ randomBytes: length => crypto.getRandomValues(new Uint8Array(length)), subtle: crypto.subtle })

/** Returns Prague-time delivery reasons; callers may safely repeat it every hour. */
export const dueEventEmailReasons = (event: Pick<PortalCalendarEvent, 'event' | 'cancelled'>, now: Date): EventEmailReason[] => {
  if (event.cancelled || Date.parse(event.event.start) <= now.getTime()) return []
  const current = parts(now)
  if (current.hour !== '09') return []
  const start = parts(new Date(event.event.start))
  const day = 86_400_000
  const currentDay = Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day))
  const startDay = Date.UTC(Number(start.year), Number(start.month) - 1, Number(start.day))
  const days = Math.round((startDay - currentDay) / day)
  return [
    ...(days === 7 ? ['week-before' as const] : []),
    ...(days === 1 ? ['day-before' as const] : []),
  ]
}

interface ActiveRecipient { id: number, destination: string, destination_hash: string, capability_generation: number, frequency: EventEmailReason, channel: 'email' | 'sms' }

const encrypt = async (value: unknown, config: NotificationLifecycleConfig, cryptoApi: NotificationCrypto) => {
  const iv = cryptoApi.randomBytes(12)
  const payload = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv: buffer(iv) }, config.outboxTransportKey, encoder.encode(JSON.stringify(value)))
  return { ciphertext: base64Url(new Uint8Array(payload)), iv: base64Url(iv) }
}
const digest = async (value: string, cryptoApi: NotificationCrypto) => base64Url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(value))))

/** Atomically creates encrypted, generation-bound event email work. Unique D1 identities make retries inert. */
export const planEventNotifications = async (events: PortalCalendarEvent[], dependencies: { database: NotificationDatabase, config: NotificationLifecycleConfig, now?: () => Date, crypto?: NotificationCrypto }) => {
  const emailPlanningEnabled = dependencies.config.emailSmsEnabled
    && dependencies.config.emailSmsEventDeliveryReady
    && dependencies.config.emailDeliveryReady
  const smsPlanningEnabled = dependencies.config.smsEnabled
    && dependencies.config.smsEventDeliveryReady
    && dependencies.config.smsDeliveryReady
  if (!emailPlanningEnabled && !smsPlanningEnabled) return { planned: 0 }
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  const now = dependencies.now?.() ?? new Date()
  let planned = 0
  // The shipped D1 CHECK constraint excludes event-sms. Keep the independent
  // SMS gate explicit, but never create invalid outbox rows until a reviewed
  // forward migration proves the deployed schema accepts that kind.
  const smsBlockedBySchema = smsPlanningEnabled && !dependencies.config.eventSmsOutboxSupported
  for (const item of events) {
    const reasons = [...new Set(EventEmailReasons(item, now))]
    for (const reason of reasons) {
      if (!emailPlanningEnabled) continue
      const { results } = await dependencies.database.prepare('SELECT c.id, c.destination, c.destination_hash, c.capability_generation, s.frequency FROM notification_contacts c JOIN notification_subscriptions s ON s.contact_id = c.id WHERE c.channel = ? AND c.state = ? AND s.community_slug = ? AND s.frequency = ? AND NOT EXISTS (SELECT 1 FROM notification_suppressions x WHERE x.channel = c.channel AND x.destination_hash = c.destination_hash)')
        .bind('email', 'active', item.community.id, reason).all<ActiveRecipient>()
      for (const recipient of results) {
        const projection = projectCalendarEvent(item)
        const uid = `${item.community.id}-${item.event.id}@jednadvacet.org`
        // These opaque identifiers are deterministic per immutable delivery identity.
        // Retried refreshes therefore cannot create an orphan outbox/alias after the
        // ledger's unique insert has already won.
        const identity = `${recipient.id}:${uid}:${item.sequence}:${reason}`
        const deliveryId = await digest(`delivery:${identity}`, cryptoApi)
        const capability = await digest(`capability:${identity}`, cryptoApi)
        const encrypted = await encrypt({ destination: recipient.destination, deliveryId, managementCapability: capability, event: { ...projection, uid, sequence: item.sequence, cancelled: item.cancelled }, reason, kind: 'event-email' }, dependencies.config, cryptoApi)
        const timestamp = now.toISOString()
        const writes = [
          dependencies.database.prepare('INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(contact_id, event_uid, event_revision, reason) DO NOTHING').bind(deliveryId, recipient.id, recipient.capability_generation, recipient.destination_hash, uid, item.sequence, reason, 'pending', timestamp, timestamp),
          dependencies.database.prepare('INSERT INTO notification_management_capabilities (token_digest, contact_id, expected_capability_generation, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(token_digest) DO NOTHING').bind(await digest(capability, cryptoApi), recipient.id, recipient.capability_generation, timestamp),
          dependencies.database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(`event-${deliveryId}`, recipient.id, 1, recipient.capability_generation, 'pending', encrypted.ciphertext, encrypted.iv, 'event-email', timestamp, timestamp),
        ]
        await dependencies.database.batch(writes)
        planned += 1
      }
    }
  }
  return { planned, ...(smsBlockedBySchema ? { smsBlockedBySchema: true } : {}) }
}

const EventEmailReasons = (event: PortalCalendarEvent, now: Date): EventEmailReason[] => {
  const due = dueEventEmailReasons(event, now)
  return due.length ? due : (Date.parse(event.event.start) > now.getTime() ? ['created'] : [])
}
