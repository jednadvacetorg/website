<!-- refreshed: 2026-09-10 -->
# Technology Stack

**Analysis Date:** 2026-09-10

## Languages

**Primary:**
- TypeScript 6 toolchain - Nuxt application code, Nitro handlers, shared types/utilities, build validation, and tests in `app/`, `server/`, `shared/`, `scripts/`, and `tests/`.
- Vue 3 Single-File Components - SSR-rendered pages, layouts, and reusable UI in `app/**/*.vue`.

**Secondary:**
- Markdown with MDC - typed content collections under `content/`, rendered by Nuxt Content.
- Tailwind CSS - utility styling in `app/assets/css/main.css` and Vue templates.
- JSON/YAML - map geometry, package/configuration files, and GitHub workflows such as `shared/data/communityMapGeometry.json` and `.github/workflows/pr-preview.yml`.

## Runtime

**Environment:**
- Node.js 24 - development container and GitHub Actions (`.devcontainer/devcontainer.json`, `.github/workflows/pr-preview.yml`).
- Nuxt SSR/Nitro on Cloudflare Workers - production runtime configured with the `cloudflare_module` preset in `nuxt.config.ts`.

**Package Manager:**
- npm - scripts and dependency installation are defined in `package.json`.
- Lockfile: present, npm lockfile v3 in `package-lock.json`.

## Frameworks

**Core:**
- Nuxt `^4.3.0` - application framework, SSR, routing, auto-imports, and Nitro (`package.json`, `nuxt.config.ts`).
- Vue 3 - component model for `app/pages/`, `app/components/`, and layouts.
- Nuxt Content `^3.11.0` - typed Markdown collections, SQLite indexing, content queries, and rendering (`content.config.ts`, `nuxt.config.ts`).
- Nuxt UI `^4.4.0` - UI primitives and prose components (`app/app.vue`, `app/components/`, `app/app.config.ts`).

**Testing:**
- Node built-in test runner - `npm test` runs TypeScript tests in `tests/` with `node --experimental-strip-types`.
- Nuxt typecheck / Vue TypeScript tooling - `npm run typecheck` uses generated Nuxt projects and `vue-tsc` (`tsconfig.json`, `package.json`).

**Build/Dev:**
- Nitro - server API/routes, storage adapters, scheduled tasks, Cloudflare bindings, and queue hooks (`server/`, `nuxt.config.ts`).
- Vite - Nuxt-managed development server and bundling.
- Tailwind CSS `^4.1.18` - utility CSS imported by `app/assets/css/main.css`.
- Wrangler `^4.102.0` - Cloudflare Workers deployment and temporary PR previews (`package.json`, `.github/workflows/pr-preview.yml`).

## Key Dependencies

**Critical:**
- `@nuxthub/core` `^0.10.7` - NuxtHub SQLite database integration and Blob abstraction (`nuxt.config.ts`, `server/api/community-maps/[slug].get.ts`).
- `@nuxt/image` `^2.0.0` - environment-specific `ipx`, Cloudflare, or no-op image provider selection (`nuxt.config.ts`).
- `@nuxtjs/sitemap` `^8.2.1` - sitemap generation and content sitemap metadata (`content.config.ts`, `nuxt.config.ts`).
- `nuxt-studio` `^1.5.1` - GitHub-backed content editor configuration (`nuxt.config.ts`).
- `@counterscale/tracker` `^3.4.1` - client analytics in `app/plugins/counterscale.client.ts`.
- `ical.js` `^2.2.1` - standards-compliant iCalendar generation in `server/routes/ical/[slug].get.ts`.
- `qrcode` `^1.5.4` - client-side Lightning address QR generation in `app/components/LightningQrCode.vue`.

**Infrastructure:**
- `drizzle-orm` `^0.45.1`, `drizzle-kit` `^0.31.9`, `@libsql/client` `^0.17.0`, and `better-sqlite3` `^12.11.1` - SQLite/libSQL and NuxtHub ecosystem support; no application-owned Drizzle schema is present.
- `@vueuse/nuxt` / `@vueuse/core` `^14.2.1` - Vue composables integrated into Nuxt.
- `@iconify-json/bitcoin-icons`, `lucide`, `pinhead`, `simple-icons`, and `streamline` - the allowed Nuxt Icon collections configured in `nuxt.config.ts`.
- `@types/node`, `@types/qrcode`, `@vue/language-core`, `typescript`, and `vue-tsc` - type support.

## Configuration

**Environment:**
- Private runtime values are declared in `nuxt.config.ts` under `runtimeConfig`: Portal webhook secret, Google OAuth/calendar values, events admin token, and Mapbox token/style.
- `.env.example` documents local names including `NUXT_PORTAL_WEBHOOK_SECRET`, `NUXT_GOOGLE_OAUTH_*`, `NUXT_EVENTS_ADMIN_TOKEN`, and `NUXT_MAPBOX_ACCESS_TOKEN`; `.env` exists locally but is gitignored and must not be read or committed.
- Build/development switches include `PREVIEW_DEPLOY`, `NUXT_BUILD_DIR`, `NUXT_IMAGE_PROVIDER`, `NODE_ENV`, and `STUDIO_BRANCH_NAME` (`nuxt.config.ts`).

**Build:**
- `nuxt.config.ts` defines modules, content SQLite location, transformers, image/icon providers, NuxtHub storage, Cloudflare D1/KV/R2/Queue bindings, scheduled tasks, route rules, and prerendering.
- `content.config.ts` defines typed blog, category, community, page, and people collections with sitemap schemas.
- `shared/blogArticlesTransformer.ts` derives article publication dates from date-prefixed IDs.
- `scripts/validate-content-routes.ts` runs before `nuxt build` to reject public content-route collisions.
- `tsconfig.json` references Nuxt-generated app, server, shared, and node projects.

## Platform Requirements

**Development:**
- Node.js/npm with the repository dev container from `.devcontainer/devcontainer.json`; the container starts `npm run dev` on port 2103.
- Local content SQLite cache at `/tmp/jednadvacet-content.sqlite`, miner cache at `/tmp/jednadvacet-miners`, Portal event cache at `/tmp/jednadvacet-portal-events`, and NuxtHub Blob files under `.data/blob` (`nuxt.config.ts`).

**Production:**
- Cloudflare Workers with D1 binding `DB`, KV binding `PORTAL_EVENT_SNAPSHOTS`, R2 binding `BLOB`, and queue `COMMUNITY_MAPS_QUEUE` (`nuxt.config.ts`).
- Cloudflare image provider is selected in production unless `NUXT_IMAGE_PROVIDER` overrides it; PR previews use `none` and isolated bindings.
- GitHub Actions builds and deploys temporary PR previews with `npx wrangler deploy --temporary` (`.github/workflows/pr-preview.yml`).

---

*Stack analysis: 2026-09-10*
