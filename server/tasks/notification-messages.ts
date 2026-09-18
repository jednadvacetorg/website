import { notificationConfig } from '../utils/notificationConfig.ts'
import { publishPendingNotificationPointers, type NotificationMessagesQueue } from '../utils/notificationMessagesQueue.ts'
import type { NotificationDatabase } from '../utils/notifications.ts'

interface NotificationMessagesTaskContext {
  notificationMessagesQueue?: NotificationMessagesQueue
  notificationDatabase?: NotificationDatabase
  cloudflare?: { env?: Record<string, unknown> }
}

export const drainNotificationMessages = async (context: NotificationMessagesTaskContext, runtimeConfig: Record<string, unknown>) => {
  const queue = context.notificationMessagesQueue
    ?? context.cloudflare?.env?.NOTIFICATION_MESSAGES_QUEUE as NotificationMessagesQueue | undefined
  const database = context.notificationDatabase
    ?? context.cloudflare?.env?.DB as NotificationDatabase | undefined
  if (!queue?.send) throw new Error('Notification messages queue is not configured')
  if (!database?.prepare || !database.batch) throw new Error('Notification database is not configured')

  const result = await publishPendingNotificationPointers(queue, {
    database,
    config: await notificationConfig(runtimeConfig),
  })
  console.info(`[notifications] Queued ${result.published} notification pointers`)
  return result
}

export default defineTask({
  meta: {
    name: 'notification-messages',
    description: 'Publish bounded durable notification outbox pointers',
  },
  async run(event) {
    const result = await drainNotificationMessages(event.context as NotificationMessagesTaskContext, useRuntimeConfig() as unknown as Record<string, unknown>)
    return { result: { queued: result.published } }
  },
})
