import { defineEventHandler, getRequestHeader, readBody, setResponseStatus } from 'h3'
import { evaluateNotificationAbuse } from '../../utils/notificationAbuse.ts'
import { NotificationLifecycleError, requestNotificationManagementRecovery, validateNotificationManagementRequest, type NotificationDatabase } from '../../utils/notifications.ts'
import { notificationConfig } from '../../utils/notificationConfig.ts'
import { notificationUiVerificationDecision } from '../../utils/notificationUiVerificationFixture.ts'

const genericRecoveryResponse = {
  message: 'Pokud pro tento kontakt existuje správa notifikací, pošleme ti odkaz. Zkus to prosím později, pokud ti už odkaz přišel.',
}

export default defineEventHandler(async (event) => {
  const input: unknown = await readBody(event)
  const runtimeConfig = useRuntimeConfig(event)
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
  const channel = body?.channel
  const contact = body?.contact
  const fixture = (channel === 'email' || channel === 'sms') && body && typeof contact === 'string'
    ? notificationUiVerificationDecision(runtimeConfig, channel, contact, body?.turnstileToken)
    : null
  if (fixture === 'challenge') {
    setResponseStatus(event, 403)
    return { message: 'Požadavek na notifikace potřebuje ověření.' }
  }
  if (fixture === 'success') {
    setResponseStatus(event, 202)
    return genericRecoveryResponse
  }
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  try {
    if (!database) throw new Error('Notification database is unavailable')
    const config = await notificationConfig(runtimeConfig)
    validateNotificationManagementRequest(input)
    const abuse = await evaluateNotificationAbuse(
      getRequestHeader(event, 'CF-Connecting-IP'),
      body?.turnstileToken,
      { database, config },
    )
    if (!abuse.allowed) {
      setResponseStatus(event, abuse.reason === 'rate-limited' ? 429 : 403)
      return { message: 'Požadavek na notifikace potřebuje ověření.' }
    }
    await requestNotificationManagementRecovery(input, { database, config })
  } catch (error) {
    if (error instanceof NotificationLifecycleError && error.statusCode === 400) {
      setResponseStatus(event, 400)
      return { message: 'Neplatný požadavek na notifikace.' }
    }
  }
  setResponseStatus(event, 202)
  return genericRecoveryResponse
})
