import type { CommunitiesCollectionItem } from '@nuxt/content'
import { queryCollection } from '@nuxt/content/server'
import { blob } from 'hub:blob'

import { generateCommunityMaps, type CommunityMapSource } from '../utils/staticMap.ts'

const toMapSource = (community: Pick<CommunitiesCollectionItem, 'path' | 'map' | 'hidden'>): CommunityMapSource | null => {
  if (community.hidden || !community.map) return null
  const slug = community.path.replace(/^\/+|\/+$/g, '').replaceAll('/', '-')
  if (!slug) return null
  return { slug, map: community.map }
}

export default defineTask({
  meta: {
    name: 'community-maps',
    description: 'Refresh community hero maps in R2',
  },
  async run(event) {
    const config = useRuntimeConfig()
    const requestedCommunity = event.payload.community
    if (requestedCommunity !== undefined && (
      typeof requestedCommunity !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requestedCommunity)
    )) {
      throw new Error('Task payload community must be a valid slug')
    }

    // Nuxt Content supports its internal Nitro $fetch without a request event,
    // although the public server type currently requires one.
    const records = await queryCollection(undefined as never, 'communities')
      .select('path', 'map', 'hidden')
      .all()
    let communities = records
      .map(toMapSource)
      .filter((community): community is CommunityMapSource => community !== null)
    if (requestedCommunity) {
      communities = communities.filter(community => community.slug === requestedCommunity)
      if (!communities.length) throw new Error(`Community map source not found: ${requestedCommunity}`)
    }

    try {
      return {
        result: await generateCommunityMaps({
          token: config.mapboxAccessToken,
          style: config.mapboxStyle,
          communities,
          blob,
        }),
      }
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : `non-Error rejection (${typeof error})`
      console.error(`[community-maps] Generation failed: ${detail}`)
      throw error
    }
  },
})
