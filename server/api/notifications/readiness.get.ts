import { defineEventHandler, setResponseHeader } from 'h3'
import { notificationConfig, NotificationConfigurationError } from '../../utils/notificationConfig.ts'
import { isNotificationChannelReady, notificationSchemaReady, type NotificationDatabase } from '../../utils/notifications.ts'

export interface NotificationReadiness {
  email: boolean
  sms: boolean
  webPush: boolean
}

const unavailable: NotificationReadiness = { email: false, sms: false, webPush: false }

/** Projects private delivery configuration into the only public readiness contract. */
export const projectNotificationReadiness = async (runtimeConfig: Record<string, unknown>, database?: NotificationDatabase): Promise<NotificationReadiness> => {
  const report = (reason: string) => console.warn('[notifications] Readiness unavailable', { reason })
  try {
    const config = await notificationConfig(runtimeConfig, undefined, report)
    if (!database) {
      report('database-binding-missing')
      return unavailable
    }
    if (!await notificationSchemaReady(database)) {
      report('database-schema-unavailable-or-incompatible')
      return unavailable
    }
    return { email: isNotificationChannelReady('email', config), sms: isNotificationChannelReady('sms', config), webPush: isNotificationChannelReady('web-push', config) }
  } catch (error) {
    report(error instanceof NotificationConfigurationError ? error.reason : 'configuration-or-crypto-unavailable')
    return unavailable
  }
}

export default defineEventHandler(event => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  return projectNotificationReadiness(useRuntimeConfig(event), database)
})
