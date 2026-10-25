import type { H3Event } from 'h3'
import type { PortalEvent } from '../../shared/types/portalEvents.ts'

const portalEventsUrl = 'https://portal.einundzwanzig.space/api/meetup-events?locale=cs'
const cancellationRetentionMs = 90 * 24 * 60 * 60 * 1_000
const cacheSchemaVersion = 1
const wallClockPattern = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/
const publicSlugPattern = /^[a-z0-9][a-z0-9-]*$/

export interface PortalCommunity {
  id: string
  path: string
  title: string
  portalMeetupId?: number
}

export interface PortalStorage {
  getItem(key: string): Promise<unknown>
  setItem(key: string, value: unknown): Promise<void>
  getKeys(base?: string): Promise<string[]>
}

export type PortalFetch = (url: string, options: { timeout: number, retry: number }) => Promise<unknown>

export type PortalChangeAction = 'created' | 'updated' | 'deleted'

export interface PortalChangeSignal {
  resource: 'meetup' | 'meetup-event'
  action: PortalChangeAction
  meetupId: number
  eventId?: string
  sequence: number
  occurredAt: string
}

export class PortalEventsError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

export const portalEventCacheKey = (community: Pick<PortalCommunity, 'id'> | string) =>
  `community:${typeof community === 'string' ? community : community.id}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseUtcWallClock = (value: unknown, field: string) => {
  if (typeof value !== 'string') throw new PortalEventsError(`Portal event ${field} is invalid`, 502)
  const match = wallClockPattern.exec(value)
  if (!match) throw new PortalEventsError(`Portal event ${field} is invalid`, 502)
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (instant.getUTCFullYear() !== year || instant.getUTCMonth() !== month - 1 || instant.getUTCDate() !== day
    || instant.getUTCHours() !== hour || instant.getUTCMinutes() !== minute) {
    throw new PortalEventsError(`Portal event ${field} is invalid`, 502)
  }
  return instant.toISOString()
}

const parseLink = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '' || typeof value !== 'string') return undefined
  try {
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(new URL(value).protocol) ? value : undefined
  } catch {
    return undefined
  }
}

const parseOptionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

const parseCoordinate = (value: unknown, minimum: number, maximum: number): string | undefined => {
  const coordinate = parseOptionalText(value)
  if (!coordinate) return undefined
  const numeric = Number(coordinate)
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum ? coordinate : undefined
}

const withoutMeetupMetadata = (event: Record<string, unknown>) => Object.fromEntries(
  Object.entries(event).filter(([key]) => key !== 'meetup' && key !== 'meetup_id' && key !== 'community'
    && key !== 'link' && key !== 'safeLink' && key !== 'location' && key !== 'description' && key !== 'image'
    && !['osm_type', 'osm_id', 'osm_name', 'osm_address', 'osm_lat', 'osm_lon'].includes(key)
    && !key.startsWith('meetup.')),
)

const parseTags = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.filter(isRecord)
  : []

const parseEvent = (value: unknown): PortalEvent => {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) < 0) {
    throw new PortalEventsError('Portal event row is invalid', 502)
  }
  const title = typeof value.title === 'string' && value.title.trim()
    ? value.title
    : typeof value['meetup.name'] === 'string' && value['meetup.name'].trim()
      ? value['meetup.name']
      : null
  if (!title) throw new PortalEventsError('Portal event title is invalid', 502)
  const link = typeof value.link === 'string' ? value.link : undefined
  const safeLink = parseLink(link)
  const location = parseOptionalText(value.location)
  const osmType = parseOptionalText(value.osm_type)
  const osmId = Number.isSafeInteger(value.osm_id) && (value.osm_id as number) >= 0 ? value.osm_id as number : undefined
  const osmName = parseOptionalText(value.osm_name)
  const osmAddress = parseOptionalText(value.osm_address)
  const osmLat = parseCoordinate(value.osm_lat, -90, 90)
  const osmLon = parseCoordinate(value.osm_lon, -180, 180)
  const description = parseOptionalText(value.description)
  const image = parseLink(value['meetup.logo'])
  const start = parseUtcWallClock(value.start, 'start')
  const end = value.end === null ? null : parseUtcWallClock(value.end, 'end')
  if (end && Date.parse(end) <= Date.parse(start)) {
    throw new PortalEventsError('Portal event time range is invalid', 502)
  }
  return {
    ...withoutMeetupMetadata(value),
    id: String(value.id),
    title,
    start,
    end,
    ...(link !== undefined ? { link } : {}),
    ...(safeLink ? { safeLink } : {}),
    ...(location ? { location } : {}),
    ...(osmType ? { osm_type: osmType } : {}),
    ...(osmId !== undefined ? { osm_id: osmId } : {}),
    ...(osmName ? { osm_name: osmName } : {}),
    ...(osmAddress ? { osm_address: osmAddress } : {}),
    ...(osmLat ? { osm_lat: osmLat } : {}),
    ...(osmLon ? { osm_lon: osmLon } : {}),
    ...(description ? { description } : {}),
    ...(image?.startsWith('http') ? { image } : {}),
    tags: parseTags(value.tags),
  }
}

interface CachedEvent {
  event: PortalEvent
  fingerprint: string
  sequence: number
  changedAt: string
}

interface CancelledEvent extends CachedEvent {
  cancelledAt: string
}

interface AppliedSignal {
  action: PortalChangeAction
  sequence: number
  occurredAt: string
}

interface CachedEvents {
  schemaVersion: typeof cacheSchemaVersion
  community: PortalCommunity
  events: CachedEvent[]
  cancellations: CancelledEvent[]
  signals: Record<string, AppliedSignal>
  fetchedAt: string
}

export interface PortalCalendarEvent {
  event: PortalEvent
  sequence: number
  changedAt: string
  cancelled: boolean
  community: PortalCommunity
}

const isPortalEvent = (value: unknown): value is PortalEvent => isRecord(value)
  && typeof value.id === 'string'
  && typeof value.title === 'string'
  && typeof value.start === 'string'
  && !Number.isNaN(Date.parse(value.start))
  && (value.end === null || (typeof value.end === 'string' && !Number.isNaN(Date.parse(value.end))))
  && (value.link === undefined || typeof value.link === 'string')
  && (value.safeLink === undefined || typeof value.safeLink === 'string')
  && (value.location === undefined || typeof value.location === 'string')
  && (value.osm_type === undefined || typeof value.osm_type === 'string')
  && (value.osm_id === undefined || (typeof value.osm_id === 'number' && Number.isSafeInteger(value.osm_id) && value.osm_id >= 0))
  && (value.osm_name === undefined || typeof value.osm_name === 'string')
  && (value.osm_address === undefined || typeof value.osm_address === 'string')
  && (value.osm_lat === undefined || parseCoordinate(value.osm_lat, -90, 90) === value.osm_lat)
  && (value.osm_lon === undefined || parseCoordinate(value.osm_lon, -180, 180) === value.osm_lon)
  && (value.description === undefined || typeof value.description === 'string')
  && (value.image === undefined || (typeof value.image === 'string' && /^https?:\/\//.test(value.image)))
  && Array.isArray(value.tags)
  && value.tags.every(isRecord)
  && !Object.keys(value).some(key => key === 'meetup' || key === 'meetup_id' || key === 'community' || key.startsWith('meetup.'))

const isCachedEvent = (value: unknown): value is CachedEvent => isRecord(value)
  && isPortalEvent(value.event)
  && typeof value.fingerprint === 'string'
  && Number.isSafeInteger(value.sequence)
  && typeof value.changedAt === 'string'
  && !Number.isNaN(Date.parse(value.changedAt))

const isCancelledEvent = (value: unknown): value is CancelledEvent => isCachedEvent(value)
  && 'cancelledAt' in value
  && typeof value.cancelledAt === 'string'
  && !Number.isNaN(Date.parse(value.cancelledAt))

const isCommunity = (value: unknown): value is PortalCommunity => isRecord(value)
  && typeof value.id === 'string' && publicSlugPattern.test(value.id)
  && typeof value.path === 'string' && typeof value.title === 'string'
  && (value.portalMeetupId === undefined
    || (Number.isSafeInteger(value.portalMeetupId) && (value.portalMeetupId as number) >= 0))

const isAppliedSignal = (value: unknown): value is AppliedSignal => isRecord(value)
  && ['created', 'updated', 'deleted'].includes(String(value.action))
  && Number.isSafeInteger(value.sequence)
  && typeof value.occurredAt === 'string'
  && !Number.isNaN(Date.parse(value.occurredAt))

/** Fully validates state before a background writer uses it to produce the next snapshot. */
const parseCacheForWrite = (value: unknown): CachedEvents | null => {
  if (!isRecord(value) || value.schemaVersion !== cacheSchemaVersion || !isCommunity(value.community)
    || !Array.isArray(value.events) || !value.events.every(isCachedEvent)
    || !Array.isArray(value.cancellations) || !value.cancellations.every(isCancelledEvent)
    || !isRecord(value.signals) || !Object.values(value.signals).every(isAppliedSignal)
    || typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt))) return null
  return value as unknown as CachedEvents
}

/** Public reads trust snapshots written by this integration after checking their schema identity. */
const parseCacheForRead = (value: unknown): CachedEvents | null => {
  if (!isRecord(value) || value.schemaVersion !== cacheSchemaVersion) return null
  return value as unknown as CachedEvents
}

const futureEvents = (events: readonly PortalEvent[], now: Date) => events
  .filter(event => Date.parse(event.end ?? event.start) >= now.getTime())
  .slice()
  .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Number(a.id) - Number(b.id))

const eventFingerprint = (event: PortalEvent) => JSON.stringify({
  title: event.title,
  start: event.start,
  end: event.end,
  description: event.description,
  location: event.location,
  osm_name: event.osm_name,
  osm_address: event.osm_address,
  safeLink: event.safeLink,
  image: event.image,
  tags: event.tags,
})

const nextRevision = (event: PortalEvent, previous: CachedEvent | undefined, now: Date, force = false): CachedEvent => {
  const fingerprint = eventFingerprint(event)
  if (!force && previous?.fingerprint === fingerprint) return { ...previous, event }
  return {
    event,
    fingerprint,
    sequence: Math.max(previous ? previous.sequence + 1 : 0, Math.floor(now.getTime() / 1_000)),
    changedAt: now.toISOString(),
  }
}

const fetchPayload = async (fetcher: PortalFetch, url: string) => {
  try {
    return await fetcher(url, { timeout: 20_000, retry: 0 })
  } catch (error) {
    const status = isRecord(error)
      ? typeof error.statusCode === 'number'
        ? error.statusCode
        : typeof error.status === 'number'
          ? error.status
          : undefined
      : undefined
    console.error('[portal-events] Portal fetch failed', {
      errorType: error instanceof Error ? error.name : typeof error,
      ...(status !== undefined ? { status } : {}),
    })
    throw new PortalEventsError('Portal event refresh failed', 502)
  }
}

const latestEventSignals = (signals: readonly PortalChangeSignal[]) => {
  const latest = new Map<string, PortalChangeSignal>()
  for (const signal of signals) {
    if (signal.resource !== 'meetup-event' || !signal.eventId) continue
    const previous = latest.get(signal.eventId)
    if (!previous || signal.sequence > previous.sequence) latest.set(signal.eventId, signal)
  }
  return latest
}

export interface PortalRefreshResult {
  deletedEventIds: string[]
  calendarEvents: PortalCalendarEvent[]
}

/** Fetches Portal once and replaces all requested community snapshots. */
export const refreshPortalMeetups = async (
  communities: readonly PortalCommunity[],
  storage: PortalStorage,
  fetcher: PortalFetch,
  now = new Date(),
  signals: readonly PortalChangeSignal[] = [],
  fullRefresh = false,
): Promise<PortalRefreshResult> => {
  // Queue concurrency makes stale reads unlikely, but KV is not strongly consistent.
  // Revisit a Durable Object only if cross-delivery sequence regressions are observed.
  const previousByCommunity = new Map<string, CachedEvents | null>()
  for (const community of communities) {
    previousByCommunity.set(
      community.id,
      parseCacheForWrite(await storage.getItem(portalEventCacheKey(community))),
    )
  }
  const configured = communities.filter((community): community is PortalCommunity & { portalMeetupId: number } =>
    community.portalMeetupId !== undefined)
  let eventPayload: unknown[] = []
  if (configured.length > 0) {
    const url = new URL(portalEventsUrl)
    url.searchParams.set('from', 'today')
    url.searchParams.set('meetup_id', [...new Set(configured.map(community => community.portalMeetupId))]
      .sort((a, b) => a - b).join(','))
    const payload = await fetchPayload(fetcher, url.toString())
    if (!Array.isArray(payload)) {
      throw new PortalEventsError('Portal response is invalid', 502)
    }
    // A partial refresh may legitimately have no events; protect all snapshots on a full refresh.
    if (fullRefresh && payload.length === 0) throw new PortalEventsError('Portal event response is empty', 502)
    eventPayload = payload
  }

  const failedCommunities = new Set<string>()
  const communitiesByMeetup = new Map<number, PortalCommunity[]>()
  for (const community of configured) {
    const matching = communitiesByMeetup.get(community.portalMeetupId) ?? []
    matching.push(community)
    communitiesByMeetup.set(community.portalMeetupId, matching)
  }
  const eventsByCommunity = new Map<string, PortalEvent[]>()
  for (const row of eventPayload) {
    if (!isRecord(row) || !Number.isSafeInteger(row.meetup_id)) continue
    const matching = communitiesByMeetup.get(row.meetup_id as number)
    if (!matching) continue
    let parsed: PortalEvent
    try {
      parsed = parseEvent(row)
    } catch {
      for (const community of matching) failedCommunities.add(community.id)
      continue
    }
    for (const community of matching) {
      const events = eventsByCommunity.get(community.id) ?? []
      events.push(parsed)
      eventsByCommunity.set(community.id, events)
    }
  }

  const signalsByMeetup = new Map<number, PortalChangeSignal[]>()
  for (const signal of signals) {
    const meetupSignals = signalsByMeetup.get(signal.meetupId) ?? []
    meetupSignals.push(signal)
    signalsByMeetup.set(signal.meetupId, meetupSignals)
  }
  const snapshots: CachedEvents[] = []
  const deletedEventIds = new Set<string>()
  for (const community of communities) {
    const previous = previousByCommunity.get(community.id) ?? null
    if (failedCommunities.has(community.id)) {
      if (previous) snapshots.push(previous)
      continue
    }
    const communitySignals = community.portalMeetupId === undefined
      ? []
      : signalsByMeetup.get(community.portalMeetupId) ?? []
    const incomingSignals = latestEventSignals(communitySignals)
    const retainedSignals = Object.fromEntries(Object.entries(previous?.signals ?? {})
      .filter(([, signal]) => now.getTime() - Date.parse(signal.occurredAt) < cancellationRetentionMs))
    for (const [eventId, signal] of incomingSignals) {
      const applied = retainedSignals[eventId]
      if (!applied || signal.sequence > applied.sequence) {
        retainedSignals[eventId] = {
          action: signal.action,
          sequence: signal.sequence,
          occurredAt: signal.occurredAt,
        }
      }
    }

    const previousActive = new Map(previous?.events.map(item => [item.event.id, item]))
    const previousCancelled = new Map((previous?.cancellations ?? [])
      .filter(item => now.getTime() - Date.parse(item.cancelledAt) < cancellationRetentionMs)
      .map(item => [item.event.id, item]))
    const sourceEvents = futureEvents(eventsByCommunity.get(community.id) ?? [], now)
    const sourceById = new Map(sourceEvents.map(event => [event.id, event]))
    const cancellations = new Map(previousCancelled)

    for (const [eventId, signal] of Object.entries(retainedSignals)) {
      if (signal.action !== 'deleted') {
        cancellations.delete(eventId)
        continue
      }
      const basis = previousActive.get(eventId) ?? previousCancelled.get(eventId)
      const event = sourceById.get(eventId) ?? basis?.event
      if (!event) continue
      const previousSignal = previous?.signals[eventId]
      const isNewDeletion = signal.action === 'deleted'
        && (!previousSignal || signal.sequence > previousSignal.sequence)
      const revision = previousCancelled.has(eventId) && !isNewDeletion
        ? previousCancelled.get(eventId) as CancelledEvent
        : nextRevision(event, basis, now, isNewDeletion)
      cancellations.set(eventId, {
        ...revision,
        cancelledAt: isNewDeletion ? signal.occurredAt : previousCancelled.get(eventId)?.cancelledAt ?? signal.occurredAt,
      })
    }

    const events = sourceEvents
      .filter(event => retainedSignals[event.id]?.action !== 'deleted')
      .map((event) => {
        const restored = previousCancelled.get(event.id)
        return nextRevision(event, restored ?? previousActive.get(event.id), now, Boolean(restored))
      })
    const cache: CachedEvents = {
      schemaVersion: cacheSchemaVersion,
      community,
      events,
      cancellations: [...cancellations.values()],
      signals: retainedSignals,
      fetchedAt: now.toISOString(),
    }
    snapshots.push(cache)
    for (const eventId of incomingSignals.keys()) {
      if (retainedSignals[eventId]?.action === 'deleted') deletedEventIds.add(eventId)
    }
  }

  await Promise.all(snapshots.map(snapshot => storage.setItem(portalEventCacheKey(snapshot.community), snapshot)))
  if (failedCommunities.size > 0) {
    throw new PortalEventsError(
      `Portal event refresh was incomplete for: ${[...failedCommunities].sort().join(', ')}`,
      502,
    )
  }
  return {
    deletedEventIds: [...deletedEventIds],
    calendarEvents: snapshots.flatMap(cache => [
      ...cache.events.map(item => ({ ...item, cancelled: false, community: cache.community })),
      ...cache.cancellations.map(item => ({ ...item, cancelled: true, community: cache.community })),
    ]),
  }
}

const readSelectedCaches = async (
  requested: readonly string[] | 'all',
  storage: PortalStorage,
) => {
  const keys = requested === 'all'
    // Removed or renamed content communities can leave obsolete keys behind. Writer-side
    // cleanup is deferred until a retention policy is defined for those public snapshots.
    ? (await storage.getKeys('community:')).filter(key => key.startsWith('community:')).sort()
    : requested.map(portalEventCacheKey)
  if (keys.length === 0) throw new PortalEventsError('Portal event cache is unavailable', 503)
  const caches = await Promise.all(keys.map(async (key) => {
    const value = await storage.getItem(key)
    if (value === null || value === undefined) throw new PortalEventsError('Community was not found', 404)
    const cache = parseCacheForRead(value)
    if (!cache) throw new PortalEventsError('Portal event cache is unavailable', 503)
    return cache
  }))
  return caches
}

/** Returns browser events exclusively from durable community snapshots. */
export const getPortalEvents = async (
  requested: string,
  storage: PortalStorage,
): Promise<PortalEvent[]> => {
  const caches = await readSelectedCaches(requested === 'all' ? 'all' : [requested], storage)
  return caches.flatMap(cache => cache.events.map(({ event }) => requested === 'all'
    ? { ...event, community: { path: cache.community.path, name: cache.community.title } }
    : event))
}

/** Returns active and cancelled rows exclusively from durable community snapshots. */
export const getPortalCalendarEvents = async (
  requested: readonly string[] | 'all',
  storage: PortalStorage,
): Promise<PortalCalendarEvent[]> => {
  const caches = await readSelectedCaches(requested, storage)
  return caches.flatMap(cache => [
    ...cache.events.map(item => ({ ...item, cancelled: false, community: cache.community })),
    ...cache.cancellations.map(item => ({ ...item, cancelled: true, community: cache.community })),
  ])
}

/** Returns snapshot-owned community labels together with their calendar rows. */
export const getPortalCalendarData = async (
  requested: readonly string[] | 'all',
  storage: PortalStorage,
) => {
  const caches = await readSelectedCaches(requested, storage)
  return {
    communities: caches.map(cache => cache.community),
    events: caches.flatMap(cache => [
      ...cache.events.map(item => ({ ...item, cancelled: false, community: cache.community })),
      ...cache.cancellations.map(item => ({ ...item, cancelled: true, community: cache.community })),
    ]),
  }
}

/** Reads all content-owned communities, including valid empty calendar scopes. */
export const getPortalCommunities = async (event?: H3Event): Promise<PortalCommunity[]> => {
  const { queryCollection } = await import('@nuxt/content/server')
  const communities = await queryCollection(event as H3Event, 'communities').all()
  return communities.map((community) => {
    const portalMeetupId = community.portal_meetup_id === undefined || community.portal_meetup_id === null
      ? undefined
      : Number(community.portal_meetup_id)
    if (portalMeetupId !== undefined && (!Number.isSafeInteger(portalMeetupId) || portalMeetupId <= 0)) {
      throw new Error(`Community ${community.path} has an invalid Portal meetup ID`)
    }
    return {
      id: community.path.replace(/^\/+|\/+$/g, ''),
      path: community.path,
      title: community.title,
      ...(portalMeetupId !== undefined ? { portalMeetupId } : {}),
    }
  })
}
