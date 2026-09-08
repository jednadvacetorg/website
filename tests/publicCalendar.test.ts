import assert from 'node:assert/strict'
import test from 'node:test'
import ICAL from 'ical.js'
import {
  generateCalendar,
  getPublicCalendarFeed,
  parsePublicCalendarScope,
  PublicCalendarError,
  type PublicCalendarCommunity,
  type PublicCalendarDependencies,
} from '../server/routes/ical/[slug].get.ts'
import type { PortalCalendarEvent, PortalCommunity, PortalStorage } from '../server/utils/portalEvents.ts'

const brno: PortalCommunity = { id: 'brno', path: '/brno', title: 'Brno', portalMeetupId: 360 }
const online: PortalCommunity = { id: 'online-poker', path: '/online-poker', title: 'Online poker', portalMeetupId: 367 }
const pribram: PublicCalendarCommunity = { id: 'pribram', path: '/pribram', title: 'Příbram' }
const now = new Date('2026-08-30T12:00:00.000Z')

const portalEvent = (id: number, portalLink: string, title: string) => ({
  id,
  title,
  start: '2026-08-31 15:00',
  end: '2026-08-31 17:00',
  description: 'První řádek\nDruhý řádek',
  link: 'https://example.test/event',
  osm_name: 'Bitcoin Coffee',
  osm_address: 'Brno, Česko',
  tags: [{ name: 'Začátečníci' }, { name: 'Praha' }],
  'meetup.portalLink': portalLink,
})

const meetupRows = [
  { id: 360, portalLink: 'portal:brno' },
  { id: 367, portalLink: 'portal:online' },
]

const dependencies = (options: {
  communities?: readonly PublicCalendarCommunity[]
  events?: unknown[]
  meetups?: unknown[]
  fail?: boolean
} = {}): PublicCalendarDependencies => {
  const values = new Map<string, unknown>()
  const storage: PortalStorage = {
    getItem: async key => values.get(key),
    setItem: async (key, value) => { values.set(key, value) },
  }
  return {
    communities: async () => options.communities ?? [brno, online],
    storage,
    fetch: async (url) => {
      if (options.fail) throw new Error('Portal transport detail')
      return url.endsWith('/meetups')
        ? options.meetups ?? meetupRows
        : options.events ?? [
            portalEvent(1, 'portal:brno', 'Brněnský meetup'),
            portalEvent(2, 'portal:online', 'Online meetup'),
          ]
    },
    now,
  }
}

test('an unconfigured community keeps a valid empty feed that starts returning events after Portal is connected', async () => {
  const emptyResponse = await getPublicCalendarFeed('pribram', dependencies({
    communities: [pribram],
    fail: true,
  }))
  const emptyCalendar = ICAL.Component.fromString(await emptyResponse.text())
  assert.equal(emptyResponse.status, 200)
  assert.equal(emptyCalendar.getFirstPropertyValue('x-wr-calname'), 'Jednadvacet - Příbram')
  assert.deepEqual(emptyCalendar.getAllSubcomponents('vevent'), [])

  const connectedResponse = await getPublicCalendarFeed('pribram', dependencies({
    communities: [{ ...pribram, portalMeetupId: 500 }],
    events: [portalEvent(3, 'portal:pribram', 'Příbramský meetup')],
    meetups: [{ id: 500, portalLink: 'portal:pribram' }],
  }))
  const connectedCalendar = ICAL.Component.fromString(await connectedResponse.text())
  assert.deepEqual(connectedCalendar.getAllSubcomponents('vevent').map(event =>
    event.getFirstPropertyValue('summary')), ['Příbramský meetup'])
})

test('a mixed scope includes unconfigured communities while fetching events only for configured ones', async () => {
  const response = await getPublicCalendarFeed('brno,pribram', dependencies({
    communities: [brno, pribram],
    events: [portalEvent(1, 'portal:brno', 'Brněnský meetup')],
  }))
  const calendar = ICAL.Component.fromString(await response.text())
  assert.equal(calendar.getFirstPropertyValue('x-wr-calname'), 'Jednadvacet - Brno, Příbram')
  assert.deepEqual(calendar.getAllSubcomponents('vevent').map(event =>
    event.getFirstPropertyValue('summary')), ['Brno - Brněnský meetup'])
})

test('configured scope returns one generated inline calendar with stable event metadata', async () => {
  const response = await getPublicCalendarFeed('brno', dependencies())
  const body = await response.text()
  const calendar = ICAL.Component.fromString(body)
  const event = calendar.getFirstSubcomponent('vevent')

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8')
  assert.equal(response.headers.get('content-disposition'), 'inline')
  assert.equal(response.headers.get('vary'), 'Sec-Fetch-Dest')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(calendar.getFirstPropertyValue('x-wr-calname'), 'Jednadvacet - Brno')
  assert.equal(event?.getFirstPropertyValue('uid'), 'meetup-event-1@einundzwanzig.space')
  assert.equal(event?.getFirstPropertyValue('summary'), 'Brněnský meetup')
  assert.equal(event?.getFirstPropertyValue('status'), 'CONFIRMED')
  assert.equal(event?.getFirstPropertyValue('location'), 'Bitcoin Coffee, Brno, Česko')
  assert.match(String(event?.getFirstPropertyValue('description')), /^\[Začátečníci\] \[Praha\]\n\nPrvní řádek/)
})

test('comma-separated and all-country scopes produce one calendar containing every selected community', async () => {
  assert.deepEqual(parsePublicCalendarScope('online-poker,brno'), ['brno', 'online-poker'])
  for (const scope of ['brno,online-poker', 'all']) {
    const response = await getPublicCalendarFeed(scope, dependencies())
    const calendar = ICAL.Component.fromString(await response.text())
    const events = calendar.getAllSubcomponents('vevent')
    assert.equal(calendar.getFirstPropertyValue('x-wr-calname'), scope === 'all'
      ? 'Jednadvacet - Celé Česko'
      : 'Jednadvacet - Brno, Online poker')
    assert.deepEqual(events.map(event => event.getFirstPropertyValue('summary')), [
      'Brno - Brněnský meetup',
      'Online poker - Online meetup',
    ])
  }
})

test('browser document navigations receive the generated feed as readable plain text', async () => {
  const response = await getPublicCalendarFeed('brno', dependencies(), true)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.match(await response.text(), /^BEGIN:VCALENDAR/)
})

test('generated cancellation preserves UID and emits a higher sequence', () => {
  const item: PortalCalendarEvent = {
    event: {
      id: '1',
      title: 'Zrušený meetup',
      start: '2026-08-31T15:00:00.000Z',
      end: null,
      tags: [],
    },
    sequence: 10,
    changedAt: now.toISOString(),
    cancelled: true,
    community: brno,
  }
  const calendar = ICAL.Component.fromString(generateCalendar('Jednadvacet', [item]))
  const event = calendar.getFirstSubcomponent('vevent')
  assert.equal(event?.getFirstPropertyValue('uid'), 'meetup-event-1@einundzwanzig.space')
  assert.equal(event?.getFirstPropertyValue('status'), 'CANCELLED')
  assert.equal(event?.getFirstPropertyValue('sequence'), 10)
  const start = event?.getFirstPropertyValue<ICAL.Time>('dtstart')
  const end = event?.getFirstPropertyValue<ICAL.Time>('dtend')
  assert.equal(end?.toUnixTime(), (start?.toUnixTime() ?? 0) + 60 * 60)
})

test('cancellation wins when active and cancelled revisions have the same sequence', () => {
  const active: PortalCalendarEvent = {
    event: { id: '1', title: 'Stale active meetup', start: '2026-08-31T15:00:00.000Z', end: null, tags: [] },
    sequence: 10,
    changedAt: now.toISOString(),
    cancelled: false,
    community: brno,
  }
  const cancelled: PortalCalendarEvent = { ...active, cancelled: true }
  const calendar = ICAL.Component.fromString(generateCalendar('Jednadvacet', [active, cancelled]))
  assert.equal(calendar.getAllSubcomponents('vevent').length, 1)
  assert.equal(calendar.getFirstSubcomponent('vevent')?.getFirstPropertyValue('status'), 'CANCELLED')
})

test('malformed, numeric, duplicate, unknown, and query-extended scopes fail safely', async () => {
  for (const scope of ['360', 'brno/../../private', 'brno,,online-poker', 'brno,brno', undefined]) {
    assert.throws(
      () => parsePublicCalendarScope(scope),
      (error: unknown) => error instanceof PublicCalendarError && error.statusCode === 400,
    )
  }
  assert.throws(
    () => parsePublicCalendarScope('brno', { upstream: 'https://attacker.example/calendar' }),
    (error: unknown) => error instanceof PublicCalendarError && error.statusCode === 400,
  )
  await assert.rejects(
    getPublicCalendarFeed('unknown', dependencies()),
    (error: unknown) => error instanceof PublicCalendarError && error.statusCode === 404,
  )
})

test('Portal failures return a safe local error without upstream details', async () => {
  await assert.rejects(
    getPublicCalendarFeed('brno', dependencies({ fail: true })),
    (error: unknown) => error instanceof PublicCalendarError
      && error.statusCode === 503
      && !error.message.includes('Portal transport detail'),
  )
})

test('generated output contains no Portal lookup metadata', async () => {
  const response = await getPublicCalendarFeed('brno', dependencies({ events: [portalEvent(1, 'portal:brno', 'Meetup 360')] }))
  const body = await response.text()
  assert.doesNotMatch(body, /meetup=360|portal:brno|X-PORTAL/i)
})
