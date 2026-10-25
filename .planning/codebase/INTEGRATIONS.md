---
last_mapped_commit: e29e037cefaa121a9b92ae058a58c950dbf2c276
last_mapped_at: 2026-10-01
---
# External Integrations

**Analysis Date:** 2026-10-01

## APIs & External Services

**Calendar and community events:**

- Portal Einundzwanzig supplies meetup and event data through `https://portal.einundzwanzig.space/api/meetups` and `/api/meetup-events?locale=cs` (`server/utils/portalEvents.ts`). Requests use native Fetch/$fetch; public reads require no credentials.
- Signed Portal notifications enter `POST /api/events/webhook` (`server/api/events/webhook.post.ts`), are authenticated with `NUXT_PORTAL_WEBHOOK_SECRET`, and are placed on the `portal-events` Cloudflare Queue (`nuxt.config.ts`).

**Google Calendar:**

- Google OAuth token endpoint and Calendar v3 API synchronize Portal events (`server/utils/googleCalendar.ts`). The implementation uses native Fetch and the OAuth refresh-token flow.
- Credentials/configuration: `NUXT_GOOGLE_OAUTH_CLIENT_ID`, `NUXT_GOOGLE_OAUTH_SECRET`, `NUXT_GOOGLE_OAUTH_REFRESH_TOKEN`, and `NUXT_GOOGLE_LEGACY_CALENDAR_ID` (`nuxt.config.ts`, `.env.example`). Queue changes and scheduled reconciliation are consumed by `server/plugins/portalEventsQueue.ts`.

**Maps and place data:**

- BeruBitcoin place API (`https://mapa.berubitcoin.cz/api/places`) supplies place data; Mapbox Static Images API renders map assets (`server/utils/staticMap.ts`). Both use native Fetch; Mapbox uses `NUXT_MAPBOX_ACCESS_TOKEN` and a configurable style (`nuxt.config.ts`, `.env.example`).
- OpenStreetMap, Mapbox, and BTC Map are attribution/outbound links in `app/components/page/Community.vue`; calendar projections include map links (`app/utils/calendar.ts`).

**Mining data:**

- WordPress-hosted JSON snapshot at `https://jednadvacet.org/wp-content/uploads/filtered_workers.json` is fetched and validated by `server/utils/miners.ts`; the cached last-known data is persisted through Nitro storage.

**Analytics:**

- Counterscale pageview/intent tracking uses `@counterscale/tracker` in `app/plugins/counterscale.client.ts`.
- `nuxt.config.ts` proxies `/cntrsclc` to `https://analytics.jednadvacet.org/collect`; this path is excluded from the sitemap.

## Data Storage

**Databases:**

- Nuxt Content uses SQLite at `/tmp/jednadvacet-content.sqlite` locally (`nuxt.config.ts`) and framework-managed Cloudflare D1 through the `DB` binding in production (`nuxt.config.ts`). Collection schema is defined in `content.config.ts`.
- NuxtHub configures SQLite DB support (`nuxt.config.ts`). Drizzle and LibSQL packages are installed (`package.json`), but no separately implemented application database layer is detected.

**Key-value and snapshots:**

- Production Nitro storage uses Cloudflare KV namespace binding `PORTAL_EVENT_SNAPSHOTS` for Portal event snapshots and miner cache (`nuxt.config.ts`; consumers include `server/api/events/index.get.ts`, `server/api/miners.get.ts`, and `server/routes/ical/[slug].get.ts`).
- Preview uses in-memory storage; local development uses filesystem storage below `/tmp/jednadvacet-*` (`nuxt.config.ts`).

**File Storage:**

- NuxtHub Blob stores generated community map variants in Cloudflare R2 production binding `BLOB`; map generation and blob access are implemented in `server/plugins/communityMapsQueue.ts` and `server/api/community-maps/[slug].get.ts`.
- Public map assets are delivered from `https://files.jednadvacet.org/community-maps/v1/...` (`app/components/page/Community.vue`). Local blobs use `.data/blob` (`nuxt.config.ts`). Static checked-in assets reside in `public/`.

**Caching:**

- Nitro storage provides event/miner persistence and stale fallback (`nuxt.config.ts`, `server/utils/miners.ts`). No external cache service is detected.

## Authentication & Identity

**Auth Provider:**

- Custom admin bearer-token authentication protects event refresh and map refresh handlers using `NUXT_EVENTS_ADMIN_TOKEN` (`server/utils/eventsAdminAuth.ts`, `server/api/events/refresh.post.ts`, `server/api/community-maps/refresh.get.ts`).
- Portal webhook authentication validates HMAC-SHA-256 signatures with `NUXT_PORTAL_WEBHOOK_SECRET` (`server/api/events/webhook.post.ts`).
- Google Calendar server-to-server requests use OAuth refresh credentials (`server/utils/googleCalendar.ts`).
- Nuxt Studio is configured for the public `Jednadvacetorg/web` GitHub repository, with branch selected by `STUDIO_BRANCH_NAME` (`nuxt.config.ts`); no custom auth provider is implemented in this repository.

## Monitoring & Observability

**Error Tracking:**

- No dedicated error-tracking service detected. Errors are handled through HTTP responses, queue retries, and console logging in `server/`.

**Logs:**

- Subsystem logs use `console.info`, `console.warn`, and `console.error` in `server/utils/`, `server/plugins/`, and `server/tasks/`.
- Cloudflare observability logs and traces are configured in `nuxt.config.ts`; logging/tracing settings are enabled, while the overall observability `enabled` flag is false.

## CI/CD & Deployment

**Hosting:**

- Cloudflare Workers production runtime using Nuxt/Nitro and Wrangler (`nuxt.config.ts`, `package.json`).
- PR builds deploy temporary Workers without production bindings using `.github/workflows/pr-preview.yml`; a separate workflow posts the preview URL (`.github/workflows/pr-preview-comment.yml`).

**CI Pipeline:**

- `.github/workflows/pr-preview.yml` runs on pull requests, installs with `npm ci`, builds preview configuration, checks generated bindings for production-resource leakage, and deploys with `wrangler deploy --temporary`.
- `.github/workflows/pr-preview-comment.yml` validates preview metadata and upserts a pull request comment. No dedicated test/typecheck workflow is detected in `.github/workflows/`.

## Environment Configuration

**Required env vars:**

- `NUXT_PORTAL_WEBHOOK_SECRET` - webhook verification.
- `NUXT_GOOGLE_OAUTH_CLIENT_ID`, `NUXT_GOOGLE_OAUTH_SECRET`, `NUXT_GOOGLE_OAUTH_REFRESH_TOKEN`, `NUXT_GOOGLE_LEGACY_CALENDAR_ID` - Calendar synchronization.
- `NUXT_EVENTS_ADMIN_TOKEN` - protected refresh operations.
- `NUXT_MAPBOX_ACCESS_TOKEN` - Mapbox map rendering.
- `PREVIEW_DEPLOY`, `NUXT_IMAGE_PROVIDER`, `NUXT_BUILD_DIR`, and `STUDIO_BRANCH_NAME` are optional deployment/build switches (`nuxt.config.ts`).

**Secrets location:**

- Local variable names are documented in `.env.example`; local `.env` is configuration and its contents are not part of this mapping.
- Production runtime secrets are configured for the Cloudflare Worker; the fork-safe preview workflow uses no Cloudflare secret (`.github/workflows/pr-preview.yml`).

## Webhooks & Callbacks

**Incoming:**

- `POST /api/events/webhook` accepts signed Portal meetup/event change notifications, validates them, then queues work (`server/api/events/webhook.post.ts`).
- Google Calendar does not call back into this application; synchronization is outbound (`server/utils/googleCalendar.ts`).

**Outgoing:**

- Portal API reads originate in `server/utils/portalEvents.ts`.
- Google token exchange and Calendar API operations originate in `server/utils/googleCalendar.ts`.
- BeruBitcoin and Mapbox requests originate in `server/utils/staticMap.ts`.
- Miner snapshot reads originate in `server/utils/miners.ts`.
- Counterscale browser events are sent through the `/cntrsclc` proxy configured in `nuxt.config.ts`.

---

*Integration audit: 2026-10-01*
