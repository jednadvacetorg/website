import type { PortalCalendarEvent } from './portalEvents.ts'
import { projectCalendarEvent } from './calendarEventProjection.ts'

const googleTokenUrl = 'https://oauth2.googleapis.com/token'
const googleCalendarUrl = 'https://www.googleapis.com/calendar/v3'
const integrationSource = 'portal'
const base32hexAlphabet = '0123456789abcdefghijklmnopqrstuv'
const googleRequestTimeoutMs = 10_000
const googleOperationConcurrency = 2

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

export interface GoogleCalendarFailureSummary {
  operation: string
  status?: number
  reason?: string
  transport?: GoogleCalendarTransportFailure
  count: number
}

export type GoogleCalendarTransportFailure = 'timeout' | 'subrequest-limit' | 'network'

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
  readonly failures?: readonly GoogleCalendarFailureSummary[]
  readonly transport?: GoogleCalendarTransportFailure

  constructor(
    message: string,
    status?: number,
    reason?: string,
    failures?: readonly GoogleCalendarFailureSummary[],
    transport?: GoogleCalendarTransportFailure,
  ) {
    super(message)
    this.name = 'GoogleCalendarError'
    this.status = status
    this.reason = reason
    this.failures = failures
    this.transport = transport
  }
}

const classifyTransportFailure = (error: unknown): GoogleCalendarTransportFailure => {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout'
    if (/subrequests?|too many requests/i.test(error.message)) return 'subrequest-limit'
  }
  return 'network'
}

const summarizeOperationFailures = (failures: readonly unknown[]): GoogleCalendarFailureSummary[] => {
  const summaries = new Map<string, GoogleCalendarFailureSummary>()
  for (const failure of failures) {
    const operation = failure instanceof GoogleCalendarError
      ? failure.message
      : 'Unknown Google Calendar operation failure'
    const status = failure instanceof GoogleCalendarError ? failure.status : undefined
    const reason = failure instanceof GoogleCalendarError ? failure.reason : undefined
    const transport = failure instanceof GoogleCalendarError ? failure.transport : undefined
    const key = JSON.stringify([operation, status, reason, transport])
    const summary = summaries.get(key)
    if (summary) {
      summary.count += 1
    } else {
      summaries.set(key, {
        operation,
        ...(status !== undefined ? { status } : {}),
        ...(reason ? { reason } : {}),
        ...(transport ? { transport } : {}),
        count: 1,
      })
    }
  }
  return [...summaries.values()].sort((left, right) => right.count - left.count)
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
  } catch (error) {
    throw new GoogleCalendarError(
      'Google OAuth is unavailable',
      undefined,
      undefined,
      undefined,
      classifyTransportFailure(error),
    )
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
  } catch (error) {
    throw new GoogleCalendarError(
      'Google Calendar is unavailable',
      undefined,
      undefined,
      undefined,
      classifyTransportFailure(error),
    )
  }
}

const discardResponseBody = async (response: Response) => {
  await response.body?.cancel()
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
    if (updated.ok) {
      await discardResponseBody(updated)
      return 'updated'
    }
    if (updated.status !== 404) await rejectedResponse(updated, 'Google Calendar rejected an event update')
    await discardResponseBody(updated)
  }

  const inserted = await googleRequest(fetcher, token, config, '/events', {
    method: 'POST',
    body: JSON.stringify({ id, ...body }),
  })
  if (inserted.ok) {
    await discardResponseBody(inserted)
    return 'created'
  }
  if (inserted.status === 409) {
    await discardResponseBody(inserted)
    const updated = await googleRequest(fetcher, token, config, `/events/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    if (updated.ok) {
      await discardResponseBody(updated)
      return 'updated'
    }
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
  await discardResponseBody(response)
  return response.status !== 404 && response.status !== 410
}

const executeOperations = async (operations: readonly (() => Promise<void>)[]) => {
  const failures: unknown[] = []
  for (let index = 0; index < operations.length; index += googleOperationConcurrency) {
    const results = await Promise.allSettled(
      operations.slice(index, index + googleOperationConcurrency).map(operation => operation()),
    )
    const batchFailures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    failures.push(...batchFailures)
    if (batchFailures.some(failure => failure instanceof GoogleCalendarError
      && (failure.status === 429
        || failure.reason === 'rateLimitExceeded'
        || failure.reason === 'userRateLimitExceeded'))) break
  }
  return failures
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

/** Applies one coalesced queue batch while sharing a single OAuth access token. */
export const syncGoogleCalendarChanges = async (
  events: readonly PortalCalendarEvent[],
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch = fetch,
  deletedEventIds: readonly string[] = [],
): Promise<GoogleCalendarSyncReport> => {
  const resolved = new Map<string, PortalCalendarEvent>()
  for (const item of events) {
    const previous = resolved.get(item.event.id)
    if (!previous || item.sequence > previous.sequence
      || (item.sequence === previous.sequence && item.cancelled && !previous.cancelled)) {
      resolved.set(item.event.id, item)
    }
  }
  const deletions = deletedEventIds.filter(eventId => !resolved.has(eventId))
  if (resolved.size === 0 && deletions.length === 0) return { created: 0, updated: 0, deleted: 0 }

  const token = await accessToken(config, fetcher)
  const report: GoogleCalendarSyncReport = { created: 0, updated: 0, deleted: 0 }
  const operations = [...resolved.values()].map(item => async () => {
    if (item.cancelled) {
      if (await deleteWithToken(item.event.id, config, fetcher, token)) report.deleted += 1
      return
    }
    const result = await upsertWithToken(item, config, fetcher, token)
    report[result] += 1
  })
  operations.push(...deletions.map(eventId => async () => {
    if (await deleteWithToken(eventId, config, fetcher, token)) report.deleted += 1
  }))
  const failures = await executeOperations(operations)
  if (failures.length > 0) {
    throw new GoogleCalendarError(
      `Google Calendar synchronization failed for ${failures.length} operation(s)`,
      undefined,
      undefined,
      summarizeOperationFailures(failures),
    )
  }
  return report
}

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
      if (existingEvent?.sequence !== undefined && existingEvent.sequence >= item.sequence) return
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

  const failures = await executeOperations(operations)
  if (failures.length > 0) {
    throw new GoogleCalendarError(
      `Google Calendar synchronization failed for ${failures.length} operation(s)`,
      undefined,
      undefined,
      summarizeOperationFailures(failures),
    )
  }
  return report
}

const portalMeetupEventsUrl = 'https://portal.einundzwanzig.space/api/meetup-events'
const portalRequestTimeoutMs = 10_000
const importedEventProperty = 'jednadvacetImportedEventId'
const portalTextLimit = 255

export interface GoogleCalendarImportReport {
  /** Events created in Portal from manually added Google events. */
  created: number
  /** Manual Google events removed because Portal already publishes them. */
  removed: number
  /** Imported events whose Portal copy was not visible in the supplied Portal state yet. */
  pending: number
  /** Events without a recognizable community prefix, all-day events and recurring events. */
  skipped: number
  failed: number
}

interface ManualGoogleEvent {
  id: string
  summary: string
  start: string
  end?: string
  location?: string
  description?: string
  importedEventId?: string
}

const comparable = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

/** Resolves the community from the city prefix used by legacy calendar titles, e.g. "Brno - Meetup". */
const splitCommunityPrefix = (summary: string, communities: readonly PortalCalendarEvent['community'][]) => {
  const title = summary.normalize('NFC').trim()
  const candidates = communities
    .filter(community => community.portalMeetupId !== undefined)
    .map(community => ({ community, prefix: community.title.normalize('NFC').trim() }))
    .sort((left, right) => right.prefix.length - left.prefix.length)
  for (const { community, prefix } of candidates) {
    if (!prefix || comparable(title.slice(0, prefix.length)) !== comparable(prefix)) continue
    const rest = title.slice(prefix.length)
    if (rest && /^[\p{L}\p{N}]/u.test(rest)) continue
    return { community, title: rest.replace(/^[\s\-–—:|,]+/u, '') }
  }
  return undefined
}

/** Portal renders descriptions as plain text, while Google stores what its editor produced as HTML. */
const plainText = (value: string) => value
  .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, '\'')
  .replace(/&amp;/g, '&')
  .trim()

const listManualEvents = async (
  config: GoogleCalendarConfig,
  fetcher: GoogleFetch,
  token: string,
  now: Date,
) => {
  const events: ManualGoogleEvent[] = []
  let skipped = 0
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({
      timeMin: now.toISOString(),
      singleEvents: 'true',
      maxResults: '2500',
      showDeleted: 'false',
    })
    if (pageToken) query.set('pageToken', pageToken)
    const response = await googleRequest(fetcher, token, config, `/events?${query}`)
    if (!response.ok) await rejectedResponse(response, 'Google Calendar rejected the event list')
    const payload = await responseJson(response)
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new GoogleCalendarError('Google Calendar returned an invalid event list')
    }
    for (const value of payload.items) {
      if (!isRecord(value) || typeof value.id !== 'string') continue
      const privateProperties = isRecord(value.extendedProperties) && isRecord(value.extendedProperties.private)
        ? value.extendedProperties.private
        : undefined
      if (privateProperties?.jednadvacetSource === integrationSource) continue
      const start = isRecord(value.start) && typeof value.start.dateTime === 'string' ? value.start.dateTime : undefined
      if (typeof value.summary !== 'string' || !start || Number.isNaN(Date.parse(start))
        || typeof value.recurringEventId === 'string') {
        skipped += 1
        continue
      }
      const end = isRecord(value.end) && typeof value.end.dateTime === 'string' ? value.end.dateTime : undefined
      events.push({
        id: value.id,
        summary: value.summary,
        start,
        ...(end && Date.parse(end) > Date.parse(start) ? { end } : {}),
        ...(typeof value.location === 'string' && value.location.trim() ? { location: value.location.trim() } : {}),
        ...(typeof value.description === 'string' && plainText(value.description)
          ? { description: plainText(value.description) }
          : {}),
        ...(typeof privateProperties?.[importedEventProperty] === 'string'
          ? { importedEventId: privateProperties[importedEventProperty] }
          : {}),
      })
    }
    pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : undefined
  } while (pageToken)
  return { events, skipped }
}

const createPortalEvent = async (
  item: ManualGoogleEvent,
  meetupId: number,
  title: string,
  portalApiToken: string,
  fetcher: GoogleFetch,
) => {
  const response = await fetcher(portalMeetupEventsUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(portalRequestTimeoutMs),
    headers: {
      'authorization': `Bearer ${portalApiToken}`,
      'accept': 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      meetup_id: meetupId,
      start: item.start,
      ...(item.end ? { end: item.end } : {}),
      ...(title ? { title: title.slice(0, portalTextLimit) } : {}),
      ...(item.location ? { location: item.location.slice(0, portalTextLimit) } : {}),
      ...(item.description ? { description: item.description } : {}),
    }),
  })
  if (!response.ok) {
    await discardResponseBody(response)
    throw new Error(`Portal rejected an event import (${response.status})`)
  }
  const payload = await response.json().catch(() => undefined)
  const created = isRecord(payload) && isRecord(payload.data) ? payload.data : payload
  if (!isRecord(created) || (typeof created.id !== 'number' && typeof created.id !== 'string')) {
    throw new Error('Portal returned an invalid imported event')
  }
  return String(created.id)
}

/**
 * Moves manually added Google events into Portal, which stays the single source of truth.
 * A manual event is created in Portal once and marked; it is removed from Google only after the
 * supplied Portal state contains its copy, which the regular synchronization publishes back.
 */
export const importGoogleCalendarEvents = async (
  portalEvents: readonly PortalCalendarEvent[],
  communities: readonly PortalCalendarEvent['community'][],
  config: GoogleCalendarConfig,
  portalApiToken: string,
  fetcher: GoogleFetch = fetch,
  now = new Date(),
): Promise<GoogleCalendarImportReport> => {
  const token = await accessToken(config, fetcher)
  const { events, skipped } = await listManualEvents(config, fetcher, token, now)
  const published = portalEvents.filter(item => !item.cancelled)
  const report: GoogleCalendarImportReport = { created: 0, removed: 0, pending: 0, skipped, failed: 0 }

  // Sequential on purpose: Portal throttles writes per token and a partial run must stay easy to resume.
  for (const item of events) {
    const match = splitCommunityPrefix(item.summary, communities)
    if (!match) {
      report.skipped += 1
      continue
    }
    try {
      const alreadyPublished = published.some(portal => portal.event.id === item.importedEventId
        || (portal.community.id === match.community.id && Date.parse(portal.event.start) === Date.parse(item.start)))
      if (alreadyPublished) {
        const response = await googleRequest(fetcher, token, config, `/events/${encodeURIComponent(item.id)}`, {
          method: 'DELETE',
        })
        if (!response.ok && response.status !== 404 && response.status !== 410) {
          await rejectedResponse(response, 'Google Calendar rejected a manual event deletion')
        }
        await discardResponseBody(response)
        report.removed += 1
      } else if (item.importedEventId) {
        report.pending += 1
      } else {
        const portalEventId = await createPortalEvent(
          item,
          match.community.portalMeetupId as number,
          match.title,
          portalApiToken,
          fetcher,
        )
        report.created += 1
        const response = await googleRequest(fetcher, token, config, `/events/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ extendedProperties: { private: { [importedEventProperty]: portalEventId } } }),
        })
        if (!response.ok) await rejectedResponse(response, 'Google Calendar rejected an import marker')
        await discardResponseBody(response)
      }
    } catch (error) {
      report.failed += 1
      console.error(`[portal-events] Google Calendar import step failed: ${error instanceof Error ? error.message : typeof error}`)
    }
  }
  return report
}
