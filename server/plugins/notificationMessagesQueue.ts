import { notificationConfig } from '../utils/notificationConfig.ts'
import { consumeNotificationOutboxPointer, notificationMessagesQueueName, parseNotificationOutboxPointer, type NotificationDeliveryHook, type NotificationQueueDependencies } from '../utils/notificationMessagesQueue.ts'
import type { NotificationDatabase } from '../utils/notifications.ts'

interface NotificationQueueEnvelope {
  id: string
  body: unknown
}

interface NotificationQueueHookContext {
  batch: { queue: string, messages: NotificationQueueEnvelope[] }
  context?: { notificationDatabase?: NotificationDatabase, cloudflare?: { env?: Record<string, unknown> } }
}

export const processNotificationQueueMessage = async (message: NotificationQueueEnvelope, dependencies: NotificationQueueDependencies, deliver?: NotificationDeliveryHook) => {
  const pointer = parseNotificationOutboxPointer(message.body)
  if (!deliver) throw new Error('Notification delivery hook is not configured')
  return consumeNotificationOutboxPointer(pointer, dependencies, deliver)
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async queueEvent => {
    const event = queueEvent as unknown as NotificationQueueHookContext
    if (event.batch.queue !== notificationMessagesQueueName) return

    const database = event.context?.notificationDatabase
      ?? event.context?.cloudflare?.env?.DB as NotificationDatabase | undefined
    if (!database?.prepare || !database.batch) throw new Error('Notification database is not configured')
    const dependencies: NotificationQueueDependencies = {
      database,
      config: await notificationConfig(useRuntimeConfig() as unknown as Record<string, unknown>),
    }
    for (const message of event.batch.messages) {
      try {
        await processNotificationQueueMessage(message, dependencies)
        console.info('[notifications] Processed notification Queue pointer', { messageId: message.id })
      } catch (error) {
        console.error('[notifications] Queue processing failed', {
          messageId: message.id,
          errorType: error instanceof Error ? error.name : typeof error,
        })
        throw error
      }
    }
  })
})
