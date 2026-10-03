import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deleteGoogleCalendarEvent,
  getGoogleCalendarConfig,
  GoogleCalendarError,
  googleCalendarEventId,
  importGoogleCalendarEvents,
  reconcileGoogleCalendar,
  syncGoogleCalendarChanges,
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

test('Google transport failures are classified without retaining their message', async () => {
  const fetcher: GoogleFetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    throw new TypeError('Too many subrequests for private-calendar@example.test')
  }

  await assert.rejects(
    syncGoogleCalendarEvent(portalEvent('42'), config, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError)
      assert.equal(error.transport, 'subrequest-limit')
      assert.doesNotMatch(JSON.stringify(error), /private-calendar/)
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

test('a queued change batch shares one OAuth token and coalesces event revisions', async () => {
  let tokenRequests = 0
  const requests: Array<{ url: string, method?: string }> = []
  const fetcher: GoogleFetch = async (url, init) => {
    requests.push({ url, method: init?.method })
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenRequests += 1
      return tokenResponse()
    }
    if (init?.method === 'PUT') return Response.json({ id: 'updated' })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(null, { status: 500 })
  }

  const report = await syncGoogleCalendarChanges([
    portalEvent('1', { sequence: 10 }),
    portalEvent('1', { sequence: 11 }),
    portalEvent('2', { cancelled: true }),
  ], config, fetcher, ['3'])
  assert.equal(tokenRequests, 1)
  assert.deepEqual(report, { created: 0, updated: 1, deleted: 2 })
  assert.equal(requests.filter(request => request.method === 'PUT').length, 1)
  assert.equal(requests.filter(request => request.method === 'DELETE').length, 2)
})

test('a queued change batch retains grouped Google rejection diagnostics', async () => {
  const fetcher: GoogleFetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    return Response.json({
      error: {
        errors: [{ reason: 'insufficientPermissions', message: 'Sensitive upstream detail' }],
      },
    }, { status: 403 })
  }

  await assert.rejects(
    syncGoogleCalendarChanges([portalEvent('1'), portalEvent('2')], config, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError)
      assert.equal(error.message, 'Google Calendar synchronization failed for 2 operation(s)')
      assert.deepEqual(error.failures, [{
        operation: 'Google Calendar rejected an event update',
        status: 403,
        reason: 'insufficientPermissions',
        count: 2,
      }])
      assert.doesNotMatch(JSON.stringify(error.failures), /Sensitive upstream detail/)
      return true
    },
  )
})

test('a queued change batch stops after the first rate-limited operation group', async () => {
  let updates = 0
  const fetcher: GoogleFetch = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (init?.method === 'PUT') {
      updates += 1
      return Response.json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 403 })
    }
    return new Response(null, { status: 500 })
  }

  await assert.rejects(
    syncGoogleCalendarChanges([
      portalEvent('1'),
      portalEvent('2'),
      portalEvent('3'),
      portalEvent('4'),
    ], config, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError)
      assert.deepEqual(error.failures, [{
        operation: 'Google Calendar rejected an event update',
        status: 403,
        reason: 'rateLimitExceeded',
        count: 2,
      }])
      return true
    },
  )
  assert.equal(updates, 2)
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

test('full reconciliation skips an active event with an equal Google sequence', async () => {
  const googleId = await googleCalendarEventId('1')
  let writes = 0
  const fetcher: GoogleFetch = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (url.includes('/events?')) {
      return Response.json({
        items: [{
          id: googleId,
          extendedProperties: {
            private: {
              jednadvacetEventId: '1',
              jednadvacetSequence: '10',
            },
          },
        }],
      })
    }
    if (init?.method === 'PUT' || init?.method === 'POST') writes += 1
    return Response.json({ id: googleId })
  }

  assert.deepEqual(
    await reconcileGoogleCalendar([portalEvent('1', { sequence: 10 })], config, fetcher),
    { created: 0, updated: 0, deleted: 0 },
  )
  assert.equal(writes, 0)
})

test('full reconciliation updates an active event with a newer Portal sequence', async () => {
  const googleId = await googleCalendarEventId('1')
  let updates = 0
  const fetcher: GoogleFetch = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (url.includes('/events?')) {
      return Response.json({
        items: [{
          id: googleId,
          extendedProperties: {
            private: {
              jednadvacetEventId: '1',
              jednadvacetSequence: '9',
            },
          },
        }],
      })
    }
    if (init?.method === 'PUT') updates += 1
    return Response.json({ id: googleId })
  }

  assert.deepEqual(
    await reconcileGoogleCalendar([portalEvent('1', { sequence: 10 })], config, fetcher),
    { created: 0, updated: 1, deleted: 0 },
  )
  assert.equal(updates, 1)
})

test('full reconciliation retains grouped Google insert diagnostics', async () => {
  const fetcher: GoogleFetch = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (url.includes('/events?')) return Response.json({ items: [] })
    return Response.json({ error: { errors: [{ reason: 'invalid' }] } }, { status: 400 })
  }

  await assert.rejects(
    reconcileGoogleCalendar([portalEvent('1'), portalEvent('2')], config, fetcher),
    (error: unknown) => {
      assert.ok(error instanceof GoogleCalendarError)
      assert.deepEqual(error.failures, [{
        operation: 'Google Calendar rejected an event insert',
        status: 400,
        reason: 'invalid',
        count: 2,
      }])
      return true
    },
  )
})

const importNow = new Date('2026-09-01T00:00:00.000Z')
const decin: PortalCommunity = { id: 'decin', path: '/decin', title: 'Děčín', portalMeetupId: 361 }
const manualEvent = (id: string, summary: string, overrides: Record<string, unknown> = {}) => ({
  id,
  summary,
  start: { dateTime: '2026-09-20T18:00:00+02:00' },
  end: { dateTime: '2026-09-20T20:00:00+02:00' },
  ...overrides,
})
const importFetcher = (items: unknown[], requests: Array<{ url: string, init?: RequestInit }>): GoogleFetch =>
  async (url, init) => {
    requests.push({ url, init })
    if (url === 'https://oauth2.googleapis.com/token') return tokenResponse()
    if (url === 'https://portal.einundzwanzig.space/api/meetup-events') {
      return Response.json({ data: { id: 900 } }, { status: 201 })
    }
    if (!init?.method) return Response.json({ items })
    return new Response(null, { status: init.method === 'DELETE' ? 204 : 200 })
  }

test('import creates a Portal event for a manual Google event and marks the original', async () => {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  const report = await importGoogleCalendarEvents([], [brno, decin], config, 'portal-token', importFetcher([
    manualEvent('manual-1', 'Decin: Přednáška', {
      location: ' Kavárna ',
      description: 'První řádek<br>druhý &amp; <b>tučný</b>',
    }),
  ], requests), importNow)

  assert.deepEqual(report, { created: 1, removed: 0, pending: 0, skipped: 0, failed: 0 })
  const created = requests.find(request => request.url.startsWith('https://portal.einundzwanzig.space/'))
  assert.equal(new Headers(created?.init?.headers).get('authorization'), 'Bearer portal-token')
  assert.deepEqual(JSON.parse(String(created?.init?.body)), {
    meetup_id: 361,
    start: '2026-09-20T18:00:00+02:00',
    end: '2026-09-20T20:00:00+02:00',
    title: 'Přednáška',
    location: 'Kavárna',
    description: 'První řádek\ndruhý & tučný',
  })
  const marker = requests.at(-1)
  assert.equal(marker?.init?.method, 'PATCH')
  assert.match(marker?.url ?? '', /\/events\/manual-1$/)
  assert.deepEqual(JSON.parse(String(marker?.init?.body)), {
    extendedProperties: { private: { jednadvacetImportedEventId: '900' } },
  })
})

test('import removes a manual Google event once Portal publishes it and never creates it twice', async () => {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  const marked = { extendedProperties: { private: { jednadvacetImportedEventId: '900' } } }
  const report = await importGoogleCalendarEvents([
    portalEvent('900', { event: { ...portalEvent('900').event, start: '2026-09-21T10:00:00.000Z' } }),
    portalEvent('77', { event: { ...portalEvent('77').event, start: '2026-09-22T16:00:00.000Z' } }),
  ], [brno], config, 'portal-token', importFetcher([
    manualEvent('moved-in-portal', 'Brno - Meetup', marked),
    manualEvent('same-start', 'Brno - Meetup', { start: { dateTime: '2026-09-22T18:00:00+02:00' } }),
    manualEvent('not-visible-yet', 'Brno - Jiný', {
      start: { dateTime: '2026-09-25T18:00:00+02:00' },
      extendedProperties: { private: { jednadvacetImportedEventId: '901' } },
    }),
  ], requests), importNow)

  assert.deepEqual(report, { created: 0, removed: 2, pending: 1, skipped: 0, failed: 0 })
  assert.deepEqual(
    requests.filter(request => request.init?.method).map(request => `${request.init?.method} ${request.url.split('/').at(-1)}`),
    ['POST token', 'DELETE moved-in-portal', 'DELETE same-start'],
  )
})

test('import leaves managed, unmatched, all-day and recurring Google events alone', async () => {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  const report = await importGoogleCalendarEvents([], [brno, { id: 'online', path: '/online', title: 'Online' }], config, 'portal-token', importFetcher([
    manualEvent('managed', 'Brno - Meetup', { extendedProperties: { private: { jednadvacetSource: 'portal' } } }),
    manualEvent('other-city', 'Brnoslav slaví'),
    manualEvent('no-meetup', 'Online - Stream'),
    manualEvent('all-day', 'Brno - Konference', { start: { date: '2026-09-20' }, end: { date: '2026-09-21' } }),
    manualEvent('recurring', 'Brno - Stůl', { recurringEventId: 'series' }),
  ], requests), importNow)

  assert.deepEqual(report, { created: 0, removed: 0, pending: 0, skipped: 4, failed: 0 })
  assert.equal(requests.filter(request => request.init?.method && !request.url.includes('oauth2')).length, 0)
})

test('import counts a rejected Portal write and continues with the next event', async () => {
  const requests: Array<{ url: string, init?: RequestInit }> = []
  let portalCalls = 0
  const base = importFetcher([
    manualEvent('first', 'Brno - První'),
    manualEvent('second', 'Brno', { start: { dateTime: '2026-09-23T18:00:00+02:00' }, end: undefined }),
  ], requests)
  const report = await importGoogleCalendarEvents([], [brno], config, 'portal-token', async (url, init) => {
    if (url.startsWith('https://portal.einundzwanzig.space/') && ++portalCalls === 1) {
      requests.push({ url, init })
      return Response.json({ message: 'This action is unauthorized.' }, { status: 403 })
    }
    return base(url, init)
  }, importNow)

  assert.deepEqual(report, { created: 1, removed: 0, pending: 0, skipped: 0, failed: 1 })
  const second = requests.filter(request => request.url.startsWith('https://portal.einundzwanzig.space/')).at(-1)
  assert.deepEqual(JSON.parse(String(second?.init?.body)), { meetup_id: 360, start: '2026-09-23T18:00:00+02:00' })
})
