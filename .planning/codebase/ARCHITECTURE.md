<!-- refreshed: 2026-09-10 -->
# Architecture

**Analysis Date:** 2026-09-10

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ Nuxt 4 SSR application shell                                │
│ `app/app.vue`, `app/layouts/`, Nuxt UI                      │
└───────────────┬─────────────────────────┬───────────────────┘
                │                         │
                ▼                         ▼
┌────────────────────────────┐  ┌─────────────────────────────┐
│ File-based page adapters    │  │ Nitro HTTP/task adapters     │
│ `app/pages/`                │  │ `server/api/`, `server/routes/`│
└──────────────┬─────────────┘  └──────────────┬──────────────┘
               │                               │
               ▼                               ▼
┌────────────────────────────┐  ┌─────────────────────────────┐
│ Typed Nuxt Content read     │  │ Integration/domain utilities │
│ model `content.config.ts`   │  │ `server/utils/`              │
└──────────────┬─────────────┘  └──────────────┬──────────────┘
               │                               │
               ▼                               ▼
┌────────────────────────────┐  ┌─────────────────────────────┐
│ Markdown and static assets  │  │ Portal/Google/Mapbox/Beru   │
│ `content/`, `public/`       │  │ APIs, KV, R2, queues         │
└────────────────────────────┘  └─────────────────────────────┘
```

The system is a content-driven Nuxt 4 SSR site deployed with Nitro's `cloudflare_module` preset. Markdown collections are the primary read model; Vue pages and components render those records with Nuxt UI. Server-only adapters provide normalized calendar/miner data, iCalendar output, Google Calendar synchronization, and asynchronous community-map generation.

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| App shell | Global head, Czech locale, layout and page mounting | `app/app.vue` |
| Site frame | Navigation, main slot and footer | `app/layouts/default.vue` |
| Error frame | Branded error rendering over a wallpaper layout | `app/error.vue`, `app/layouts/wallpaper.vue` |
| Root route adapter | Resolves `pages` then visible `communities` in the shared root namespace | `app/pages/[...slug].vue` |
| Blog route adapter | Resolves blog index, category and article records | `app/pages/blog/[[slug]].vue` |
| People route | Lists the `people` collection at `/lide` | `app/pages/lide.vue` |
| Content model | Defines five typed collections and frontmatter validation | `content.config.ts` |
| Content route source | Shares collection directories and public prefixes | `shared/data/contentRouteSources.ts` |
| Page renderers | Render blog articles/categories and community landing pages | `app/components/page/` |
| MDC components | Add calendar, maps, miners, donation, partner and guide features to Markdown | `app/components/content/`, `app/components/` |
| Portal adapter | Validates, normalizes, caches and refreshes Portal event snapshots | `server/utils/portalEvents.ts` |
| Calendar adapters | Project events into iCalendar and Google Calendar formats | `server/routes/ical/[slug].get.ts`, `server/utils/googleCalendar.ts` |
| Map pipeline | Fetches places, creates Mapbox images and stores them in Blob/R2 | `server/utils/staticMap.ts`, `server/tasks/community-maps.ts`, `server/plugins/communityMapsQueue.ts` |

## Pattern Overview

**Overall:** File-based Nuxt routing over typed filesystem content, with thin server adapters around external APIs and Cloudflare-backed storage.

**Key Characteristics:**
- Use `queryCollection` and generated `@nuxt/content` item types at route and component boundaries.
- Keep `/blog` explicit and resolve root `pages` before `communities`; public paths are part of the content contract.
- Keep untrusted external payloads behind server utilities and expose normalized values to browser components.
- Keep pure transformations in `app/utils/` or server utility modules so UI, iCalendar and Google Calendar consumers share projections.
- Use Nuxt UI primitives for layout and controls; specialized interaction remains local to components such as `app/components/CommunityMap.vue`.

## Layers

**Application shell and layouts:**
- Purpose: Establish locale, global head defaults, navigation, footer and error presentation.
- Location: `app/app.vue`, `app/layouts/`, `app/error.vue`.
- Depends on: Nuxt runtime and Nuxt UI.
- Used by: Every browser route.

**Route adapters:**
- Purpose: Translate URLs into typed collection records and choose renderers.
- Location: `app/pages/`.
- Contains: Root catch-all, optional blog catch-all and explicit people route.
- Depends on: `useAsyncData`, `queryCollection`, generated collection types and page components.
- Used by: Nuxt's filesystem router.

**Content model and build extensions:**
- Purpose: Define schemas, source paths, prefixes, publication-date transformation, redirects and route collision checks.
- Location: `content.config.ts`, `shared/blogArticlesTransformer.ts`, `shared/contentRedirectsModule.ts`, `scripts/validate-content-routes.ts`.
- Depends on: Nuxt Content, Nuxt Kit and sitemap schema support.
- Used by: Build-time indexing, sitemap generation and route adapters.

**Presentation and client behavior:**
- Purpose: Render content and provide navigation, maps, calendar filtering, miners, QR codes and social/support UI.
- Location: `app/components/`, `app/composables/content.ts`, `app/utils/`, `app/plugins/`.
- Depends on: Nuxt UI, Nuxt Content, VueUse and shared types/data.
- Used by: Pages and Markdown MDC rendering.

**Server HTTP boundary:**
- Purpose: Serve normalized data and generated feeds, while enforcing admin/webhook validation.
- Location: `server/api/`, `server/routes/`, `server/middleware/`.
- Contains: Event/miner APIs, calendar feeds, map routes, admin operations and the RSS compatibility response.
- Depends on: H3, Nuxt Content server queries, `$fetch`, runtime config and Nitro storage.

**Async and storage boundary:**
- Purpose: Run scheduled or queued community-map generation and persist snapshots/assets.
- Location: `server/tasks/community-maps.ts`, `server/plugins/communityMapsQueue.ts`, `nuxt.config.ts`.
- Depends on: Cloudflare Queues, KV, NuxtHub Blob and Mapbox/BeruBitcoin.

## Data Flow

### Primary Content Request Path

1. Nuxt mounts `app/app.vue`, which installs the layout and page outlet.
2. `/blog` and `/blog/**` enter `app/pages/blog/[[slug]].vue`; other content paths enter `app/pages/[...slug].vue`.
3. The route adapter queries the matching collection with `queryCollection(...).path(...).first()`.
4. The resolved record renders through `ContentRenderer`, or delegates to `PageBlogArticle`, `PageBlogCategory` or `PageCommunity`.
5. MDC names in Markdown resolve to auto-imported components such as `Calendar`, `CommunityMap`, `MinersTable`, `PartnersList` and `DonateBlock`.

### Portal Calendar Path

1. `app/components/content/Calendar.vue` requests `/api/events?community=...` through `useFetch`.
2. `server/api/events/index.get.ts` validates the slug and obtains configured communities from the `communities` collection.
3. `server/utils/portalEvents.ts` validates a KV/filesystem snapshot, refreshes stale data from Portal, and returns normalized events.
4. The client projects rows with `app/utils/calendar.ts`, filters/paginates locally, and emits Event JSON-LD.
5. Signed Portal notifications enter `server/api/events/webhook.post.ts`, update cancellation state/cache, and synchronize the affected event to Google Calendar.

### Public Calendar and Google Sync Paths

1. `/ical/:slug` is handled by `server/routes/ical/[slug].get.ts`, which validates a slug list, reads Portal snapshots and serializes iCalendar with `ical.js`.
2. The protected `/api/events/google-sync` handler authenticates `eventsAdminToken`, refreshes all Portal snapshots, and calls `reconcileGoogleCalendar` in `server/utils/googleCalendar.ts`.
3. Google OAuth and Calendar requests use runtime-configured credentials and an integration-owned extended-property namespace, so reconciliation only mutates managed events.

### Community Map Path

1. A scheduled Nitro task or protected `/api/community-maps/refresh` request runs `server/tasks/community-maps.ts`.
2. The task queries visible communities with `map` data and sends one JSON source message per community to the Cloudflare Queue.
3. `server/plugins/communityMapsQueue.ts` validates each message and invokes `generateCommunityMaps`.
4. `server/utils/staticMap.ts` fetches BeruBitcoin places, selects visible markers, fetches responsive Mapbox WebP variants, and writes them to NuxtHub Blob/R2.
5. `app/components/page/Community.vue` serves local development blobs through `server/api/community-maps/[slug].get.ts` and production assets from the public files CDN.

**State Management:** SSR data uses `useAsyncData`/`useFetch`; component interaction uses Vue refs/reactives/computed values. Durable server snapshots use Nitro storage (`portalEvents`, `miners`), with filesystem development storage, memory preview storage and Cloudflare KV production storage. Generated map images use NuxtHub Blob backed by filesystem locally and R2 in production.

## Key Abstractions

**Routed content source map:** `shared/data/contentRouteSources.ts` is consumed by `content.config.ts` and `scripts/validate-content-routes.ts`. Update it when adding or moving a routed collection.

**Typed collection items:** `content.config.ts` generates collection item types used by `app/pages/` and page renderers. Keep frontmatter changes in collection schemas rather than duplicating record interfaces.

**Portal contracts:** `PortalCommunity`, `PortalStorage`, `PortalFetch`, `PortalCalendarEvent` and `PortalEventsError` in `server/utils/portalEvents.ts` isolate external I/O, cache state and normalized event contracts.

**Calendar projection:** `server/utils/calendarEventProjection.ts` is shared by iCalendar and Google Calendar; `app/utils/calendar.ts` is the browser-specific Czech display/JSON-LD projection.

**Pure map projections:** `app/utils/communityMap.ts` owns SVG coordinate and pan/zoom math; `server/utils/staticMap.ts` owns external static-map validation, URL construction and image generation.

## Entry Points

**Browser application:**
- Location: `app/app.vue`.
- Triggers: Nuxt SSR request or client navigation.
- Responsibilities: Global metadata, locale, layout and page mounting.

**Content routes:**
- Locations: `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `app/pages/lide.vue`.
- Triggers: Root pages/communities, `/blog/**` and `/lide`.
- Responsibilities: Content queries, renderer selection and fatal 404s.

**HTTP APIs and feeds:**
- Locations: `server/api/`, `server/routes/ical/[slug].get.ts`, `server/middleware/rss-feed.ts`.
- Triggers: Browser data fetches, signed Portal callbacks, admin requests, calendar subscriptions and `/feed/` requests.
- Responsibilities: Validation, integration delegation, response projection and safe status translation.

**Scheduled/queued runtime:**
- Locations: `server/tasks/community-maps.ts`, `server/plugins/communityMapsQueue.ts`.
- Triggers: Nitro scheduled task and Cloudflare Queue consumer.
- Responsibilities: Enqueueing and generating map assets.

**Build/runtime configuration:**
- Location: `nuxt.config.ts`.
- Responsibilities: Module registration, content transformer, redirects, sitemap, Cloudflare D1/KV/Queue bindings, Blob/image providers, prerendering and runtime config.

## Architectural Constraints

- **Runtime:** Production targets Cloudflare Workers; avoid Node-only APIs in runtime code. Node is explicitly used by `scripts/validate-content-routes.ts` and test commands.
- **URL space:** `pages` and `communities` share `/`; `/blog` is reserved for blog collections. Route collisions are rejected by `scripts/validate-content-routes.ts`.
- **Content dates:** Blog dates come from `YYYYMMDD.` filenames through `shared/blogArticlesTransformer.ts`; order articles by `id`.
- **Storage:** Use named Nitro storage mounts configured in `nuxt.config.ts`; do not introduce ad hoc global caches.
- **External payloads:** Treat Portal, Google, BeruBitcoin and Mapbox responses as untrusted and validate before persistence or rendering.
- **Generated output:** `.nuxt/`, `.output/` and `.data/` are generated/runtime state; do not hand-edit them.

## Anti-Patterns

### Bypassing server integration adapters

**What happens:** A component or endpoint calls an upstream service directly or renders raw upstream fields.
**Why it's wrong:** It bypasses validation, safe-link filtering, cache fallback, authentication and Cloudflare-compatible storage handling.
**Do this instead:** Extend the relevant utility under `server/utils/` and expose a narrow handler under `server/api/` or `server/routes/`.

### Adding root content without route validation

**What happens:** A page/community filename claims a path already owned by another collection or `/blog`.
**Why it's wrong:** File-based precedence can make content unreachable or select the wrong renderer.
**Do this instead:** Preserve `shared/data/contentRouteSources.ts` and run the build route guard in `scripts/validate-content-routes.ts`.

## Error Handling

**Strategy:** Route adapters throw fatal Nuxt 404 errors; H3 handlers validate inputs and translate expected integration failures to explicit statuses; the global error page renders branded 404/other-error states.

**Patterns:**
- `app/pages/[...slug].vue` and `app/pages/blog/[[slug]].vue` throw `createError({ statusCode: 404, fatal: true })` when no record resolves.
- `server/utils/portalEvents.ts`, `server/utils/googleCalendar.ts` and the public calendar route use typed errors for safe status translation.
- Admin routes use `server/utils/eventsAdminAuth.ts`; Portal webhooks use timestamped HMAC validation in `server/api/events/webhook.post.ts`.
- Server logs record operational failure details while production response messages avoid upstream payloads and secrets.

## Cross-Cutting Concerns

**Logging:** `console.error`/`console.info` in server handlers, map tasks and queue processing; Cloudflare observability is configured in `nuxt.config.ts`.

**Validation:** Zod schemas validate content frontmatter; server adapters narrow external payloads; route, slug, query, webhook and calendar scope validators protect HTTP boundaries.

**Authentication:** Public content, miner and event reads are unauthenticated. Admin event/cache/map operations use the configured token; Portal webhook delivery uses HMAC headers; Google uses OAuth refresh-token credentials.

**SEO/metadata:** Route and renderer components set `Head` metadata; `nuxt.config.ts` configures site identity, sitemap exclusions, redirects and prerender crawling.

---

*Architecture analysis: 2026-09-10*
