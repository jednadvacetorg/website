<!-- refreshed: 2026-09-10 -->
# External Integrations

**Analysis Date:** 2026-09-10

## APIs & External Services

**Community events:**
- Portal Einundzwanzig - authoritative meetup and event data for the public calendar and synchronization flows.
  - Client: Nitro `$fetch` in `server/utils/portalEvents.ts`.
  - Endpoints: `https://portal.einundzwanzig.space/api/meetups` and `https://portal.einundzwanzig.space/api/meetup-events?locale=cs`.
  - Configuration: community frontmatter `portal_meetup_id` in `content/communities/`; requests use a five-second timeout and no retries.

**Google Calendar:**
- Google OAuth and Calendar API - mirrors Portal events into one configured Google calendar.
  - Client: native `fetch` in `server/utils/googleCalendar.ts`.
  - Endpoints: `https://oauth2.googleapis.com/token` and `https://www.googleapis.com/calendar/v3`.
  - Auth: private OAuth client ID/secret and refresh token from `NUXT_GOOGLE_OAUTH_CLIENT_ID`, `NUXT_GOOGLE_OAUTH_SECRET`, and `NUXT_GOOGLE_OAUTH_REFRESH_TOKEN`; target `NUXT_GOOGLE_LEGACY_CALENDAR_ID`.
  - Triggers: signed Portal webhooks in `server/api/events/webhook.post.ts` or the admin reconciliation endpoint `server/api/events/google-sync.get.ts`.

**Community maps:**
- BeruBitcoin places API - supplies Lightning/on-chain/Qerko place coordinates for generated community maps (`server/utils/staticMap.ts`).
  - Endpoint: `https://mapa.berubitcoin.cz/api/places`.
  - Auth: none detected.
- Mapbox Static Images API - renders WebP map images with place markers (`server/utils/staticMap.ts`).
  - Endpoint: `https://api.mapbox.com/styles/v1/{username}/{style}/static/...`.
  - Auth: `NUXT_MAPBOX_ACCESS_TOKEN`; style defaults to `mapbox/dark-v10` via `nuxt.config.ts`.

**Miner data:**
- Legacy Jednadvacet-hosted JSON - supplies miner statistics for `server/api/miners.get.ts`.
  - Endpoint: `https://jednadvacet.org/wp-content/uploads/filtered_workers.json`.
  - Auth: none detected; validated data is cached for one minute in Nitro storage.

**Analytics:**
- Counterscale - browser pageview and calendar-intent analytics (`app/plugins/counterscale.client.ts`).
  - Client: `@counterscale/tracker`.
  - Collection: browser requests use `/cntrsclc`, proxied by `nuxt.config.ts` to `https://analytics.jednadvacet.org/collect`.
  - Auth: hostname-based site ID; no application secret detected.

**Content editing and source control:**
- GitHub - Nuxt Studio edits the public `Jednadvacetorg/web` repository and selected branch (`nuxt.config.ts`).
  - Client: `nuxt-studio`.
  - Auth: managed by the Studio/GitHub integration; no source-configured GitHub token detected.

## Data Storage

**Databases:**
- SQLite - local Nuxt Content index at `/tmp/jednadvacet-content.sqlite`, accessed through `@nuxt/content` server query APIs (`nuxt.config.ts`, `content.config.ts`).
- Cloudflare D1 - production NuxtHub database binding `DB`, with preview builds receiving an isolated database configuration (`nuxt.config.ts`).

**File Storage:**
- Git-tracked static assets - committed images and other public files under `public/`.
- NuxtHub Blob / Cloudflare R2 - generated community map WebP objects under `community-maps/v1/`, written by `server/utils/staticMap.ts` and served from `https://files.jednadvacet.org/` by `app/components/page/Community.vue` in production.
- Local NuxtHub filesystem Blob driver - `.data/blob` during development; the local-only route `server/api/community-maps/[slug].get.ts` serves it.

**Caching:**
- Cloudflare KV namespace `PORTAL_EVENT_SNAPSHOTS` - Portal event snapshots and miner snapshots in production (`nuxt.config.ts`, `server/utils/portalEvents.ts`, `server/utils/miners.ts`).
- Filesystem storage in development and memory storage in PR previews for `portalEvents` and `miners` (`nuxt.config.ts`).
- Portal snapshots refresh when missing or at least seven days old and can serve valid stale data if refresh fails; miner snapshots refresh after one minute (`server/utils/portalEvents.ts`, `server/utils/miners.ts`).

## Authentication & Identity

**Auth Provider:**
- Custom HMAC-SHA-256 webhook authentication - `server/api/events/webhook.post.ts` validates `x-portal-event`, `x-portal-timestamp`, and `x-portal-signature` with `NUXT_PORTAL_WEBHOOK_SECRET` and a five-minute timestamp window.
- Constant-time query-token authentication protects Google sync, cache clear, and community-map refresh routes through `NUXT_EVENTS_ADMIN_TOKEN` (`server/utils/eventsAdminAuth.ts`, `server/api/events/`).
- No end-user login, session, OAuth login flow, or application identity provider is detected; Google OAuth is server-to-server refresh-token access only.

## Monitoring & Observability

**Error Tracking:**
- Not detected. Nitro handlers log integration failures with `console.error` and return sanitized HTTP errors (`server/api/events/index.get.ts`, `server/api/events/google-sync.get.ts`).

**Logs:**
- Cloudflare Workers logs, invocation logs, and traces are configured in generated Wrangler settings via `nuxt.config.ts`.
- Browser usage is measured by Counterscale; no dedicated exception tracking service is configured.

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers using Nitro preset `cloudflare_module` (`nuxt.config.ts`).
- Static/generated map files use the production Cloudflare R2 bucket `files-jednadvacet-org` (`nuxt.config.ts`).

**CI Pipeline:**
- `.github/workflows/pr-preview.yml` uses GitHub Actions, Node 24, `npm ci`, preview-safe build checks, and `wrangler deploy --temporary` without repository secrets.
- `.github/workflows/pr-preview-comment.yml` uses `actions/download-artifact` and `actions/github-script@v7` to validate preview metadata and update a sticky PR comment.

## Environment Configuration

**Required env vars:**
- `NUXT_PORTAL_WEBHOOK_SECRET` - signed Portal webhook verification.
- `NUXT_EVENTS_ADMIN_TOKEN` - protected administrative event/map endpoints.
- `NUXT_GOOGLE_OAUTH_CLIENT_ID`, `NUXT_GOOGLE_OAUTH_SECRET`, `NUXT_GOOGLE_OAUTH_REFRESH_TOKEN`, `NUXT_GOOGLE_LEGACY_CALENDAR_ID` - Google Calendar synchronization.
- `NUXT_MAPBOX_ACCESS_TOKEN` - map image generation; `NUXT_MAPBOX_STYLE` is optional through runtime configuration defaults.

**Optional build/development vars:**
- `NUXT_IMAGE_PROVIDER`, `PREVIEW_DEPLOY`, `STUDIO_BRANCH_NAME`, `NUXT_BUILD_DIR`, and `PPQ_API_KEY` (development tooling only, documented in `.env.example`).

**Secrets location:**
- Local values are expected in gitignored `.env`; production sensitive values are Cloudflare Worker runtime secrets. Secret files are not part of the source map.

## Webhooks & Callbacks

**Incoming:**
- `POST /api/events/webhook` - receives `meetup.created`, `meetup.updated`, and `meetup.deleted` Portal notifications, validates HMAC, re-fetches authoritative Portal data, updates KV, and optionally synchronizes Google Calendar (`server/api/events/webhook.post.ts`).
- Cloudflare Queue `COMMUNITY_MAPS_QUEUE` - receives generated community-map jobs from the scheduled/manual Nitro task and is processed by `server/plugins/communityMapsQueue.ts`.

**Outgoing:**
- Server GET requests to both Portal APIs, the miner JSON endpoint, BeruBitcoin places API, and Mapbox Static Images API (`server/utils/portalEvents.ts`, `server/utils/miners.ts`, `server/utils/staticMap.ts`).
- Google OAuth token and Calendar API requests (`server/utils/googleCalendar.ts`).
- Browser analytics through `/cntrsclc` to Counterscale (`app/plugins/counterscale.client.ts`, `nuxt.config.ts`).
- Public iCalendar feeds are generated locally with `ical.js`; Lightning donations use `lightning:` URI links and locally generated QR codes, with no payment processor API (`server/routes/ical/[slug].get.ts`, `app/components/LightningQrCode.vue`).
- Social and content links navigate to external Nostr, X, Facebook, Instagram, WhatsApp, GitHub, Signal, and other URLs from `app/components/SocialLinks.vue`, `app/components/app/Footer.vue`, and content files.

---

*Integration audit: 2026-09-10*
