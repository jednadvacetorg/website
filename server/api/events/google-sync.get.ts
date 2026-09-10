import { createError, defineEventHandler, getQuery, setResponseHeader } from 'h3'
import { isEventsAdminTokenValid } from '../../utils/eventsAdminAuth.ts'
import { getGoogleCalendarConfig, GoogleCalendarError, reconcileGoogleCalendar } from '../../utils/googleCalendar.ts'
import { getPortalCalendarEvents, getPortalCommunities, refreshPortalMeetups } from '../../utils/portalEvents.ts'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const query = getQuery(event)
  const runtimeConfig = useRuntimeConfig(event)
  if (!isEventsAdminTokenValid(runtimeConfig.eventsAdminToken, query.token)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid events admin token' })
  }
  if (Object.keys(query).some(key => key !== 'token')) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid Google Calendar sync request' })
  }

  try {
    const communities = await getPortalCommunities(event)
    const storage = useStorage('portalEvents')
    await refreshPortalMeetups(communities, storage, $fetch)
    const events = await getPortalCalendarEvents('all', communities, storage, $fetch)
    return {
      ok: true,
      ...await reconcileGoogleCalendar(
        events,
        getGoogleCalendarConfig(runtimeConfig as unknown as Record<string, unknown>),
      ),
    }
  } catch (error) {
    console.error('Google Calendar reconciliation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ...(error instanceof GoogleCalendarError && error.status !== undefined ? { status: error.status } : {}),
      ...(error instanceof GoogleCalendarError && error.reason ? { reason: error.reason } : {}),
    })
    throw createError({ statusCode: 502, statusMessage: 'Google Calendar synchronization failed' })
  }
})
