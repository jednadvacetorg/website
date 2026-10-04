import { projectCalendarEvent } from './calendarEventProjection.ts'
import type { NotificationCrypto, NotificationDatabase, NotificationLifecycleConfig, NotificationStatement } from './notifications.ts'
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

interface ActiveRecipient { id: number, destination: string, destination_hash: string, capability_generation: number, frequency: EventEmailReason }
interface EventState { uid: string, starts_at: string, ends_at: string, venue: string | null, cancelled: number, notification_revision: number, updated_at: string }
type DeliveryReason = EventEmailReason | 'updated' | 'cancelled'

const encrypt = async (value: unknown, config: NotificationLifecycleConfig, cryptoApi: NotificationCrypto) => {
  const iv = cryptoApi.randomBytes(12)
  const payload = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv: buffer(iv) }, config.outboxTransportKey, encoder.encode(JSON.stringify(value)))
  return { ciphertext: base64Url(new Uint8Array(payload)), iv: base64Url(iv) }
}
const digest = async (value: string, cryptoApi: NotificationCrypto) => base64Url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', encoder.encode(value))))

/** Material state and all its recipient work commit together. Portal changedAt is the source watermark. */
export const planEventNotifications = async (events: PortalCalendarEvent[], dependencies: { database: NotificationDatabase, config: NotificationLifecycleConfig, now?: () => Date, crypto?: NotificationCrypto }) => {
  const emailPlanningEnabled = dependencies.config.emailSmsEnabled
    && dependencies.config.emailSmsEventDeliveryReady
    && dependencies.config.emailDeliveryReady
  const smsPlanningEnabled = dependencies.config.smsEnabled
    && dependencies.config.smsEventDeliveryReady
    && dependencies.config.smsDeliveryReady
  const database = dependencies.database
  const cryptoApi = dependencies.crypto ?? defaultCrypto()
  const now = dependencies.now?.() ?? new Date()
  const timestamp = now.toISOString()
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000).toISOString()
  await database.prepare('DELETE FROM notification_management_capabilities WHERE expires_at <= ? OR NOT EXISTS (SELECT 1 FROM notification_contacts c WHERE c.id = contact_id AND c.capability_generation = expected_capability_generation)').bind(timestamp).run()
  let planned = 0
  // The shipped D1 CHECK constraint excludes event-sms. Keep the independent
  // SMS gate explicit, but never create invalid outbox rows until a reviewed
  // forward migration proves the deployed schema accepts that kind.
  const smsBlockedBySchema = smsPlanningEnabled && !dependencies.config.eventSmsOutboxSupported
  for (const item of events) {
    if (!dependencies.config.communitySlugs.includes(item.community.id)) continue
    const eventKey = JSON.stringify([item.community.id, item.event.id])
    const previous = await database.prepare('SELECT uid, starts_at, ends_at, venue, cancelled, notification_revision, updated_at FROM notification_event_state WHERE event_key = ?').bind(eventKey).first<EventState>()
    const sourceTime = new Date(item.changedAt).toISOString()
    if (previous && sourceTime < previous.updated_at) continue
    const projection = projectCalendarEvent(item)
    projection.start = new Date(projection.start).toISOString()
    projection.end = new Date(projection.end).toISOString()
    const venue = projection.location?.trim().replace(/\s+/g, ' ') || null
    const materialDiffers = Boolean(previous && (previous.starts_at !== projection.start || previous.ends_at !== projection.end || previous.venue !== venue || previous.cancelled !== Number(item.cancelled)))
    const materialChanged = Boolean(previous && sourceTime > previous.updated_at && materialDiffers)
    // Equal watermarks must not allow a conflicting snapshot to move state backwards.
    if (previous && sourceTime === previous.updated_at && materialDiffers) continue
    const revision = (previous?.notification_revision ?? 0) + Number(materialChanged)
    const uid = previous?.uid ?? `${item.community.id}-${item.event.id}@jednadvacet.org`
    const { results } = await database.prepare("SELECT c.id, c.destination, c.destination_hash, c.capability_generation, s.frequency FROM notification_contacts c JOIN notification_subscriptions s ON s.contact_id = c.id WHERE c.channel = 'email' AND c.state = 'active' AND s.community_slug = ? AND NOT EXISTS (SELECT 1 FROM notification_suppressions x WHERE x.channel = c.channel AND x.destination_hash = c.destination_hash)").bind(item.community.id).all<ActiveRecipient>()
    const recipients = new Map<number, { recipient: ActiveRecipient, selected: EventEmailReason[] }>()
    for (const recipient of results) {
      const entry = recipients.get(recipient.id) ?? { recipient, selected: [] }
      entry.selected.push(recipient.frequency)
      recipients.set(recipient.id, entry)
    }
    // One bound JSON value avoids D1's parameter limit as the recipient set grows.
    const snapshotGuard = "NOT EXISTS (SELECT 1 FROM json_each(?) r LEFT JOIN notification_contacts c ON c.id = json_extract(r.value, '$[0]') WHERE c.id IS NULL OR c.capability_generation <> json_extract(r.value, '$[1]'))"
    const snapshotValues = [JSON.stringify([...recipients.values()].map(({ recipient }) => [recipient.id, recipient.capability_generation]))]
    const stateGuard = (previous
      ? 'EXISTS (SELECT 1 FROM notification_event_state WHERE event_key = ? AND notification_revision = ? AND updated_at = ?)'
      : 'NOT EXISTS (SELECT 1 FROM notification_event_state WHERE event_key = ?)') + ` AND ${snapshotGuard}`
    const stateValues = [...(previous ? [eventKey, previous.notification_revision, previous.updated_at] : [eventKey]), ...snapshotValues]
    const writes: NotificationStatement[] = []
    const insertedOutboxes: number[] = []
    if (materialChanged) {
      writes.push(database.prepare(`UPDATE notification_outbox SET version = version + 1, status = 'invalidated', payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE kind = 'event-email' AND status IN ('pending', 'queued', 'claimed') AND EXISTS (SELECT 1 FROM notification_event_deliveries d WHERE d.event_uid = ? AND d.event_revision < ? AND (notification_outbox.id = 'event-' || d.id OR substr(notification_outbox.id, 1, length('event-' || d.id || '-g')) = 'event-' || d.id || '-g')) AND ${stateGuard}`).bind(timestamp, timestamp, uid, revision, ...stateValues))
      writes.push(database.prepare(`UPDATE notification_event_deliveries SET status = 'failed', updated_at = ? WHERE event_uid = ? AND event_revision < ? AND status = 'pending' AND ${stateGuard}`).bind(timestamp, uid, revision, ...stateValues))
    }
    if (!emailPlanningEnabled) {
      writes.push(database.prepare(`UPDATE notification_outbox SET version = version + 1, status = 'invalidated', payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE kind = 'event-email' AND status IN ('pending', 'queued', 'claimed') AND EXISTS (SELECT 1 FROM notification_event_deliveries d WHERE d.event_uid = ? AND d.status = 'pending' AND (notification_outbox.id = 'event-' || d.id OR substr(notification_outbox.id, 1, length('event-' || d.id || '-g')) = 'event-' || d.id || '-g')) AND ${stateGuard}`).bind(timestamp, timestamp, uid, ...stateValues))
      writes.push(database.prepare(`UPDATE notification_event_deliveries SET status = 'failed', updated_at = ? WHERE event_uid = ? AND status = 'pending' AND ${stateGuard}`).bind(timestamp, uid, ...stateValues))
    }
    const due = dueEventEmailReasons(item, now)
    const startDay = parts(new Date(projection.start))
    const startLocalDay = Date.UTC(Number(startDay.year), Number(startDay.month) - 1, Number(startDay.day))
    const localNow = parts(now)
    const localNowDay = Date.UTC(Number(localNow.year), Number(localNow.month) - 1, Number(localNow.day))
    for (const { recipient, selected } of recipients.values()) {
      const reasons = new Set<DeliveryReason>()
      if (!item.cancelled && Date.parse(projection.start) > now.getTime()) {
        for (const reason of due) if (selected.includes(reason)) reasons.add(reason)
        const elapsedReminder = selected.some(reason => {
          if (reason === 'created') return false
          const reminderDay = startLocalDay - (reason === 'week-before' ? 7 : 1) * 86_400_000
          return localNowDay > reminderDay || (localNowDay === reminderDay && Number(localNow.hour) > 9)
        })
        if (!previous && (selected.includes('created') || elapsedReminder)) reasons.add('created')
      }
      if (materialChanged) reasons.add(item.cancelled ? 'cancelled' : 'updated')
      // Recovery is for unsent ledger work only, never a reason to resend terminal/submitted work.
      const pending = await database.prepare("SELECT reason FROM notification_event_deliveries WHERE contact_id = ? AND event_uid = ? AND event_revision = ? AND status = 'pending' AND submitted_at IS NULL AND expected_capability_generation <> ?").bind(recipient.id, uid, revision, recipient.capability_generation).all<{ reason: DeliveryReason }>()
      for (const row of pending.results) if (row.reason === 'cancelled' || (!item.cancelled && Date.parse(projection.start) > now.getTime())) reasons.add(row.reason)
      for (const reason of reasons) {
        const revisionReason = reason === 'updated' || reason === 'cancelled'
        const allowed = revisionReason || reason === 'created' ? selected : selected.filter(frequency => frequency === reason)
        if (!allowed.length) continue
        const authority = `EXISTS (SELECT 1 FROM notification_contacts c JOIN notification_subscriptions s ON s.contact_id = c.id WHERE c.id = ? AND c.channel = 'email' AND c.state = 'active' AND c.capability_generation = ? AND c.destination = ? AND s.community_slug = ? AND s.frequency IN (${allowed.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM notification_suppressions x WHERE x.channel = c.channel AND x.destination_hash = c.destination_hash))${revisionReason ? " AND EXISTS (SELECT 1 FROM notification_event_deliveries WHERE contact_id = ? AND event_uid = ? AND status IN ('submitted', 'delivered'))" : ''} AND ${stateGuard}`
        const authorityValues = [recipient.id, recipient.capability_generation, recipient.destination, item.community.id, ...allowed, ...(revisionReason ? [recipient.id, uid] : []), ...stateValues]
        const deliveryId = await digest(`delivery:${recipient.id}:${uid}:${revision}:${reason}`, cryptoApi)
        writes.push(database.prepare(`INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${authority} ON CONFLICT(contact_id, event_uid, event_revision, reason) DO NOTHING`).bind(deliveryId, recipient.id, recipient.capability_generation, recipient.destination_hash, uid, revision, reason, emailPlanningEnabled ? 'pending' : 'failed', timestamp, timestamp, ...authorityValues))
        writes.push(database.prepare(`UPDATE notification_event_deliveries SET expected_capability_generation = ?, status = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND submitted_at IS NULL AND expected_capability_generation <> ? AND ${authority}`).bind(recipient.capability_generation, emailPlanningEnabled ? 'pending' : 'failed', timestamp, deliveryId, recipient.capability_generation, ...authorityValues))
        if (!emailPlanningEnabled) continue
        const capability = base64Url(cryptoApi.randomBytes(32))
        const encrypted = await encrypt({ destination: recipient.destination, deliveryId, managementCapability: capability, event: { ...projection, uid, sequence: revision, cancelled: item.cancelled }, reason, kind: 'event-email' }, dependencies.config, cryptoApi)
        const outboxId = `event-${deliveryId}-g${recipient.capability_generation}`
        const ledgerGuard = "EXISTS (SELECT 1 FROM notification_event_deliveries WHERE id = ? AND status = 'pending' AND submitted_at IS NULL AND expected_capability_generation = ?)"
        writes.push(database.prepare(`UPDATE notification_outbox SET version = version + 1, status = 'invalidated', payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?, terminal_at = ? WHERE (id = ? OR substr(id, 1, length(?)) = ?) AND expected_capability_generation <> ? AND status IN ('pending', 'queued', 'claimed') AND ${authority}`).bind(timestamp, timestamp, `event-${deliveryId}`, `event-${deliveryId}-g`, `event-${deliveryId}-g`, recipient.capability_generation, ...authorityValues))
        insertedOutboxes.push(writes.length)
        writes.push(database.prepare(`INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, kind, created_at, updated_at) SELECT ?, ?, 1, ?, 'pending', ?, ?, 'event-email', ?, ? WHERE ${ledgerGuard} AND ${authority} ON CONFLICT(id) DO NOTHING`).bind(outboxId, recipient.id, recipient.capability_generation, encrypted.ciphertext, encrypted.iv, timestamp, timestamp, deliveryId, recipient.capability_generation, ...authorityValues))
        // The ciphertext proves ownership of this exact winning insert, even across overlapping planners.
        writes.push(database.prepare('INSERT INTO notification_management_capabilities (token_digest, contact_id, expected_capability_generation, created_at, expires_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_outbox WHERE id = ? AND payload_ciphertext = ?)').bind(await digest(capability, cryptoApi), recipient.id, recipient.capability_generation, timestamp, expiresAt, outboxId, encrypted.ciphertext))
      }
    }
    if (previous) writes.push(database.prepare(`UPDATE notification_event_state SET starts_at = ?, ends_at = ?, venue = ?, cancelled = ?, notification_revision = ?, updated_at = ? WHERE event_key = ? AND ${stateGuard}`).bind(projection.start, projection.end, venue, Number(item.cancelled), revision, sourceTime, eventKey, ...stateValues))
    else writes.push(database.prepare(`INSERT INTO notification_event_state (event_key, uid, starts_at, ends_at, venue, cancelled, notification_revision, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${stateGuard}`).bind(eventKey, uid, projection.start, projection.end, venue, Number(item.cancelled), revision, sourceTime, ...stateValues))
    const committed = await database.batch(writes) as { meta?: { changes?: number } }[]
    for (const index of insertedOutboxes) planned += committed[index]?.meta?.changes ?? 0
  }
  return { planned, ...(smsBlockedBySchema ? { smsBlockedBySchema: true } : {}) }
}
