<!-- refreshed: 2026-09-10 -->
# Coding Conventions

**Analysis Date:** 2026-09-10

## Naming Patterns

**Files:**
- Use Nuxt file-based names for routes, including `[...slug].vue` and `blog/[[slug]].vue` in `app/pages/`.
- Use PascalCase for Vue components (`app/components/CommunityMap.vue`) and camelCase for TypeScript utilities (`app/utils/communityMap.ts`, `shared/blogArticlesTransformer.ts`).
- Keep content slugs lowercase and hyphenated; blog articles use the `YYYYMMDD.slug.md` form under `content/blog-articles/`.
- Keep server handlers in Nuxt's verb/suffix form, such as `server/api/events/index.get.ts` and `server/routes/ical/[slug].get.ts`.
- Keep test filenames focused on the subject under test and suffix them with `.test.ts`, such as `tests/portalEvents.test.ts`.

**Functions:**
- Use camelCase, with `use` prefixes for composables (`useDataCommunities` in `app/composables/content.ts`) and `project`/`parse`/`get` prefixes for pure transformations and accessors.
- Use descriptive predicate names such as `isRecord`, `isPortalEvent`, and `isPortalWebhookSignatureValid` in `server/utils/portalEvents.ts` and `server/api/events/webhook.post.ts`.
- Use arrow functions for local helpers and exported pure functions; use `async` only at actual I/O or async framework boundaries (`server/utils/googleCalendar.ts`, `server/utils/staticMap.ts`).

**Variables:**
- Use camelCase for locals and reactive state (`activeMarker`, `mapContainerHeight` in `app/components/CommunityMap.vue`).
- Preserve external/content field names where they are part of the schema (`portal_meetup_id`, `redirect_from` in `content.config.ts`).

**Types:**
- Use PascalCase interfaces and type aliases (`PortalEvent`, `CalendarEventRow`, `PageResult`).
- Prefer explicit discriminated unions for route results, as in `app/pages/[...slug].vue` and `app/pages/blog/[[slug]].vue`.
- Use `as const satisfies` for immutable typed data, as in `shared/data/partners.ts`.
- Keep types at the narrowest boundary: use generated Nuxt Content collection item types in Vue (`app/pages/[...slug].vue`) and local adapter interfaces for external I/O (`server/utils/portalEvents.ts`, `server/utils/googleCalendar.ts`).
- Accept `unknown` for untrusted JSON and narrow with type guards instead of asserting its shape (`server/utils/portalEvents.ts`, `server/utils/staticMap.ts`).

## Code Style

**Formatting:**
- No repository formatter configuration is detected. Match the existing TypeScript style: single quotes, two-space indentation, semicolon-free statements, trailing commas in multiline literals, and braces on the same line.
- Use multiline arrow functions and early returns for non-trivial logic, as in `projectCommunities` in `app/composables/content.ts`.
- Vue templates use Nuxt UI primitives and Tailwind utility classes; keep component-specific CSS scoped, as in `app/components/CommunityMap.vue`.
- Keep object and tuple shapes inline when they are local and obvious; introduce named interfaces for exported contracts or complex integration data (`server/utils/staticMap.ts`).
- Existing configuration has isolated double-quoted or formatting exceptions (for example `compatibilityDate` in `nuxt.config.ts`); preserve surrounding file style rather than reformatting unrelated lines.

**Linting:**
- No ESLint, Prettier, or Biome configuration is detected. `npm run typecheck` is the available static correctness check.
- `tsconfig.json` delegates checking to Nuxt-generated project references; run `npm run typecheck` rather than invoking a standalone TypeScript configuration.

## Import Organization

**Order:**
1. External packages and type-only package imports.
2. Shared aliases such as `#shared` and `~/`.
3. Relative server/shared imports.

Keep type-only imports explicit (`import type`) and rely on Nuxt auto-imports for framework composables (`useRoute`, `useAsyncData`, `createError`, and `computed`).

**Path Aliases:**
- Use `~/` for app-local modules, `#shared` for shared modules, and relative imports in server files where the current code does so (`server/api/events/index.get.ts`).

## Error Handling

**Patterns:**
- Throw `createError` for route/API responses and include a status code and safe status message (`server/api/events/index.get.ts`, `app/pages/[...slug].vue`).
- Use a domain error with `statusCode` when a server integration needs to preserve expected HTTP semantics (`PortalEventsError` in `server/utils/portalEvents.ts`).
- Validate unknown external data with narrowing helpers before reading fields; do not trust Portal or cache payloads (`isRecord`, `parseEvent`, and `parseCache` in `server/utils/portalEvents.ts`).
- Catch transport failures at the integration boundary and avoid exposing details outside development (`server/api/events/index.get.ts`).
- Normalize optional external fields into omitted properties or explicit `null` according to the domain contract, rather than passing raw upstream values through (`parseEvent` in `server/utils/portalEvents.ts`).
- Preserve safe public error messages while retaining only documented status/reason fields from Google responses (`GoogleCalendarError` in `server/utils/googleCalendar.ts`).

## Logging

**Framework:** `console.error` at the API boundary; no application logging framework is detected.

**Patterns:**
- Log failed Portal requests once in `server/api/events/index.get.ts` and return a generic production message.
- Do not add logging to pure projection functions such as `app/utils/calendar.ts`.
- Log operational failures at server boundaries with a stable prefix/context, as in `server/utils/staticMap.ts` and `server/plugins/communityMapsQueue.ts`; do not log secrets or raw upstream response bodies.

## Comments

**When to Comment:**
- Comment non-obvious framework boundaries, security behavior, timezone handling, and data normalization. Examples include `app/utils/calendar.ts` and `server/api/events/webhook.post.ts`.
- Keep comments current and specific; ordinary control flow does not need narration.

**JSDoc/TSDoc:**
- Short `/** ... */` comments document exported helpers and security-sensitive functions in `server/utils/portalEvents.ts` and `server/api/events/webhook.post.ts`.
- Inline comments explain deployment/browser constraints in `nuxt.config.ts` and `app/components/CommunityMap.vue`.

## Function Design

**Size:**
- Keep pure helpers focused and composable (`projectCalendarEvents`, `eventJsonLd`, and `clampCommunityMapTransform`). Complex interaction state may remain local to its owning component (`app/components/CommunityMap.vue`).
- Keep one-use presentation logic in its owning Vue component; extract a module only for reusable behavior, complex pure logic, or a framework boundary (`app/components/content/Calendar.vue`, `app/utils/calendar.ts`).

**Parameters:**
- Accept `readonly` arrays for functions that do not mutate callers (`projectCalendarEvents` and `projectCommunities`).
- Inject storage, fetch, and time dependencies at server integration boundaries to keep behavior deterministic and testable (`getPortalEvents` in `server/utils/portalEvents.ts`).
- Prefer options objects for functions with several optional or integration parameters (`generateCommunityMaps` in `server/utils/staticMap.ts`).

**Return Values:**
- Return precise interfaces or discriminated unions. Use `undefined` for omitted optional metadata and `null` for an explicit empty value, following `PortalEvent` and `CalendarEventRow`.
- Do not mutate caller-owned arrays; copy before sorting (`events.slice().sort(...)` in `app/utils/calendar.ts`).
- Return stable, deterministic ordering when data crosses a boundary; tie-break by IDs or paths (`projectCommunities` and `generateCalendar`).

## Module Design

**Exports:**
- Export reusable pure helpers and domain types from focused modules; keep implementation-only parsers private (`server/utils/portalEvents.ts`).
- Vue components expose behavior through props and slots, with `defineProps` in `<script setup>` (`app/components/page/Community.vue`).
- Use Nuxt auto-imports for framework APIs and direct module imports for project utilities; do not add barrel files.

**Barrel Files:**
- No barrel/index export pattern is detected. Import modules directly from their owning paths.

## Content and UI Rules

- Define frontmatter schemas in `content.config.ts`; use generated Nuxt Content item types in Vue components.
- Order blog content by `id`, not a separately parsed date (`app/components/page/BlogCategory.vue`).
- Prefer Nuxt UI components (`UButton`, `UAlert`, `UAccordion`, `UNavigationMenu`) over bespoke controls, as shown in `app/components/content/Calendar.vue` and `app/components/app/NavMenu.vue`.
- Preserve Czech locale and metadata conventions from `app/app.vue` and `app/app.config.ts`.
- Use `script setup lang="ts"` in Vue components, generated collection types from `@nuxt/content`, and Nuxt UI primitives before bespoke controls (`app/components/content/Calendar.vue`).
- Keep SSR-sensitive browser behavior behind `import.meta.client`, lifecycle hooks, or SSR-safe VueUse composables (`app/components/CommunityMap.vue`).
- Keep accessibility semantics alongside interactive markup: labels, `role="alert"`/`role="status"`, keyboard-focus styles, and descriptive SVG titles are part of component behavior (`app/components/CommunityMap.vue`, `app/components/content/Calendar.vue`).

## Data and Security Boundaries

- Treat content frontmatter as schema-governed data and define validation in `content.config.ts`; preserve external field names such as `portal_meetup_id` and `redirect_from` where they are part of the content contract.
- Strip integration-only metadata before returning browser-facing payloads (`withoutMeetupMetadata` in `server/utils/portalEvents.ts` and generated output in `server/routes/ical/[slug].get.ts`).
- Allow navigation only through validated protocols and escape `<` in JSON-LD output (`parseLink` and `eventJsonLd` in `server/utils/portalEvents.ts` and `app/utils/calendar.ts`).
- Use bounded reads, explicit redirect handling, timeouts, and URL-length limits for external image/data fetches (`server/utils/staticMap.ts`).

---

*Convention analysis: 2026-09-10*
