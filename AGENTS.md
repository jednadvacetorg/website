# Developer Instructions

## General Guidelines

1. **Read project context before changing code** - Read the repository-root `README.md`, then select and read the task-relevant maps from the repository-root `.planning/codebase/` directory. The available maps are `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STACK.md`, `.planning/codebase/STRUCTURE.md`, `.planning/codebase/CONVENTIONS.md`, and `.planning/codebase/CONCERNS.md`. `.gsd/codebase/` is a compatibility symlink to the same canonical files.

2. **Follow the binding UI decision order** - First inspect `app/components/` and reuse a suitable existing project component. Second, use a suitable Nuxt UI component from https://ui.nuxt.com. Only if neither fits, create minimal accessible semantic markup without bespoke or complex Tailwind styling, stop before custom visual design, and consult the user about the intended design.

3. **Use existing patterns** - Before writing new code, inspect the codebase for established conventions, naming patterns, and libraries.

4. **Check package.json** - Always verify available dependencies before importing or using external libraries.

5. **Run relevant verification** - After changes, run the checks described below. Do not treat typechecking alone as sufficient verification for content routing, UI behavior, or deployment configuration.

## Working Tree and Git Safety

- Inspect the working tree before editing. Treat existing dirty paths as unrelated user work unless the task explicitly assigns them.
- Never revert, overwrite, stage, or include unrelated existing changes. Preserve every unrelated dirty-worktree path.
- For ordinary work outside GSD, edit the current working tree without automatically creating a branch or commit. Most small changes should not use GSD unless the user requests it.
- Create a commit for ordinary work only when the user explicitly requests one. If its scope is clear, that request is sufficient approval; if unrelated changes are present, ask which paths to include.
- GSD may create incremental implementation commits only on `gsd/phase-*` branches and their isolated executor worktrees. Never create GSD implementation commits on `master`.
- Keep `master` protected: never merge, rebase, cherry-pick, tag, push, or otherwise change its history without explicit user approval. Successful checks, UAT, phase completion, or a request to review do not imply integration approval.
- When explicitly requested, related dependent GSD phases may be completed on one existing `gsd/phase-*` milestone branch. Review and approve the complete milestone diff before integrating that branch into `master`; keep the phase order and record each phase's verification in its artifacts.
- Before integrating a phase, report the source and target branches, branch ancestry, commits and diff against `master`, relevant verification and UAT results, and unmet dependencies. Explain the consequences and confirm the user's intended integration path.
- Prefer `/gsd-ship <phase>` for a reviewed PR into `master`; also offer keeping the phase branch unchanged when further review is wanted. Do not run `/gsd-complete-milestone` until its branch-merge effects have been explained and the user explicitly approves proceeding.

### Commit Messages

- Follow the repository's Conventional Commit style with a concise imperative subject.
- Prefer standard types such as `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`, and `ci:`.
- Use `content:` for editorial changes to published site content, such as articles, community profiles, people, categories, page copy, and assets under `public/` that are directly used by that content. This is an intentional repository-specific extension, not a standard Conventional Commits type, so tools must treat it explicitly rather than assume it is universally recognized.
- Use `docs:` for developer or project documentation, `feat:` for new content functionality, and `fix:` for behavioral corrections rather than editorial content updates.

## Project-Specific Knowledge

- Dependencies are managed by npm (do not use pnpm or another package manager).
- This is a single Nuxt 4 application using Vue 3, TypeScript, Nuxt UI, and `@nuxt/content`. It is not a monorepo or an SPA-only application.
- The application uses Nuxt SSR/Nitro and is deployed to Cloudflare Workers. Preserve Cloudflare compatibility and do not assume Node-native runtime APIs are available in production.
- Blog articles are stored in `content/blog-articles/` with date prefixes in filenames (e.g., `20230816.bolt-karta-s-lnbits.md`).
- The collection is defined in `content.config.ts`, check it when working with content files and keep correct frontmatter fields structure.
- When querying blog articles, use `id` for ordering because it contains the date from the filename.
- `pages` and `communities` share the root URL space. Keep their public paths unique and preserve the routing precedence defined by the catch-all pages.
- Source code lives in `app/`, `content/`, `shared/`, and root configuration files. Treat `.nuxt/`, `.output/`, `.data/`, root log files, and `node_modules/` as generated or diagnostic output rather than source of truth.
- Treat content as actionable work only when it has a syntactic TODO marker or an unambiguous product placeholder. Ordinary editorial prose, including future-looking prose, is not an implementation task.
- Use icons only from the collections allowed by `studio.editor.iconLibraries` in `nuxt.config.ts` and installed directly as `@iconify-json/*` dependencies. Do not introduce icons from other collections or dynamically construct icon names unless they are explicitly included in the Nuxt Icon client bundle.

## Coding Conventions

- Vue components use `<script setup lang="ts">` and Nuxt auto-imported composables unless an explicit import is required.
- Prefer generated Nuxt Content and Nuxt UI types. Do not expand `any` usage without a concrete framework-boundary reason.
- Keep collection queries, frontmatter, routes, redirects, and sitemap behavior aligned with `content.config.ts`.
- Reuse components from `app/components/` before adding new components, and prefer Nuxt UI primitives over custom controls.

## Simplicity and Scope Control

- Start each feature with the smallest responsibility map that can deliver it. Requirements describe outcomes, not required files, layers, or abstractions.
- When writing new Czech user-facing copy, address the user consistently with singular informal forms (tykání), including UI, validation, error, accessibility, and page-copy strings. Prefer forms such as `vyber`, `zkus`, `můžeš`, `chceš`, `ti`, `tě`, and `tvůj`/`tvoje` instead of `vyberte`, `zkuste`, `můžete`, `chcete`, `vám`, `vás`, and `váš`/`vaše`. Preserve the established voice in blog articles, author profiles, quotations, and other editorial content unless the task explicitly asks to change it.
- Add a new component, helper, type, export, or source file only when it has at least two production consumers, isolates genuinely complex pure logic, or is required by a framework boundary. Tests do not count as a second consumer.
- Keep one-use logic local by default. Do not split components merely because template sections have different conceptual responsibilities.
- Keep types at the narrowest boundary. Put a type in `shared/` only when production code on both client and server consumes it.
- Do not add persisted state, deduplication, schema metadata, compatibility layers, factories, or wrappers unless a requirement or concrete failure mode needs them. Persisted state must have an explicit key owner, invalidation strategy, and retention policy.
- Test behavior through stable public boundaries. Do not write tests that inspect source or configuration text with regular expressions. Use typecheck, builds, generated output, and browser verification for framework wiring and content placement.
- For a narrow feature, prefer one focused test file per stable behavior boundary rather than one file per requirement or acceptance criterion.
- Keep feature work separate from discovered tooling, devcontainer, build, documentation, and deployment-policy fixes. Report those separately and get approval before mixing them into the feature diff.
- Before final verification, perform a simplification pass: identify one-use files and exports, duplicated identity or validation, unnecessary response envelopes, implementation-coupled tests, and behavior not required by the task.

## Local Development Workflow

- The devcontainer normally starts the development server automatically. Before starting another server, browse `http://localhost:2103/` with `agent-browser` to check whether it is already running.
- If no server is running, start `npm run dev` as a background process and wait until Nuxt reports that it is ready. Do not run it again while an existing server is active.
- Use the development server by default for debugging. Use a production build when verifying production-only behavior or one of the build-sensitive changes listed below.
- This application is server-rendered. HTTP requests can help inspect server output, but they do not replace browser verification for hydration, client navigation, responsive layout, or interactive behavior.
- Before the final response, stop every server, watcher, browser session, test script, Cloudflare `workerd` process, and other background process started during the task. Check for orphaned descendants after stopping their parent processes.
- Do not stop devcontainer services or a development server that was already running before the task. Track process ownership when starting background work and report any process intentionally left running.

## Dev Container

- Store temporary files under `/tmp`; access outside `/workspace` and `/tmp` is not permitted.
- Save screenshots and browser artifacts under `/tmp/screenshots`. Do not add temporary artifacts to the repository.

## Verification

- Always run `npm run typecheck` after code or configuration changes.
- Run relevant focused tests with `node --experimental-strip-types --test tests/*.test.ts` when the affected behavior has test coverage.
- Run `npm run build` after changes to content schemas or routing, Nuxt configuration, integrations, shared build modules, or server/runtime behavior. The build also validates public content-route collisions.
- Run `npm run build:cloudflare` when changing Cloudflare deployment behavior or production image-provider selection.
- For UI and route changes, use `agent-browser` to inspect the rendered DOM at desktop and mobile sizes and take screenshots when visual evidence is useful. Do not install or use Puppeteer, Playwright, or another browser automation package.
- Verify actual page content and error rendering rather than relying only on an HTTP status code or successful compilation.
- After adding or changing an icon, run the production build and inspect its Nuxt Icon output for unresolved or dropped icons. Use `agent-browser` on every affected route to verify the icon is visibly rendered after SSR and client navigation, and confirm that rendering does not request `/api/_nuxt_icon/**` or `api.iconify.design`. A successful build alone is not sufficient.
