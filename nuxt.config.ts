import { fileURLToPath } from 'node:url'
import { navigationItems } from './shared/data/navigation'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { deriveContentPath, routedContentSources } from './shared/data/contentRouteSources'

// Content is deployed with the bundle. Keep notification scopes and titles in
// that same build, rather than maintaining a second registry in environment vars.
const communitySource = routedContentSources.communities
const communityDirectory = join(import.meta.dirname, 'content', communitySource.directory)
const notificationCommunities = [...globSync('**/*.{md,mdc}', { cwd: communityDirectory })]
  .filter(file => !file.endsWith('README.md'))
  .map(file => {
    const body = readFileSync(join(communityDirectory, file), 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)
    if (!frontmatter) throw new Error(`Community frontmatter is missing: ${file}`)
    const community = parse(frontmatter[1]!) as { path?: string, title: string }
    return { slug: (community.path ?? deriveContentPath(file, communitySource.prefix)).replace(/^\/+|\/+$/g, ''), title: community.title }
  })

const isPreviewDeploy = Boolean(process.env.PREVIEW_DEPLOY)
// Workers Builds uses master for production; local preview builds can opt in explicitly.
// Keep the temporary-account PREVIEW_DEPLOY profile independent of Worker Previews.
const isWorkerPreview = !isPreviewDeploy && (
  process.env.WORKER_PREVIEW === '1' || Boolean(
    process.env.WORKERS_CI === '1' && process.env.WORKERS_CI_BRANCH && process.env.WORKERS_CI_BRANCH !== 'master',
  )
)
const isAnyPreview = isPreviewDeploy || isWorkerPreview
const isDevelopment = process.env.NODE_ENV === 'development'
const communityMapsCron = '17 3 * * *'
const communityMapsQueue = 'community-maps'
const portalEventsCron = '47 3 * * *'
const portalEventsQueue = 'portal-events'
const notificationMessagesCron = '13 * * * *'
const notificationPublicationCron = '* * * * *'
const notificationMessagesQueue = 'notification-messages'
const notificationMessagesDeadLetterQueue = 'notification-messages-dlq'

const iconLibraries = ['bitcoin-icons', 'lucide', 'pinhead', 'simple-icons', 'streamline']

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
      filename: process.env.CONTENT_LOCAL_DATABASE_PATH || '/tmp/jednadvacet-content.sqlite',
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
  ],

  fonts: {
    families: [
      { name: 'Ubuntu Sans', weights: [400, 800], styles: ['normal', 'italic'], global: true },
      // Article OG image titles; the family has a single weight.
      { name: 'Ubuntu Condensed', weights: [400], styles: ['normal'], global: true },
    ],
  },

  ogImage: {
    defaults: {
      extension: 'png',
      // Cache keys and URLs are content-addressed (props + component hash +
      // module version), so entries never go stale and can live in KV
      // indefinitely. The same value also controls `cache-control` for
      // `/_og/d/*`, which already carries `immutable`.
      cacheMaxAgeSeconds: 60 * 60 * 24 * 365 * 10,
    },
    // Czech titles need latin-ext glyphs (ě, š, č, ř, ž, ý, á, í, é, ú, ů, ó, ď, ť, ň).
    fontSubsets: ['latin', 'latin-ext'],
    // Runtime-rendered images (/_og/d, used by /debug/**) persist in KV.
    // Temporary-account builds disable this cache; Worker Previews use their own KV.
    runtimeCacheStorage: isPreviewDeploy
      ? false
      : {
          driver: 'cloudflare-kv-binding',
          binding: 'OG_IMAGE_CACHE',
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
    // One root derives separated outbox, suppression, and abuse subkeys internally.
    notificationRootKey: '',
    notificationTurnstileSecret: '',
    notificationTurnstileExpectedHostname: '',
    // Provider verification and real-device checks belong to the release checklist.
    brevoApiKey: '',
    brevoCallbackSecret: '',
    brevoSenderName: '',
    brevoSmsSender: '',
    brevoSenderEmail: '',
    // VAPID private material stays server-only; its matching public key is the
    // sole Web Push value serialized to browsers.
    notificationVapidPrivateKey: '',
    notificationVapidSubject: 'https://jednadvacet.org',
    public: {
      // This is the only notification-abuse value intentionally exposed to browsers.
      notificationTurnstileSiteKey: '',
      notificationVapidPublicKey: '',
    },
  },

  sitemap: {
    // People have no standalone routes; everything else is content-backed.
    exclude: ['/debug/**', '/cntrsclc'],
  },

  hub: {
    db: 'sqlite',
    // Preview builds compile Blob support for the protected route but receive
    // no production R2 binding. Their rendered pages read the public CDN.
    blob: isAnyPreview
      // The protected blob route remains in the Worker bundle, but review apps
      // deliberately receive no R2 resource or binding.
      ? { driver: 'fs', dir: '/tmp/jednadvacet-preview-blob' }
      : process.env.NODE_ENV === 'production'
        ? { driver: 'cloudflare-r2', binding: 'BLOB', bucketName: 'files-jednadvacet-org' }
        : { driver: 'fs', dir: '.data/blob' },
  },

  image: {
    // Preview builds run on *.workers.dev, where the zone-scoped
    // /cdn-cgi/image/ endpoint does not exist — serve original images there.
    provider: process.env.NUXT_IMAGE_PROVIDER || (isAnyPreview ? 'none' : process.env.NODE_ENV === 'production' ? 'cloudflare' : 'ipx'),
    cloudflare: {
      baseURL: '/',
    },
  },

  icon: {
    collections: iconLibraries,
    provider: isDevelopment ? 'server' : 'none',
    fallbackToApi: false,
    serverBundle: { collections: iconLibraries },
    clientBundle: {
      icons: navigationItems.flatMap(item =>
        item.children?.flatMap(child => child.icon ? [child.icon] : []) ?? [],
      ),
      scan: {
        globInclude: ['app/**/*.{vue,ts}', 'shared/data/**/*.ts', 'content/**/*.{md,yml,yaml}'],
        globExclude: ['node_modules'],
        additionalCollections: iconLibraries,
      },
      sizeLimitKb: 256,
    },
  },

  nitro: {
    replace: {
      __PREVIEW_DEPLOY__: JSON.stringify(isAnyPreview),
      __NOTIFICATION_COMMUNITIES__: JSON.stringify(notificationCommunities),
    },
    experimental: {
      tasks: true,
    },
    // Scheduled runs refresh generated maps and Portal event snapshots.
    scheduledTasks: isWorkerPreview
      ? {}
      : isPreviewDeploy
        ? {
            [portalEventsCron]: 'portal-events',
            [notificationMessagesCron]: 'notification-messages',
            [notificationPublicationCron]: 'notification-publication',
          }
        : {
            [communityMapsCron]: 'community-maps',
            [portalEventsCron]: 'portal-events',
            // Automatic notification jobs require the Worker binding context.
            ...(isDevelopment ? {} : {
              [notificationMessagesCron]: 'notification-messages',
              [notificationPublicationCron]: 'notification-publication',
            }),
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
          portalEvents: {
            driver: 'cloudflare-kv-binding',
            binding: 'PORTAL_EVENT_SNAPSHOTS',
            base: 'portal-events:v3',
          },
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
      'sharp': 'unenv/mock/proxy-cjs', // sharp can't run in Cloudflare Workers; retain the alias for Nuxt Image's IPX dependency.
    },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: 'jednadvacetorg-web',
        // Nitro's Wrangler types predate Worker Previews; the emitted configuration
        // is consumed by the project's current Wrangler. Never include these IDs
        // in temporary-account builds, which must provision their own resources.
        ...(!isPreviewDeploy ? {
          previews: {
            d1_databases: [{
              binding: 'DB',
              database_name: 'web-preview',
              database_id: 'b36b3fe7-a1f5-4c09-b874-36de416053c4',
            }],
            kv_namespaces: [
              { binding: 'OG_IMAGE_CACHE', id: '072fb3b3ed6f40738d513eef1fc107a5' },
              { binding: 'PORTAL_EVENT_SNAPSHOTS', id: '8d544b1ecf2e46838eea8ae4fe5fcfad' },
            ],
            // No production variables, secrets, R2 or Queue producers are inherited.
            vars: {},
          },
        } : {}),
        // Keep prerendered pages asset-first while allowing unknown navigations to fall through to Nuxt.
        compatibility_flags: ['assets_navigation_has_no_effect'],
        assets: {
          html_handling: 'drop-trailing-slash',
          not_found_handling: '404-page',
          run_worker_first: [
            '/api/*',
            '/ical/*',
            '/feed/*',
            '/podcast.xml',
            '/cntrsclc',
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
        // must never receive the production namespaces.
        kv_namespaces: isPreviewDeploy
          ? [
              {
                binding: 'PORTAL_EVENT_SNAPSHOTS',
              },
            ]
          : [
              {
                binding: 'PORTAL_EVENT_SNAPSHOTS',
                id: 'fc1c8f97503145fd8f6563fd22358ab6',
              },
              {
                binding: 'OG_IMAGE_CACHE',
                id: '14ec9a559f0c430799b5e7f74d176e57',
              },
            ],
        queues: isPreviewDeploy
          ? {
              producers: [
                { binding: 'PORTAL_EVENTS_QUEUE', queue: portalEventsQueue },
                { binding: 'NOTIFICATION_MESSAGES_QUEUE', queue: notificationMessagesQueue },
              ],
              consumers: [
                {
                  queue: portalEventsQueue,
                  max_batch_size: 100,
                  max_batch_timeout: 5,
                  max_retries: 3,
                  retry_delay: 60,
                  max_concurrency: 1,
                },
                {
                  queue: notificationMessagesQueue,
                  max_batch_size: 10,
                  max_batch_timeout: 5,
                  max_retries: 5,
                  retry_delay: 60,
                  max_concurrency: 1,
                  dead_letter_queue: notificationMessagesDeadLetterQueue,
                },
              ],
            }
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
                {
                  binding: 'NOTIFICATION_MESSAGES_QUEUE',
                  queue: notificationMessagesQueue,
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
                {
                  queue: notificationMessagesQueue,
                  max_batch_size: 10,
                  max_batch_timeout: 5,
                  max_retries: 5,
                  retry_delay: 60,
                  max_concurrency: 1,
                  dead_letter_queue: notificationMessagesDeadLetterQueue,
                },
              ],
            },
        triggers: isPreviewDeploy
          ? {
              crons: [portalEventsCron, notificationMessagesCron, notificationPublicationCron],
            }
          : {
              crons: [communityMapsCron, portalEventsCron, ...(isDevelopment ? [] : [notificationMessagesCron, notificationPublicationCron])],
            },
        observability: cloudflareObservability,
      }
    },
    prerender: {
      routes: ['/'],
      // Debug OG previews render on demand; prerendering all variants
      // for every article would pointlessly slow down the build.
      ignore: ['/_studio', '/debug/**', '/podcast.xml'],
      crawlLinks: true,
    },
    preset: 'cloudflare_module',
  },

  routeRules: {
    // A queued public analytics request must not disclose a later management URL.
    '/**': { headers: { 'referrer-policy': 'strict-origin' } },
    '/notifications/manage/**': { headers: { 'cache-control': 'no-store' } },
    '/api/notifications/**': { headers: { 'cache-control': 'no-store' } },
    '/sitemap.xml': { prerender: true },
    '/cntrsclc': { proxy: { to: 'https://analytics.jednadvacet.org/collect' } }, // Mask tracker collect URL to avoid blockers.
    '/author/**': { redirect: { to: '/lide', statusCode: 302 } },
    '/blog/page/**': { redirect: { to: '/blog', statusCode: 302 } },
    '/category/**': { redirect: { to: '/blog', statusCode: 302 } },
    '/tag/**': { redirect: { to: '/blog', statusCode: 302 } },
  },

  vite: {
    server: {
      allowedHosts: true,
    },
  },
})
