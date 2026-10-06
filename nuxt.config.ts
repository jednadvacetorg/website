import { fileURLToPath } from 'node:url'
import { navigationItems } from './shared/data/navigation'

const isPreviewDeploy = Boolean(process.env.PREVIEW_DEPLOY)
const isDevelopment = process.env.NODE_ENV === 'development'
const communityMapsCron = '17 3 * * *'
const communityMapsQueue = 'community-maps'
const portalEventsCron = '47 3 * * *'
const portalEventsQueue = 'portal-events'

const studioIconLibraries = ['bitcoin-icons', 'lucide', 'pinhead', 'simple-icons', 'streamline']

// Nitro 2's bundled Wrangler type predates traces, but it emits this object unchanged.
const cloudflareObservability = {
  enabled: false,
  head_sampling_rate: 1,
  logs: {
    enabled: true,
    head_sampling_rate: 1,
    persist: true,
    invocation_logs: true,
  },
  traces: {
    enabled: true,
    persist: true,
    head_sampling_rate: 1,
  },
}

export default defineNuxtConfig({
  buildDir: process.env.NUXT_BUILD_DIR || undefined,

  compatibilityDate: "2026-03-01",

  content: {
    _localDatabase: {
      type: 'sqlite',
      // SQLite writes are unreliable on the devcontainer's virtiofs workspace
      // mount, so local Content caches stay on the container filesystem.
      filename: '/tmp/jednadvacet-content.sqlite',
    },
    build: {
      transformers: [
        '~~/shared/blogArticlesTransformer',
      ],
    },
    renderer: {
      alias: {
        table: 'ProseScrollableTable',
      },
    },
  },

  css: ['~/assets/css/main.css'],

  alias: {
    // Redirects only the nuxt-og-image Tailwind theme resolution to a
    // dedicated stylesheet (see app/assets/css/og-image.css). Nothing else
    // imports this specifier, so the site build is unaffected.
    '#tailwindcss': fileURLToPath(new URL('./app/assets/css/og-image.css', import.meta.url)),
  },

  devtools: { enabled: true },

  modules: [
    '@nuxt/content',
    '@nuxt/ui',
    '@nuxt/image',
    '@nuxt/fonts',
    'nuxt-og-image',
    '@nuxthub/core',
    '@nuxtjs/sitemap',
    '@vueuse/nuxt',
    './shared/contentRedirectsModule',
    'nuxt-studio'
  ],

  fonts: {
    families: [
      { name: 'Ubuntu Sans', weights: [400, 800], styles: ['normal'], global: true },
    ],
  },

  ogImage: {
    defaults: {
      extension: 'png',
    },
    // Czech titles need latin-ext glyphs (ě, š, č, ř, ž, ý, á, í, é, ú, ů, ó, ď, ť, ň).
    fontSubsets: ['latin', 'latin-ext'],
    security: {
      // Must cover the 3840px YouTube 4K export (default limit is 2048px).
      maxDimension: 3840,
    },
  },

  site: {
    url: 'https://jednadvacet.org',
    name: 'Jednadvacet',
  },

  runtimeConfig: {
    portalWebhookSecret: '',
    googleOauthClientId: '',
    googleOauthSecret: '',
    googleOauthRefreshToken: '',
    googleLegacyCalendarId: '',
    eventsAdminToken: '',
    mapboxAccessToken: '',
    mapboxStyle: 'mapbox/dark-v10',
  },

  sitemap: {
    // People have no standalone routes; everything else is content-backed.
    exclude: ['/_studio/**', '/debug/**', '/cntrsclc'],
  },

  hub: {
    db: 'sqlite',
    // Preview builds compile Blob support for the protected route but receive
    // no production R2 binding. Their rendered pages read the public CDN.
    blob: isPreviewDeploy
      ? { driver: 'cloudflare-r2', binding: 'BLOB' }
      : process.env.NODE_ENV === 'production'
        ? { driver: 'cloudflare-r2', binding: 'BLOB', bucketName: 'files-jednadvacet-org' }
        : { driver: 'fs', dir: '.data/blob' },
  },

  image: {
    // PREVIEW_DEPLOY builds run on *.workers.dev, where the zone-scoped
    // /cdn-cgi/image/ endpoint does not exist — serve original images there.
    provider: process.env.NUXT_IMAGE_PROVIDER || (process.env.PREVIEW_DEPLOY ? 'none' : process.env.NODE_ENV === 'production' ? 'cloudflare' : 'ipx'),
    cloudflare: {
      baseURL: '/',
    },
  },

  icon: {
    collections: studioIconLibraries,
    provider: isDevelopment ? 'server' : 'none',
    fallbackToApi: false,
    serverBundle: { collections: studioIconLibraries },
    clientBundle: {
      icons: navigationItems.flatMap(item =>
        item.children?.flatMap(child => child.icon ? [child.icon] : []) ?? [],
      ),
      scan: {
        globInclude: ['app/**/*.{vue,ts}', 'content/**/*.{md,yml,yaml}'],
        globExclude: ['node_modules'],
        additionalCollections: studioIconLibraries,
      },
      sizeLimitKb: 256,
    },
  },

  nitro: {
    experimental: {
      tasks: true,
    },
    // Scheduled runs refresh generated maps and Portal event snapshots.
    scheduledTasks: isPreviewDeploy
      ? {}
      : {
          [communityMapsCron]: 'community-maps',
          [portalEventsCron]: 'portal-events',
        },
    devStorage: {
      miners: {
        driver: 'fs',
        base: '/tmp/jednadvacet-miners',
      },
      portalEvents: {
        driver: 'fs',
        base: '/tmp/jednadvacet-portal-events',
      },
    },
    storage: isPreviewDeploy
      ? {
          miners: { driver: 'memory' },
          portalEvents: { driver: 'memory' },
        }
      : {
          miners: {
            driver: 'cloudflare-kv-binding',
            binding: 'PORTAL_EVENT_SNAPSHOTS',
            base: 'miners:v1',
          },
          portalEvents: {
            driver: 'cloudflare-kv-binding',
            binding: 'PORTAL_EVENT_SNAPSHOTS',
            base: 'portal-events:v3',
          },
        },
    alias: {
      'sharp': 'unenv/mock/proxy-cjs', // sharp can't run in Cloudflare Workers; pulled in transitively by nuxt-studio's IPX media handler
    },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: 'jednadvacetorg-web',
        // Keep prerendered pages asset-first while allowing unknown navigations to fall through to Nuxt.
        compatibility_flags: ['assets_navigation_has_no_effect'],
        assets: {
          html_handling: 'drop-trailing-slash',
          not_found_handling: '404-page',
          run_worker_first: [
            '/api/*',
            '/ical/*',
            '/feed/*',
            '/cntrsclc',
            '/_studio/*',
            '!/_nuxt/*',
            '!/images/*',
            '!/icons/*',
            '!/img/*',
            '!/.well-known/*',
            '!/robots.txt',
            '!/favicon.ico',
            '!/apple-touch-icon.png',
            '!/apple-touch-icon-precomposed.png',
          ],
        },
        // PR previews omit the prod database_id so the temp account auto-provisions
        // a fresh D1 (Nuxt Content reseeds it from dump.*.sql). See review apps in README.
        d1_databases: isPreviewDeploy
          ? [
              {
                binding: 'DB',
                database_name: 'web-preview',
              }
            ]
          : [
              {
                binding: 'DB',
                database_name: 'web',
                database_id: '76d271b2-5335-40ba-81dd-bf7e1ef79522'
              }
            ],
        // Temporary PR previews run in an unrelated Cloudflare account and
        // must never receive the production event snapshot namespace.
        kv_namespaces: isPreviewDeploy
          ? []
          : [
              {
                binding: 'PORTAL_EVENT_SNAPSHOTS',
                id: 'fc1c8f97503145fd8f6563fd22358ab6',
              },
            ],
        queues: isPreviewDeploy
          ? undefined
          : {
              producers: [
                {
                  binding: 'COMMUNITY_MAPS_QUEUE',
                  queue: communityMapsQueue,
                },
                {
                  binding: 'PORTAL_EVENTS_QUEUE',
                  queue: portalEventsQueue,
                },
              ],
              consumers: [
                {
                  queue: communityMapsQueue,
                  max_batch_size: 1,
                  max_batch_timeout: 5,
                  max_retries: 3,
                  retry_delay: 60,
                  max_concurrency: 4,
                },
                {
                  queue: portalEventsQueue,
                  max_batch_size: 100,
                  max_batch_timeout: 5,
                  max_retries: 3,
                  retry_delay: 60,
                  max_concurrency: 1,
                  // No DLQ is provisioned yet; persistent valid failures are visible in logs
                  // but Cloudflare discards them after retries are exhausted.
                },
              ],
            },
        triggers: isPreviewDeploy
          ? undefined
          : {
              crons: [communityMapsCron, portalEventsCron],
            },
        observability: cloudflareObservability,
      }
    },
    prerender: {
      routes: ['/'],
      // Debug OG previews render on demand; prerendering all variants
      // for every article would pointlessly slow down the build.
      ignore: ['/_studio', '/debug/**'],
      crawlLinks: true,
    },
    preset: 'cloudflare_module',
  },

  routeRules: {
    '/cntrsclc': { proxy: { to: 'https://analytics.jednadvacet.org/collect' } }, // Mask tracker collect URL to avoid blockers.
    '/author/**': { redirect: { to: '/lide', statusCode: 302 } },
    '/blog/page/**': { redirect: { to: '/blog', statusCode: 302 } },
    '/category/**': { redirect: { to: '/blog', statusCode: 302 } },
    '/tag/**': { redirect: { to: '/blog', statusCode: 302 } },
  },

  studio: {
    dev: true,
    editor: {
      iconLibraries: studioIconLibraries,
    },
    repository: {
      provider: 'github',
      owner: 'Jednadvacetorg',
      repo: 'web',
      branch: process.env.STUDIO_BRANCH_NAME || 'master',
      private: false,
    },
  },

  vite: {
    server: {
      allowedHosts: true,
    },
  },
})
