# Production notification deployment

## Deployment contract

Production uses Cloudflare Workers Builds connected to `master`. The operator pushes only after reviewing the local merge commit. No repository command resets production data automatically.

Configure Workers Builds once:

- Build command: `npm run build:cloudflare`
- Deploy command: `npm run deploy:cloudflare`
- Production branch: `master`
- Do not set `PREVIEW_DEPLOY` for production.

The deploy command uses supported Wrangler commands: apply pending D1 migrations from `.output/server/wrangler.json`, then deploy the same generated Worker with `--keep-vars`. Migration failure prevents deployment. The build token needs access to the intended D1 as well as Worker deployment; the former deploy-only permission is not sufficient. Keep the production DB binding pinned to `web`, UUID `76d271b2-5335-40ba-81dd-bf7e1ef79522`.

NuxtHub disables build-time migrations for the native D1 driver. `wrangler deploy` alone does **not** initialize the notification schema. The generated config packages the reviewed SQL and uses `_hub_migrations`. Wrangler records migration filenames including `.sql`; use Wrangler consistently for production, rather than alternating it with the NuxtHub CLI, whose ledger naming differs. Never edit a ledger to manufacture migration success.

Supply public `NUXT_PUBLIC_NOTIFICATION_TURNSTILE_SITE_KEY` and `NUXT_PUBLIC_NOTIFICATION_VAPID_PUBLIC_KEY` to the **build** as well as Worker runtime settings. Prerendered pages retain build-time values. Keep private secrets in Worker secrets, never in committed files, arguments, logs or browser artifacts. Preserve separate test/production VAPID pairs and existing root/provider identities.

## One-time removal of the abandoned production experiment

The operator supplied the production table list and five historical migrations on 2026-10-29 and explicitly chose to discard the old experiment, rather than migrate its contacts. Production contains no notification tables according to that inspection. This is an operator-reported observation, not a remote query performed by the coding agent.

Only after the reviewed local merge and deployment setup above, in the **existing production `web` D1 console**, run:

```sql
SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;
```

Stop if the target differs from the inspected database, if any `notification_*` table exists, or if the listed tables now contain data that must be retained. Otherwise this exact one-time reset removes the reported experiment, rebuildable Content tables and their discarded migration history:

```sql
DROP TABLE IF EXISTS user_subscriptions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS _content_blogArticles;
DROP TABLE IF EXISTS _content_blogCategories;
DROP TABLE IF EXISTS _content_communities;
DROP TABLE IF EXISTS _content_pages;
DROP TABLE IF EXISTS _content_people;
DROP TABLE IF EXISTS _content_info;
DROP TABLE IF EXISTS _hub_migrations;
```

This permanently deletes the old contacts and subscriptions. Do not drop `sqlite_sequence` or Cloudflare system tables. Do not delete/recreate the D1 database or change its UUID/binding. Do not rerun this reset after the new notification schema is installed. Resetting the ledger while retaining that schema would make the next initial migration fail.

Then push the approved local master:

```bash
git push origin master
```

The deployment applies the fresh initial notification migration. Nuxt Content restores its collections from build dumps on subsequent content queries. Existing Worker isolates may cache collection integrity checks, so expect a temporary content outage between reset and the new deployment. Open real content pages after deployment to verify recovery; a successful upload is not proof of working Content or delivery.

## Configuration and first enablement

Runtime readiness now depends on concrete configuration and actual D1 schema, not operator evidence JSON, artifact hashes, prior receipt assertions or a 24-hour timer. The former `NUXT_NOTIFICATION_EXPECTED_*` / `NUXT_NOTIFICATION_*_EVIDENCE` settings and Web Push rollout switches are no longer read. Communities/titles are compiled from content; the consent revision belongs to the server.

- All channels need the private `NUXT_NOTIFICATION_ROOT_KEY` (32 random bytes, unpadded base64url), Turnstile secret and expected hostname. Turnstile validity must be checked with a real challenge; presence is not provider authentication.
- Email needs Brevo API/callback secrets, sender name, `NUXT_BREVO_SENDER_EMAIL=noreply@jednadvacet.org` and all four email switches enabled: `NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED`, `NUXT_NOTIFICATION_EMAIL_SMS_ENABLED`, `NUXT_NOTIFICATION_EMAIL_SMS_FIRST_MESSAGE_READY`, `NUXT_NOTIFICATION_EMAIL_SMS_EVENT_DELIVERY_READY`.
- SMS needs Brevo API key, its own `NUXT_BREVO_SMS_SENDER` and the three `NUXT_NOTIFICATION_SMS_ENABLED`, `NUXT_NOTIFICATION_SMS_FIRST_MESSAGE_READY`, `NUXT_NOTIFICATION_SMS_EVENT_DELIVERY_READY` switches enabled.
- Web Push needs a matching public/private P-256 VAPID pair and valid subject. There is no additional rollout switch. Do not rotate established VAPID/root identities casually.

Verify Brevo domain/sender, SPF/DKIM/DMARC, account/credits/countries and message cost independently. Configure the email webhook `/api/notifications/brevo-events` with the callback bearer header. The separate optional SMS webhook is `/api/notifications/brevo-events-sms`; never put credentials in callback URLs. Test receipts/stop results are recorded as observations, not runtime settings.

## Post-deployment checklist

1. Confirm the deployment is the intended master commit, with the production D1, Queue/DLQ, KV, R2 and cron bindings. No preview bindings, keys or fixtures may enter production.
2. Open homepage, calendar, community and article pages and verify content/SSR/client navigation. Confirm the migration log and actual notification schema.
3. Request `/api/notifications/readiness`; it returns only three booleans with `no-store`. Server logs give fixed diagnostic reasons; see [channel operations](sms-web-push-delivery-operations.md).
4. With explicit controlled recipients, verify activation, visible first message, management/click, recovery, a real event, stop and no subsequent send. Record actual browser/device versions. Initial receipt alone does not prove event delivery.
5. Verify email calendar attachment and authenticated, correlated, idempotent callbacks. Inspect Queue/DLQ/retry health and PII-safe logs. Do not replay ambiguous sends, clear delivery ledgers or remove suppression to manufacture success.

The user accepted temporarily broken notification functionality and requested no separate rollback implementation. This does not waive migration, consent, credential or privacy safety. No production send, reset, push or deployment is authorized merely by running local tests.

The existing `verify:email-delivery` CLI remains an optional offline/explicit-probe review tool. Its private observation files are not Worker configuration or a first-enable prerequisite. Live probe modes require separate recipient/send authorization; they are not executed by `deploy:cloudflare`.
