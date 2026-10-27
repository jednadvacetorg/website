# Email delivery operations

Email delivery remains disabled until all reviewed production gates pass. The verifier produces evidence; it never installs evidence, changes a switch, provisions secrets, applies migrations or deploys. Do not set `NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED=true` during setup, sandbox, callback, or live-canary work.

**Current execution authority:** changed local implementation → full milestone code/security/UI review and accepted fixes → rerun required checks → explicitly reviewed integration decision → separately authorized production verification/release. Offline tests of the five modes are local-candidate evidence only. They do not complete 06-06 Task 2, 06-07, MAIL-01 or a phase, and do not authorize any command below against production.

## Required production prerequisites

### Isolated preview testing

Only a `PREVIEW_DEPLOY` build can test delivery without production-observation records. Root/Turnstile/provider credentials and all existing channel, first-message and event-delivery switches still apply; missing credentials or disabled switches remain fail-closed. No new runtime bypass switch exists. The private Turnstile expected hostname must be a `*.workers.dev` host and determines the HTTPS management-link origin; request headers cannot choose it. Production builds always retain the original evidence gates and `https://jednadvacet.org` management origin, regardless of runtime hostname settings.

Preview testing does not prove production readiness. Keep switches off outside an explicitly authorized recipient/message test. SMS lifecycle copy is bounded to one GSM-7 segment even with the longer Learned Mantis URL; overlong messages fail rather than being truncated or sent multipart.

An authorized operator supplies `CLOUDFLARE_API_TOKEN` through the environment and `NUXT_BREVO_API_KEY` through the environment/API header. Use narrowly scoped authenticated read access to Worker deployments/content/settings/schedules, Queues, the intended DNS zone and D1. The existing installed Wrangler executable is used only for bounded read-only D1 `SELECT` queries, addressed by database UUID and account ID. There is no credential discovery or provider CLI dependency. Brevo must verify `Jednadvacet.org <noreply@jednadvacet.org>` and the SPF, DKIM, and DMARC evidence for the `jednadvacet.org` sending domain. Do not use `noreply@b.jednadvacet.org`. Inbound mail remains deferred to a future dedicated receiving subdomain and is not configured or tested in this runbook.

Store `NUXT_BREVO_API_KEY`, `NUXT_BREVO_CALLBACK_SECRET`, and one `NUXT_NOTIFICATION_ROOT_KEY` as Cloudflare Worker secrets. Generate the root as one unpadded base64url 32-byte value and never print it. The Worker internally derives non-extractable, purpose-separated AES-GCM outbox and HMAC suppression/abuse keys with fixed HKDF context labels. Replacing the root is a deliberate deployment and can temporarily make retained encrypted work or hashes unavailable; there is no compatibility or recovery path through a former root. Configure Brevo to call the deployed HTTPS `/api/notifications/brevo-events` endpoint with the callback bearer; never place secrets in a URL, command line, log, or this document.

Before a separately authorized remote migration, inspect the generated Worker target and production `web` D1 migration state. The local candidate is one generated initial migration representing the unchanged final schema. It is authorized only because production is empty and the sole migrated preview database will be discarded and reprovisioned by a separately authorized operator action. Apply only the reviewed generated migration to an intended fresh database, deploy the matching bundle, and keep the manual switch false.

The fresh-install rehearsal independently compares the one initial SQL, Drizzle snapshot and journal with the checkpointed final schema, runs the native NuxtHub runner twice, and requires exact `_hub_migrations` and packaged Worker agreement. An existing preview ledger is incompatible: never silently mark it applied, rewrite its ledger, or apply the squashed migration over it. Record any existing target schema and ordered `_hub_migrations` ledger under separately authorized read-only access, then choose an authorized disposal or reprovisioning path.

## Verification sequence

The existing package command also supports credential-free candidate verification:

```bash
npm run verify:email-delivery -- local-preflight --channels email,sms,web-push --target local --config .output/server/wrangler.json --expectations /tmp/email-review/expected.json --artifacts /tmp/email-review/artifacts.json --expect-switch false
```

This reads only the three named inputs and their artifact inventory. It does not read environment credentials, discover authentication, execute Wrangler, request metadata, call a provider, or accept live evidence. It emits `local-candidate`, matching config/bundle/ordered migration hashes and `artifacts: passed`; all live and human gates remain pending. This is byte identity, not a migration rehearsal or an assertion that inventory includes every generated module. Independently review the inventory and run the migration/bundle verifier. The joint SMS/push boundary and observation-only multichannel readiness review are described in [SMS and Web Push operations](sms-web-push-delivery-operations.md).

Run the local checks with fresh `/tmp` Content and Nuxt build paths and an owned empty dotenv file. Existing failing compiler/runtime diagnostics are blockers even if a tool returns zero:

```bash
npm test
npm run typecheck
npm run build:cloudflare
```

The existing command has five strict modes. Every invocation requires `--target production`, `--config`, `--expectations`, `--artifacts` and `--expect-switch true|false`. Unknown/duplicate flags, extra positional arguments and missing values fail. `--authorize-probe` applies only to sandbox/callback/live-canary; `--approve-readiness` and `--evidence` apply only to readiness. These are separate explicit operator authorizations, not implicit permission from a passing test.

### Reviewed inputs (no secrets)

Keep inputs/evidence outside the repository, for example `/tmp/email-review/`. The expectations JSON contains the **reviewed**, independently recorded values below. Do not regenerate expectations from altered candidate bytes just to make a drift failure pass:

```json
{
  "accountId": "<Cloudflare account ID, 32 lowercase hex characters>",
  "worker": "jednadvacetorg-web",
  "d1Id": "<web database UUID>",
  "d1Name": "web",
  "queue": "notification-messages",
  "queueId": "<notification queue ID, 32 lowercase hex characters>",
  "dlq": "notification-messages-dlq",
  "dlqId": "<DLQ ID, 32 lowercase hex characters>",
  "zoneId": "<jednadvacet.org zone ID, 32 lowercase hex characters>",
  "deploymentId": "<current 100-percent deployment UUID>",
  "versionId": "<its sole version UUID>",
  "managementBaseUrl": "https://jednadvacet.org/notifications/manage/",
  "callbackUrl": "https://jednadvacet.org/api/notifications/brevo-events",
  "spfValue": "<reviewed exact root-domain v=spf1 TXT record ending in ~all or -all>",
  "configHash": "<SHA-256 of exact wrangler.json bytes>",
  "bundleHash": "<reviewed aggregate described below>",
  "migrationHash": "<reviewed ordered aggregate described below>"
}
```

The artifacts JSON inventories the actual emitted modules relative to the generated config directory, the emitted/reviewed assets manifest file and ordered generated migration files. Module names are unique, relative paths without traversal. Include every uploaded module/resource (including SQL/wasm resources when emitted); the downloaded Worker module inventory must match exactly. Migration names are NuxtHub tags **without `.sql`**, sorted lexicographically and unique:

```json
{
  "modules": [{ "name": "index.mjs" }, { "name": "chunks/example.mjs" }],
  "assetsManifest": "/tmp/email-review/reviewed-assets-manifest.json",
  "migrations": [{ "name": "0000_majestic_lightspeed", "path": "/absolute/reviewed/0000_majestic_lightspeed.sql" }]
}
```

Names in this example are illustrative; use the actual generated/upload inventory, including any reviewed forward migration. The verifier reads actual file bytes through the injected file boundary, not source-text regexes or asserted `passed` booleans. `bundleHash` is SHA-256 of UTF-8 `JSON.stringify({ modules, assetsHash })`, where `modules` is sorted `[relativeName, SHA256(fileBytes)]` pairs and `assetsHash` hashes the exact assets manifest bytes. `migrationHash` is SHA-256 of `JSON.stringify([[tag, SHA256(sqlBytes)], ...])` in supplied sorted order. `configHash` is independent of code identity. No replacement build/hash CLI is introduced.

Production preflight downloads authenticated Worker multipart content and compares all module bytes. It also requires the authenticated deployment's `workers/message` annotation to be exactly `email:<bundleHash>:<migrationHash>:<configHash>`. This is a **release attestation** for the referenced assets manifest/reviewed migration bytes, not independent proof that every asset was uploaded or that those SQL bytes were applied. `_hub_migrations` records names, not SQL hashes. An independent reviewed migration rehearsal/history decision and exact asset upload inventory remain mandatory. If annotations, a complete manifest, or metadata are unavailable, verification fails; do not substitute a local config for a deployed observation. Split/gradual deployments are rejected.

The current Worker must expose the exact sender name/email and strict string manual-switch setting as plain-text bindings, and the three required secrets as secret bindings. Its authenticated custom-domain mapping must associate the root hostname/zone with this production Worker; an absent/different mapping fails, as does a mismatched downloaded `cf-entrypoint`. Preflight separately checks D1 UUID, Queue producer/consumer/DLQ IDs, cron, persistent invocation logs, exact root-domain Brevo sender/domain status, verified Brevo code/DKIM/DMARC plus matching authenticated DNS records and the separately reviewed root SPF record. Brevo does not expose an SPF status in its domain metadata: the verifier uses the authenticated root DNS TXT record. Callback metadata must identify the exact HTTPS endpoint, bearer and required event set. Public readiness must be no-store, exactly three booleans, with SMS/push false. Missing/masked callback auth metadata is a failure rather than guessed proof.

### Mode commands — production authorization still pending

```bash
npm run verify:email-delivery -- preflight --target production --config .output/server/wrangler.json --expectations /tmp/email-review/expected.json --artifacts /tmp/email-review/artifacts.json --expect-switch false
npm run verify:email-delivery -- sandbox --target production --config .output/server/wrangler.json --expectations /tmp/email-review/expected.json --artifacts /tmp/email-review/artifacts.json --expect-switch false --authorize-probe
npm run verify:email-delivery -- callback --target production --config .output/server/wrangler.json --expectations /tmp/email-review/expected.json --artifacts /tmp/email-review/artifacts.json --expect-switch false --authorize-probe
npm run verify:email-delivery -- live-canary --target production --config .output/server/wrangler.json --expectations /tmp/email-review/expected.json --artifacts /tmp/email-review/artifacts.json --expect-switch false --authorize-probe
npm run verify:email-delivery -- readiness --target production --config .output/server/wrangler.json --expectations /tmp/email-review/expected-enabled.json --artifacts /tmp/email-review/artifacts.json --expect-switch true --approve-readiness --evidence /tmp/email-review/attested-evidence.json
```

The first four require public email readiness false; readiness confirms an already explicitly authorized manual state and public readiness true. It cannot turn either on. Before production, review the later runtime evidence-installation/first-enablement sequence; this local implementation does not supply a rollout bypass.

Supply canary-only values through environment, never flags/URLs in logs: `EMAIL_VERIFY_SUPPRESSION_RECIPIENT`, `EMAIL_VERIFY_FINAL_RECIPIENT`, `EMAIL_VERIFY_SUPPRESSION_DELIVERY_ID`, `EMAIL_VERIFY_DELIVERY_ID`, `EMAIL_VERIFY_CALLBACK_EVENT_ID`, and `EMAIL_VERIFY_MANAGEMENT_TOKEN`. Use two distinct dedicated non-user email contacts and two distinct opaque delivery IDs. Prepare them through separately authorized existing lifecycle/D1 operator boundaries; this verifier deliberately performs no seeding, unsuppression or cleanup writes. Callback requires an active matching suppression contact and submitted ledger row with a matching opaque provider ID and zero prior receipts. It checks unauthenticated 401 without mutation, an unrelated delivery without mutation, one hard-bounce receipt, contact deletion/outbox scrubbing, and replay with identical durable state. It reads the original contact's outbox even after the ledger's foreign key becomes null.

Sandbox invokes the existing email adapter with `X-Sib-Sandbox: drop`, Czech HTML/text and one `METHOD:PUBLISH` attachment. Live canary requires a fresh pending matching final contact/delivery with no provider ID, callback receipts, suppression or queued work, then makes **exactly one** provider request and reads back correlated durable delivered evidence. A repeat against an already observed delivered row is denied. There is no application resend/polling engine or distributed exactly-once claim: timeout, 429/5xx, malformed acceptance, a lost callback or an immediate read before callback arrival is inconclusive/failure. **Do not rerun a send after an ambiguous attempt**; inspect the existing provider/D1 boundaries under separate authorization. A crash or missing result cannot prove non-delivery. Provider callback ID formats must satisfy the existing callable boundary; real account-specific interoperability remains a production gate.

### Evidence and privacy

Turnstile is an abuse signal, not management authorization. Live synthetic SMS-recovery checks observed identical-token replay rejected when the accepted widget stayed mounted, but accepted after removal (with or without replacement). The cause remains unresolved; further diagnostics were stopped. Every supplied token still goes through validation, the low-volume token-free allowance and requester minute limit remain, and no application replay cache or lifecycle workaround is installed. This is not evidence that all operation surfaces reject replay. Recovery for an eligible real contact can rotate its management link and enqueue a message, so evaluate repeated-recovery/message-cost impact before enabling delivery; the requester limit is not a per-contact or cross-IP cap. The diagnostic runs created no contacts or outbox rows and sent no messages. Use separate production Turnstile keys and retire chat-shared test credentials.

Management pages and notification APIs use `no-store`, analytics excludes management URLs, and the site sends `strict-origin` referrers. Nitro's generic 404 fallback remains a documented exception (`no-cache`/`no-referrer`), not a full no-store guarantee. Cloudflare invocation logging/tracing was deliberately left unchanged; complete deployed privacy/retention review remains a separate gate.

The output allowlist is `channel`, hashed `targetIdentity`, opaque `deploymentId`, `bundleHash`, `migrationHash`, `configHash`, observed `manualSwitch`, `verifiedAt`, `expiresAt`, `evidenceKind`, `mode`, and fixed `passed|pending` gates. No destinations, provider IDs/bodies, credentials, management capabilities, raw command errors or arbitrary external fields are emitted. Errors are fixed categories; direct CLI errors emit one fixed sentence and exit unsuccessfully. Network/command/file operations have a 15-second deadline; each file/body/command output is capped at 16 MiB. Redirects are rejected. The CLI's real adapter labels observations `production-observation`; injected offline tests label results `local-candidate`. Imported code never invokes main. These records are operator-held attestations, not signed certificates or runtime enablement inputs in this plan.

Evidence lasts at most **24 hours**. Readiness requires exactly one record for each first-four mode, identical target/bundle/migration/config identity, the pinned switch-off deployment, matching evidence kind, all corresponding gates and separate human inbox/calendar/link/log attestations. Future verification times beyond five minutes, stale/expired evidence or caller expiry beyond 24 hours fail. Readiness expires no later than the oldest source expiry. Human gates always remain `pending` after a live-canary result; only actual separate inspection and explicit approval may attest them. Tests may use synthetic human attestations but cannot promote them to production evidence.

If authorized switch enablement creates a new deployment UUID without changing reviewed artifacts, `expected-enabled.json` pins its new `deploymentId`/`versionId` and the prior `probeDeploymentId`. Readiness requires that prior deployment still appear in authenticated deployment history with the same exact release annotation; absent history fails. Arbitrary previous-deployment evidence is rejected. Changed bytes/manifest/config/migration require fresh review and probes, not adjusted expiry. Retain only bounded evidence under the operator's review record; do not overwrite historical production records or commit secrets/input addresses to source.

## Human approval and rollback

Recovery is neutral while its channel or supplied database schema is not ready: the HTTP response remains generic 202, but the existing management capability and recovery work are not rotated or replaced. Readiness at request time does not guarantee a later provider receipt; Queue consumption still rechecks current authority and readiness before transport. Brevo callbacks authenticate before reading and enforce the 64 KiB byte ceiling during stream consumption, not only after JSON buffering.

Human review must inspect the live canary sender, Czech HTML/text, token-scoped management link, non-RSVP `event.ics`, and PII-safe Cloudflare logs before enabling delivery. The reviewer must explicitly approve the exact bundle evidence.

If an authorized production check fails, stop sending, disable the manual switch through the existing reviewed Worker configuration workflow, and redeploy the reviewed disabled candidate with the existing `npx wrangler deploy --config .output/server/wrangler.json` operator command. This verifier has no rollback/deploy mode. Provisioning/replacing credentials uses existing Brevo and `npx wrangler secret put <NAME> --config .output/server/wrangler.json` workflows with secret input on stdin, never an argument. Each write/deployment still requires explicit target/candidate authorization. Coordinate API-key/callback-bearer replacement, then obtain fresh preflight/callback evidence; never reuse a suppressed canary as final-delivery proof or unsuppress it to manufacture success. Root replacement has the limitations above; do not invent a former-root recovery path.
