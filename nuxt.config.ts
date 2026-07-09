export default defineNuxtConfig({
  compatibilityDate: "2026-03-01",

  content: {
    build: {
      transformers: [
        '~~/shared/blogArticlesTransformer',
      ],
    },
  },

  css: ['~/assets/css/main.css'],

  devtools: { enabled: true },

  modules: [
    '@nuxt/content',
    '@nuxt/ui',
    '@nuxt/image',
    '@nuxthub/core',
    '@nuxtjs/sitemap',
    '@vueuse/nuxt',
    './shared/contentRedirectsModule',
    'nuxt-studio'
  ],

  site: {
    url: 'https://jednadvacet.org',
    name: 'Jednadvacet',
  },

  sitemap: {
    // People have no standalone routes; everything else is content-backed.
    exclude: ['/_studio/**', '/debug/**', '/cntrsclc'],
  },

  hub: {
    db: 'sqlite',
  },

  image: {
    provider: process.env.NUXT_IMAGE_PROVIDER || (process.env.NODE_ENV === 'production' ? 'cloudflare' : 'ipx'),
    cloudflare: {
      baseURL: '/',
    },
  },

  nitro: {
    alias: {
      'sharp': 'unenv/mock/proxy-cjs', // sharp can't run in Cloudflare Workers; pulled in transitively by nuxt-studio's IPX media handler
    },
    cloudflare: {
      deployConfig: true,
      nodeCompat: true,
      wrangler: {
        name: 'jednadvacetorg-web',
        assets: {
          html_handling: 'drop-trailing-slash',
        },
        // PR previews omit the prod database_id so the temp account auto-provisions
        // a fresh D1 (Nuxt Content reseeds it from dump.*.sql). See review apps in README.
        d1_databases: process.env.PREVIEW_DEPLOY
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
        observability: {
          enabled: true,
          logs: {
            enabled: true,
            invocation_logs: true,
          },
        },
      }
    },
    prerender: {
      routes: ['/'],
      ignore: ['/_studio'],
      crawlLinks: true,
    },
    preset: 'cloudflare_module',
  },

  routeRules: {
    '/cntrsclc': { proxy: { to: 'https://analytics.jednadvacet.org/collect' } }, // Mask tracker collect URL to avoid blockers.
  },

  studio: {
    dev: true,
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
