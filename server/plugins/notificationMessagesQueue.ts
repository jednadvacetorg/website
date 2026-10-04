import { notificationConfig } from '../utils/notificationConfig.ts'
import { sendBrevoEventEmail, sendBrevoLifecycleEmail } from '../utils/brevoEmail.ts'
import { sendBrevoEventSms, sendBrevoLifecycleSms } from '../utils/brevoSms.ts'
import { sendWebPush } from '../utils/webPush.ts'
import { parseWebPushSubscription } from '../utils/webPushSubscriptions.ts'
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

/** The production dispatch, with external transport injected for local boundary proof. */
export const dispatchNotificationQueueMessage = (message: NotificationQueueEnvelope, dependencies: NotificationQueueDependencies, runtime: Record<string, unknown>, fetcher: typeof fetch = fetch) =>
  processNotificationQueueMessage(message, dependencies, async (payload, authorization, authorize) => {
    // Adapters finish composition/crypto before reaching this transport boundary.
    const authorizedFetch: typeof fetch = async (url, request) => {
      if (!await authorize()) throw new Error('Notification delivery authorization expired')
      return fetcher(url, request)
    }
    if (authorization.channel === 'web-push' && payload.kind !== 'event-email' && payload.kind !== 'event-sms') {
      if (!dependencies.config.webPushDelivery) throw new Error('Web Push delivery is not configured')
      return sendWebPush(parseWebPushSubscription(JSON.parse(payload.destination)), {
        title: 'Jednadvacet.org',
        body: payload.kind === 'reactivation' ? 'Potvrď obnovení upozornění.' : payload.kind === 'management-recovery' ? 'Otevři nové nastavení upozornění.' : 'Odběr upozornění je aktivní.',
        url: `/notifications/manage/${payload.capability}`,
      }, dependencies.config.webPushDelivery, authorizedFetch)
    }
    if (typeof runtime.brevoApiKey !== 'string' || !runtime.brevoApiKey.trim() || typeof runtime.brevoSenderName !== 'string' || !runtime.brevoSenderName.trim()) throw new Error('Brevo delivery is not configured')
    if (payload.kind !== 'event-email' && payload.kind !== 'event-sms') {
      if (authorization.channel === 'sms') return sendBrevoLifecycleSms({ apiKey: runtime.brevoApiKey, sender: runtime.brevoSenderName }, { recipient: payload.destination, capability: payload.capability, kind: payload.kind }, authorizedFetch)
      if (authorization.channel !== 'email') throw new Error('Notification channel is invalid')
      return sendBrevoLifecycleEmail({ apiKey: runtime.brevoApiKey, senderName: runtime.brevoSenderName, senderEmail: 'noreply@jednadvacet.org', sandbox: runtime.brevoSandbox === true }, { destination: payload.destination, capability: payload.capability, kind: payload.kind }, authorizedFetch)
    }
    if (payload.kind === 'event-sms') return sendBrevoEventSms({ apiKey: runtime.brevoApiKey, sender: runtime.brevoSenderName }, { deliveryId: payload.deliveryId, recipient: payload.destination, event: payload.event }, authorizedFetch)
    return sendBrevoEventEmail({ apiKey: runtime.brevoApiKey, senderName: runtime.brevoSenderName, senderEmail: 'noreply@jednadvacet.org', sandbox: runtime.brevoSandbox === true }, {
      deliveryId: payload.deliveryId, recipient: payload.destination,
      managementUrl: `https://jednadvacet.org/notifications/manage/${payload.managementCapability}`,
      event: payload.event, uid: payload.event.uid, sequence: payload.event.sequence, cancelled: payload.event.cancelled,
    }, authorizedFetch)
  })

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
        const result = await dispatchNotificationQueueMessage(message, dependencies, runtime)
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
