export interface BrevoSmsConfig {
  apiKey: string
  sender: string
}

export interface BrevoSmsEvent {
  deliveryId: string
  recipient: string
  event: { title: string, start: string, url?: string }
  reason?: 'created' | 'week-before' | 'day-before' | 'updated' | 'cancelled'
}

export interface BrevoSmsLifecycle {
  recipient: string
  capability: string
  kind: 'first-activation' | 'reactivation' | 'management-recovery'
}

export type BrevoSmsAttemptResult = {
  attempted: boolean
  status: 'submitted' | 'invalid-request' | 'auth' | 'credits' | 'rate-limited' | 'provider-5xx' | 'transport'
  httpStatus?: number
  providerMessageId?: string
}

const pragueTime = (value: string) => new Intl.DateTimeFormat('cs-CZ', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Prague',
}).format(new Date(value))

const isRecipient = (value: string) => /^\+[1-9]\d{7,14}$/.test(value)
const isSender = (value: string) => /^(?:[A-Za-z0-9]{1,11}|\d{1,15})$/.test(value)
const providerMessageId = (value: unknown) => {
  if (typeof value !== 'object' || value === null || !('messageId' in value)) return
  const id = value.messageId
  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return String(id)
  if (typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id)) return id
}
const providerOutcome = async (response: Response): Promise<BrevoSmsAttemptResult> => {
  let body: unknown
  try {
    const text = await response.text()
    if (text.length <= 16_384) body = JSON.parse(text)
  } catch { body = undefined }
  const id = providerMessageId(body)
  if (response.status === 201) return id ? { attempted: true, status: 'submitted', httpStatus: 201, providerMessageId: id } : { attempted: true, status: 'invalid-request', httpStatus: 201 }
  const code = typeof body === 'object' && body !== null && 'code' in body ? body.code : undefined
  return { attempted: true, status: response.status === 429 ? 'rate-limited' : response.status >= 500 ? 'provider-5xx' : code === 'not_enough_credits' ? 'credits' : response.status === 401 || response.status === 403 || code === 'permission_denied' || code === 'account_under_validation' ? 'auth' : 'invalid-request', httpStatus: response.status }
}

const gsm7Basic = new Set([..."@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"])
const gsm7Extension = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€'])

/** Converts application-owned copy to GSM-7 and counts septets, including extension escapes. */
export const gsm7OneSegment = (value: string) => {
  let text = ''
  let units = 0
  for (const character of value.normalize('NFD').replace(/\p{Mark}/gu, '')) {
    const normalized = gsm7Basic.has(character) || gsm7Extension.has(character) ? character : '?'
    text += normalized
    units += gsm7Extension.has(normalized) ? 2 : 1
  }
  if (units > 160) throw new Error('Notification SMS exceeds one GSM-7 segment')
  return text
}

/** Creates one application-owned Czech transactional segment, or fails instead of sending multipart SMS. */
export const composeBrevoEventSms = (message: BrevoSmsEvent) => {
  const lead = message.reason === 'cancelled' ? 'Akce zrušena' : message.reason === 'updated' ? 'Změna akce' : 'Jednadvacet'
  const text = `${lead}: ${message.event.title}, ${pragueTime(message.event.start)}${message.event.url ? ` ${message.event.url}` : ''}`
  return gsm7OneSegment(text)
}

/** First and recovery messages carry only the generation-bound management capability. */
export const composeBrevoLifecycleSms = (message: BrevoSmsLifecycle) => {
  const lead = message.kind === 'reactivation'
    ? 'Jednadvacet: pro obnovení upozornění potvrď nastavení: '
    : 'Jednadvacet: nastavení nebo zrušení upozornění: '
  const text = `${lead}https://jednadvacet.org/notifications/manage/${message.capability}`
  return gsm7OneSegment(text)
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
    return await providerOutcome(response)
  } catch {
    return { attempted: true, status: 'transport' }
  }
}

export const sendBrevoLifecycleSms = async (config: BrevoSmsConfig, message: BrevoSmsLifecycle, fetcher: typeof fetch = fetch): Promise<BrevoSmsAttemptResult> => {
  if (!config.apiKey.trim() || !isSender(config.sender) || !isRecipient(message.recipient)) return { attempted: false, status: 'invalid-request' }
  let content: string
  try { content = composeBrevoLifecycleSms(message) } catch { return { attempted: false, status: 'invalid-request' } }
  try {
    const response = await fetcher('https://api.brevo.com/v3/transactionalSMS/send', {
      method: 'POST', headers: { 'api-key': config.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: message.recipient, sender: config.sender, content, type: 'transactional' }),
    })
    return await providerOutcome(response)
  } catch { return { attempted: true, status: 'transport' } }
}
