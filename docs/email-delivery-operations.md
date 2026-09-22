# Email delivery operations

Email delivery remains disabled until the verifier records current evidence for the exact production Worker bundle. Do not set `NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED=true` during setup, sandbox, callback, or live-canary work.

## Required production prerequisites

An operator must authenticate the Cloudflare and Brevo CLIs to the intended production accounts. Brevo must verify `Jednadvacet.org <noreply@jednadvacet.org>` and the SPF, DKIM, and DMARC evidence for the `jednadvacet.org` sending domain. Do not use `noreply@b.jednadvacet.org`. Inbound mail remains deferred to a future dedicated receiving subdomain and is not configured or tested in this runbook.

Store `NUXT_BREVO_API_KEY`, `NUXT_BREVO_CALLBACK_SECRET`, and one `NUXT_NOTIFICATION_ROOT_KEY` as Cloudflare Worker secrets. Generate the root as one unpadded base64url 32-byte value and never print it. The Worker internally derives non-extractable, purpose-separated AES-GCM outbox and HMAC suppression/abuse keys with fixed HKDF context labels. Replacing the root is a deliberate deployment and can temporarily make retained encrypted work or hashes unavailable; there is no compatibility or recovery path through a former root. Configure Brevo to call the deployed HTTPS `/api/notifications/brevo-events` endpoint with the callback bearer; never place secrets in a URL, command line, log, or this document.

Before a remote migration, inspect the generated Worker target and production `web` D1 migration state. Apply only the reviewed generated migration to the intended database, deploy the matching bundle, and keep the manual switch false.

## Verification sequence

Build the Worker and run the local checks first:

```bash
npm test
npm run typecheck
npm run build:cloudflare
npm run verify:email-delivery -- preflight --target production
```

The preflight command emits only a target, bundle hash, timestamp, and false manual-switch state. Sandbox, callback, live-canary, and final readiness checks need authenticated Brevo and Cloudflare production access. Run each provider-send mode once only, use distinct controlled canary identities for suppression and final delivery, and retain only opaque delivery IDs, bundle hashes, fixed outcomes, and timestamps.

## Human approval and rollback

Human review must inspect the live canary sender, Czech HTML/text, token-scoped management link, non-RSVP `event.ics`, and PII-safe Cloudflare logs before enabling delivery. The reviewer must explicitly approve the exact bundle evidence.

If a check fails, set the manual switch false, redeploy the unchanged reviewed bundle, and stop. Rotate the Brevo API key or callback bearer in Brevo and Cloudflare together, then repeat the complete preflight and callback sequence. Do not reuse a suppressed canary contact as final-delivery evidence.
