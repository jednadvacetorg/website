---
last_mapped_commit: e29e037cefaa121a9b92ae058a58c950dbf2c276
last_mapped_at: 2026-10-01
---
# Codebase Concerns

**Analysis Date:** 2026-10-01

## Tech Debt

**Permissive content metadata types:**

- Issue: Shared SEO/navigation metadata use `z.any()`, and blog article schema uses `.passthrough()`, so extra or malformed metadata is accepted without a collection-level contract.
- Files: `content.config.ts`
- Impact: Incorrect metadata may be consumed downstream without build-time validation; this is a validation weakness, not evidence of a current broken page.
- Fix approach: Inventory actual metadata consumers and constrain the supported shape while retaining only fields with demonstrated consumers.

**Large coupled deployment configuration:**

- Issue: Module setup, runtime secrets, storage, preview isolation, queues, cron, route rules, image provider, Studio and Worker settings are colocated.
- Files: `nuxt.config.ts`
- Impact: Environment-specific edits are difficult to isolate and configuration changes carry broad regression risk.
- Fix approach: Keep a single source of truth but extract small typed environment/config builders only where independently testable; add assertions for preview isolation and required production bindings.

**Tracked macOS metadata files:**

- Issue: `.DS_Store` files are present in source directories.
- Files: `app/.DS_Store`, `app/components/.DS_Store`, `app/assets/.DS_Store`, `server/.DS_Store`, `server/api/.DS_Store`, `server/routes/.DS_Store`, `content/.DS_Store`
- Impact: Adds irrelevant binary noise to source changes and directory inspection.
- Fix approach: Remove tracked metadata files and ignore them. This is repository hygiene, not runtime behavior.

## Known Bugs

**Calendar makes an unconditional post-hydration refresh:**

- Symptoms: The component fetches `/api/events` using SSR-aware `useFetch`, then unconditionally calls `refresh()` on mount.
- Files: `app/components/content/Calendar.vue`
- Trigger: Visit a page rendering the calendar with SSR payload data.
- Workaround: None; condition the second request on missing/stale data if a duplicate is confirmed in browser network inspection. Source shows the repeated call; no live/browser probe was performed.

**Repeated collection reads per person block:**

- Symptoms: Every `PersonBlock` fetches all articles and all communities and filters locally; the people page renders multiple blocks.
- Files: `app/components/PersonBlock.vue`, `app/pages/lide.vue`
- Trigger: Load the people listing with multiple people.
- Workaround: None. Query once at the page boundary and pass only each person's matching records; measure before introducing extra abstractions.

## Security Considerations

**Administrative map refresh token is accepted in query string:**

- Risk: A token on `GET /api/community-maps/refresh` can be captured in browser history, request/proxy logs or copied URLs; GET enqueues a mutating operation.
- Files: `server/api/community-maps/refresh.get.ts`, `server/utils/eventsAdminAuth.ts`, `README.md`
- Current mitigation: `cache-control: no-store`, token validation and optional community slug validation are present.
- Recommendations: Move to POST with Bearer authorization as used by `server/api/events/refresh.post.ts`; rotate any token exposed in URLs. Source presence does not establish whether the route is reachable in a deployed environment.

**Production Studio is configured as enabled:**

- Risk: `studio.dev: true` and a public GitHub repository are configured while `/_studio/*` runs through the Worker. A misconfigured auth/publishing boundary could expose write-capable editing.
- Files: `nuxt.config.ts`, `shared/contentRedirectsModule.ts`
- Current mitigation: Studio route is excluded from sitemap; this is not access control.
- Recommendations: Verify production authentication and branch protections in the actual deployment, and test that unauthenticated users cannot edit/publish. Configuration is evidence of intended module setup, not proof of deployed exposure.

**External event descriptions enter MDC rendering:**

- Risk: Portal description strings are normalized as text but rendered with `MDCCached`; renderer behavior determines whether hostile markup/components are safely constrained.
- Files: `server/utils/portalEvents.ts`, `app/components/content/Calendar.vue`
- Current mitigation: Event links are protocol-allowlisted for `http`, `https`, `mailto`, and `tel`; the explicit link uses a separate `safeLink` field.
- Recommendations: Define an explicit plain-text or sanitized Markdown policy and add boundary/browser tests for hostile markup, components and URLs. No exploit is established by source inspection alone.

**Webhook request size has no application-level bound:**

- Risk: The signed webhook handler reads the raw request body before parsing and does not enforce a visible byte limit.
- Files: `server/api/events/webhook.post.ts`
- Current mitigation: HMAC verification, a five-minute timestamp skew, event-envelope validation and queueing only verified metadata are implemented.
- Recommendations: Enforce a conservative body-size limit at the route/platform boundary before buffering; verify upstream/platform limits rather than assuming one. `deliveryId` is queued but no deduplication is visible at the handler boundary.

## Performance Bottlenecks

**Unconditional calendar refetch:**

- Problem: Mount refresh repeats the SSR-aware request on every initial calendar render.
- Files: `app/components/content/Calendar.vue`
- Cause: `refresh()` is called unconditionally in `onMounted` after `useFetch`.
- Improvement path: Remove or make refresh conditional; confirm request counts using browser network inspection.

**Repeated people relationship scans:**

- Problem: Each rendered profile loads full article and community collections.
- Files: `app/components/PersonBlock.vue`, `app/pages/lide.vue`
- Cause: Full-collection queries are inside the per-person component data loader.
- Improvement path: Load relationship data once for the page if measured query/render cost warrants it.

**Unbounded all-community event aggregation:**

- Problem: Requests for all communities enumerate every `community:*` snapshot and load them before response projection/serialization.
- Files: `server/utils/portalEvents.ts`, `server/api/events/index.get.ts`, `server/routes/ical/[slug].get.ts`
- Cause: Aggregation has no explicit community, event-count or payload cap in the read helper; orphan keys are retained.
- Improvement path: Set an explicit retention and response budget, instrument payload size, and cache/materialize aggregate reads if observed volume requires it.

**Map jobs multiply provider requests:**

- Problem: Each community-map job obtains three image variants from Mapbox; the places dataset is fetched once per call to `generateCommunityMaps`.
- Files: `server/utils/staticMap.ts`, `server/plugins/communityMapsQueue.ts`, `server/tasks/community-maps.ts`
- Cause: Community queue messages are isolated per community; there is no shared places snapshot across messages.
- Improvement path: Consider a refresh-batch places snapshot only if provider volume/latency is material; preserve per-community retry isolation.

## Fragile Areas

**Portal snapshot readers accept shallow validation:**

- Files: `server/utils/portalEvents.ts`, `server/plugins/portalEventsQueue.ts`, `server/utils/portalEventsQueue.ts`
- Why fragile: Writers fully validate cached state with `parseCacheForWrite`, while public `parseCacheForRead` checks only object-ness and schema version before type-casting. Queue concurrency is limited but comments explicitly acknowledge KV's lack of strong consistency.
- Safe modification: Apply runtime validation to data read from KV, preserve sequence/revision and snapshot replacement invariants, and test malformed, duplicate, out-of-order and concurrent deliveries.
- Test coverage: `tests/portalEvents.test.ts` and `tests/portalEventsQueue.test.ts` cover utility/queue behavior; no actual Cloudflare KV consistency test is present.

**External Google Calendar reconciliation:**

- Files: `server/utils/googleCalendar.ts`, `server/plugins/portalEventsQueue.ts`
- Why fragile: Full refreshes can perform multiple external writes/deletes and fail partially; retries repeat operations.
- Safe modification: Preserve deterministic IDs, idempotent operations, rate-limit handling and failure summaries; test partial failure/retry semantics.
- Test coverage: `tests/googleCalendar.test.ts` covers utility behavior but not real/emulated queue partial retries.

**Cloudflare shims and generated runtime config:**

- Files: `nuxt.config.ts`, `package.json`
- Why fragile: Worker deployment relies on `nodeCompat: true`, `cloudflare_module`, and an alias that mocks `sharp` for transitive Nuxt Studio/IPX behavior.
- Safe modification: For runtime/module upgrades run both `npm run build` and `npm run build:cloudflare`, inspect generated Worker imports, and smoke-test Studio, image, API, queue and scheduled-task paths.
- Test coverage: `tests/` does not execute the built Worker bundle.

**Interactive SVG map behavior:**

- Files: `app/components/CommunityMap.vue`, `app/utils/communityMap.ts`
- Why fragile: Pointer capture, pinch state and SVG coordinate transforms combine browser geometry APIs with mutable interaction state.
- Safe modification: Preserve cancellation/unmount reset behavior and check mouse, keyboard, touch, reduced-motion and narrow layouts in a browser.
- Test coverage: `tests/communityProjection.test.ts` covers projection logic; no browser/component interaction tests exist.

**Content route and redirect coupling:**

- Files: `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `shared/contentRedirectsModule.ts`, `scripts/validate-content-routes.ts`
- Why fragile: Pages and communities share root paths, blog collections share `/blog`, and redirects are registered through content processing.
- Safe modification: Keep `content.config.ts` and `shared/data/contentRouteSources.ts` aligned and run `npm run build` after content/routing changes.
- Test coverage: `tests/validateContentRoutes.test.ts` covers source collisions; hook behavior and rendered route precedence are not covered by a browser suite.

## Scaling Limits

**Portal and map queue/provider throughput:**

- Current capacity: `nuxt.config.ts` configures Portal queue batch size 100, concurrency 1, three retries; map queue batch size 1, concurrency 4, three retries.
- Limit: Portal processing fetches provider data and may trigger Google API operations; map processing requests three images per community. Portal consumer configuration explicitly has no DLQ and discards messages after retries.
- Scaling path: Add dead-letter/recovery operations and queue-age/failure monitoring; measure provider and Worker limits before increasing concurrency.

**All-community response growth:**

- Current capacity: The all-community path loads every matching stored snapshot and combines its events.
- Limit: Memory, serialization time and response bytes grow with stored community/event history; removed community keys are not currently cleaned by the read path.
- Scaling path: Establish snapshot retention and bounded output, then consider pagination or a materialized aggregate when measured volume necessitates it.

## Dependencies at Risk

**Nuxt Studio and Worker image stack:**

- Risk: `nuxt-studio` is enabled alongside a transitive `sharp` shim and Cloudflare Worker preset.
- Impact: Dependency changes may break Studio media handling or the production bundle.
- Migration plan: Pin/review upgrades, keep Cloudflare build verification and route smoke checks, and replace the shim only with a proven Worker-compatible path.

## Missing Critical Features

**Queue dead-letter/recovery path:**

- Problem: Portal consumer explicitly documents no DLQ; after retry exhaustion Cloudflare discards persistent failures.
- Blocks: Reliable replay/recovery of provider outages, persistent configuration errors or poison messages without manual diagnosis.

**Independent automated CI quality gates:**

- Problem: No `.github/workflows/` files are present in the current workspace scan; this does not establish whether deployment is configured outside the repository.
- Blocks: Repository evidence does not show automated test/typecheck gates on changes. Confirm actual external CI before treating this as a deployment fact.

**Non-iCalendar notification subscriptions:**

- Problem: SMS, email and web-notification UI records locally entered contact fields only in browser local storage and deliberately shows an alert that the features are not ready; no submission route/provider is present in inspected `server/api/`.
- Blocks: These notification channels do not deliver notifications. This is an explicitly disclosed product gap, not a hidden malfunction.

## Test Coverage Gaps

**SSR, hydration and browser interactions:**

- What's not tested: Duplicate calendar fetch, error rendering, head metadata, route precedence and interactive map behavior.
- Files: `app/components/content/Calendar.vue`, `app/components/CommunityMap.vue`, `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`
- Risk: Browser-only regressions are not caught by existing Node utility tests.
- Priority: High

**Administrative route and webhook limits:**

- What's not tested: HTTP method/header enforcement, request body limits, webhook delivery replay/deduplication and real queue-unavailable behavior.
- Files: `server/api/events/webhook.post.ts`, `server/api/events/refresh.post.ts`, `server/api/community-maps/refresh.get.ts`
- Risk: Helper tests cannot establish deployed H3/Worker behavior or resource limits.
- Priority: High

**Generated Worker and production bindings:**

- What's not tested: Real queue registration, cron execution, KV/R2 binding behavior, preview isolation and Worker-compatible bundle imports in runtime.
- Files: `nuxt.config.ts`, `server/plugins/portalEventsQueue.ts`, `server/plugins/communityMapsQueue.ts`, `server/tasks/portal-events.ts`, `server/tasks/community-maps.ts`
- Risk: Deployment-only failures can leave snapshots stale or processing unavailable.
- Priority: High

**Content references and rich-content trust policy:**

- What's not tested: Broken author/category/organizer references, permissive extra frontmatter, hostile external description rendering and malformed asset paths.
- Files: `content.config.ts`, `content/`, `app/components/PersonBlock.vue`, `app/components/CategoriesBadges.vue`, `app/components/SocialLinks.vue`, `server/utils/portalEvents.ts`, `app/components/content/Calendar.vue`
- Risk: Editorial inconsistencies and upstream data can produce broken relationships or unexpected rendered content.
- Priority: Medium

---

*Concerns audit: 2026-10-01*
