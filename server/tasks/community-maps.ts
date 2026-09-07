import type { CommunitiesCollectionItem } from '@nuxt/content'
import { queryCollection } from '@nuxt/content/server'
import type { H3Event } from 'h3'

import type { CommunityMapSource } from '../utils/staticMap.ts'

interface CommunityMapQueue {
  sendBatch: (messages: Array<{ body: CommunityMapSource, contentType: 'json' }>) => Promise<unknown>
}

interface CommunityMapTaskContext {
  communityMapsQueue?: CommunityMapQueue
  cloudflare?: { env?: Record<string, unknown> }
  contentEvent?: H3Event
}

const toMapSource = (community: Pick<CommunitiesCollectionItem, 'path' | 'map' | 'hidden'>): CommunityMapSource | null => {
  if (community.hidden || !community.map) return null
  const slug = community.path.replace(/^\/+|\/+$/g, '').replaceAll('/', '-')
  if (!slug) return null
  return { slug, map: community.map }
}

export default defineTask({
  meta: {
    name: 'community-maps',
    description: 'Queue community hero map refreshes',
  },
  async run(event) {
    try {
      const requestedCommunity = event.payload.community
      if (requestedCommunity !== undefined && (
        typeof requestedCommunity !== 'string'
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedCommunity)
      )) {
        throw new Error('Task payload community must be a valid slug')
      }

      const context = event.context as CommunityMapTaskContext
      const queue = context.communityMapsQueue
        ?? context.cloudflare?.env?.COMMUNITY_MAPS_QUEUE as CommunityMapQueue | undefined
      if (!queue?.sendBatch) throw new Error('Community maps queue is not configured')

      // Scheduled tasks have no H3 event, so only that path uses Nitro's internal fetch.
      const contentEvent = context.contentEvent ?? (undefined as never)
      const records = await queryCollection(contentEvent, 'communities')
        .select('path', 'map', 'hidden')
        .order('path', 'ASC')
        .all()
      let communities = records
        .map(toMapSource)
        .filter((community): community is CommunityMapSource => community !== null)
      if (requestedCommunity) {
        communities = communities.filter(community => community.slug === requestedCommunity)
        if (!communities.length) throw new Error(`Community map source not found: ${requestedCommunity}`)
      }

      await queue.sendBatch(communities.map(body => ({ body, contentType: 'json' })))
      console.info(`[community-maps] Queued ${communities.length} communities`)
      return {
        result: { queued: communities.length },
      }
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : `non-Error rejection (${typeof error})`
      console.error(`[community-maps] Enqueue failed: ${detail}`)
      throw error
    }
  },
})
