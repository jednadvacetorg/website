import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getPortalCalendarData,
  getPortalCalendarEvents,
  getPortalEvents,
  portalEventCacheKey,
  PortalEventsError,
  refreshPortalMeetups,
  type PortalChangeSignal,
  type PortalCommunity,
  type PortalFetch,
  type PortalStorage,
} from '../server/utils/portalEvents.ts'

const brno: PortalCommunity = { id: 'brno', path: '/brno', title: 'Brno', portalMeetupId: 360 }
const pribram: PortalCommunity = { id: 'pribram', path: '/pribram', title: 'Příbram' }
const now = new Date('2026-08-30T12:00:00.000Z')

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  'meetup.name': 'Jednadvacet Brno',
  meetup_id: 360,
  'meetup.id': 360,
  title: 'Budoucí meetup',
  start: '2026-08-31 15:00',
  end: null,
  link: 'https://portal.example/events/1',
  ...overrides,
})

const storage = (values = new Map<string, unknown>()): PortalStorage => ({
  getItem: async key => values.get(key),
  setItem: async (key, value) => { values.set(key, value) },
  getKeys: async base => [...values.keys()].filter(key => !base || key.startsWith(base)),
})

const fetcher = (events: unknown, calls: string[] = []): PortalFetch => async (url, options) => {
  calls.push(url)
  assert.deepEqual(options, { timeout: 20_000, retry: 0 })
  assert.equal(new URL(url).pathname, '/api/meetup-events')
  assert.equal(new URL(url).searchParams.get('locale'), 'cs')
  assert.equal(new URL(url).searchParams.get('from'), 'today')
  return events
}

const signal = (overrides: Partial<PortalChangeSignal> = {}): PortalChangeSignal => ({
  resource: 'meetup-event',
  action: 'updated',
  meetupId: 360,
  eventId: '1',
  sequence: 100,
  occurredAt: now.toISOString(),
  ...overrides,
})

test('Portal transport failures log safe endpoint diagnostics', async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args))
  const upstreamError = Object.assign(new Error('Sensitive upstream detail'), { statusCode: 504 })
  const failedFetch: PortalFetch = async () => {
    throw upstreamError
  }

  await assert.rejects(
    refreshPortalMeetups([brno], storage(), failedFetch, now),
    error => error instanceof PortalEventsError && error.message === 'Portal event refresh failed',
  )
  assert.deepEqual(logs, [[
    '[portal-events] Portal fetch failed',
    { errorType: 'Error', status: 504 },
  ]])
  assert.doesNotMatch(JSON.stringify(logs), /Sensitive upstream detail/)
})

test('one refresh fetches only selected meetup IDs and writes community-keyed snapshots', async () => {
  const values = new Map<string, unknown>()
  const calls: string[] = []
  const refresh = await refreshPortalMeetups([brno, pribram], storage(values), fetcher([
    event({
      end: '2026-08-31 19:00',
      location: 'Brno',
      osm_lat: '49.195278',
      osm_lon: '16.608333',
      tags: [{ name: 'Začátečníci' }],
      meetup_id: 360,
      custom: 'retained',
    }),
  ], calls), now)

  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0]!).searchParams.get('meetup_id'), '360')
  assert.ok(values.has('community:brno'))
  assert.ok(values.has('community:pribram'))
  assert.equal(values.has('portal:360:events'), false)
  const result = await getPortalEvents('brno', storage(values))
  assert.equal(result[0]?.start, '2026-08-31T15:00:00.000Z')
  assert.equal(result[0]?.custom, 'retained')
  assert.equal(result[0]?.meetup_id, undefined)
  assert.equal(result[0]?.['meetup.id'], undefined)
  assert.deepEqual(await getPortalEvents('pribram', storage(values)), [])
  assert.deepEqual(refresh.calendarEvents.map(item => ({ id: item.event.id, community: item.community.id })), [
    { id: '1', community: 'brno' },
  ])
})

test('unknown or eventless meetups get empty snapshots while other communities refresh', async () => {
  const values = new Map<string, unknown>()
  const missing: PortalCommunity = { id: 'missing', path: '/missing', title: 'Missing', portalMeetupId: 999 }

  const calls: string[] = []
  await refreshPortalMeetups([missing, brno, pribram], storage(values), fetcher([event()], calls), now)
  assert.equal(new URL(calls[0]!).searchParams.get('meetup_id'), '360,999')
  assert.ok(values.has(portalEventCacheKey(brno)))
  assert.ok(values.has(portalEventCacheKey(pribram)))
  assert.deepEqual(await getPortalEvents('missing', storage(values)), [])
})

test('a malformed community export preserves its snapshot without blocking healthy communities', async () => {
  const values = new Map<string, unknown>()
  const store = storage(values)
  const ostrava: PortalCommunity = { id: 'ostrava', path: '/ostrava', title: 'Ostrava', portalMeetupId: 500 }
  await refreshPortalMeetups([brno], store, fetcher([event()]), now)
  const previousBrno = values.get(portalEventCacheKey(brno))

  await assert.rejects(
    refreshPortalMeetups([brno, ostrava], store, fetcher([
      event({ start: 'invalid' }),
      event({ id: 2, meetup_id: 500, title: 'Ostravský meetup' }),
    ]), new Date(now.getTime() + 60_000)),
    (error: unknown) => error instanceof PortalEventsError && /brno/.test(error.message),
  )
  assert.deepEqual(values.get(portalEventCacheKey(brno)), previousBrno)
  assert.ok(values.has(portalEventCacheKey(ostrava)))
})

test('public reads use only KV keys and ignore obsolete meetup-keyed entries', async () => {
  const values = new Map<string, unknown>([['portal:360:events', { schemaVersion: 1 }]])
  await refreshPortalMeetups([brno], storage(values), fetcher([event()]), now)
  const result = await getPortalEvents('all', storage(values))
  assert.deepEqual(result.map(item => item.community), [{ path: '/brno', name: 'Brno' }])
  const data = await getPortalCalendarData('all', storage(values))
  assert.deepEqual(data.communities.map(community => community.id), ['brno'])
})

test('an empty full refresh is rejected without replacing any snapshots', async () => {
  const values = new Map<string, unknown>()
  await refreshPortalMeetups([brno], storage(values), fetcher([event()]), now)
  const before = structuredClone([...values])
  await assert.rejects(
    refreshPortalMeetups([brno, pribram], storage(values), fetcher([]), now, [], true),
    (error: unknown) => error instanceof PortalEventsError && error.statusCode === 502,
  )
  assert.deepEqual([...values], before)
})

test('delete tombstones survive refresh and expire after 90 days', async () => {
  const values = new Map<string, unknown>()
  const store = storage(values)
  await refreshPortalMeetups([brno], store, fetcher([event()]), now)
  const deletedAt = new Date(now.getTime() + 60_000)
  const deletion = await refreshPortalMeetups([brno], store, fetcher([event()]), deletedAt, [signal({
    action: 'deleted',
    sequence: 101,
    occurredAt: deletedAt.toISOString(),
  })])
  assert.deepEqual(deletion.deletedEventIds, ['1'])
  let rows = await getPortalCalendarEvents(['brno'], store)
  assert.equal(rows[0]?.cancelled, true)
  const cancellationSequence = rows[0]?.sequence ?? 0

  await refreshPortalMeetups([brno], store, fetcher([event()]), new Date(deletedAt.getTime() + 60_000))
  rows = await getPortalCalendarEvents(['brno'], store)
  assert.equal(rows[0]?.sequence, cancellationSequence)
  assert.equal(rows[0]?.cancelled, true)

  await refreshPortalMeetups([brno], store, fetcher([event()]), new Date(deletedAt.getTime() + 90 * 24 * 60 * 60 * 1_000))
  rows = await getPortalCalendarEvents(['brno'], store)
  assert.deepEqual(rows, [])
})

test('a newer update restores an event and an older delete retry cannot cancel it again', async () => {
  const values = new Map<string, unknown>()
  const store = storage(values)
  await refreshPortalMeetups([brno], store, fetcher([event()]), now)
  await refreshPortalMeetups([brno], store, fetcher([event()]), now, [signal({ action: 'deleted', sequence: 101 })])
  await refreshPortalMeetups([brno], store, fetcher([event({ title: 'Obnovený meetup' })]), now, [
    signal({ action: 'updated', sequence: 102 }),
  ])
  await refreshPortalMeetups([brno], store, fetcher([event({ title: 'Obnovený meetup' })]), now, [
    signal({ action: 'deleted', sequence: 101 }),
  ])
  const rows = await getPortalCalendarEvents(['brno'], store)
  assert.deepEqual(rows.map(row => ({ title: row.event.title, cancelled: row.cancelled })), [
    { title: 'Obnovený meetup', cancelled: false },
  ])
})

test('a cold delete creates a tombstone from the authoritative export', async () => {
  const values = new Map<string, unknown>()
  await refreshPortalMeetups([brno], storage(values), fetcher([event()]), now, [signal({ action: 'deleted' })])
  const rows = await getPortalCalendarEvents(['brno'], storage(values))
  assert.equal(rows[0]?.cancelled, true)
})

test('an empty partial refresh clears active events and preserves a deletion tombstone', async () => {
  const values = new Map<string, unknown>()
  const store = storage(values)
  await refreshPortalMeetups([brno], store, fetcher([event()]), now)
  const result = await refreshPortalMeetups([brno], store, fetcher([]), new Date(now.getTime() + 60_000), [signal({
    action: 'deleted',
    sequence: 103,
  })])
  assert.deepEqual(await getPortalEvents('brno', store), [])
  assert.deepEqual(result.deletedEventIds, ['1'])
  assert.equal(result.calendarEvents[0]?.cancelled, true)
})

test('a partial refresh with no events or prior snapshot creates an empty snapshot', async () => {
  const store = storage()
  await refreshPortalMeetups([brno], store, fetcher([]), now)
  assert.deepEqual(await getPortalEvents('brno', store), [])
})

test('communities without a Portal ID require no fetch even on a full refresh', async () => {
  const store = storage()
  await refreshPortalMeetups([pribram], store, async () => assert.fail('Unexpected Portal request'), now, [], true)
  assert.deepEqual(await getPortalEvents('pribram', store), [])
})

test('missing and incompatible snapshots fail without attempting a refresh', async () => {
  await assert.rejects(
    getPortalEvents('unknown', storage()),
    (error: unknown) => error instanceof PortalEventsError && error.statusCode === 404,
  )
  await assert.rejects(
    getPortalEvents('brno', storage(new Map([['community:brno', { schemaVersion: 2 }]]))),
    (error: unknown) => error instanceof PortalEventsError && error.statusCode === 503,
  )
})
