import type { CalendarEventProjection } from './calendarEventProjection.ts'

export interface BrevoEmailConfig {
  apiKey: string
  senderName: string
  senderEmail: 'noreply@b.jednadvacet.org'
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
    `SEQUENCE:${message.sequence}`, 'ORGANIZER:mailto:noreply@b.jednadvacet.org',
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

const boundedMessageId = (value: unknown) => typeof value === 'object' && value !== null && 'messageId' in value && typeof value.messageId === 'string' && value.messageId.length <= 256 ? value.messageId : undefined

/** Makes exactly one Worker-native transactional request and never returns provider response text. */
export const sendBrevoEventEmail = async (config: BrevoEmailConfig, message: BrevoEventEmail, fetcher: typeof fetch = fetch): Promise<BrevoAttemptResult> => {
  if (config.senderEmail !== 'noreply@b.jednadvacet.org' || !config.apiKey.trim() || !config.senderName.trim()) return { attempted: false, status: 'auth' }
  const content = composeBrevoEventEmail(message)
  try {
    const response = await fetcher('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': config.apiKey, 'content-type': 'application/json', ...(config.sandbox ? { 'X-Sib-Sandbox': 'drop' } : {}) },
      body: JSON.stringify({ sender: { name: config.senderName, email: config.senderEmail }, to: [{ email: message.recipient }], subject: content.subject, textContent: content.text, htmlContent: content.html, attachment: [{ name: 'event.ics', content: base64Utf8(content.ics) }], headers: { 'X-Mailin-custom': message.deliveryId } }),
    })
    let data: unknown
    try { data = await response.json() } catch { data = undefined }
    if (response.status === 201 || response.status === 202) return { attempted: true, status: boundedMessageId(data) ? 'submitted' : 'invalid-request', httpStatus: response.status, providerMessageId: boundedMessageId(data) }
    return { attempted: true, status: response.status === 429 ? 'rate-limited' : response.status === 401 || response.status === 403 ? 'auth' : response.status >= 500 ? 'provider-5xx' : 'invalid-request', httpStatus: response.status }
  } catch { return { attempted: true, status: 'transport' } }
}
