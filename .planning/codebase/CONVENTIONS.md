---
last_mapped_commit: e29e037cefaa121a9b92ae058a58c950dbf2c276
last_mapped_at: 2026-10-01
---
# Coding Conventions

**Analysis Date:** 2026-10-01

## Naming Patterns

**Files:**

- Vue single-file components use PascalCase (`app/components/CommunityMap.vue`, `app/components/content/Calendar.vue`).
- Composables and utilities use lower camel case (`app/composables/content.ts`, `app/utils/calendar.ts`).
- Nuxt server routes use HTTP-method suffixes (`server/api/events/index.get.ts`, `server/api/events/webhook.post.ts`).
- Automated tests use domain-oriented `.test.ts` filenames in `tests/` (`tests/portalEvents.test.ts`).

**Functions:**

- Use lower camel case. Prefix Vue composables with `use` (`useDataCommunities` in `app/composables/content.ts`); name transformations by their domain action (`projectCalendarEvents` in `app/utils/calendar.ts`).
- Use `is`-prefixed predicates for type guards, for example `isRecord` and `isCommunity` in `server/utils/portalEvents.ts`.

**Variables:**

- Use lower camel case for local variables, reactive values, and parameters. Preserve upstream/content schema spellings such as `portal_meetup_id` at their data boundaries (`content.config.ts`, `server/utils/portalEvents.ts`).
- Use uppercase names for stable module constants where appropriate; module constants in `server/utils/portalEvents.ts` use descriptive lower camel case.

**Types:**

- Use PascalCase for interfaces, aliases, and classes (`PortalCommunity`, `PortalStorage`, and `PortalEventsError` in `server/utils/portalEvents.ts`).
- Use explicit dependency contracts for injectable side effects and discriminated unions where result variants differ (`PageResult` in `app/pages/[...slug].vue`).
- Use `import type` for type-only imports, as in `server/utils/portalEvents.ts` and `tests/portalEvents.test.ts`.

## Code Style

**Formatting:**

- No repository ESLint, Prettier, or Biome configuration is present; follow nearby source formatting.
- TypeScript examples use two-space indentation, single quotes, and trailing commas in multiline lists/objects; semicolons are generally omitted. See `app/composables/content.ts` and `server/utils/portalEvents.ts`.
- Vue components use `<script setup lang="ts">`, then template and optional styles; see `app/components/content/Calendar.vue`.

**Linting:**

- `package.json` defines no lint script. `npm run typecheck` runs `nuxt typecheck`; `tsconfig.json` references generated Nuxt app, server, shared, and node projects.
- Respect Nuxt-generated Content and framework types rather than adding broader `any` annotations.

## Import Organization

**Order:**

1. Node built-ins and external packages (`node:assert/strict`, `h3`).
2. Type-only imports alongside their owning module/package.
3. Project alias and relative imports, grouped logically; tests commonly use explicit relative `.ts` paths.

**Path Aliases:**

- Use Nuxt aliases such as `#shared/types/portalEvents` and `~/composables/content` where appropriate. Server/test modules also use explicit relative paths, e.g. `../server/utils/portalEvents.ts` in `tests/portalEvents.test.ts`.
- Rely on Nuxt auto-imports for framework composables in Vue files (`app/components/content/Calendar.vue`).

## Error Handling

**Patterns:**

- Validate untrusted external payloads at integration boundaries and narrow `unknown` with type guards; `server/utils/portalEvents.ts` defines `PortalEventsError` and validates its Portal inputs.
- Convert API failures to H3 errors with appropriate status and safe public messages (`server/api/events/index.get.ts`, `server/api/events/refresh.post.ts`).
- Catch network failures where sanitization is required, log limited diagnostics, and avoid forwarding raw upstream messages (`fetchPayload` in `server/utils/portalEvents.ts`).
- Use typed content query results and Nuxt 404 handling for missing public content (`app/pages/[...slug].vue`, `app/pages/blog/[[slug]].vue`).

## Logging

**Framework:** `console`.

**Patterns:**

- Prefix integration/background messages with a subsystem (`[portal-events]` in `server/utils/portalEvents.ts`).
- Log categorized, non-sensitive diagnostics; do not expose tokens or raw external error details to public responses.

## Comments

**When to Comment:**

- Explain non-obvious deployment, consistency, security, and data-integrity constraints, not obvious operations. Examples include comments in `nuxt.config.ts` and `server/utils/portalEvents.ts`.

**JSDoc/TSDoc:**

- Short JSDoc documents exported functions when it establishes a contract, such as `refreshPortalMeetups` in `server/utils/portalEvents.ts`; avoid comments on self-evident local helpers.

## Function Design

**Size:** Keep pure parsers/projections small; orchestration may be larger when stages remain explicit, as in `refreshPortalMeetups` in `server/utils/portalEvents.ts`.

**Parameters:**

- Use narrow interfaces and `Pick`/`Partial` for dependency/input boundaries (`PortalStorage`, `PortalFetch` in `server/utils/portalEvents.ts`).
- Inject fetchers, storage, and clocks into side-effecting domain functions to support deterministic tests (`refreshPortalMeetups`).

**Return Values:** Return explicit typed domain results and `undefined` for absent optional values; preserve inputs when sorting or projecting (`projectCalendarEvents` in `app/utils/calendar.ts`). Batch operations return structured result objects (`PortalRefreshResult` in `server/utils/portalEvents.ts`).

## Module Design

**Exports:** Export public domain operations and testable types; keep internal parsers/helpers private (`server/utils/portalEvents.ts`). Nuxt entrypoints use framework-compatible exports, including default route handlers under `server/api/`.

**Barrel Files:** No application barrel convention is detected. Import from defining modules; use Nuxt auto-import where supported instead of adding one-use barrels.

---

*Convention analysis: 2026-10-01*
