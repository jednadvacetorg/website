import { createError, defineEventHandler, getRequestHeader, readBody } from 'h3'
import { evaluateNotificationAbuse } from '../../utils/notificationAbuse.ts'
import { activateNotificationChannel, NotificationLifecycleError, validateNotificationActivation, type NotificationDatabase, type NotificationLifecycleConfig } from '../../utils/notifications.ts'
import { notificationConfig } from '../../utils/notificationConfig.ts'
import { publishPendingNotificationPointers, type NotificationMessagesQueue } from '../../utils/notificationMessagesQueue.ts'

export default defineEventHandler(async (event) => {
  const input: unknown = await readBody(event)
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Notification activation is unavailable' })
  let config: NotificationLifecycleConfig
  try {
    config = await notificationConfig(useRuntimeConfig(event))
    validateNotificationActivation(input, config)
  } catch (error) {
    const statusCode = error instanceof NotificationLifecycleError ? error.statusCode : 503
    throw createError({ statusCode, statusMessage: 'Notification activation is unavailable' })
  }
  const abuse = await evaluateNotificationAbuse(
    getRequestHeader(event, 'CF-Connecting-IP'),
    body?.turnstileToken,
    { database, config },
  )
  if (!abuse.allowed) {
    throw createError({
      statusCode: abuse.reason === 'rate-limited' ? 429 : 403,
      statusMessage: 'Notification request needs verification',
    })
  }
  try {
    const result = await activateNotificationChannel(input, { database, config })
    const queue = (event.context._platform as { cloudflare?: { env?: { NOTIFICATION_MESSAGES_QUEUE?: NotificationMessagesQueue } } } | undefined)?.cloudflare?.env?.NOTIFICATION_MESSAGES_QUEUE
    const publication = Promise.resolve().then(async () => {
      if (!queue?.send) throw new Error('Notification Queue unavailable')
      await publishPendingNotificationPointers(queue, { database, config }, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
    }).catch(() => { console.error('[notifications] Lifecycle pointer publication failed') })
    try {
      if (typeof event.waitUntil === 'function') event.waitUntil(publication)
      else await publication
    } catch {
      console.error('[notifications] Lifecycle pointer publication registration failed')
      await publication
    }
    return result
  } catch (error) {
    const statusCode = error instanceof NotificationLifecycleError ? error.statusCode : 503
    throw createError({ statusCode, statusMessage: 'Notification activation is unavailable' })
  }
})
