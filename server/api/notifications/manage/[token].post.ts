import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { confirmNotificationReactivation, NotificationLifecycleError, removeNotificationCommunity, stopNotificationChannel, updateNotificationFrequencies, type NotificationDatabase } from '../../../utils/notifications.ts'
import { notificationConfig } from '../../../utils/notificationConfig.ts'
import { mutateNotificationUiVerificationManagement } from '../../../utils/notificationUiVerificationFixture.ts'
import { publishPendingNotificationPointers, type NotificationMessagesQueue } from '../../../utils/notificationMessagesQueue.ts'

const unavailable = { outcome: 'unavailable' as const }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return unavailable
  const body: unknown = await readBody(event)
  if (!isRecord(body) || typeof body.action !== 'string') throw createError({ statusCode: 400, statusMessage: 'Invalid notification management action' })
  const fixture = mutateNotificationUiVerificationManagement(useRuntimeConfig(event), token, body.action, body)
  if (fixture) return fixture
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Notification management is unavailable' })
  try {
    const dependencies = { database, config: await notificationConfig(useRuntimeConfig(event)) }
    if (body.action === 'update-frequencies') return await updateNotificationFrequencies(token, body.communitySlug, body.frequencies, dependencies)
    if (body.action === 'remove-community') return await removeNotificationCommunity(token, body.communitySlug, dependencies)
    if (body.action === 'stop-channel') return await stopNotificationChannel(token, dependencies)
    if (body.action === 'confirm-reactivation') {
      const result = await confirmNotificationReactivation(token, dependencies)
      if (result.outcome === 'reactivated') {
        const queue = (event.context._platform as { cloudflare?: { env?: { NOTIFICATION_MESSAGES_QUEUE?: NotificationMessagesQueue } } } | undefined)?.cloudflare?.env?.NOTIFICATION_MESSAGES_QUEUE
        const publication = Promise.resolve().then(async () => {
          if (!queue?.send) throw new Error('Notification Queue unavailable')
          await publishPendingNotificationPointers(queue, dependencies, { lifecycleLimit: 100, eventLimit: 0, budgetMs: 5000 })
        }).catch(() => { console.error('[notifications] Lifecycle pointer publication failed') })
        try {
          if (typeof event.waitUntil === 'function') event.waitUntil(publication)
          else await publication
        } catch {
          console.error('[notifications] Lifecycle pointer publication registration failed')
          await publication
        }
      }
      return result
    }
  } catch (error) {
    if (error instanceof NotificationLifecycleError) throw createError({ statusCode: error.statusCode, statusMessage: 'Invalid notification management action' })
    throw createError({ statusCode: 503, statusMessage: 'Notification management is unavailable' })
  }
  throw createError({ statusCode: 400, statusMessage: 'Invalid notification management action' })
})
