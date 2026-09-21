import { defineEventHandler } from 'h3'
import { notificationConfig } from '../../utils/notificationConfig.ts'
import { assertNotificationRootKeyRetention, type NotificationDatabase } from '../../utils/notifications.ts'
import { notificationUiVerificationFixtureEnabled } from '../../utils/notificationUiVerificationFixture.ts'

export interface NotificationReadiness {
  email: boolean
  sms: boolean
  webPush: boolean
}

const unavailable: NotificationReadiness = { email: false, sms: false, webPush: false }

/** Projects private delivery configuration into the only public readiness contract. */
export const projectNotificationReadiness = async (runtimeConfig: Record<string, unknown>, database?: NotificationDatabase): Promise<NotificationReadiness> => {
  try {
    if (notificationUiVerificationFixtureEnabled(runtimeConfig)) return { email: true, sms: true, webPush: false }
    const config = await notificationConfig(runtimeConfig)
    if (!database) return unavailable
    await assertNotificationRootKeyRetention({ database, config })
    const emailSmsReady = config.emailSmsEnabled
      && config.emailSmsFirstMessageReady
      && config.emailSmsEventDeliveryReady
    const webPushReady = config.webPushEnabled
      && config.webPushFirstMessageReady
      && config.webPushEventDeliveryReady

    const emailReady = emailSmsReady && config.emailDeliveryReady
    return { email: emailReady, sms: emailSmsReady, webPush: webPushReady }
  } catch {
    return unavailable
  }
}

export default defineEventHandler(event => {
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  return projectNotificationReadiness(useRuntimeConfig(event), database)
})
