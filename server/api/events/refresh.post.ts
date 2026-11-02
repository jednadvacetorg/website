import { createError, defineEventHandler, getHeader, setResponseHeader, setResponseStatus } from 'h3'

import { isEventsAdminTokenValid } from '../../utils/eventsAdminAuth.ts'
import { getPortalCommunities, refreshPortalMeetups } from '../../utils/portalEvents.ts'
import type { PortalEventsQueue } from '../../utils/portalEventsQueue.ts'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const authorization = getHeader(event, 'authorization')
  const suppliedToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
  if (!isEventsAdminTokenValid(useRuntimeConfig(event).eventsAdminToken, suppliedToken)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid events admin token' })
  }

  const platform = event.context._platform as { cloudflare?: { env?: Record<string, unknown> } } | undefined
  const queue = platform?.cloudflare?.env?.PORTAL_EVENTS_QUEUE as PortalEventsQueue | undefined
  if (import.meta.dev && !queue?.send) {
    const communities = await getPortalCommunities(event)
    await refreshPortalMeetups(communities, useStorage('portalEvents'), $fetch, new Date(), [], true)
    return { ok: true, refreshed: communities.length }
  }
  const task = await runTask<{ queued: number }>('portal-events', {
    context: { portalEventsQueue: queue },
  })
  setResponseStatus(event, 202)
  return { ok: true, ...task.result }
})
