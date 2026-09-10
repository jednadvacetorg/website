import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deleteGoogleCalendarEvent,
  getGoogleCalendarConfig,
  GoogleCalendarError,
  googleCalendarEventId,
  reconcileGoogleCalendar,
  syncGoogleCalendarEvent,
  type GoogleCalendarConfig,
  type GoogleFetch,
} from '../server/utils/googleCalendar.ts'
import type { PortalCalendarEvent, PortalCommunity } from '../server/utils/portalEvents.ts'

const config: GoogleCalendarConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  refreshToken: 'refresh-token',
  calendarId: 'legacy@example.test',
}
const brno: PortalCommunity = { id: 'brno', path: '/brno', title: 'Brno', portalMeetupId: 360 }
const portalEvent = (id: string, overrides: Partial<PortalCalendarEvent> = {}): PortalCalendarEvent => ({
  event: {
    id,
    title: 'Meetup',
    start: '2026-09-10T17:00:00.000Z',
    end: null,
    description: 'Popis',
    safeLink: 'https://example.test/event',
    osm_name: 'Bitcoin Coffee',
    osm_address: 'Brno',
    tags: [{ name: 'Bitcoin' }, { name: 'Začátečníci' }],
  },
  sequence: 10,
  changedAt: '2026-09-01T12:00:00.000Z',
  cancelled: false,
  community: brno,
  ...overrides,
})

const tokenResponse = () => Response.json({ access_token: 'access-token', expires_in: 3600 })

test('Google event IDs are stable base32hex values accepted by Calendar', async () => {
  const id = await googleCalendarEventId('42')
  assert.equal(id, await googleCalendarEventId('42'))
  assert.match(id, /^[a-v0-9]{5,1024}$/)
  assert.notEqual(id, await googleCalendarEventId('43'))
})

test('Google configuration requires every private OAuth value', () => {
  assert.deepEqual(getGoogleCalendarConfig({
    googleOauthClientId: 'client-id',
    googleOauthSecret: 'secret',
    googleOauthRefreshToken: 'refresh',
    googleLegacyCalendarId: 'calendar',
  }), {
    clientId: 'client-id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    calendarId: 'calendar',
  })
  assert.throws(() => getGoogleCalendarConfig({}), /not configured/)
})

test('webhook upsert refreshes OAuth and creates a prefixed event with shared ICS formatting', async () => {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  const fetcher: GoogleFetch = async (url, init) => {
    requests.push({ url, init })
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (init?.method === 'PUT') return new Response(null, { status: 404 })
    if (init?.method === 'POST') return Response.json({ id: 'created' })
    return new Response(null, { status: 500 })
  }

  assert.equal(await syncGoogleCalendarEvent(portalEvent('42'), config, fetcher), 'created')
  const insert = requests.find(request => request.init?.method === 'POST' && request.url.includes('/events'))
  assert.ok(insert)
  const body = JSON.parse(String(insert.init?.body))
  assert.equal(body.summary, 'Brno - Meetup')
  assert.equal(body.description, '[Bitcoin] [Začátečníci]\n\nPopis')
  assert.equal(body.location, 'Bitcoin Coffee, Brno')
  assert.equal(body.start.dateTime, '2026-09-10T17:00:00.000Z')
  assert.equal(body.end.dateTime, '2026-09-10T18:00:00.000Z')
  assert.equal(body.extendedProperties.private.jednadvacetEventId, '42')
  assert.equal(body.extendedProperties.private.jednadvacetSequence, '10')
  assert.equal(body.reminders.useDefault, false)
})

test('Google rejections retain only the status and documented reason', async () => {
  const fetcher: GoogleFetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    return Response.json({
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [{ reason: 'insufficientPermissions', message: 'Sensitive upstream detail' }],
      },
    }, { status: 403 })
  }

  await assert.rejects(
    syncGoogleCalendarEvent(portalEvent('42'), config, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError)
      assert.equal(error.message, 'Google Calendar rejected an event update')
      assert.equal(error.status, 403)
      assert.equal(error.reason, 'insufficientPermissions')
      assert.doesNotMatch(error.message, /Sensitive upstream detail/)
      return true
    },
  )
})

test('Google insert rejections identify the failed fallback operation', async () => {
  const fetcher: GoogleFetch = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (init?.method === 'PUT') return new Response(null, { status: 404 })
    return Response.json({ error: { errors: [{ reason: 'forbidden' }] } }, { status: 403 })
  }

  await assert.rejects(
    syncGoogleCalendarEvent(portalEvent('42'), config, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError)
      assert.equal(error.message, 'Google Calendar rejected an event insert')
      assert.equal(error.status, 403)
      assert.equal(error.reason, 'forbidden')
      return true
    },
  )
})

test('deleting an already absent Google event is idempotent', async () => {
  const fetcher: GoogleFetch = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    assert.equal(init?.method, 'DELETE')
    return new Response(null, { status: 404 })
  }
  assert.equal(await deleteGoogleCalendarEvent('42', config, fetcher), false)
})

test('full reconciliation rewrites current events and deletes only stale future managed events', async () => {
  const active = portalEvent('1')
  const cancelled = portalEvent('2', { cancelled: true })
  const activeGoogleId = await googleCalendarEventId('1')
  const cancelledGoogleId = await googleCalendarEventId('2')
  const staleGoogleId = await googleCalendarEventId('3')
  const pastGoogleId = await googleCalendarEventId('4')
  const deleted: string[] = []
  const fetcher: GoogleFetch = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (url.includes('/events?')) {
      return Response.json({
        items: [
          { id: activeGoogleId, end: { dateTime: '2026-09-10T18:00:00Z' }, extendedProperties: { private: { jednadvacetEventId: '1' } } },
          { id: staleGoogleId, end: { dateTime: '2026-09-11T18:00:00Z' }, extendedProperties: { private: { jednadvacetEventId: '3' } } },
          { id: pastGoogleId, end: { dateTime: '2026-08-01T18:00:00Z' }, extendedProperties: { private: { jednadvacetEventId: '4' } } },
          { id: 'manual-event', end: { dateTime: '2026-09-11T18:00:00Z' } },
        ],
      })
    }
    if (init?.method === 'PUT') return Response.json({ id: activeGoogleId })
    if (init?.method === 'DELETE') {
      deleted.push(url)
      return new Response(null, { status: url.endsWith(staleGoogleId) ? 204 : 404 })
    }
    return new Response(null, { status: 500 })
  }

  const report = await reconcileGoogleCalendar(
    [active, cancelled],
    config,
    fetcher,
    new Date('2026-09-05T00:00:00.000Z'),
  )
  assert.deepEqual(report, { created: 0, updated: 1, deleted: 1 })
  assert.ok(deleted.some(url => url.endsWith(staleGoogleId)))
  assert.ok(deleted.some(url => url.endsWith(cancelledGoogleId)))
  assert.ok(deleted.every(url => !url.endsWith(pastGoogleId) && !url.endsWith('manual-event')))
})

test('full reconciliation lets the highest sequence win between active and cancelled records', async () => {
  const updatedBodies: unknown[] = []
  const deleted: string[] = []
  const fetcher: GoogleFetch = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (url.includes('/events?')) return Response.json({ items: [] })
    if (init?.method === 'POST') {
      updatedBodies.push(JSON.parse(String(init.body)))
      return Response.json({ id: 'created' })
    }
    if (init?.method === 'DELETE') {
      deleted.push(url)
      return new Response(null, { status: 404 })
    }
    return new Response(null, { status: 500 })
  }
  const olderCancellation = portalEvent('5', { sequence: 10, cancelled: true })
  const newerActive = portalEvent('5', { sequence: 11 })

  const report = await reconcileGoogleCalendar([olderCancellation, newerActive], config, fetcher)
  assert.deepEqual(report, { created: 1, updated: 0, deleted: 0 })
  assert.equal(updatedBodies.length, 1)
  assert.equal(deleted.length, 0)
})
