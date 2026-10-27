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
  if (typeof id === 'string' && id.length > 0 && new TextEncoder().encode(id).byteLength <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(id)) return id
}

/** The two senders share only this adapter-local, bounded request/body operation. */
const requestSms = async (config: BrevoSmsConfig, body: string, fetcher: typeof fetch): Promise<BrevoSmsAttemptResult> => {
  const controller = new AbortController()
  let disposed = false
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let complete = false
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<BrevoSmsAttemptResult>(resolve => {
    timer = setTimeout(() => {
      disposed = true
      controller.abort()
      resolve({ attempted: true, status: 'transport' })
    }, 10_000)
  })
  try {
    return await Promise.race([deadline, (async (): Promise<BrevoSmsAttemptResult> => {
      const received = await fetcher('https://api.brevo.com/v3/transactionalSMS/send', {
        method: 'POST', headers: { 'api-key': config.apiKey, 'content-type': 'application/json' }, body, signal: controller.signal,
      })
      if (disposed) {
        void received.body?.cancel().catch(() => {})
        return { attempted: true, status: 'transport' }
      }
      response = received
      const httpStatus = response.status
      // These outcomes are authoritative without an optional provider error body.
      if (httpStatus === 429 || httpStatus >= 500) return { attempted: true, status: httpStatus === 429 ? 'rate-limited' : 'provider-5xx', httpStatus }
      const length = response.headers.get('content-length')
      let data: unknown
      if (!(length && /^\d+$/.test(length) && Number(length) > 16_384) && response.body) {
        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        while (!disposed) {
          const chunk = await reader.read()
          if (disposed) return { attempted: true, status: 'transport' }
          if (chunk.done) { complete = true; break }
          size += chunk.value.byteLength
          if (size > 16_384) break
          chunks.push(chunk.value)
        }
        if (complete) {
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
          try { data = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* Fixed invalid-request below. */ }
        }
      }
      const id = providerMessageId(data)
      if (httpStatus === 201) return id ? { attempted: true, status: 'submitted', httpStatus, providerMessageId: id } : { attempted: true, status: 'invalid-request', httpStatus }
      const code = typeof data === 'object' && data !== null && 'code' in data ? data.code : undefined
      return { attempted: true, status: code === 'not_enough_credits' ? 'credits' : httpStatus === 401 || httpStatus === 403 || code === 'permission_denied' || code === 'account_under_validation' ? 'auth' : 'invalid-request', httpStatus }
    })()])
  } catch { return { attempted: true, status: 'transport' } }
  finally {
    disposed = true
    clearTimeout(timer!)
    if (reader) {
      if (!complete) void reader.cancel().catch(() => {})
      reader.releaseLock()
    } else if (response) void response.body?.cancel().catch(() => {})
  }
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
  try {
    const content = composeBrevoEventSms(message)
    const body = JSON.stringify({ recipient: message.recipient, sender: config.sender, content, type: 'transactional' })
    return requestSms(config, body, fetcher)
  } catch {
    return { attempted: false, status: 'invalid-request' }
  }
}

export const sendBrevoLifecycleSms = async (config: BrevoSmsConfig, message: BrevoSmsLifecycle, fetcher: typeof fetch = fetch): Promise<BrevoSmsAttemptResult> => {
  if (!config.apiKey.trim() || !isSender(config.sender) || !isRecipient(message.recipient)) return { attempted: false, status: 'invalid-request' }
  try {
    const content = composeBrevoLifecycleSms(message)
    const body = JSON.stringify({ recipient: message.recipient, sender: config.sender, content, type: 'transactional' })
    return requestSms(config, body, fetcher)
  } catch { return { attempted: false, status: 'invalid-request' } }
}
