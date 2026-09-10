import type { PortalCalendarEvent } from './portalEvents.ts'
import { projectCalendarEvent } from './calendarEventProjection.ts'

const googleTokenUrl = 'https://oauth2.googleapis.com/token'
const googleCalendarUrl = 'https://www.googleapis.com/calendar/v3'
const integrationSource = 'portal'
const base32hexAlphabet = '0123456789abcdefghijklmnopqrstuv'
const googleRequestTimeoutMs = 10_000

export interface GoogleCalendarConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  calendarId: string
}

export type GoogleFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface GoogleCalendarSyncReport {
  created: number
  updated: number
  deleted: number
}

interface ManagedGoogleEvent {
  id: string
  portalEventId?: string
  sequence?: number
  end?: string
}

/** Represents a safe integration failure without retaining Google response bodies. */
export class GoogleCalendarError extends Error {
  readonly status?: number
  readonly reason?: string

  constructor(
    message: string,
    status?: number,
    reason?: string,
  ) {
    super(message)
    this.name = 'GoogleCalendarError'
    this.status = status
    this.reason = reason
  }
}

/** Validates private runtime configuration before any Google side effect. */
export const getGoogleCalendarConfig = (runtimeConfig: Record<string, unknown>): GoogleCalendarConfig => {
  const values = {
    clientId: runtimeConfig.googleOauthClientId,
    clientSecret: runtimeConfig.googleOauthSecret,
    refreshToken: runtimeConfig.googleOauthRefreshToken,
    calendarId: runtimeConfig.googleLegacyCalendarId,
  }
  if (Object.values(values).some(value => typeof value !== 'string' || !value)) {
    throw new GoogleCalendarError('Google Calendar is not configured')
  }
  return values as GoogleCalendarConfig
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const responseJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    throw new GoogleCalendarError('Google Calendar returned an invalid response')
  }
}

const googleErrorReason = async (response: Response) => {
  try {
    const payload = await response.json()
    if (!isRecord(payload) || !isRecord(payload.error) || !Array.isArray(payload.error.errors)) return undefined
    const error = payload.error.errors.find(isRecord)
    return typeof error?.reason === 'string' ? error.reason : undefined
  } catch {
    return undefined
  }
}

const rejectedResponse = async (response: Response, operation: string): Promise<never> => {
  throw new GoogleCalendarError(operation, response.status, await googleErrorReason(response))
}

const accessToken = async (config: GoogleCalendarConfig, fetcher: GoogleFetch) => {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  })
  let response: Response
  try {
    response = await fetcher(googleTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(googleRequestTimeoutMs),
    })
  } catch {
    throw new GoogleCalendarError('Google OAuth is unavailable')
  }
  if (!response.ok) await rejectedResponse(response, 'Google OAuth rejected the refresh token')
  const payload = await responseJson(response)
  if (!isRecord(payload) || typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new GoogleCalendarError('Google OAuth returned no access token')
  }
  return payload.access_token
}

const base32hex = (bytes: Uint8Array) => {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += base32hexAlphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += base32hexAlphabet[(value << (5 - bits)) & 31]
  return output
}

/** Returns a stable Google-compatible ID for one Portal event. */
export const googleCalendarEventId = async (portalEventId: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`jednadvacet:portal:${portalEventId}`))
  return `j21${base32hex(new Uint8Array(digest))}`
}

const googleEventBody = (item: PortalCalendarEvent) => {
  const projected = projectCalendarEvent(item, true)
  return {
    summary: projected.title,
    ...(projected.description ? { description: projected.description } : {}),
    ...(projected.location ? { location: projected.location } : {}),
    ...(projected.url?.startsWith('http://') || projected.url?.startsWith('https://')
      ? { source: { title: 'Portal', url: projected.url } }
      : {}),
    start: { dateTime: projected.start },
    end: { dateTime: projected.end },
    sequence: item.sequence,
    reminders: { useDefault: false },
    extendedProperties: {
      private: {
        jednadvacetSource: integrationSource,
        jednadvacetEventId: item.event.id,
        jednadvacetCommunity: item.community.id,
        jednadvacetSequence: String(item.sequence),
      },
    },
  }
}

const googleRequest = async (
  fetcher: GoogleFetch,
  token: string,
  config: GoogleCalendarConfig,
  path: string,
  init: RequestInit = {},
) => {
  try {
    return await fetcher(`${googleCalendarUrl}/calendars/${encodeURIComponent(config.calendarId)}${path}`, {
      ...init,
      signal: AbortSignal.timeout(googleRequestTimeoutMs),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch {
    throw new GoogleCalendarError('Google Calendar is unavailable')
  }
}

const upsertWithToken = async (
  item: PortalCalendarEvent,
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch,
  token: string,
  knownToExist?: boolean,
): Promise<'created' | 'updated'> => {
  const id = await googleCalendarEventId(item.event.id)
  const body = googleEventBody(item)
  if (knownToExist !== false) {
    const updated = await googleRequest(fetcher, token, config, `/events/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    if (updated.ok) return 'updated'
    if (updated.status !== 404) await rejectedResponse(updated, 'Google Calendar rejected an event update')
  }

  const inserted = await googleRequest(fetcher, token, config, '/events', {
    method: 'POST',
    body: JSON.stringify({ id, ...body }),
  })
  if (inserted.ok) return 'created'
  if (inserted.status === 409) {
    const updated = await googleRequest(fetcher, token, config, `/events/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    if (updated.ok) return 'updated'
    await rejectedResponse(updated, 'Google Calendar rejected an event update after an insert conflict')
  }
  return rejectedResponse(inserted, 'Google Calendar rejected an event insert')
}

const deleteWithToken = async (
  portalEventId: string,
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch,
  token: string,
) => {
  const id = await googleCalendarEventId(portalEventId)
  const response = await googleRequest(fetcher, token, config, `/events/${id}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    await rejectedResponse(response, 'Google Calendar rejected an event deletion')
  }
  return response.status !== 404 && response.status !== 410
}

const listManagedEvents = async (
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch,
  token: string,
): Promise<ManagedGoogleEvent[]> => {
  const events: ManagedGoogleEvent[] = []
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({
      privateExtendedProperty: `jednadvacetSource=${integrationSource}`,
      maxResults: '2500',
      showDeleted: 'false',
    })
    if (pageToken) query.set('pageToken', pageToken)
    const response = await googleRequest(fetcher, token, config, `/events?${query}`)
    if (!response.ok) await rejectedResponse(response, 'Google Calendar rejected the managed event list')
    const payload = await responseJson(response)
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new GoogleCalendarError('Google Calendar returned an invalid event list')
    }
    for (const value of payload.items) {
      if (!isRecord(value) || typeof value.id !== 'string') continue
      const privateProperties = isRecord(value.extendedProperties) && isRecord(value.extendedProperties.private)
        ? value.extendedProperties.private
        : undefined
      const end = isRecord(value.end)
        ? typeof value.end.dateTime === 'string'
          ? value.end.dateTime
          : typeof value.end.date === 'string'
            ? value.end.date
            : undefined
        : undefined
      events.push({
        id: value.id,
        ...(typeof privateProperties?.jednadvacetEventId === 'string'
          ? { portalEventId: privateProperties.jednadvacetEventId }
          : {}),
        ...(typeof privateProperties?.jednadvacetSequence === 'string'
          && Number.isSafeInteger(Number(privateProperties.jednadvacetSequence))
          ? { sequence: Number(privateProperties.jednadvacetSequence) }
          : {}),
        ...(end ? { end } : {}),
      })
    }
    pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : undefined
  } while (pageToken)
  return events
}

/** Creates or replaces one Google event after a Portal webhook. */
export const syncGoogleCalendarEvent = async (
  item: PortalCalendarEvent,
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch = fetch,
) => upsertWithToken(item, config, fetcher, await accessToken(config, fetcher))

/** Removes one integration-owned Google event after a Portal deletion webhook. */
export const deleteGoogleCalendarEvent = async (
  portalEventId: string,
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch = fetch,
) => deleteWithToken(portalEventId, config, fetcher, await accessToken(config, fetcher))

/** Rewrites all current Portal events and removes only stale future events owned by this integration. */
export const reconcileGoogleCalendar = async (
  events: readonly PortalCalendarEvent[],
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch = fetch,
  now = new Date(),
): Promise<GoogleCalendarSyncReport> => {
  const token = await accessToken(config, fetcher)
  const existing = await listManagedEvents(config, fetcher, token)
  const existingById = new Map(existing.map(event => [event.id, event]))
  const resolved = new Map<string, PortalCalendarEvent>()
  for (const item of events) {
    const previous = resolved.get(item.event.id)
    if (!previous || item.sequence > previous.sequence
      || (item.sequence === previous.sequence && item.cancelled && !previous.cancelled)) {
      resolved.set(item.event.id, item)
    }
  }
  const active = new Map([...resolved].filter(([, item]) => !item.cancelled))
  const cancelled = new Map([...resolved].filter(([, item]) => item.cancelled))

  const report: GoogleCalendarSyncReport = { created: 0, updated: 0, deleted: 0 }
  const operations: Array<() => Promise<void>> = []
  for (const item of active.values()) {
    operations.push(async () => {
      const id = await googleCalendarEventId(item.event.id)
      const existingEvent = existingById.get(id)
      if (existingEvent?.sequence !== undefined && existingEvent.sequence > item.sequence) return
      const result = await upsertWithToken(item, config, fetcher, token, existingEvent !== undefined)
      report[result] += 1
    })
  }

  const deletions = new Map<string, PortalCalendarEvent | undefined>(cancelled)
  for (const event of existing) {
    if (!event.portalEventId || active.has(event.portalEventId) || cancelled.has(event.portalEventId)) continue
    if (event.end && Date.parse(event.end) >= now.getTime()) deletions.set(event.portalEventId, undefined)
  }
  for (const [portalEventId, cancellation] of deletions) {
    operations.push(async () => {
      const id = await googleCalendarEventId(portalEventId)
      const existingEvent = existingById.get(id)
      if (cancellation && existingEvent?.sequence !== undefined && existingEvent.sequence > cancellation.sequence) return
      if (await deleteWithToken(portalEventId, config, fetcher, token)) report.deleted += 1
    })
  }

  const failures: unknown[] = []
  for (let index = 0; index < operations.length; index += 5) {
    const results = await Promise.allSettled(operations.slice(index, index + 5).map(operation => operation()))
    failures.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
  }
  if (failures.length > 0) throw new GoogleCalendarError(`Google Calendar synchronization failed for ${failures.length} operation(s)`)
  return report
}
