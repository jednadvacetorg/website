import { blob } from 'hub:blob'

import { generateCommunityMaps, parseCommunityMapSource } from '../utils/staticMap.ts'

const queueName = 'community-maps'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch }) => {
    if (batch.queue !== queueName) return

    const config = useRuntimeConfig()
    for (const message of batch.messages) {
      let label = message.id
      try {
        const source = parseCommunityMapSource(message.body)
        label = source.slug
        await generateCommunityMaps({
          token: config.mapboxAccessToken,
          style: config.mapboxStyle,
          communities: [source],
          blob,
        })
        console.info(`[community-maps] Generated ${source.slug}`)
      } catch (error) {
        const detail = error instanceof Error
          ? `${error.name}: ${error.message}`
          : `non-Error rejection (${typeof error})`
        console.error(`[community-maps] Queue processing failed for ${label}: ${detail}`)
        throw error
      }
    }
  })
})
