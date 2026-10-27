import type { CalendarEventProjection } from './calendarEventProjection.ts'
import type { LifecycleNotificationMessagePayload, NotificationOutboxPointer } from './notificationMessagesQueue.ts'

export interface BrevoEmailConfig {
  apiKey: string
  senderName: string
  senderEmail: 'noreply@jednadvacet.org'
  sandbox?: boolean
}

export interface BrevoEventEmail {
  deliveryId: string
  recipient: string
  managementUrl: string
  event: CalendarEventProjection
  uid: string
  sequence: number
  cancelled?: boolean
}

export type BrevoAttemptResult = { attempted: boolean, status: 'submitted' | 'invalid-request' | 'auth' | 'rate-limited' | 'provider-5xx' | 'transport', httpStatus?: number, providerMessageId?: string }

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const escapeIcs = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
/** Folds at UTF-8 byte boundaries so non-ASCII event text remains importable. */
const fold = (line: string) => {
  const chunks: string[] = []
  let chunk = ''
  let size = 0
  for (const character of line) {
    const characterSize = new TextEncoder().encode(character).length
    if (size + characterSize > 75 && chunk) {
      chunks.push(chunk)
      chunk = ` ${character}`
      size = characterSize + 1
    } else {
      chunk += character
      size += characterSize
    }
  }
  chunks.push(chunk)
  return chunks.join('\r\n')
}
const icsDate = (date: string) => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
const base64Utf8 = (value: string) => btoa(String.fromCodePoint(...new TextEncoder().encode(value)))

export const eventIcs = (message: BrevoEventEmail) => {
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//Jednadvacet.org//Email delivery//CS', 'VERSION:2.0', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${escapeIcs(message.uid)}`, `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(message.event.start)}`, `DTEND:${icsDate(message.event.end)}`,
    `SEQUENCE:${message.sequence}`, 'ORGANIZER:mailto:noreply@jednadvacet.org',
    `SUMMARY:${escapeIcs(message.event.title)}`,
    ...(message.event.location ? [`LOCATION:${escapeIcs(message.event.location)}`] : []),
    ...(message.event.description ? [`DESCRIPTION:${escapeIcs(message.event.description)}`] : []),
    ...(message.event.url ? [`URL:${escapeIcs(message.event.url)}`] : []),
    ...(message.cancelled ? ['STATUS:CANCELLED'] : []), 'END:VEVENT', 'END:VCALENDAR', '',
  ]
  return lines.map(fold).join('\r\n')
}

export const composeBrevoEventEmail = (message: BrevoEventEmail) => {
  const event = message.event
  const details = [event.title, event.start, event.location, event.description, event.url].filter((value): value is string => Boolean(value)).join('\n')
  const text = `${details}\n\nNastavení odběru: ${message.managementUrl}`
  const html = `<p><strong>${escapeHtml(event.title)}</strong></p><p>${escapeHtml(event.start)}${event.location ? `<br>${escapeHtml(event.location)}` : ''}</p>${event.description ? `<p>${escapeHtml(event.description).replace(/\n/g, '<br>')}</p>` : ''}${event.url ? `<p><a href="${escapeHtml(event.url)}">Podrobnosti o akci</a></p>` : ''}<p><a href="${escapeHtml(message.managementUrl)}">Nastavení odběru</a></p>`
  return { subject: `${message.cancelled ? 'Zrušeno: ' : ''}${event.title}`, text, html, ics: eventIcs(message) }
}

/** Normalizes the provider-owned message identifier without applying local-ID rules. */
export const normalizeBrevoProviderId = (value: unknown) => {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).byteLength > 256 || /[\u0000-\u001F\u007F-\u009F]/.test(value)) return
  const startsBracketed = value.startsWith('<')
  const endsBracketed = value.endsWith('>')
  if (startsBracketed !== endsBracketed) return
  const normalized = startsBracketed ? value.slice(1, -1) : value
  return normalized && !(startsBracketed && /[<>]/.test(normalized)) && !/[\u0000-\u001F\u007F-\u009F]/.test(normalized) ? normalized : undefined
}

const boundedMessageId = (value: unknown) => typeof value === 'object' && value !== null && 'messageId' in value ? normalizeBrevoProviderId(value.messageId) : undefined

/** One deadline owns headers and raw body bytes, including transports which ignore abort. */
const requestEmail = async (config: BrevoEmailConfig, body: string, fetcher: typeof fetch): Promise<BrevoAttemptResult> => {
  const controller = new AbortController()
  let disposed = false
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let complete = false
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<BrevoAttemptResult>(resolve => {
    timer = setTimeout(() => {
      disposed = true
      controller.abort()
      resolve({ attempted: true, status: 'transport' })
    }, 10_000)
  })
  try {
    return await Promise.race([deadline, (async (): Promise<BrevoAttemptResult> => {
      const received = await fetcher('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': config.apiKey, 'content-type': 'application/json', ...(config.sandbox ? { 'X-Sib-Sandbox': 'drop' } : {}) },
        body, signal: controller.signal,
      })
      if (disposed) {
        void received.body?.cancel().catch(() => {})
        return { attempted: true, status: 'transport' }
      }
      response = received
      const httpStatus = response.status
      if (httpStatus !== 201 && httpStatus !== 202) return { attempted: true, status: httpStatus === 429 ? 'rate-limited' : httpStatus === 401 || httpStatus === 403 ? 'auth' : httpStatus >= 500 ? 'provider-5xx' : 'invalid-request', httpStatus }
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
          if (size > 16_384) return { attempted: true, status: 'invalid-request', httpStatus, providerMessageId: undefined }
          chunks.push(chunk.value)
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        try { data = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* Fixed invalid-request below. */ }
      }
      const providerMessageId = boundedMessageId(data)
      return { attempted: true, status: providerMessageId ? 'submitted' : 'invalid-request', httpStatus, providerMessageId }
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

export const composeBrevoLifecycleEmail = (message: LifecycleNotificationMessagePayload) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(message.capability)) throw new Error('Notification management capability is invalid')
  const url = `https://jednadvacet.org/notifications/manage/${message.capability}`
  const lead = message.kind === 'first-activation'
    ? 'Odběr e-mailových upozornění je aktivní. Tady můžeš změnit nastavení nebo odběr ukončit.'
    : message.kind === 'reactivation'
      ? 'Chceš obnovit e-mailová upozornění? Otevři nastavení a potvrď obnovení. Do té doby ti upozornění na akce nepošleme.'
      : 'Tady je tvůj nový odkaz na nastavení e-mailových upozornění. Předchozí odkaz už neplatí. Pokud čekáš na obnovení odběru, potvrď ho v nastavení.'
  return {
    subject: message.kind === 'reactivation' ? 'Potvrď obnovení upozornění' : 'Nastavení e-mailových upozornění',
    text: `${lead}\n\nNastavení odběru: ${url}`,
    html: `<p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(url)}">Nastavení odběru</a></p>`,
  }
}

/** Lifecycle mail has no event attachment and makes exactly one transport attempt. */
export const sendBrevoLifecycleEmail = async (config: BrevoEmailConfig, message: LifecycleNotificationMessagePayload & { attempt?: NotificationOutboxPointer }, fetcher: typeof fetch = fetch): Promise<BrevoAttemptResult> => {
  if (config.senderEmail !== 'noreply@jednadvacet.org' || !config.apiKey.trim() || !config.senderName.trim()) return { attempted: false, status: 'auth' }
  try {
    const content = composeBrevoLifecycleEmail(message)
    const body = JSON.stringify({ sender: { name: config.senderName, email: config.senderEmail }, to: [{ email: message.destination }], subject: content.subject, textContent: content.text, htmlContent: content.html, ...(message.attempt ? { headers: { 'X-Mailin-custom': `lifecycle:v1:${message.attempt.outboxId}:${message.attempt.version}` } } : {}) })
    return requestEmail(config, body, fetcher)
  } catch { return { attempted: false, status: 'invalid-request' } }
}

/** Makes exactly one Worker-native transactional request and never returns provider response text. */
export const sendBrevoEventEmail = async (config: BrevoEmailConfig, message: BrevoEventEmail, fetcher: typeof fetch = fetch): Promise<BrevoAttemptResult> => {
  if (config.senderEmail !== 'noreply@jednadvacet.org' || !config.apiKey.trim() || !config.senderName.trim()) return { attempted: false, status: 'auth' }
  try {
    const content = composeBrevoEventEmail(message)
    const body = JSON.stringify({ sender: { name: config.senderName, email: config.senderEmail }, to: [{ email: message.recipient }], subject: content.subject, textContent: content.text, htmlContent: content.html, attachment: [{ name: 'event.ics', content: base64Utf8(content.ics) }], headers: { 'X-Mailin-custom': message.deliveryId } })
    return requestEmail(config, body, fetcher)
  } catch { return { attempted: false, status: 'invalid-request' } }
}
