<!-- refreshed: 2026-09-10 -->
# Codebase Structure

**Analysis Date:** 2026-09-10

## Directory Layout

```text
/workspace/
├── app/                     # Nuxt app shell, pages, layouts, components and client utilities
│   ├── components/          # App chrome, page renderers, MDC and reusable UI
│   ├── composables/         # Shared content queries/projections
│   ├── layouts/              # Default and wallpaper layouts
│   ├── pages/                # File-based route adapters
│   ├── plugins/              # Client-only Nuxt plugins
│   ├── utils/                # Browser-safe pure projections
│   └── assets/css/           # Global CSS entry
├── content/                 # Nuxt Content Markdown collections
│   ├── blog-articles/        # Date-prefixed articles
│   ├── blog-categories/      # Blog category records
│   ├── communities/          # Root-routed community records
│   ├── pages/                # Root-routed general pages
│   └── people/               # Author/organizer records
├── public/                   # Static images, icons and public media
├── server/                   # Nitro APIs, routes, middleware, tasks, plugins and utilities
├── shared/                   # Build extensions, shared data and cross-boundary types
├── scripts/                  # Node-only build validation
├── tests/                    # Built-in Node test-runner tests
├── .planning/codebase/       # Committed GSD repository maps
├── .devcontainer/            # Development container definition/local state
├── content.config.ts         # Collection schemas and content sources
├── nuxt.config.ts            # Nuxt modules, Nitro, Cloudflare and runtime configuration
├── package.json              # npm scripts and dependencies
├── package-lock.json         # npm lockfile
└── tsconfig.json             # References Nuxt-generated TypeScript projects
```

Generated or local-only directories include `node_modules/`, `.nuxt/`, `.output/`, `.data/`, `.wrangler/` and `.devcontainer/data/`. Treat them as build/runtime state, not source of truth.

## Directory Purposes

**`app/`:**
- Purpose: Nuxt 4 application source.
- Key files: `app/app.vue`, `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `app/pages/lide.vue`.
- Add routes under `app/pages/`, global frame UI under `app/components/app/`, collection renderers under `app/components/page/`, and Markdown-facing features under `app/components/content/`.

**`app/components/`:**
- `app/components/app/`: navigation, logo, social menu and footer.
- `app/components/page/`: `BlogArticle.vue`, `BlogCategory.vue` and `Community.vue`.
- `app/components/content/`: `Calendar.vue`, `MinersTable.vue`, `SubscriptionGuide.vue` and the global `ProseScrollableTable` alias.
- Direct children: reusable displays and feature blocks such as `CommunityMap.vue`, `PersonBlock.vue`, `PartnersList.vue`, `DonateBlock.vue`, `HomepageHero.vue` and `HomepageTopics.vue`.

**`app/composables/` and `app/utils/`:**
- Purpose: Reusable content queries and browser-safe pure projections.
- Key files: `app/composables/content.ts`, `app/utils/calendar.ts`, `app/utils/communityMap.ts`.
- Keep one-use view logic in its component; add a composable or utility when logic has a stable reusable boundary.

**`content/`:**
- Purpose: Filesystem-backed content database indexed by Nuxt Content.
- Collections are declared in `content.config.ts`: `blogArticles`, `blogCategories`, `communities`, `pages` and `people`.
- Blog files use `YYYYMMDD.slug.md`; page, community, category and people filenames provide their slug identifiers. Follow the schema and public-route rules in `content.config.ts`.

**`server/`:**
- Purpose: Nitro server-only behavior and external integration boundaries.
- `server/api/`: H3 endpoints for events, miners, admin operations and development map serving.
- `server/routes/`: generated public iCalendar route at `server/routes/ical/[slug].get.ts`.
- `server/middleware/`: request-level compatibility behavior such as `server/middleware/rss-feed.ts`.
- `server/utils/`: pure/injectable integration logic for Portal, Google Calendar, miners, maps, auth and projections.
- `server/tasks/` and `server/plugins/`: scheduled/queued map orchestration.

**`shared/`:**
- Purpose: Code/data used across build, server and client boundaries.
- `shared/data/`: navigation, partner data, map geometry and routed content source metadata.
- `shared/types/`: cross-boundary `miners` and `portalEvents` contracts.
- Root modules: `shared/blogArticlesTransformer.ts` and `shared/contentRedirectsModule.ts`.
- Put a type here only when production code on both client and server consumes it.

**`public/`:**
- Purpose: Files served directly without content processing.
- Key locations: `public/images/app/`, `public/images/blog/`, `public/images/avatars/`, `public/images/partners/` and `public/icons/`.
- Use root-relative URLs and preserve the media naming conventions documented in `README.md`.

**`scripts/`:**
- Purpose: Node-only build guards.
- Key file: `scripts/validate-content-routes.ts`, which detects routed collection collisions and invalid root/blog paths before `nuxt build`.

**`tests/`:**
- Purpose: Focused tests for pure transformations and server integration behavior using Node's built-in test runner.
- Key files: `tests/validateContentRoutes.test.ts`, `tests/portalEvents.test.ts`, `tests/publicCalendar.test.ts`, `tests/googleCalendar.test.ts`, `tests/miners.test.ts`, `tests/communityProjection.test.ts` and `tests/communityHeroMaps.test.ts`.

## Key File Locations

**Entry Points:**
- `app/app.vue`: browser shell and global head.
- `app/pages/[...slug].vue`: root pages/communities.
- `app/pages/blog/[[slug]].vue`: blog index/category/article routes.
- `app/pages/lide.vue`: people listing.
- `server/api/events/index.get.ts`: public event API.
- `server/routes/ical/[slug].get.ts`: public calendar feed.
- `server/api/community-maps/refresh.get.ts`: protected map queue trigger.

**Configuration:**
- `nuxt.config.ts`: modules, Nitro preset, D1/KV/Queue/Blob bindings, route rules, image provider and runtime config.
- `content.config.ts`: collection schemas, source directories and URL prefixes.
- `app/app.config.ts`: Nuxt UI theme configuration.
- `shared/data/navigation.ts`: fixed navigation and allowed icon references.
- `tsconfig.json`: Nuxt-generated app/server/shared/node project references.

**Core Logic:**
- `server/utils/portalEvents.ts`: Portal normalization, cache lifecycle and event revisions/cancellations.
- `server/utils/googleCalendar.ts`: OAuth, managed-event reconciliation and sync.
- `server/utils/staticMap.ts`: map source validation and image generation.
- `app/composables/content.ts`: content queries and community grouping.
- `app/utils/calendar.ts`: browser calendar/JSON-LD projections.
- `shared/data/contentRouteSources.ts`: routed collection contract.

**Testing:**
- `tests/`: pure projections, server adapters, auth/webhook behavior and route validation.
- `package.json`: `npm test` invokes `node --experimental-strip-types --test tests/*.test.ts`.

## Naming Conventions

**Files:**
- Vue components use PascalCase, for example `app/components/CommunityMap.vue`.
- Composable modules use lowercase camelCase and export `use*` functions, for example `app/composables/content.ts`.
- Pure utility modules use descriptive camelCase, for example `app/utils/calendar.ts` and `server/utils/portalEvents.ts`.
- Nuxt route handlers use filesystem suffixes such as `index.get.ts`, `[slug].get.ts`, `webhook.post.ts` and `[[slug]].vue`.
- Markdown slugs are lowercase; blog Markdown starts with `YYYYMMDD.`.
- Tests use descriptive camelCase names ending in `.test.ts`.

**Directories:**
- Group UI by responsibility: `app/components/app/`, `app/components/page/` and `app/components/content/`.
- Mirror Nuxt conventions for `app/pages/`, `app/layouts/`, `app/plugins/`, `server/api/`, `server/routes/`, `server/tasks/` and `server/utils/`.
- Keep shared constants/data in `shared/data/` and cross-boundary types in `shared/types/`.

## Where to Add New Code

**New Feature:**
- Content-backed page: add a Markdown record to the relevant `content/` collection; use `app/pages/[...slug].vue` or `app/pages/blog/[[slug]].vue` unless a new route shape is required.
- Blog feature: add content under `content/blog-articles/` or `content/blog-categories/`; extend `app/components/page/` only when rendering needs collection-specific behavior.
- External/server feature: add a narrow H3 handler under `server/api/` or `server/routes/`, with validation/normalization in `server/utils/`.
- Scheduled or queued feature: place the task in `server/tasks/` and Cloudflare event hook in `server/plugins/`; configure bindings in `nuxt.config.ts`.

**New Component/Module:**
- Global navigation/frame: `app/components/app/`.
- Collection renderer: `app/components/page/`.
- Markdown/MDC feature: `app/components/content/`.
- Reusable display block: direct child of `app/components/`.
- Pure browser transformation: `app/utils/`; cross-client/server transformation or type: `shared/`.

**Utilities:**
- Content query/projection: `app/composables/content.ts`.
- Calendar display: `app/utils/calendar.ts`; iCalendar/Google shared projection: `server/utils/calendarEventProjection.ts`.
- Community map UI math: `app/utils/communityMap.ts`; external image pipeline: `server/utils/staticMap.ts`.
- Shared navigation/content source/data: `shared/data/`.

## Special Directories

**`.planning/codebase/`:**
- Purpose: Committed GSD architecture, structure, quality, technology and concern maps.
- Generated: No; refresh intentionally from the live repository.
- Committed: Yes.

**`.nuxt/`, `.output/`, `.data/`, `.wrangler/`, `node_modules/`:**
- Purpose: Generated Nuxt output, deployment output, local storage, Wrangler state and dependencies.
- Generated: Yes.
- Committed: No.

**`.devcontainer/`:**
- Purpose: Reproducible development environment definition.
- Generated: Definition is committed; `.devcontainer/data/` is local ignored state.

**`public/`:**
- Purpose: Static runtime assets.
- Generated: No for source media/icons; generated community-map objects are written to Blob/R2 rather than committed source.
- Committed: Source assets are committed subject to ignore rules.

---

*Structure analysis: 2026-09-10*
