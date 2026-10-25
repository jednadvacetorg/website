---
last_mapped_commit: e29e037cefaa121a9b92ae058a58c950dbf2c276
last_mapped_at: 2026-10-01
---
# Codebase Structure

**Analysis Date:** 2026-10-01

## Directory Layout

```text
jednadvacet-org/
├── app/                         # Nuxt shell, routes, layouts, components, browser helpers
│   ├── assets/css/              # Global stylesheet
│   ├── components/              # Shared, app, content, and page UI
│   ├── composables/             # Reusable Nuxt Content queries/projections
│   ├── layouts/                 # Shared page shells
│   ├── pages/                   # File-based routes
│   ├── plugins/                 # Nuxt plugins
│   └── utils/                   # Browser-safe feature helpers
├── content/                     # Nuxt Content Markdown records
│   ├── blog-articles/           # Date-prefixed articles
│   ├── blog-categories/         # Blog category pages
│   ├── communities/             # Root-routed community profiles
│   ├── pages/                   # Root-routed site pages
│   └── people/                  # People records
├── public/                      # Served static assets and well-known resources
├── scripts/                     # Build-time validators
├── server/                      # Nitro HTTP handlers and background work
│   ├── api/                     # /api endpoints
│   ├── middleware/              # Nitro request middleware
│   ├── plugins/                 # Nitro/Cloudflare queue consumers
│   ├── routes/                  # Non-API server routes (e.g. iCal)
│   ├── tasks/                   # Scheduled/manual task entry points
│   └── utils/                   # Server domain and integration logic
├── shared/                      # Cross-runtime data, types, and Nuxt build module
│   ├── data/
│   └── types/
├── tests/                       # Node test-runner behavior tests
├── content.config.ts            # Typed Content collection definitions
├── nuxt.config.ts               # Nuxt/Nitro/modules/runtime/deployment configuration
└── package.json                 # npm scripts and dependencies
```

## Directory Purposes

**`app/pages/`:**

- Purpose: Define public file-based routes and resolve content records.
- Contains: `app/pages/[...slug].vue` for page/community paths, `app/pages/blog/[[slug]].vue` for blog routes, and `app/pages/lide.vue` for people.
- Key files: `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `app/pages/lide.vue`.

**`app/components/`:**

- Purpose: Render shared shell, feature UI, and content views.
- Contains: Components grouped in `app/`, `content/`, and `page/`, plus top-level reusable features.
- Key files: `app/components/app/NavBar.vue`, `app/components/app/NavMenu.vue`, `app/components/page/Community.vue`, `app/components/content/Calendar.vue`.

**`app/composables/`:**

- Purpose: Share app-level query/projection behavior.
- Contains: Content helpers in `app/composables/content.ts`.
- Key files: `app/composables/content.ts`.

**`app/layouts/`:**

- Purpose: Wrap route content in site-level layouts.
- Contains: `app/layouts/default.vue` and `app/layouts/wallpaper.vue`.
- Key files: `app/layouts/default.vue`, `app/layouts/wallpaper.vue`.

**`app/plugins/` and `app/utils/`:**

- Purpose: Register app plugins and hold browser-safe helpers.
- Contains: Client analytics plugin `app/plugins/counterscale.client.ts`; calendar and community map helpers `app/utils/calendar.ts`, `app/utils/communityMap.ts`.

**`content/`:**

- Purpose: Store Markdown/MDC collection records consumed by Nuxt Content.
- Contains: Blog articles/categories, communities, pages, and people; collection definitions are in `content.config.ts`.
- Key files: `content/pages/index.md`, `content/communities/pribram.md`, `content/blog-articles/20230816.bolt-karta-s-lnbits.md`.
- Routing rule: Pages and communities occupy `/`; blog categories and articles occupy `/blog`; people are listed at `/lide` rather than having standalone routes.

**`server/api/`, `server/routes/`, and `server/middleware/`:**

- Purpose: Provide Nitro HTTP entry points.
- Contains: Event/map/miner APIs, iCalendar feed route, RSS middleware.
- Key files: `server/api/events/index.get.ts`, `server/api/events/webhook.post.ts`, `server/routes/ical/[slug].get.ts`, `server/middleware/rss-feed.ts`.

**`server/tasks/` and `server/plugins/`:**

- Purpose: Schedule background work and consume Cloudflare queue batches.
- Contains: Portal event and community map task/consumer pairs.
- Key files: `server/tasks/portal-events.ts`, `server/tasks/community-maps.ts`, `server/plugins/portalEventsQueue.ts`, `server/plugins/communityMapsQueue.ts`.

**`server/utils/`:**

- Purpose: Keep reusable server-only business and integration logic out of thin request handlers.
- Contains: Portal snapshot operations, Google Calendar synchronization, static map generation, miners access, projections, and auth/queue helpers.
- Key files: `server/utils/portalEvents.ts`, `server/utils/googleCalendar.ts`, `server/utils/staticMap.ts`, `server/utils/eventsAdminAuth.ts`.

**`shared/data/` and `shared/types/`:**

- Purpose: Supply cross-boundary static data and contracts.
- Contains: Navigation, partners, route sources, map geometry and event/miner types.
- Key files: `shared/data/navigation.ts`, `shared/data/contentRouteSources.ts`, `shared/data/communityMapGeometry.json`, `shared/types/portalEvents.ts`.

**`scripts/` and `tests/`:**

- Purpose: Validate build/content invariants and exercise behavior at stable boundaries.
- Contains: `scripts/validate-content-routes.ts`; Node test files such as `tests/portalEvents.test.ts` and `tests/validateContentRoutes.test.ts`.

**`public/`:**

- Purpose: Serve static files directly.
- Contains: Site icons, app/blog/partner images, and `public/.well-known/` resources.

## Key File Locations

**Entry Points:**

- `app/app.vue`: Global UI shell and head.
- `app/pages/[...slug].vue`: Root page/community route dispatcher.
- `app/pages/blog/[[slug]].vue`: Blog route dispatcher.
- `server/api/events/index.get.ts`: Public event API.
- `server/routes/ical/[slug].get.ts`: iCalendar response route.

**Configuration:**

- `nuxt.config.ts`: Modules, runtime config, deployment preset, Cloudflare bindings, storage, queues, schedules, sitemap and image settings.
- `content.config.ts`: Collection schemas, source paths/prefixes and sitemap filtering.
- `shared/data/contentRouteSources.ts`: Routed collection directory/prefix metadata.
- `app/app.config.ts`: Application/Nuxt UI configuration.
- `package.json`: npm scripts and dependencies.

**Core Logic:**

- `server/utils/portalEvents.ts`: External event parsing, snapshot validation and storage operations.
- `server/utils/googleCalendar.ts`: Calendar OAuth and event synchronization.
- `server/utils/staticMap.ts`: Community map generation.
- `app/composables/content.ts`: Shared content queries/projections.
- `scripts/validate-content-routes.ts`: Public route collision validation.

**Testing:**

- `tests/`: Node `node:test` tests for route validation and domain/boundary behavior.
- `package.json`: `npm test` runs `node --experimental-strip-types --test tests/*.test.ts`.

## Naming Conventions

**Files:**

- Vue components use PascalCase, e.g. `app/components/page/BlogArticle.vue`.
- Nitro handlers include method suffixes, e.g. `server/api/events/index.get.ts` and `server/api/events/webhook.post.ts`.
- Content records use lowercase slug filenames; blog article names begin with `YYYYMMDD.`, e.g. `content/blog-articles/20230816.bolt-karta-s-lnbits.md`.
- Helpers/modules use descriptive camelCase names, e.g. `shared/blogArticlesTransformer.ts`.

**Directories:**

- Framework directories are lowercase (`pages`, `layouts`, `plugins`, `api`, `tasks`, `utils`).
- Components are grouped by responsibility under `app/components/app/`, `app/components/content/`, and `app/components/page/`.
- Dynamic route segments use Nuxt bracket notation, e.g. `app/pages/[...slug].vue` and `server/routes/ical/[slug].get.ts`.

## Where to Add New Code

**New Feature:**

- Route entry: Extend/add a file under `app/pages/`; content-backed root routes should respect the existing catch-all in `app/pages/[...slug].vue`.
- Presentation: Reuse or add the smallest suitable component under `app/components/`; use `page/` for page views and `content/` for MDC components.
- Server behavior: Add HTTP boundary handlers under `server/api/` or `server/routes/`; place reusable server logic in `server/utils/`.
- Tests: Add focused Node test files under `tests/` following `package.json`'s test command.

**New Content Collection:**

- Schema/source: Update `content.config.ts`.
- Routed collection metadata: Update `shared/data/contentRouteSources.ts` and keep its consumers aligned.
- Consumer: Add the smallest query/rendering change in `app/pages/`, `app/composables/`, or `app/components/`.
- Collision validation: Update `scripts/validate-content-routes.ts` and related tests when routing semantics change.

**New Component/Module:**

- UI: Add under `app/components/` only when justified by reuse/complexity; follow existing responsibility groupings.
- Nuxt build/framework boundary: Place in `shared/` when it must be consumed as a framework module, as with `shared/contentRedirectsModule.ts`.
- Markdown renderer override: Place under `app/components/content/` and configure the renderer alias in `nuxt.config.ts`.

**Utilities:**

- Browser-safe helpers: `app/utils/`.
- Server-only domain/integration logic: `server/utils/`.
- Client/server contracts: `shared/types/` only when both sides consume them.
- Shared constants/static data: `shared/data/`.

## Special Directories

**`.nuxt/`, `.output/`, `.data/`, `node_modules/`:**

- Purpose: Generated Nuxt/build/runtime/dependency artifacts.
- Generated: Yes.
- Committed: Treat as generated/diagnostic output, not source of truth.

**`public/`:**

- Purpose: Directly served static files.
- Generated: Repository-managed assets are not generated; production map blobs use configured storage.
- Committed: Checked-in static assets are part of the source tree.

**`.planning/`:**

- Purpose: GSD plans and codebase reference documents, including `.planning/codebase/`.
- Generated: Workflow-managed documentation.
- Committed: Depends on workflow; application source should not import planning artifacts.

---

*Structure analysis: 2026-10-01*
