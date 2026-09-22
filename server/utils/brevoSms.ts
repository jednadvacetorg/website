export interface BrevoSmsConfig {
  apiKey: string
  sender: string
}

export interface BrevoSmsEvent {
  deliveryId: string
  recipient: string
  event: { title: string, start: string, url?: string }
}

export type BrevoSmsAttemptResult = {
  attempted: boolean
  status: 'submitted' | 'invalid-request' | 'auth' | 'rate-limited' | 'provider-5xx' | 'transport'
  httpStatus?: number
  providerMessageId?: string
}

const pragueTime = (value: string) => new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Prague',
}).format(new Date(value))

const isRecipient = (value: string) => /^\+[1-9]\d{7,14}$/.test(value)
const isSender = (value: string) => /^(?:[A-Za-z0-9]{1,11}|\d{1,15})$/.test(value)
const providerMessageId = (value: unknown) => typeof value === 'object' && value !== null && 'messageId' in value && typeof value.messageId === 'string' && value.messageId.length > 0 && value.messageId.length <= 256
  ? value.messageId
  : undefined

/** Creates one application-owned Czech transactional segment, or fails instead of sending multipart SMS. */
export const composeBrevoEventSms = (message: BrevoSmsEvent) => {
  const text = `Jednadvacet: ${message.event.title}, ${pragueTime(message.event.start)}${message.event.url ? ` ${message.event.url}` : ''}`
  if (new TextEncoder().encode(text).length > 160) throw new Error('Notification SMS exceeds one segment')
  return text
}

/** Makes one Worker-native transactional SMS request and returns only a bounded opaque outcome. */
export const sendBrevoEventSms = async (config: BrevoSmsConfig, message: BrevoSmsEvent, fetcher: typeof fetch = fetch): Promise<BrevoSmsAttemptResult> => {
  if (!config.apiKey.trim() || !isSender(config.sender) || !isRecipient(message.recipient)) return { attempted: false, status: 'invalid-request' }
  let content: string
  try {
    content = composeBrevoEventSms(message)
  } catch {
    return { attempted: false, status: 'invalid-request' }
  }
  try {
    const response = await fetcher('https://api.brevo.com/v3/transactionalSMS/send', {
      method: 'POST',
      headers: { 'api-key': config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: message.recipient, sender: config.sender, content, type: 'transactional', webhookUrl: undefined }),
    })
    let body: unknown
    try { body = await response.json() } catch { body = undefined }
    const id = providerMessageId(body)
    if (response.status === 201) return id ? { attempted: true, status: 'submitted', httpStatus: 201, providerMessageId: id } : { attempted: true, status: 'invalid-request', httpStatus: 201 }
    return { attempted: true, status: response.status === 429 ? 'rate-limited' : response.status === 401 || response.status === 403 ? 'auth' : response.status >= 500 ? 'provider-5xx' : 'invalid-request', httpStatus: response.status }
  } catch {
    return { attempted: true, status: 'transport' }
  }
}
