import { defineEventHandler, getRouterParam } from 'h3'
import { readNotificationManagement, type NotificationDatabase } from '../../../utils/notifications.ts'
import { notificationConfig } from '../../../utils/notificationConfig.ts'

const unavailable = { state: 'unavailable' as const }

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, 'token')
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return unavailable
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  if (!database) return unavailable
  try {
    return await readNotificationManagement(token, {
      database,
      config: await notificationConfig(useRuntimeConfig(event)),
    })
  } catch {
    return unavailable
  }
})
