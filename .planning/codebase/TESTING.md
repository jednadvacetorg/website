---
last_mapped_commit: e29e037cefaa121a9b92ae058a58c950dbf2c276
last_mapped_at: 2026-10-01
---
# Testing Patterns

**Analysis Date:** 2026-10-01

## Test Framework

**Runner:**

- Node.js built-in `node:test` runner executes TypeScript using Node's `--experimental-strip-types` flag.
- Config: No separate test configuration is present. `package.json` defines `node --experimental-strip-types --test tests/*.test.ts`.

**Assertion Library:** Node's built-in `node:assert/strict`, imported as `assert` (`tests/portalEvents.test.ts`).

**Run Commands:**

```bash
npm test                                      # Run all top-level test files
node --experimental-strip-types --test tests/*.test.ts  # Direct equivalent
npm run typecheck                             # Check Nuxt/TypeScript types
npm run build                                 # Validate routes and build Nuxt
```

No watch or coverage command is declared in `package.json`.

## Test File Organization

**Location:** Tests live separately under top-level `tests/`, importing exported production functions from `app/`, `server/`, and `scripts/`.

**Naming:** Use `<domain>.test.ts`, e.g. `tests/calendarProjection.test.ts`, `tests/portalEvents.test.ts`, and `tests/validateContentRoutes.test.ts`.

**Structure:**

```text
tests/
├── communityProjection.test.ts
├── calendarProjection.test.ts
├── communityHeroMaps.test.ts
├── eventsAdmin.test.ts
├── googleCalendar.test.ts
├── miners.test.ts
├── portalEvents.test.ts
├── portalEventsQueue.test.ts
├── portalWebhook.test.ts
├── publicCalendar.test.ts
└── validateContentRoutes.test.ts
```

## Test Structure

**Suite Organization:** Tests are independent top-level `test()` calls; names state observable behavior. Representative real pattern:

```typescript
import assert from 'node:assert/strict'
import test from 'node:test'
import { eventJsonLd, projectCalendarEvents } from '../app/utils/calendar.ts'

test('JSON-LD uses the Prague winter offset', () => {
  const event = { id: '1', title: 'Brno meetup', start: '2026-01-31T15:00:00.000Z', end: null, tags: [] }
  assert.equal(JSON.parse(eventJsonLd([event]))['@graph'][0].startDate, '2026-01-31T16:00:00+01:00')
})
```

This style appears in `tests/calendarProjection.test.ts`.

**Patterns:**

- Keep tests focused on a behavior or invariant; do not add nested suites.
- Define small local fixture factories and doubles near the top of the test file (`tests/portalEvents.test.ts`).
- Prefer exact structured assertions (`assert.deepEqual`) where shape/order matters; use scalar, presence, and regex assertions for narrower contracts.
- Use fixed dates/clocks for deterministic time behavior (`tests/portalEvents.test.ts`, `tests/publicCalendar.test.ts`).

## Mocking

**Framework:** Node test context mocking (`t.mock.method`) plus manually injected typed doubles. No Jest, Vitest, Sinon, or Vue Test Utils test harness is configured.

**Patterns:**

```typescript
const fetcher: PortalFetch = async (url, options) => {
  calls.push(url)
  assert.deepEqual(options, { timeout: 5_000, retry: 0 })
  return url.endsWith('/meetups') ? meetupRows : events
}

test('Portal transport failures log safe endpoint diagnostics', async t => {
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args))
  // Call the exported operation and assert its public result/log contract.
})
```

The patterns are drawn from `tests/portalEvents.test.ts`.

**What to Mock:**

- Inject HTTP fetchers and storage interfaces; use an in-memory `Map` for storage (`tests/portalEvents.test.ts`, `tests/miners.test.ts`).
- Mock `console` only to check operational logging (`tests/communityHeroMaps.test.ts`).
- For file-system tools, create temporary directories and clean them in `finally` (`tests/validateContentRoutes.test.ts`).

**What NOT to Mock:** Call pure projection/parsing functions directly. Verify generated iCalendar through the real `ical.js` parser in `tests/publicCalendar.test.ts`; test visible contracts, not implementation/source text.

## Fixtures and Factories

**Test Data:**

```typescript
const brno: PortalCommunity = { id: 'brno', path: '/brno', title: 'Brno', portalMeetupId: 360 }
const now = new Date('2026-08-30T12:00:00.000Z')
const event = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Budoucí meetup',
  start: '2026-08-31 15:00',
  end: null,
  ...overrides,
})
```

Pattern from `tests/portalEvents.test.ts`.

**Location:** Keep fixtures/factories local to relevant test files; no shared fixture directory is detected. Prefer minimal domain-valid records with overrides for scenario differences.

## Coverage

**Requirements:** No coverage threshold, coverage tool, or coverage script is configured in `package.json`. Existing tests emphasize server integration utilities and pure data transformations; Vue rendering and browser interaction are not represented in `tests/`.

**View Coverage:** Not configured.

## Test Types

**Unit Tests:** Exercise pure projections, parsers, validation, auth checks, and error classification (`tests/calendarProjection.test.ts`, `tests/eventsAdmin.test.ts`, `tests/miners.test.ts`).

**Integration Tests:** Exercise composed utility workflows with injected external dependencies, such as event-cache refresh, calendar generation, and route validation (`tests/portalEvents.test.ts`, `tests/publicCalendar.test.ts`, `tests/validateContentRoutes.test.ts`). Route-source validation launches the script in a child Node process and supplies a temporary content root (`tests/validateContentRoutes.test.ts`). Tests do not call live Portal/Google/Mapbox services or run a Nuxt server.

**E2E Tests:** No browser/E2E framework or test files are detected. Hydration, responsive layout, and interactive UI need separate browser verification; `npm test` does not cover them.

## Common Patterns

**Async Testing:** Use async test callbacks and `assert.rejects` for promise errors; match domain class/status when these are contractual (`tests/portalEvents.test.ts`):

```typescript
await assert.rejects(
  getPortalEvents('unknown', storage()),
  (error: unknown) => error instanceof PortalEventsError && error.statusCode === 404,
)
```

**Error Testing:**

```typescript
assert.throws(
  () => parseCommunityMapSource({ slug: '../brno', map: { lat: 49.19, lng: 16.61 } }),
  /slug/,
)
```

- For safe-error behavior, assert both the error contract and absence of sensitive details in logged/public output (`tests/portalEvents.test.ts`, `tests/communityHeroMaps.test.ts`).
- Cover malformed and boundary inputs, and use `try/finally` to guarantee temporary resource cleanup (`tests/validateContentRoutes.test.ts`).

---

*Testing analysis: 2026-10-01*
