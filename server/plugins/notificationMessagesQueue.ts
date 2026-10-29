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
  env?: { DB?: NotificationDatabase }
  context?: { notificationDatabase?: NotificationDatabase }
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
      const signal = request?.signal ?? undefined
      if (signal?.aborted || !await authorize(signal) || signal?.aborted) throw new Error('Notification delivery authorization expired')
      return fetcher(url, request)
    }
    if (authorization.channel === 'web-push') {
      if (!dependencies.config.webPushDelivery) throw new Error('Web Push delivery is not configured')
      if (payload.kind === 'event-web-push') {
        let url = '/kalendar'
        try {
          const candidate = new URL(payload.event.url ?? url, 'https://jednadvacet.org')
          if (candidate.origin === 'https://jednadvacet.org' && !candidate.username && !candidate.password) url = `${candidate.pathname}${candidate.search}`
        } catch { /* Fall back to the application calendar. */ }
        return sendWebPush(parseWebPushSubscription(JSON.parse(payload.destination)), {
          title: payload.reason === 'cancelled' ? 'Akce je zrušená' : payload.reason === 'updated' ? 'Změna akce' : 'Jednadvacet.org',
          body: Array.from(payload.event.title.replace(/[\u0000-\u001f\u007f]/g, ' ')).slice(0, 200).join(''),
          url,
        }, dependencies.config.webPushDelivery, authorizedFetch)
      }
      if (!('capability' in payload)) throw new Error('Notification channel is invalid')
      const { results: subscriptions } = await dependencies.database.prepare('SELECT DISTINCT community_slug FROM notification_subscriptions WHERE contact_id = ? ORDER BY community_slug')
        .bind(authorization.contact_id).all<{ community_slug: string }>()
      const scope = subscriptions.length === dependencies.config.communitySlugs.length
        ? 'celé Česko'
        : subscriptions.map(({ community_slug: slug }) => dependencies.config.communityTitles?.[slug] ?? slug.replace(/-/g, ' ').replace(/^./, letter => letter.toLocaleUpperCase('cs'))).join(', ')
      const confirmation = `Odebíráš upozornění pro ${scope}.`
      return sendWebPush(parseWebPushSubscription(JSON.parse(payload.destination)), {
        title: 'Jednadvacet.org',
        body: payload.kind === 'reactivation' ? 'Potvrď obnovení upozornění.' : payload.kind === 'management-recovery' ? 'Otevři nové nastavení upozornění.' : Array.from(confirmation).length <= 240 ? confirmation : `${Array.from(confirmation).slice(0, 239).join('').trimEnd()}…`,
        url: `/notifications/manage/${payload.capability}`,
      }, dependencies.config.webPushDelivery, authorizedFetch)
    }
    const sender = authorization.channel === 'sms' ? runtime.brevoSmsSender : runtime.brevoSenderName
    const managementOrigin = dependencies.config.managementOrigin ?? 'https://jednadvacet.org'
    if (typeof runtime.brevoApiKey !== 'string' || !runtime.brevoApiKey.trim() || typeof sender !== 'string' || !sender.trim()) throw new Error('Brevo delivery is not configured')
    if (payload.kind === 'event-web-push') throw new Error('Notification channel is invalid')
    if ('capability' in payload) {
      if (authorization.channel === 'sms') return sendBrevoLifecycleSms({ apiKey: runtime.brevoApiKey, sender, managementOrigin }, { recipient: payload.destination, capability: payload.capability, kind: payload.kind }, authorizedFetch)
      if (authorization.channel !== 'email') throw new Error('Notification channel is invalid')
      if (!authorization.lifecycleAttempt) throw new Error('Lifecycle email attempt is unavailable')
      return sendBrevoLifecycleEmail({ apiKey: runtime.brevoApiKey, senderName: sender, senderEmail: 'noreply@jednadvacet.org', sandbox: runtime.brevoSandbox === true, managementOrigin }, { destination: payload.destination, capability: payload.capability, kind: payload.kind, attempt: authorization.lifecycleAttempt }, authorizedFetch)
    }
    if (payload.kind === 'event-sms') return sendBrevoEventSms({ apiKey: runtime.brevoApiKey, sender }, { deliveryId: payload.deliveryId, recipient: payload.destination, event: payload.event, reason: payload.reason }, authorizedFetch)
    return sendBrevoEventEmail({ apiKey: runtime.brevoApiKey, senderName: sender, senderEmail: 'noreply@jednadvacet.org', sandbox: runtime.brevoSandbox === true }, {
      deliveryId: payload.deliveryId, recipient: payload.destination,
      managementUrl: `${managementOrigin}/notifications/manage/${payload.managementCapability}`,
      event: payload.event, uid: payload.event.uid, sequence: payload.event.sequence, cancelled: payload.event.cancelled,
    }, authorizedFetch)
  })

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async queueEvent => {
    const event = queueEvent as unknown as NotificationQueueHookContext
    if (event.batch.queue !== notificationMessagesQueueName) return

    const database = event.context?.notificationDatabase
      ?? event.env?.DB
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
