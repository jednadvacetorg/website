import { notificationConfig } from '../utils/notificationConfig.ts'
import { planEventNotifications } from '../utils/eventEmailNotifications.ts'
import { publishPendingNotificationPointers, type NotificationMessagesQueue } from '../utils/notificationMessagesQueue.ts'
import type { NotificationDatabase } from '../utils/notifications.ts'
import { getPortalCalendarEvents, type PortalStorage } from '../utils/portalEvents.ts'

interface NotificationMessagesTaskContext {
  notificationMessagesQueue?: NotificationMessagesQueue
  notificationDatabase?: NotificationDatabase
  portalStorage?: PortalStorage
  cloudflare?: { env?: Record<string, unknown> }
}

export const drainNotificationMessages = async (context: NotificationMessagesTaskContext, runtimeConfig: Record<string, unknown>) => {
  const queue = context.notificationMessagesQueue
    ?? context.cloudflare?.env?.NOTIFICATION_MESSAGES_QUEUE as NotificationMessagesQueue | undefined
  const database = context.notificationDatabase
    ?? context.cloudflare?.env?.DB as NotificationDatabase | undefined
  if (!queue?.send) throw new Error('Notification messages queue is not configured')
  if (!database?.prepare || !database.batch) throw new Error('Notification database is not configured')

  const config = await notificationConfig(runtimeConfig)
  // Read the validated snapshot before publishing pointers. Repeated hourly runs are
  // harmless because the delivery ledger has a stable D1 dedupe identity.
  const planned = await planEventNotifications(
    await getPortalCalendarEvents(config.communitySlugs, context.portalStorage ?? useStorage('portalEvents')),
    { database, config },
  )
  const result = await publishPendingNotificationPointers(queue, {
    database,
    config,
  })
  console.info(`[notifications] Planned ${planned.planned} and queued ${result.published} notification pointers`)
  return { ...result, planned: planned.planned }
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
