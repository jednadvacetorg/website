# Email delivery operations

Email delivery remains disabled until the verifier records current evidence for the exact production Worker bundle. Do not set `NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED=true` during setup, sandbox, callback, or live-canary work.

## Required production prerequisites

An operator must authenticate the Cloudflare and Brevo CLIs to the intended production accounts. Brevo must verify `Jednadvacet.org <noreply@jednadvacet.org>` and the SPF, DKIM, and DMARC evidence for the `jednadvacet.org` sending domain. Do not use `noreply@b.jednadvacet.org`. Inbound mail remains deferred to a future dedicated receiving subdomain and is not configured or tested in this runbook.

Store `NUXT_BREVO_API_KEY`, `NUXT_BREVO_CALLBACK_SECRET`, `NUXT_NOTIFICATION_ROOT_KEYS`, and `NUXT_NOTIFICATION_CURRENT_KEY_VERSION` as Cloudflare Worker secrets. `NUXT_NOTIFICATION_ROOT_KEYS` is a JSON map of version names to independently generated base64url 32-byte root values; never print the JSON or any root value. The Worker derives non-extractable, purpose-separated AES-GCM outbox and HMAC suppression/abuse keys with fixed HKDF context labels. Configure Brevo to call the deployed HTTPS `/api/notifications/brevo-events` endpoint with the callback bearer; never place secrets in a URL, command line, log, or this document.

## Notification root rotation

Add a new independently generated 32-byte root under a new version name, deploy with both the old and new roots, then switch only `NUXT_NOTIFICATION_CURRENT_KEY_VERSION` and deploy again. That one switch controls every new outbox, destination-hash, and abuse-hash write while retained root versions continue to service their durable references. Before removing an old root, verify D1 has no nonterminal encrypted outbox payload, contact/suppression or retained delivery hash, or unexpired abuse attempt with that version. Remove the old root only after those references clear.

Delete the former separate notification keyring/current-version inputs from Cloudflare; they are not aliases and cannot configure notification cryptography.

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
