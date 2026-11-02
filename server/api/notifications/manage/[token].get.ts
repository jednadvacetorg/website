import { defineEventHandler, getRouterParam } from 'h3'
import { readNotificationManagement, type NotificationDatabase } from '../../../utils/notifications.ts'
import { notificationConfig } from '../../../utils/notificationConfig.ts'
import { forgetNotificationBrowser, notificationManagementToken, rememberNotificationBrowser } from '../../../utils/notificationBrowserSession.ts'

const unavailable = { state: 'unavailable' as const }

export default defineEventHandler(async (event) => {
  const token = notificationManagementToken(event)
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return unavailable
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  if (!database) return unavailable
  try {
    const result = await readNotificationManagement(token, {
      database,
      config: await notificationConfig(useRuntimeConfig(event)),
    })
    if (getRouterParam(event, 'token') === 'browser' && (result.state === 'unavailable' || result.channel !== 'web-push')) {
      forgetNotificationBrowser(event)
      return unavailable
    }
    // A valid notification link restores this browser's management session.
    if (result.state !== 'unavailable' && result.channel === 'web-push' && getRouterParam(event, 'token') !== 'browser') rememberNotificationBrowser(event, token)
    return result
  } catch {
    return unavailable
  }
})
