import { defineContentConfig, defineCollection, z, property } from '@nuxt/content'
import { defineSitemapSchema } from '@nuxtjs/sitemap/content'
import { routedContentSources } from './shared/data/contentRouteSources'

const commonSchema = {
  title: z.string(),
  seo: property(z.any().optional()).editor({ hidden: true }),
  navigation: property(z.any().optional()).editor({ hidden: true }),
  sitemap: property(defineSitemapSchema({ z })).editor({ hidden: true }),
  redirect_from: z.array(z.string()).optional(),
}

const exclude = ['README.md']

export default defineContentConfig({
  collections: {
    blogArticles: defineCollection({
      type: 'page',
      source: {
        include: `${routedContentSources.blogArticles.directory}/**`,
        exclude,
        prefix: routedContentSources.blogArticles.prefix,
      },
      schema: z.object({
        ...commonSchema,
        published: property(z.string().optional()).editor({ hidden: true }),
        thumbnail: z.string(),
        categories: z.array(z.string()).optional(),
        authors: z.array(z.string()).optional(),
      }).passthrough()
    }),

    blogCategories: defineCollection({
      type: 'page',
      source: {
        include: `${routedContentSources.blogCategories.directory}/**`,
        exclude,
        prefix: routedContentSources.blogCategories.prefix,
      },
      schema: z.object({
        ...commonSchema,
      }),
    }),

    communities: defineCollection({
      type: 'page',
      source: {
        include: `${routedContentSources.communities.directory}/**`,
        exclude,
        prefix: routedContentSources.communities.prefix,
      },
      schema: z.object({
        ...commonSchema,
        sitemap: property(defineSitemapSchema({
          name: 'communities',
          filter: community => community.hidden !== true,
        })).editor({ hidden: true }),
        hidden: property(z.boolean().optional()).editor({ description: 'Skryje komunitu z veřejné landing page, navigace, mapy a sitemap.' }),
        region: z.string().trim().min(1),
        priority: z.number().int().nonnegative().optional(),
        map: property(z.object({
          lat: z.number().finite().min(48).max(52),
          lng: z.number().finite().min(12).max(19),
          zoom: z.number().finite().min(0).max(22).optional(),
        }).optional()).editor({ description: 'Najdi ideální souřadnice a zoom tak aby byly vidět všechny důležité body na mapě: https://labs.mapbox.com/location-helper/' }),
        signal_group: z.string().url(),
        portal_meetup_id: z.number().int().nonnegative().optional(),
        organizers: z.array(z.string()).optional(),
      }),
    }),

    pages: defineCollection({
      type: 'page',
      source: {
        include: `${routedContentSources.pages.directory}/**`,
        exclude,
        prefix: routedContentSources.pages.prefix,
      },
      schema: z.object({
        ...commonSchema,
      }),
    }),

    people: defineCollection({
      type: 'page',
      source: {
        include: 'people/**',
        exclude,
      },
      schema: z.object({
        title: z.string(),
        seo: property(z.any().optional()).editor({ hidden: true }),
        navigation: property(z.any().optional()).editor({ hidden: true }),
        avatar: z.string().optional(),
        donateLnAddress: z.string().optional(),
        links: z.array(z.string()).optional(),
      }),
    }),
  },
})
