---
last_mapped_commit: e29e037cefaa121a9b92ae058a58c950dbf2c276
last_mapped_at: 2026-10-01
---
<!-- refreshed: 2026-10-01 -->

# Architecture

**Analysis Date:** 2026-10-01

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│              Nuxt 4 SSR application (`app/`)                 │
│ Shell `app/app.vue` · layouts · file-based page routes      │
├──────────────────┬──────────────────┬───────────────────────┤
│ Content routes   │ Feature UI       │ Nitro HTTP/background │
│ `app/pages/`     │ `app/components/`│ `server/`             │
└────────┬─────────┴────────┬─────────┴──────────┬────────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Typed Nuxt Content collections · shared contracts and data   │
│ `content.config.ts`, `content/`, `shared/`                   │
└──────────────────────────────┬──────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare Workers / D1 / KV / R2 / Queues / external APIs   │
│ Deployment, bindings, and local driver selection: `nuxt.config.ts` │
└─────────────────────────────────────────────────────────────┘
```

This repository is one Nuxt 4 application with Vue 3, TypeScript, Nuxt Content, Nuxt UI, NuxtHub, and Nitro. SSR and client navigation enter through `app/app.vue`. Content records are validated and grouped by `content.config.ts`; production uses Nitro's Cloudflare Workers preset configured in `nuxt.config.ts`.

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Application shell | Global head, Czech locale, UI provider, layout, route announcer | `app/app.vue` |
| Root content routing | Resolve a page first, then a visible community at the requested path | `app/pages/[...slug].vue` |
| Blog routing | Resolve blog index, category, then article | `app/pages/blog/[[slug]].vue` |
| People listing | Query and render the people collection | `app/pages/lide.vue` |
| Collection definitions | Schemas, collection sources, route prefixes, sitemap metadata | `content.config.ts` |
| Page presentation | Render page, community, blog category and article views | `app/components/page/` |
| Navigation and shared data | Static navigation, partner records, route metadata, map geometry | `shared/data/` |
| HTTP and background entry points | Nitro APIs/routes, scheduled tasks, queue consumers | `server/api/`, `server/routes/`, `server/tasks/`, `server/plugins/` |
| Domain and integration services | Validate/project external data, snapshots, calendars, maps | `server/utils/` |

## Pattern Overview

**Overall:** Content-driven SSR with Nuxt file routing, typed Nuxt Content collections, and Nitro services.

**Key Characteristics:**

- Markdown in `content/` is the source for pages, communities, blog records, and people; `content.config.ts` defines its schemas.
- Route files choose records and views; presentation is delegated to components under `app/components/`.
- Server handlers are boundary adapters; reusable integration/domain logic belongs in `server/utils/`.
- Cloudflare queues and scheduled tasks handle asynchronous refresh work; public reads use stored snapshots where applicable.
- `shared/` contains contracts/data consumed across the app and server boundaries.

## Layers

**Application shell and presentation:**

- Purpose: Provide site-wide shell and render content and interactive features.
- Location: `app/app.vue`, `app/layouts/`, `app/components/`
- Contains: Layouts, navigation/footer, page views, MDC components, feature UI.
- Depends on: Nuxt/Vue, Nuxt UI, generated Content types, shared data.
- Used by: File-based routes and Markdown/MDC rendering.

**Routing and content query:**

- Purpose: Resolve URL paths to typed records and select route-specific presentation.
- Location: `app/pages/`, `app/composables/`, `content.config.ts`
- Contains: Catch-all root route, optional blog slug route, people page, collection query helpers and schemas.
- Depends on: Nuxt Content generated types and collections.
- Used by: SSR and client-side page navigation.

**Server HTTP and background:**

- Purpose: Expose APIs/feeds and initiate or consume asynchronous jobs.
- Location: `server/api/`, `server/routes/`, `server/middleware/`, `server/tasks/`, `server/plugins/`
- Contains: Event and map APIs, miner endpoint, iCal route, RSS middleware, scheduled task handlers, Cloudflare queue consumers.
- Depends on: Nitro/H3, Cloudflare bindings, `server/utils/`, shared contracts.
- Used by: Browser components, Portal callbacks, calendar clients, cron and queue invocations.

**Domain and integration services:**

- Purpose: Isolate upstream parsing, validation, projections, storage, and synchronization rules.
- Location: `server/utils/`
- Contains: `portalEvents.ts`, `googleCalendar.ts`, `calendarEventProjection.ts`, `staticMap.ts`, `miners.ts`, and auth/queue helpers.
- Depends on: Fetch/Web Crypto, Nitro storage, runtime config, external services.
- Used by: HTTP handlers, tasks, and queue consumers.

**Shared contracts and build modules:**

- Purpose: Share narrowly-scoped data and framework-boundary code.
- Location: `shared/`
- Contains: `shared/data/`, `shared/types/`, `shared/blogArticlesTransformer.ts`, `shared/contentRedirectsModule.ts`.
- Depends on: Nuxt Content/Nuxt Kit only where required.
- Used by: Both `app/` and `server/`, or Nuxt build/configuration.

## Data Flow

### Primary Content Request Path

1. `app/app.vue` renders `NuxtLayout` and `NuxtPage` inside `UApp`.
2. Root URLs enter `app/pages/[...slug].vue`, which queries `pages` and then `communities` using `route.path`.
3. `/blog` paths enter `app/pages/blog/[[slug]].vue`, which resolves index, `blogCategories`, or `blogArticles`.
4. The route renders `ContentRenderer` or a page view from `app/components/page/`.
5. Collection schemas and source prefixes come from `content.config.ts` and `shared/data/contentRouteSources.ts`; `nuxt.config.ts` configures the blog transformer and table renderer alias.

### Portal Event Read and Refresh

1. `app/components/content/Calendar.vue` requests `/api/events`.
2. `server/api/events/index.get.ts` reads validated snapshots through `server/utils/portalEvents.ts` and Nitro storage.
3. `server/api/events/webhook.post.ts` verifies incoming callbacks before enqueueing typed messages; `server/plugins/portalEventsQueue.ts` processes refreshes and stores snapshots.
4. Scheduled work enters through `server/tasks/portal-events.ts`; authenticated manual refresh enters through `server/api/events/refresh.post.ts`.
5. `server/routes/ical/[slug].get.ts` projects stored event data into an iCalendar response.

### Community Map Generation

1. `server/tasks/community-maps.ts` selects communities and enqueues map jobs.
2. `server/plugins/communityMapsQueue.ts` invokes `server/utils/staticMap.ts` and stores map variants through NuxtHub blob storage.
3. `app/components/page/Community.vue` presents community map assets; API handlers under `server/api/community-maps/` serve or refresh protected/generated assets.

**State Management:**

- Request data uses Nuxt `useAsyncData`/`useFetch` and typed Content queries.
- Markdown collection data is queried, not mutated in client state.
- Ephemeral interaction state is local to feature components (for example calendar/map UI).
- Server integration snapshots use Nitro storage mounts configured in `nuxt.config.ts`; background updates use scheduled tasks and queues.

## Key Abstractions

**Routed content sources:**

- Purpose: Keep collection directories and public prefixes consistent between schema configuration and route checks.
- Examples: `content.config.ts`, `shared/data/contentRouteSources.ts`, `scripts/validate-content-routes.ts`.
- Pattern: Declare routed source metadata centrally and validate public route collisions during the build.

**Content query/view separation:**

- Purpose: Keep URL resolution distinct from page presentation.
- Examples: `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `app/components/page/`.
- Pattern: Query typed collection items in the route and pass them to rendering components.

**Portal event snapshots and queue contracts:**

- Purpose: Avoid coupling public reads to an upstream request and explicitly validate asynchronous messages.
- Examples: `server/utils/portalEvents.ts`, `server/utils/portalEventsQueue.ts`, `shared/types/portalEvents.ts`.
- Pattern: Parse/validate at boundaries, persist snapshot state, serve snapshot-backed reads, and process typed queue messages.

## Entry Points

**Nuxt application:**

- Location: `app/app.vue`
- Triggers: SSR or client route rendering.
- Responsibilities: Global metadata, locale, layout and page shell.

**Content routes:**

- Location: `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `app/pages/lide.vue`
- Triggers: Root content/community paths, blog paths, `/lide`.
- Responsibilities: Query collection data, select views, set metadata or report missing records.

**Nitro HTTP routes:**

- Location: `server/api/`, `server/routes/`, `server/middleware/`
- Triggers: Browser requests, signed webhooks, admin requests, iCal/RSS clients.
- Responsibilities: Validate input, call services, shape responses and headers.

**Background handlers:**

- Location: `server/tasks/`, `server/plugins/`
- Triggers: Cron and queue deliveries configured in `nuxt.config.ts`.
- Responsibilities: Enqueue scheduled work and process queue batches.

## Architectural Constraints

- **Runtime:** Production uses the `cloudflare_module` Nitro preset (`nuxt.config.ts`); prefer Web APIs and configured bindings over Node-only production assumptions.
- **Rendering:** SSR is the default; use Nuxt-aware data fetching and keep browser APIs client-scoped.
- **Route space:** Pages and communities share root paths; blog categories and articles share `/blog`. Keep `content.config.ts`, `shared/data/contentRouteSources.ts`, and `scripts/validate-content-routes.ts` aligned.
- **Storage:** Nitro storage differs across development, preview, and production in `nuxt.config.ts`; don't assume one driver or preview access to production data.
- **Trust boundary:** Verify external webhook payloads before queueing and validate upstream data before persistence in `server/utils/portalEvents.ts`.
- **Global state:** Keep mutable UI state component-local; shared module-level code in `shared/` and `server/utils/` should remain data/constants or stateless helpers.
- **Circular imports:** No intentional cycles are evident in the inspected app/server/shared layers; keep shared contracts below their consumers.

## Anti-Patterns

### Bypassing snapshot-backed event reads

**What happens:** Public UI fetches Portal directly or bypasses `server/utils/portalEvents.ts`.
**Why it's wrong:** It couples public rendering to upstream availability and bypasses validation and snapshot semantics.
**Do this instead:** Use `server/api/events/index.get.ts` and its snapshot-backed service.

### Adding a conflicting content route

**What happens:** A page/community or blog record duplicates another public URL.
**Why it's wrong:** Route resolution becomes ambiguous because collections share URL spaces.
**Do this instead:** Maintain `content.config.ts` and `shared/data/contentRouteSources.ts`; run the route validator in `scripts/validate-content-routes.ts`.

## Error Handling

**Strategy:** Validate data at boundaries and translate failures at route/service boundaries.

**Patterns:**

- Missing content throws fatal 404 errors in `app/pages/[...slug].vue` and `app/pages/blog/[[slug]].vue`.
- Nitro endpoints use H3 errors and safe response details, for example `server/api/events/index.get.ts`.
- Queue handlers log processing failures and preserve retry behavior by allowing failed processing to reject.
- External event payloads and persisted snapshots are parsed/validated in `server/utils/portalEvents.ts`.

## Cross-Cutting Concerns

**Logging:** Server tasks, queue consumers, and integration boundaries use console logging; Workers observability is configured in `nuxt.config.ts`.
**Validation:** Content frontmatter schemas live in `content.config.ts`; endpoint/service boundaries validate input and integration records.
**Authentication:** Event refresh credentials are checked by `server/utils/eventsAdminAuth.ts`; Portal webhook verification is in `server/api/events/webhook.post.ts`; Google Calendar OAuth/synchronization is in `server/utils/googleCalendar.ts`.
**SEO and metadata:** Global head behavior is in `app/app.vue`; collection sitemap metadata is in `content.config.ts` and sitemap configuration is in `nuxt.config.ts`.

---

*Architecture analysis: 2026-10-01*
