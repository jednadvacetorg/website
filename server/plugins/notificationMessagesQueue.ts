import { notificationConfig } from '../utils/notificationConfig.ts'
import { sendBrevoEventEmail } from '../utils/brevoEmail.ts'
import { sendBrevoEventSms } from '../utils/brevoSms.ts'
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
    const runtime = useRuntimeConfig() as unknown as Record<string, unknown>
    const dependencies: NotificationQueueDependencies = {
      database,
      config: await notificationConfig(runtime),
    }
    for (const message of event.batch.messages) {
      try {
        const result = await processNotificationQueueMessage(message, dependencies, async payload => {
          if (payload.kind !== 'event-email' && payload.kind !== 'event-sms') throw new Error('Notification lifecycle delivery hook is not configured')
          if (typeof runtime.brevoApiKey !== 'string' || typeof runtime.brevoSenderName !== 'string') throw new Error('Brevo delivery is not configured')
          if (payload.kind === 'event-sms') return sendBrevoEventSms({ apiKey: runtime.brevoApiKey, sender: runtime.brevoSenderName }, {
            deliveryId: payload.deliveryId,
            recipient: payload.destination,
            event: payload.event,
          })
          return sendBrevoEventEmail({
            apiKey: runtime.brevoApiKey,
            senderName: runtime.brevoSenderName,
            senderEmail: 'noreply@jednadvacet.org',
            sandbox: runtime.brevoSandbox === true,
          }, {
            deliveryId: payload.deliveryId,
            recipient: payload.destination,
            managementUrl: `https://jednadvacet.org/notifications/manage/${payload.managementCapability}`,
            event: payload.event,
            uid: payload.event.uid,
            sequence: payload.event.sequence,
            cancelled: payload.event.cancelled,
          })
        })
        console.info('[notifications] Processed notification Queue pointer', { messageId: message.id, delivered: result.delivered })
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
