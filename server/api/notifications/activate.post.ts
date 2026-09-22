import { createError, defineEventHandler, getRequestHeader, readBody } from 'h3'
import { evaluateNotificationAbuse } from '../../utils/notificationAbuse.ts'
import { activateNotificationChannel, NotificationLifecycleError, validateNotificationActivation, type NotificationDatabase, type NotificationLifecycleConfig } from '../../utils/notifications.ts'
import { notificationConfig } from '../../utils/notificationConfig.ts'
import { notificationUiVerificationDecision } from '../../utils/notificationUiVerificationFixture.ts'
import { serializeWebPushSubscription } from '../../utils/webPushSubscriptions.ts'

const isFixtureActivationInput = (value: Record<string, unknown>, channel: 'email' | 'sms') =>
  value.channel === channel
  && typeof value.contact === 'string'
  && Array.isArray(value.communitySlugs) && value.communitySlugs.length > 0 && value.communitySlugs.every(slug => slug === 'brno')
  && Array.isArray(value.frequencies) && value.frequencies.length > 0 && value.frequencies.every(frequency => frequency === 'created' || frequency === 'week-before' || frequency === 'day-before')
  && typeof value.consentAt === 'string' && !Number.isNaN(Date.parse(value.consentAt))
  && value.consentVersion === '2026-09'

export default defineEventHandler(async (event) => {
  const input: unknown = await readBody(event)
  const runtimeConfig = useRuntimeConfig(event)
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const channel = body?.channel
  const contact = body?.contact
  const fixture = (channel === 'email' || channel === 'sms') && body && isFixtureActivationInput(body, channel)
    ? notificationUiVerificationDecision(runtimeConfig, channel, contact, body?.turnstileToken)
    : null
  if (fixture === 'challenge') throw createError({ statusCode: 403, statusMessage: 'Notification request needs verification' })
  if (fixture === 'success') return { state: 'active' as const }
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  if (!database) throw createError({ statusCode: 503, statusMessage: 'Notification activation is unavailable' })
  let config: NotificationLifecycleConfig
  try {
    config = await notificationConfig(runtimeConfig)
    const normalizedInput = body?.channel === 'web-push'
      ? { ...body, contact: serializeWebPushSubscription(body.contact) }
      : input
    validateNotificationActivation(normalizedInput, config)
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
    const normalizedInput = body?.channel === 'web-push'
      ? { ...body, contact: serializeWebPushSubscription(body.contact) }
      : input
    return await activateNotificationChannel(normalizedInput, { database, config })
  } catch (error) {
    const statusCode = error instanceof NotificationLifecycleError ? error.statusCode : 503
    throw createError({ statusCode, statusMessage: 'Notification activation is unavailable' })
  }
})
