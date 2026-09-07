import { createError, defineEventHandler, getQuery, setResponseHeader, setResponseStatus } from 'h3'

import { isEventsAdminTokenValid } from '../../utils/eventsAdminAuth.ts'

interface CommunityMapEnqueueResult {
  queued: number
}

interface CommunityMapQueue {
  sendBatch: (messages: Array<{ body: unknown, contentType: 'json' }>) => Promise<unknown>
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const query = getQuery(event)
  const runtimeConfig = useRuntimeConfig(event)
  if (!isEventsAdminTokenValid(runtimeConfig.eventsAdminToken, query.token)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid events admin token' })
  }
  if (
    Object.keys(query).some(key => key !== 'token' && key !== 'community')
    || (query.community !== undefined && (
      typeof query.community !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(query.community)
    ))
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid community map refresh request' })
  }

  const platform = event.context._platform as { cloudflare?: { env?: Record<string, unknown> } } | undefined
  const queue = platform?.cloudflare?.env?.COMMUNITY_MAPS_QUEUE as CommunityMapQueue | undefined
  const task = await runTask<CommunityMapEnqueueResult>('community-maps', {
    payload: query.community ? { community: query.community } : {},
    context: { communityMapsQueue: queue, contentEvent: event },
  })
  setResponseStatus(event, 202)
  return { ok: true, ...task.result }
})
