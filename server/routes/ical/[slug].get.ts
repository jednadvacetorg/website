import ICAL from 'ical.js'
import { createError, defineEventHandler, getHeader, getQuery, getRouterParam, type H3Event } from 'h3'
import {
  getPortalCalendarEvents,
  type PortalCalendarEvent,
  type PortalCommunity,
  type PortalFetch,
  type PortalStorage,
} from '../../utils/portalEvents.ts'
import { projectCalendarEvent } from '../../utils/calendarEventProjection.ts'

const publicSlugPattern = /^[a-z0-9][a-z0-9-]*$/
const maxSelectedCommunities = 100

export type PublicCalendarCommunity = Omit<PortalCommunity, 'portalMeetupId'> & {
  portalMeetupId?: number
}

export interface PublicCalendarDependencies {
  communities: () => Promise<readonly PublicCalendarCommunity[]>
  storage: PortalStorage
  fetch: PortalFetch
  now?: Date
}

/** Represents a public-safe iCalendar route failure. */
export class PublicCalendarError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

/** Validates and canonicalizes an all-country or comma-separated public scope. */
export const parsePublicCalendarScope = (scope: string | undefined, query: Record<string, unknown> = {}) => {
  if (Object.keys(query).length > 0 || !scope) throw new PublicCalendarError(400, 'Neplatná adresa kalendáře.')
  if (scope === 'all') return 'all' as const
  const slugs = scope.split(',')
  if (slugs.length > maxSelectedCommunities || slugs.some(slug => !publicSlugPattern.test(slug) || /^\d+$/.test(slug))) {
    throw new PublicCalendarError(400, 'Neplatná adresa kalendáře.')
  }
  const unique = [...new Set(slugs)].sort()
  if (unique.length !== slugs.length) throw new PublicCalendarError(400, 'Neplatná adresa kalendáře.')
  return unique
}

/** Projects cached Portal events into one standards-compliant calendar document. */
export const generateCalendar = (name: string, events: readonly PortalCalendarEvent[], prefixCommunity = false) => {
  const calendar = new ICAL.Component('vcalendar')
  calendar.addPropertyWithValue('version', '2.0')
  calendar.addPropertyWithValue('prodid', '-//Jednadvacet.org//Calendar//CS')
  calendar.addPropertyWithValue('calscale', 'GREGORIAN')
  calendar.addPropertyWithValue('name', name)
  calendar.addPropertyWithValue('x-wr-calname', name)

  const uniqueEvents = new Map<string, PortalCalendarEvent>()
  for (const item of events) {
    const uid = `meetup-event-${item.event.id}@einundzwanzig.space`
    const previous = uniqueEvents.get(uid)
    if (!previous || item.sequence > previous.sequence
      || (item.sequence === previous.sequence && item.cancelled && !previous.cancelled)) {
      uniqueEvents.set(uid, item)
    }
  }

  for (const [uid, item] of [...uniqueEvents].sort((left, right) =>
    Date.parse(left[1].event.start) - Date.parse(right[1].event.start) || left[0].localeCompare(right[0]))) {
    const projected = projectCalendarEvent(item, prefixCommunity)
    const event = new ICAL.Component('vevent')
    event.addPropertyWithValue('uid', uid)
    event.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(item.changedAt), true))
    event.addPropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(projected.start), true))
    event.addPropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(projected.end), true))
    event.addPropertyWithValue('summary', projected.title)
    event.addPropertyWithValue('status', item.cancelled ? 'CANCELLED' : 'CONFIRMED')
    event.addPropertyWithValue('sequence', item.sequence)
    if (projected.description) event.addPropertyWithValue('description', projected.description)
    if (projected.location) event.addPropertyWithValue('location', projected.location)
    if (projected.url) event.addPropertyWithValue('url', projected.url)
    if (item.event.image) {
      const image = new ICAL.Property('image')
      image.resetType('uri')
      image.setParameter('value', 'URI')
      image.setParameter('display', 'BADGE')
      image.setValue(item.event.image)
      event.addProperty(image)
    }
    calendar.addSubcomponent(event)
  }
  return calendar.toString()
}

/** Resolves a public scope to cached events and returns one generated inline feed. */
export const getPublicCalendarFeed = async (
  scope: string | undefined,
  dependencies: PublicCalendarDependencies,
  asPlainText = false,
): Promise<Response> => {
  const requested = parsePublicCalendarScope(scope)
  const communities = await dependencies.communities()
  const selected = requested === 'all'
    ? communities
    : communities.filter(community => requested.includes(community.id))
  if (selected.length === 0 || (requested !== 'all' && selected.length !== requested.length)) {
    throw new PublicCalendarError(404, 'Kalendář komunity nebyl nalezen.')
  }

  let events: PortalCalendarEvent[]
  try {
    const configured = selected.filter((community): community is PortalCommunity =>
      community.portalMeetupId !== undefined)
    events = configured.length === 0
      ? []
      : await getPortalCalendarEvents(
          configured.map(community => community.id),
          configured,
          dependencies.storage,
          dependencies.fetch,
          dependencies.now,
        )
  } catch {
    throw new PublicCalendarError(503, 'Kalendář je nyní nedostupný.')
  }
  const name = requested === 'all'
    ? 'Jednadvacet - Celé Česko'
    : `Jednadvacet - ${selected.map(community => community.title).join(', ')}`
  const body = generateCalendar(name, events, requested === 'all' || selected.length > 1)

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': asPlainText ? 'text/plain; charset=utf-8' : 'text/calendar; charset=utf-8',
      'content-disposition': 'inline',
      'vary': 'Sec-Fetch-Dest',
      'x-content-type-options': 'nosniff',
    },
  })
}

const getPublicCalendarCommunities = async (event: H3Event): Promise<PublicCalendarCommunity[]> => {
  const { queryCollection } = await import('@nuxt/content/server')
  const communities = await queryCollection(event, 'communities').all()
  return communities.map((community) => {
    const portalMeetupId = community.portal_meetup_id === undefined || community.portal_meetup_id === null
      ? undefined
      : Number(community.portal_meetup_id)
    if (portalMeetupId !== undefined && (!Number.isSafeInteger(portalMeetupId) || portalMeetupId < 0)) {
      throw new Error(`Community ${community.path} has an invalid Portal meetup ID`)
    }
    return {
      id: community.path.replace(/^\/+/, ''),
      path: community.path,
      title: community.title,
      ...(portalMeetupId !== undefined ? { portalMeetupId } : {}),
    }
  })
}

export default defineEventHandler(async (event) => {
  try {
    const scope = getRouterParam(event, 'slug')
    parsePublicCalendarScope(scope, getQuery(event))
    return await getPublicCalendarFeed(scope, {
      communities: () => getPublicCalendarCommunities(event),
      storage: useStorage('portalEvents'),
      fetch: $fetch,
    }, getHeader(event, 'sec-fetch-dest') === 'document')
  } catch (error) {
    const statusCode = error instanceof PublicCalendarError ? error.statusCode : 503
    const statusMessage = error instanceof PublicCalendarError
      ? error.message
      : 'Kalendář je nyní nedostupný.'
    throw createError({ statusCode, statusMessage })
  }
})
