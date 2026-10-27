import { notificationConfig } from '../utils/notificationConfig.ts'
import { planEventNotifications } from '../utils/eventEmailNotifications.ts'
import { publishPendingNotificationPointers, type NotificationMessagesQueue } from '../utils/notificationMessagesQueue.ts'
import type { NotificationDatabase } from '../utils/notifications.ts'
import { getPortalCalendarEvents, PortalEventsError, type PortalStorage } from '../utils/portalEvents.ts'

interface NotificationMessagesTaskContext {
  notificationMessagesQueue?: NotificationMessagesQueue
  notificationDatabase?: NotificationDatabase
  portalStorage?: PortalStorage
  cloudflare?: { env?: Record<string, unknown> }
}

export const drainNotificationMessages = async (context: NotificationMessagesTaskContext, runtimeConfig: Record<string, unknown>, options: { planning: boolean, now?: () => Date } = { planning: true }) => {
  const queue = context.notificationMessagesQueue
    ?? context.cloudflare?.env?.NOTIFICATION_MESSAGES_QUEUE as NotificationMessagesQueue | undefined
  const database = context.notificationDatabase
    ?? context.cloudflare?.env?.DB as NotificationDatabase | undefined
  if (!database?.prepare || !database.batch) throw new Error('Notification database is not configured')

  let expired = 0
  let remainingExpired: number | null = null
  let oldestExpiredAt: string | null = null
  const lifecycleExpiry = {
    receiptsDeleted: 0, evidenceCleared: 0, mutationStatements: 0,
    remainingWorkRows: null as number | null,
    remainingReceiptsAtLeast: null as number | null, remainingEvidenceAtLeast: null as number | null,
    receiptBacklogTruncated: null as boolean | null, evidenceBacklogTruncated: null as boolean | null,
    oldestReceiptTerminalAt: null as string | null, oldestEvidenceTerminalAt: null as string | null,
    malformedOwnersAtLeast: null as number | null, malformedBacklogTruncated: null as boolean | null,
    deferred: true, failed: false,
  }
  // The minute owner expires traffic-independent attempts before any private config,
  // calendar access or publication. The cutoff is fixed for this invocation.
  if (!options.planning) {
    const cutoff = (options.now?.() ?? new Date()).toISOString()
    let failed = false
    try {
      for (let page = 0; page < 4; page++) {
        const result = await database.prepare('DELETE FROM notification_abuse_attempts WHERE id IN (SELECT id FROM notification_abuse_attempts WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 500)').bind(cutoff).run() as { meta?: { changes?: number } }
        const changes = result?.meta?.changes
        if (!Number.isSafeInteger(changes) || changes! < 0 || changes! > 500) throw new Error('Invalid expiry result')
        expired += changes!
        if (changes! < 500) break
      }
    } catch { failed = true }
    try {
      const remaining = await database.prepare('SELECT COUNT(*) AS remaining, MIN(expires_at) AS oldest FROM notification_abuse_attempts WHERE expires_at <= ?').bind(cutoff).first<{ remaining: number, oldest: string | null }>()
      if (!remaining || !Number.isSafeInteger(remaining.remaining) || remaining.remaining < 0) throw new Error('Invalid expiry accounting')
      remainingExpired = remaining.remaining
      oldestExpiredAt = remaining.oldest
    } catch { failed = true }
    const diagnostic = { expired, remainingExpired, oldestExpiredAt }
    if (failed || remainingExpired) console.warn('[notifications] Attempt expiry backlog', diagnostic)
    else console.info('[notifications] Attempt expiry backlog', diagnostic)
    if (failed) throw new Error('Notification attempt expiry failed')

    // Work-row envelope, not a CPU or wall-time guarantee. Abuse keeps its full
    // priority/max; receipts and field clears share only actual remaining rows.
    const evidence = '(o.email_destination_hash IS NOT NULL OR o.email_provider_message_id IS NOT NULL OR o.email_delivery_status IS NOT NULL OR o.email_attempted_at IS NOT NULL OR o.email_attempt_version IS NOT NULL)'
    const lifecycle = "o.kind IN ('first-activation', 'reactivation', 'management-recovery') AND o.status IN ('consumed', 'invalidated')"
    const validTerminal = "strftime('%Y-%m-%dT%H:%M:%fZ', o.terminal_at, '+0 seconds') = o.terminal_at"
    const eligible = `${lifecycle} AND ${validTerminal} AND julianday(o.terminal_at) <= julianday(?) - 30`
    let remaining = 2000 - expired
    try {
      for (const receipts of [true, false]) {
        while (remaining > 0 && lifecycleExpiry.mutationStatements < 4) {
          const limit = Math.min(500, remaining)
          const sql = receipts
            ? `DELETE FROM notification_lifecycle_email_callbacks WHERE receipt_key IN (SELECT cb.receipt_key FROM notification_lifecycle_email_callbacks cb JOIN notification_outbox o ON o.id = cb.outbox_id WHERE ${eligible} ORDER BY o.terminal_at, cb.receipt_key LIMIT ?)`
            : `UPDATE notification_outbox SET email_destination_hash = NULL, email_provider_message_id = NULL, email_delivery_status = NULL, email_attempted_at = NULL, email_attempt_version = NULL WHERE id IN (SELECT o.id FROM notification_outbox o WHERE ${eligible} AND ${evidence} AND NOT EXISTS (SELECT 1 FROM notification_lifecycle_email_callbacks cb WHERE cb.outbox_id = o.id) ORDER BY o.terminal_at, o.id LIMIT ?)`
          lifecycleExpiry.mutationStatements++
          const result = await database.prepare(sql).bind(cutoff, limit).run() as { meta?: { changes?: number } }
          const changes = result?.meta?.changes
          if (!Number.isSafeInteger(changes) || changes! < 0 || changes! > limit) throw new Error('Invalid lifecycle expiry result')
          if (receipts) lifecycleExpiry.receiptsDeleted += changes!
          else lifecycleExpiry.evidenceCleared += changes!
          remaining -= changes!
          if (changes! < limit) break
        }
      }
      lifecycleExpiry.remainingWorkRows = remaining
    } catch { lifecycleExpiry.failed = true }
    // Bounded samples explicitly report lower bounds/overflow, never false exact
    // totals. LIMIT bounds result/work cardinality, not underlying scan cost.
    try {
      const result = await database.prepare(`SELECT COUNT(*) AS remaining, MIN(terminal_at) AS oldest FROM (SELECT o.terminal_at FROM notification_lifecycle_email_callbacks cb JOIN notification_outbox o ON o.id = cb.outbox_id WHERE ${eligible} ORDER BY o.terminal_at, cb.receipt_key LIMIT 501)`)
        .bind(cutoff).first<{ remaining: number, oldest: string | null }>()
      if (!result || !Number.isSafeInteger(result.remaining) || result.remaining < 0 || result.remaining > 501) throw new Error('Invalid lifecycle expiry accounting')
      lifecycleExpiry.remainingReceiptsAtLeast = result.remaining
      lifecycleExpiry.receiptBacklogTruncated = result.remaining === 501
      lifecycleExpiry.oldestReceiptTerminalAt = result.oldest
    } catch { lifecycleExpiry.failed = true }
    try {
      const result = await database.prepare(`SELECT COUNT(*) AS remaining, MIN(terminal_at) AS oldest,
        (SELECT COUNT(*) FROM (SELECT o.id FROM notification_outbox o WHERE ${lifecycle} AND ${evidence} AND COALESCE((${validTerminal}), 0) = 0 LIMIT 501)) AS malformed
        FROM (SELECT o.terminal_at FROM notification_outbox o WHERE ${eligible} AND ${evidence} ORDER BY o.terminal_at, o.id LIMIT 501)`)
        .bind(cutoff).first<{ remaining: number, oldest: string | null, malformed: number }>()
      if (!result || ![result.remaining, result.malformed].every(count => Number.isSafeInteger(count) && count >= 0 && count <= 501)) throw new Error('Invalid lifecycle expiry accounting')
      lifecycleExpiry.remainingEvidenceAtLeast = result.remaining
      lifecycleExpiry.evidenceBacklogTruncated = result.remaining === 501
      lifecycleExpiry.oldestEvidenceTerminalAt = result.oldest
      lifecycleExpiry.malformedOwnersAtLeast = result.malformed
      lifecycleExpiry.malformedBacklogTruncated = result.malformed === 501
    } catch { lifecycleExpiry.failed = true }
    if (lifecycleExpiry.failed) lifecycleExpiry.remainingWorkRows = null
    lifecycleExpiry.deferred = lifecycleExpiry.failed || Boolean(lifecycleExpiry.remainingReceiptsAtLeast || lifecycleExpiry.remainingEvidenceAtLeast || lifecycleExpiry.malformedOwnersAtLeast)
    if (lifecycleExpiry.deferred) console.warn('[notifications] Lifecycle email expiry backlog', lifecycleExpiry)
    else console.info('[notifications] Lifecycle email expiry backlog', lifecycleExpiry)
    if (lifecycleExpiry.failed) throw new Error('Notification lifecycle email expiry failed')
  }
  if (!queue?.send) throw new Error('Notification messages queue is not configured')

  const errors: Error[] = []
  let planned: number | null = null
  let stage = 'calendar'
  if (options.planning) try {
    const config = await notificationConfig(runtimeConfig)
    const events = await getPortalCalendarEvents(config.communitySlugs, context.portalStorage ?? useStorage('portalEvents'))
    stage = 'planner'
    planned = (await planEventNotifications(events, { database, config })).planned
  } catch (error) {
    const category = stage === 'calendar' && error instanceof PortalEventsError
      ? error.statusCode === 404 ? 'calendar-404' : 'calendar-503'
      : stage
    errors.push(new Error(`Notification event planning failed (${category})`))
  }

  // Already committed lifecycle work must drain even when calendar/planning fails.
  // Report sanitized failures only after drain, retaining both if publication fails too.
  let published = 0
  try {
    published = (await publishPendingNotificationPointers(queue, { database, now: options.now }, options.planning ? 25 : { lifecycleLimit: 100, eventLimit: 300, budgetMs: 20000 })).published
  } catch {
    errors.push(new Error('Notification pointer publication failed'))
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Notification planning and publication failed')
  console.info('[notifications] Notification pointer drain completed', { planned, published })
  return { published, planned, ...(!options.planning ? { expired, remainingExpired, oldestExpiredAt, lifecycleExpiry } : {}) }
}

export default defineTask({
  meta: {
    name: 'notification-messages',
    description: 'Publish bounded durable notification outbox pointers',
  },
  async run(event) {
    const result = await drainNotificationMessages(event.context as NotificationMessagesTaskContext, useRuntimeConfig() as unknown as Record<string, unknown>)
    return { result: { queued: result.published, planned: result.planned } }
  },
})
