<!-- refreshed: 2026-09-10 -->
# Testing Patterns

**Analysis Date:** 2026-09-10

## Test Framework

**Runner:**
- Node's built-in `node:test` runner, invoked with TypeScript stripping. No Vitest, Jest, Playwright, or Vue Test Utils configuration is detected.
- Test files: `tests/calendarProjection.test.ts`, `tests/communityProjection.test.ts`, `tests/communityHeroMaps.test.ts`, `tests/eventsAdmin.test.ts`, `tests/googleCalendar.test.ts`, `tests/miners.test.ts`, `tests/portalEvents.test.ts`, `tests/portalWebhook.test.ts`, `tests/publicCalendar.test.ts`, and `tests/validateContentRoutes.test.ts`.

**Assertion Library:**
- `node:assert/strict`, using `equal`, `deepEqual`, `match`, `ok`, and `notEqual`.

**Run Commands:**
```bash
npm test
node --experimental-strip-types --test tests/*.test.ts
npm run typecheck
npm run build
```

`npm test` is defined in `package.json` as `node --experimental-strip-types --test tests/*.test.ts`. No watch or coverage command is configured.
- The current suite contains 72 passing tests when run with `npm test`.

## Test File Organization

**Location:**
- Tests are separated from application code in the root `tests/` directory.
- Pure client projections, server integration logic, webhook helpers, and route-validation scripts each have a focused test file.

**Naming:**
- Use the implementation subject followed by `.test.ts`, for example `calendarProjection.test.ts` and `portalEvents.test.ts`.

**Structure:**
```text
tests/
├── calendarProjection.test.ts
├── communityHeroMaps.test.ts
├── communityProjection.test.ts
├── eventsAdmin.test.ts
├── googleCalendar.test.ts
├── miners.test.ts
├── portalEvents.test.ts
├── portalWebhook.test.ts
├── publicCalendar.test.ts
└── validateContentRoutes.test.ts
```

## Test Structure

**Suite Organization:**
```ts
import assert from 'node:assert/strict'
import test from 'node:test'

test('projection gives every event its Prague date and sorts by instant then numeric ID', () => {
  const events = projectCalendarEvents([...])
  assert.deepEqual(events.map(event => event.id), ['2', '20', '30'])
})
```

**Patterns:**
- Each behavior is a top-level `test(...)`; nested `describe` suites are not used.
- Shared fixtures and injected adapters are defined near the top of a file (`brno`, `event`, `storage`, and `fetcher` in `tests/portalEvents.test.ts`; `dependencies` in `tests/publicCalendar.test.ts`).
- Async tests return an `async` function and use `await`; synchronous tests directly assert pure results.
- Temporary filesystem fixtures use `try/finally` cleanup (`tests/validateContentRoutes.test.ts`).
- Assertions verify public outputs and side effects, such as cache entries and fetch call counts, rather than implementation text.
- Prefer one test per observable behavior with scenario-oriented names; use loops only for a compact matrix of equivalent cases (`tests/communityHeroMaps.test.ts`, `tests/publicCalendar.test.ts`).
- Use `assert.deepEqual` for complete structured results and `assert.equal`/`assert.ok` for focused fields; use predicate callbacks when checking typed domain errors (`tests/googleCalendar.test.ts`, `tests/portalEvents.test.ts`).

## Mocking

**Framework:**
- No mocking library is used. Dependencies are replaced with small typed functions and in-memory adapters.

**Patterns:**
```ts
const storage = (values = new Map<string, unknown>()): PortalStorage => ({
  getItem: async key => values.get(key),
  setItem: async (key, value) => { values.set(key, value) },
})

const fetcher = (events: unknown, meetupRows = meetups): PortalFetch => async (url, options) => {
  assert.deepEqual(options, { timeout: 5_000, retry: 0 })
  return url.endsWith('/meetups') ? meetupRows : events
}
```

**What to Mock:**
- Mock network and persistence at injected boundaries (`PortalFetch` and `PortalStorage` in `server/utils/portalEvents.ts`).
- Use temporary directories and child processes when testing the actual route validator (`tests/validateContentRoutes.test.ts`).
- Supply a fixed `now` date to time-sensitive functions such as `getPortalEvents`.
- Replace global logging with `t.mock.method` when the log itself is the behavior under test (`tests/communityHeroMaps.test.ts`).
- Use `Response` objects and capture request URLs, headers, methods, and bodies to verify integration contracts without making live network calls (`tests/googleCalendar.test.ts`, `tests/communityHeroMaps.test.ts`).

**What NOT to Mock:**
- Do not mock pure projections such as `projectCalendarEvents` or `eventJsonLd`.
- Do not inspect source/configuration text with regular expressions; test stable public behavior and generated/runtime output.
- Do not use real Portal, Google, Mapbox, BeruBitcoin, Cloudflare bindings, or a running Nitro server in this suite; inject narrow adapters instead (`tests/portalEvents.test.ts`, `tests/googleCalendar.test.ts`, `tests/communityHeroMaps.test.ts`).

## Fixtures and Factories

**Test Data:**
```ts
const event = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  'meetup.name': 'Jednadvacet Brno',
  title: 'Budoucí meetup',
  start: '2026-08-31 15:00',
  end: null,
  ...overrides,
})
```

**Location:**
- Small fixtures and factories are colocated with the tests that use them (`tests/portalEvents.test.ts`). There is no shared fixture directory.
- Content-route tests create Markdown fixtures in OS temporary directories and always remove them in `finally` blocks (`tests/validateContentRoutes.test.ts`).
- Prefer factory overrides for large external payloads so each test states only the fields relevant to its behavior (`event` in `tests/portalEvents.test.ts`, `portalEvent` in `tests/googleCalendar.test.ts`).

## Coverage

**Requirements:**
- No coverage tool, threshold, or CI coverage requirement is configured.

**View Coverage:**
- Not applicable. Use `npm test`, `npm run typecheck`, and `npm run build` for current automated verification.

## Test Types

**Unit Tests:**
- Pure date/time and JSON-LD projection behavior is covered in `tests/calendarProjection.test.ts`.
- Community grouping/projection and static-map parsing, selection, URL bounds, generation, and failure behavior are covered in `tests/communityProjection.test.ts` and `tests/communityHeroMaps.test.ts`.
- Portal normalization, cache fallback, sorting, and multi-community behavior are covered in `tests/portalEvents.test.ts`.
- HMAC signatures, replay windows, and webhook ID extraction are covered in `tests/portalWebhook.test.ts`.
- Google Calendar OAuth, event projection/sync, reconciliation, idempotent deletion, and safe errors are covered in `tests/googleCalendar.test.ts`; miner normalization/cache behavior is covered in `tests/miners.test.ts`.

**Integration Tests:**
- `tests/validateContentRoutes.test.ts` launches `scripts/validate-content-routes.ts` against temporary content trees and checks process status and diagnostics.
- `tests/publicCalendar.test.ts` exercises public iCalendar generation through injected community, storage, fetch, and clock dependencies and parses the resulting `ical.js` document.
- No test directly boots Nitro, Nuxt Content, or a live external service.

**E2E Tests:**
- No automated browser/E2E suite is detected. Manual browser verification is required for rendered routes, hydration, responsive UI, and interactive map/calendar behavior.
- Component templates are not mounted in automated tests; use browser verification for `app/components/CommunityMap.vue`, `app/components/content/Calendar.vue`, and route rendering.

## Common Patterns

**Async Testing:**
```ts
test('fresh cache avoids Portal', async () => {
  const result = await getPortalEvents('brno', [brno], storage(values), fetcher(...), now)
  assert.equal(result[0]?.title, 'Cached')
})
```

**Error Testing:**
- Failure paths assert non-zero child-process status and diagnostic text (`tests/validateContentRoutes.test.ts`).
- Invalid or hostile input is tested through observable safe outputs, such as an unsafe URL being retained as raw `link` but omitted from `safeLink` (`tests/portalEvents.test.ts`).
- Use `assert.fail` in injected fakes when an unexpected call would invalidate the behavior under test.
- Use `assert.rejects` with an error predicate when status codes, error classes, or secret-redaction behavior matter (`tests/publicCalendar.test.ts`, `tests/googleCalendar.test.ts`, `tests/communityHeroMaps.test.ts`).
- Verify no writes occur after rejected or invalid upstream responses when the operation has destructive side effects (`tests/communityHeroMaps.test.ts`).

**Required verification for changes:**
- Run `npm test` for test-covered logic.
- Run `npm run typecheck` after TypeScript or Vue changes.
- Run `npm run build` for content, routing, module, server/runtime, or configuration changes, then manually verify relevant rendered routes.
- Run `npm run build:cloudflare` for Cloudflare deployment behavior or production image-provider changes, and use browser verification for UI and route changes as required by `AGENTS.md`.

---

*Testing analysis: 2026-09-10*
