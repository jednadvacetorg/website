---
last_mapped_commit: e29e037cefaa121a9b92ae058a58c950dbf2c276
last_mapped_at: 2026-10-01
---
# Technology Stack

**Analysis Date:** 2026-10-01

## Languages

**Primary:**

- TypeScript 6.x - Nuxt application, server handlers/tasks, shared data, scripts, and tests (`app/`, `server/`, `shared/`, `scripts/`, `tests/`).
- Vue 3 single-file components - SSR interface and client behavior in `app/`.
- Markdown/MDC - content records and embedded components under `content/`, typed by `content.config.ts`.

**Secondary:**

- CSS with Tailwind CSS v4 - styles and UI theme in `app/assets/css/main.css`.
- JSON, YAML, and shell - application data/configuration and CI workflows (for example `shared/data/`, `nuxt.config.ts`, `.github/workflows/`).

## Runtime

**Environment:**

- Node.js 24 in GitHub preview CI (`.github/workflows/pr-preview.yml`); local runtime is npm/Node in the devcontainer (`.devcontainer/devcontainer.json`).
- Cloudflare Workers with Nuxt/Nitro `cloudflare_module` preset in production (`nuxt.config.ts`); `nodeCompat` is enabled, but Worker/Web API compatibility remains required.

**Package Manager:**

- npm; scripts and dependency declarations are in `package.json`.
- Lockfile: present (`package-lock.json`).

## Frameworks

**Core:**

- Nuxt 4 (`nuxt` ^4.3.0) - SSR application, routing, auto-imports, Nitro server and build (`nuxt.config.ts`).
- Vue 3 - component and reactivity runtime (`app/`).
- Nitro/H3 - API handlers, route handlers, tasks, queue consumers and storage (`server/`).
- `@nuxt/content` 3.x - typed Markdown collections and content database (`content.config.ts`).
- `@nuxt/ui` 4.x and Tailwind CSS 4.x - UI primitives and styling (`app/app.vue`, `app/assets/css/main.css`).

**Testing:**

- Node built-in test runner - `npm test` runs `node --experimental-strip-types --test tests/*.test.ts` (`package.json`).
- Nuxt typecheck - `npm run typecheck`; no separate test framework is declared in `package.json`.

**Build/Dev:**

- Vite via Nuxt - development and bundling (`nuxt.config.ts`).
- Wrangler 4.x - Cloudflare deployment and temporary previews (`package.json`, `.github/workflows/pr-preview.yml`).
- NuxtHub Core 0.10.x - D1/R2 integration and `hub:blob` (`nuxt.config.ts`, `server/plugins/communityMapsQueue.ts`).
- Nuxt Studio 1.x - repository-backed content editing (`nuxt.config.ts`).
- `@vueuse/nuxt` 14.x - VueUse Nuxt integration (`nuxt.config.ts`).

## Key Dependencies

**Critical:**

- `@nuxt/content` - content collection query and Markdown rendering consumed throughout `app/` and `server/`.
- `@nuxt/ui` - shared component library used by application UI (`app/`).
- `@nuxthub/core` - database and blob-storage framework integration (`nuxt.config.ts`).
- `@nuxt/image` 2.x - responsive image component/provider support in `app/`.
- `@nuxtjs/sitemap` 8.x - sitemap integration and content schema (`content.config.ts`, `nuxt.config.ts`).
- `nuxt-studio` - content editor integration (`nuxt.config.ts`).

**Infrastructure:**

- `drizzle-orm`, `drizzle-kit`, `@libsql/client`, and `better-sqlite3` are present for database/framework tooling; no standalone application ORM layer is declared in `package.json`.
- `@counterscale/tracker` - browser analytics (`app/plugins/counterscale.client.ts`).
- `ical.js` - iCalendar serialization (`server/routes/ical/[slug].get.ts`).
- `qrcode` - lazy Lightning URI QR generation (`app/components/LightningQrCode.vue`).
- `@vueuse/core` and `@vueuse/nuxt` - client utilities and auto-imports.
- Iconify JSON packs for Bitcoin Icons, Lucide, Pinhead, Simple Icons, and Streamline are installed and configured in `nuxt.config.ts`.

## Configuration

**Environment:**

- Nuxt runtime secrets/configuration are declared in `nuxt.config.ts`; `.env.example` documents variable names without secret values. `.env` is local configuration and must not be read.
- Runtime integration names include `NUXT_PORTAL_WEBHOOK_SECRET`, Google OAuth/calendar variables, `NUXT_EVENTS_ADMIN_TOKEN`, and `NUXT_MAPBOX_ACCESS_TOKEN` (`.env.example`, `nuxt.config.ts`).
- Build switches include `PREVIEW_DEPLOY`, `NUXT_IMAGE_PROVIDER`, `NUXT_BUILD_DIR`, and `STUDIO_BRANCH_NAME` (`nuxt.config.ts`).

**Build:**

- `nuxt.config.ts` configures modules, Content SQLite location, NuxtHub, image/icon providers, Nitro storage/tasks, Cloudflare bindings, queues, schedules, routing and Studio.
- `content.config.ts` defines the typed content collections and schemas.
- `tsconfig.json` uses Nuxt-generated TypeScript configuration.
- `package.json` provides `dev`, `build`, `build:cloudflare`, `test`, and `typecheck`; build runs `scripts/validate-content-routes.ts` before Nuxt build.

## Platform Requirements

**Development:**

- Node.js/npm compatible with the Nuxt 4 toolchain; the project devcontainer supplies a recommended environment (`.devcontainer/devcontainer.json`).
- Local writable storage is used for NuxtHub blob files under `.data/blob`; Nuxt Content SQLite is placed at `/tmp/jednadvacet-content.sqlite` (`nuxt.config.ts`).

**Production:**

- Cloudflare Workers deployment named `jednadvacetorg-web`, using Nitro's `cloudflare_module` preset (`nuxt.config.ts`).
- Cloudflare D1, KV, R2, Queues, and cron bindings are generated/configured through `nuxt.config.ts`.

---

*Stack analysis: 2026-10-01*
