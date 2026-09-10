---
last_mapped_commit: 406253b1b73b8ef1369805abfcfd98a6f3adb0d1
---
<!-- refreshed: 2026-09-10 -->
# Codebase Concerns

**Analysis Date:** 2026-09-10

## Tech Debt

**Content schemas accept unbounded metadata:**
- Issue: Shared `seo` and `navigation` fields use `z.any()`, and blog article frontmatter uses `.passthrough()`.
- Files: `content.config.ts`
- Impact: Unsupported frontmatter can enter generated content records and rendering paths without validation.
- Fix approach: Define narrow schemas for supported metadata and explicitly allow only fields consumed by the application.

**Build-time extension boundaries are untyped:**
- Issue: The Nuxt Content transformer and `content:file:afterParse` hook use `any` casts.
- Files: `shared/blogArticlesTransformer.ts`, `shared/contentRedirectsModule.ts`
- Impact: Nuxt Content payload changes can silently break publication-date extraction or redirects without type errors.
- Fix approach: Use framework hook/transformer types where available and add malformed-payload tests at the boundary.

**Several integration packages exceed the visible domain model:**
- Issue: Drizzle, LibSQL, Better SQLite, NuxtHub database support, Studio/IPX, and multiple image/runtime adapters are installed while application data is primarily content-backed and event-cache-backed.
- Files: `package.json`, `nuxt.config.ts`, `server/utils/portalEvents.ts`
- Impact: Install size, upgrade burden, and Cloudflare incompatibility risk are larger than the application surface requires.
- Fix approach: Document each production consumer or remove unused packages and configuration after deployment requirements are confirmed.

**Administrative operations are exposed as query-token GET endpoints:**
- Issue: Cache clearing, Google reconciliation, and map refresh mutate state through GET requests authenticated with a token in the URL.
- Files: `server/api/events/cache-clear.get.ts`, `server/api/events/google-sync.get.ts`, `server/api/community-maps/refresh.get.ts`, `server/utils/eventsAdminAuth.ts`
- Impact: URLs can be retained in browser history, reverse-proxy logs, analytics, and copied referrers; GET semantics also make accidental or automated replays easy.
- Fix approach: Move mutating operations to POST, accept credentials through an authorization header, disable caching, and add explicit operator/audit controls.

**Calendar component performs an unnecessary client refresh:**
- Issue: `useFetch` already performs an SSR-aware request, then `onMounted` calls `refresh()` again unconditionally.
- Files: `app/components/content/Calendar.vue`
- Impact: Each hydrated calendar can duplicate the Portal/cache request and increase Worker and upstream load.
- Fix approach: Remove the unconditional mounted refresh or refresh only after a documented client-only invalidation condition.

## Known Bugs

**Typecheck fails because the mounted filesystem exposes two app entry casings:**
- Symptoms: `npm run typecheck` fails with TS1149 because `/workspace/app/app.vue` and `/workspace/app/App.vue` are both included by the generated Nuxt TypeScript project.
- Files: `app/app.vue`, `app/App.vue`, `tsconfig.json`, `.nuxt/tsconfig.app.json`
- Trigger: Run `npm run typecheck` in the current virtiofs-mounted workspace.
- Workaround: Do not access or delete the wrong-case alias directly; normalize the host filename/mount and restart the affected Docker/OpenCode environment as documented.

**Virtiofs/OpenCode casing aliases can recur after recovery:**
- Symptoms: A wrong-case path can reappear and make otherwise valid Nuxt commands report duplicate-file errors.
- Files: `docs/incidents/opencode-case-alias-on-virtiofs.md`, `AGENTS.md`, `opencode.json`
- Trigger: Tooling accesses a non-canonical case for a source path on the case-insensitive host mount.
- Workaround: Stop OpenCode, clean its snapshot, normalize filenames on the host, and restart Docker Desktop; never remove the alias directly from the Linux mount.

**Canonical URL fallback is evaluated too late:**
- Symptoms: String concatenation happens before `|| '/'`, so the fallback cannot replace an empty path; the root canonical URL also lacks the intended trailing slash normalization.
- Files: `app/app.vue`
- Trigger: Render the root route or inspect canonical links for normalized/empty paths.
- Workaround: None; normalize the path first, then build the complete canonical URL and apply the fallback.

**Calendar data can be rendered as executable MDC input:**
- Symptoms: Portal-controlled descriptions are passed directly to `<MDC>`.
- Files: `app/components/content/Calendar.vue`, `server/utils/portalEvents.ts`
- Trigger: A Portal event contains Markdown/MDC-like description content.
- Workaround: Current tests cover normalized fields but do not prove hostile component-like descriptions are rendered as inert text.

## Security Considerations

**Portal records retain more upstream data than the browser needs:**
- Risk: `parseEvent` removes selected meetup fields but spreads nearly all other upstream keys into `PortalEvent`; tags are also retained as arbitrary records.
- Files: `server/utils/portalEvents.ts`, `shared/types/portalEvents.ts`
- Current mitigation: Known navigation uses `safeLink`; link protocols are restricted; meetup lookup metadata is removed; cache values are validated before reuse.
- Recommendations: Allowlist the event response fields, use a narrow tag shape, and keep raw diagnostic/upstream metadata server-side.

**MDC is an unsafe trust boundary for remote descriptions:**
- Risk: A compromised or unexpectedly expressive Portal description may invoke supported MDC components or create unwanted rendered markup.
- Files: `app/components/content/Calendar.vue`, `server/utils/portalEvents.ts`
- Current mitigation: Portal payloads are normalized and JSON-LD uses escaped output handling.
- Recommendations: Render remote descriptions as escaped text, or sanitize and allowlist Markdown features before invoking `MDC`; add hostile-description tests.

**Webhook request bodies are not size-limited before buffering:**
- Risk: `readRawBody` reads the complete request before JSON parsing or rejection, allowing memory pressure from oversized requests.
- Files: `server/api/events/webhook.post.ts`
- Current mitigation: HMAC authentication and a five-minute timestamp window prevent unauthorized refresh work.
- Recommendations: Enforce a small body limit at the Nitro/Worker route boundary and reject oversized requests before buffering where supported.

**Webhook replay handling lacks event-ID deduplication:**
- Risk: Multiple valid deliveries within the timestamp window can repeat Portal refreshes and Google Calendar side effects.
- Files: `server/api/events/webhook.post.ts`, `server/utils/portalEvents.ts`, `server/utils/googleCalendar.ts`
- Current mitigation: Timestamped HMAC covers the exact raw body and event/resource/action values are validated.
- Recommendations: Persist short-lived processed webhook IDs when Portal supplies one, or coalesce refresh/sync work per meetup and event.

**Admin credentials are exposed through URL transport:**
- Risk: The `eventsAdminToken` is accepted as `?token=...` on mutating endpoints, making accidental disclosure through logs and history plausible.
- Files: `server/api/events/cache-clear.get.ts`, `server/api/events/google-sync.get.ts`, `server/api/community-maps/refresh.get.ts`, `nuxt.config.ts`
- Current mitigation: The token is private runtime configuration and comparison rejects missing or wrong-length values.
- Recommendations: Use an authorization header and POST endpoints, rotate any token after exposure, and add rate limiting or Cloudflare Access.

**No application-owned security-header policy is visible:**
- Risk: CSP, clickjacking protection, and a consistent referrer policy are not defined for the application; remote MDC, analytics, images, and external links would need an explicit policy.
- Files: `nuxt.config.ts`, `app/components/content/Calendar.vue`, `app/plugins/counterscale.client.ts`
- Current mitigation: Several external links use `rel="noopener noreferrer"`, and calendar/map responses set `nosniff`.
- Recommendations: Define and test compatible security headers at the Worker/proxy boundary; add `rel="noopener noreferrer"` to `app/components/SocialLinks.vue` and `app/components/PersonBlock.vue`.

**Development server accepts every host:**
- Risk: `allowedHosts: true` broadens the dev server host trust boundary and should not be carried into a reachable development environment.
- Files: `nuxt.config.ts`
- Current mitigation: This is Vite development configuration, not an application production route.
- Recommendations: Restrict allowed hosts to the documented tunnel/local hosts and keep dev servers inaccessible from untrusted networks.

## Performance Bottlenecks

**Stale public calendar requests can stampede the Portal:**
- Problem: A missing or stale cache causes a public request to fetch both Portal endpoints; `all` refreshes every configured community.
- Files: `server/api/events/index.get.ts`, `server/utils/portalEvents.ts`, `server/routes/ical/[slug].get.ts`
- Cause: `getPortalCaches` checks freshness per request but has no refresh lock or stale-while-revalidate path.
- Improvement path: Coalesce refreshes, refresh only stale communities, serve a bounded stale snapshot when safe, and impose a refresh budget.

**Person blocks repeat full relationship scans:**
- Problem: Each `PersonBlock` loads all articles and communities before filtering one person.
- Files: `app/components/PersonBlock.vue`, `app/pages/lide.vue`, `app/components/page/BlogArticle.vue`, `app/components/page/Community.vue`
- Cause: The async-data key is person-specific, so multiple blocks do not share the large collection queries.
- Improvement path: Load a shared relationship projection at the list/page boundary or use an explicit shared cache key.

**Portal refresh repeatedly scans full upstream arrays per community:**
- Problem: For each community, the full event array is filtered and the full meetup array is searched with `.find()`.
- Files: `server/utils/portalEvents.ts`
- Cause: `refreshPortalMeetups` does not index event rows by meetup link or meetup rows by ID before processing selected communities.
- Improvement path: Build maps once per refresh and bound accepted upstream array sizes before processing.

**Google reconciliation is an unbounded full-calendar operation:**
- Problem: Reconciliation lists every integration-owned Google event and creates one operation for every active/cancelled/deleted event.
- Files: `server/utils/googleCalendar.ts`, `server/api/events/google-sync.get.ts`
- Cause: There is no maximum event count, execution budget, resumable cursor, or durable sync checkpoint.
- Improvement path: Bound the managed set, paginate work across jobs, and make reconciliation resumable before event volume grows.

**Community map generation multiplies external image work:**
- Problem: A refresh generates three Mapbox images per community and writes all outputs, while a scheduled run covers every visible mapped community.
- Files: `server/tasks/community-maps.ts`, `server/plugins/communityMapsQueue.ts`, `server/utils/staticMap.ts`, `nuxt.config.ts`
- Cause: Each message invokes three external image requests; queue retry and scheduling can repeat expensive work after partial failures.
- Improvement path: Track generation versions, skip unchanged sources, batch or prioritize variants, and make writes/idempotent retries observable.

## Fragile Areas

**Content route and redirect contract:**
- Files: `content.config.ts`, `shared/data/contentRouteSources.ts`, `scripts/validate-content-routes.ts`, `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `shared/contentRedirectsModule.ts`
- Why fragile: Pages and communities share `/`; articles and categories share `/blog`; redirect rules are generated during content parsing and route precedence decides the renderer.
- Safe modification: Preserve filename/prefix rules, run `npm test` and `npm run build`, and add collision fixtures for every new route shape.
- Test coverage: `tests/validateContentRoutes.test.ts` covers static collisions, but runtime precedence, canonical links, and generated redirects lack browser coverage.

**Portal cache and webhook state machine:**
- Files: `server/utils/portalEvents.ts`, `server/api/events/webhook.post.ts`, `shared/types/portalEvents.ts`, `tests/portalEvents.test.ts`
- Why fragile: Cache schema, cancellation retention, sequence revisions, Portal field names, and webhook ordering jointly determine public and iCalendar output.
- Safe modification: Preserve server-only normalization, test malformed cache/upstream rows, deletion/update races, and concurrent refreshes against a Worker-compatible storage double.
- Test coverage: Pure normalization and signature tests are strong; HTTP status behavior, body limits, deduplication, and real Portal schema drift are not covered.

**Cloudflare/Node dependency boundary:**
- Files: `nuxt.config.ts`, `package.json`, `app/components/PersonBlock.vue`, `app/components/LightningQrCode.vue`
- Why fragile: Production uses `cloudflare_module` and aliases `sharp` to an unenv proxy, while transitive Studio/IPX, SQLite, QR, and development tooling dependencies remain Node-oriented.
- Safe modification: Avoid Node APIs in `server/`, run both standard and Cloudflare builds after dependency/config changes, and verify image/editor behavior in the generated Worker.
- Test coverage: No committed smoke test executes the generated Worker in an actual Cloudflare environment.

**Map generation and object storage publication:**
- Files: `server/utils/staticMap.ts`, `server/tasks/community-maps.ts`, `server/plugins/communityMapsQueue.ts`, `app/components/page/Community.vue`
- Why fragile: Content slugs become object keys, three responsive variants must agree with frontend URLs, and production/local storage paths differ.
- Safe modification: Keep slug validation and variant names aligned, validate response byte/content limits, and verify a queue retry cannot publish a partial or mismatched set.
- Test coverage: Pure fetch/URL/selection behavior is tested; queue delivery, R2 permissions, CDN cache invalidation, and browser image fallback are not.

## Scaling Limits

**Content-backed relationship views:**
- Current capacity: The repository contains dozens of communities, blog articles, and people records, with complete collection scans in author/organizer blocks.
- Limit: Every additional person block repeats article/community projections, and list views load more records as content grows.
- Scaling path: Select only required fields, centralize relationship projections, and introduce bounded/paginated queries before content volume increases substantially.

**Portal and iCalendar response size:**
- Current capacity: `/api/events?community=all` and `/ical/all` aggregate all configured community events and cancellation tombstones.
- Limit: Response size, cache refresh work, and iCalendar generation grow with communities and retained events; no response/event-count cap is enforced.
- Scaling path: Add explicit event retention and response limits, per-community feeds, and background refresh/checkpointing.

**Queue/external map refresh capacity:**
- Current capacity: Cloudflare queue is configured with batch size 1 and max concurrency 4; each community message creates three Mapbox requests.
- Limit: A full scheduled refresh is proportional to mapped communities and can be delayed by rate limits or retries.
- Scaling path: Add job progress/metrics, idempotent source-version checks, and a controlled refresh budget.

## Dependencies at Risk

**Nested `sharp` vulnerability through Nuxt Studio/IPX:**
- Risk: `npm audit --omit=dev --audit-level=high` reports three high-severity `sharp` findings in the `nuxt-studio` dependency chain; the suggested forced fix changes `nuxt-studio` backward.
- Impact: Security exposure remains in installed production dependencies even though Cloudflare production cannot execute native `sharp` normally.
- Migration plan: Upgrade the owning Studio/IPX chain deliberately, verify the `sharp` alias and image behavior in `npm run build:cloudflare`, and remove unused media functionality if possible.

**Nested `esbuild` vulnerability through Drizzle tooling:**
- Risk: The same audit reports moderate `esbuild` findings through legacy `drizzle-kit` transitive dependencies; the suggested forced fix is a breaking downgrade.
- Impact: Development/build environments remain exposed to dev-server/file-read advisories and dependency resolution is harder to maintain.
- Migration plan: Upgrade or remove the unused Drizzle tool chain, then regenerate the lockfile and run tests/builds without applying `npm audit fix --force` blindly.

## Missing Critical Features

**Operational error visibility:**
- Problem: Application failures are logged with `console.error`, but no structured error tracker, alert, refresh metrics, or operator dashboard is configured.
- Blocks: Fast diagnosis of Portal, Google, miners, map queue, content, and Worker rendering failures.
- Files: `server/api/events/index.get.ts`, `server/api/events/google-sync.get.ts`, `server/api/miners.get.ts`, `server/plugins/communityMapsQueue.ts`, `app/error.vue`, `app/plugins/counterscale.client.ts`

**Automated verification and security gates:**
- Problem: Visible workflows build/deploy PR previews but do not run the repository test suite, typecheck, production build guard, or dependency audit as separate required checks.
- Blocks: Early detection of the current TS1149 failure and vulnerable dependency regressions.
- Files: `.github/workflows/pr-preview.yml`, `.github/workflows/pr-preview-comment.yml`, `package.json`

**Administrative abuse controls:**
- Problem: Protected maintenance endpoints have token authentication but no rate limit, audit record, IP/identity policy, or explicit CSRF-safe method boundary.
- Blocks: Safe delegation and forensic review of cache clears, full Google syncs, and map refreshes.
- Files: `server/api/events/cache-clear.get.ts`, `server/api/events/google-sync.get.ts`, `server/api/community-maps/refresh.get.ts`, `server/utils/eventsAdminAuth.ts`

## Test Coverage Gaps

**Typecheck and generated Cloudflare runtime:**
- What's not tested: A clean case-normalized workspace and execution of the generated Worker with D1/KV/R2/queue bindings.
- Files: `app/app.vue`, `app/App.vue`, `nuxt.config.ts`, `.github/workflows/pr-preview.yml`
- Risk: The current `npm run typecheck` failure and deployment-only module/runtime failures can block releases or appear only after deployment.
- Priority: High

**Nuxt route and rendered content behavior:**
- What's not tested: SSR/client hydration, catch-all precedence, 404/error output, redirects, canonical links, image variants, and MDC component rendering.
- Files: `app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`, `app/error.vue`, `shared/contentRedirectsModule.ts`, `app/app.vue`, `app/components/page/Community.vue`
- Risk: Content can build while the wrong record, metadata, canonical URL, or community hero asset is rendered.
- Priority: High

**HTTP security and integration boundaries:**
- What's not tested: Request-size limits, authorization-header/token handling, admin endpoint method semantics, duplicate webhooks, malformed headers, stale-cache concurrency, and hostile MDC descriptions.
- Files: `server/api/events/webhook.post.ts`, `server/api/events/cache-clear.get.ts`, `server/api/events/google-sync.get.ts`, `server/api/community-maps/refresh.get.ts`, `server/utils/portalEvents.ts`, `app/components/content/Calendar.vue`
- Risk: Abuse, privacy leakage, duplicate side effects, and upstream schema changes can affect production without a failing unit test.
- Priority: High

**Queue, storage, and external-service failure behavior:**
- What's not tested: Scheduled task context, Cloudflare queue retries, R2 publication failures, CDN freshness, Google pagination limits, and miner upstream body/timeout behavior.
- Files: `server/tasks/community-maps.ts`, `server/plugins/communityMapsQueue.ts`, `server/utils/staticMap.ts`, `server/utils/googleCalendar.ts`, `server/utils/miners.ts`
- Risk: Background work can fail partially or become expensive without a user-visible failure or reliable retry diagnosis.
- Priority: Medium

**Interactive UI behavior:**
- What's not tested: Calendar duplicate-fetch behavior, tag pagination reset, map responsive/image fallback behavior, modal QR generation, external-link hardening, and accessibility after hydration.
- Files: `app/components/content/Calendar.vue`, `app/components/CommunityMap.vue`, `app/components/page/Community.vue`, `app/components/PersonBlock.vue`, `app/components/SocialLinks.vue`
- Risk: Client-only and mobile regressions can pass the Node test suite and typechecking.
- Priority: Medium

---

*Concerns audit: 2026-09-10*
