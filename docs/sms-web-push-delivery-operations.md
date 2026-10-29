# SMS and Web Push operations

Use the build/deploy/reset procedure in [production deployment](email-delivery-operations.md). Runtime evidence envelopes and their expiry have been replaced by a release checklist, by explicit operator decision on 2026-10-29. Real verification remains pending until observed; removing a runtime gate is not a passing receipt test.

## Channel checks

- SMS uses `NUXT_BREVO_SMS_SENDER`, not the email display name. Verify sender/account, credits, recipient-country support, compliance, GSM-7/segment cost and controlled handset receipt. Lifecycle SMS are bounded to one segment; the longer Learned Mantis hostname can exceed that bound, and there is no preview-specific truncation/multipart workaround.
- Email requires its own sender/domain/DNS and authenticated callback checks; SMS configuration cannot substitute for them.
- Web Push requires valid, matching VAPID keys and subject. The public key must be supplied at build time and runtime; private material remains a Worker secret. Test and production pairs remain separate.
- Verify HTTPS, root-scope service worker, explicit permission gesture, native subscription and device display. Record only browser families actually tested. Firefox and installed iPhone first receipt are operator-confirmed in Learned Mantis; Safari macOS receipt, production event delivery and full stop/no-further-send acceptance are not inferred from them.
- iPhone/iPad users install to the Home Screen before activating Web Push. The manifest starts new installations at `/`; existing shortcuts may retain an older launch URL. Do not remove a working device subscription merely to refresh its icon.
- First activation and valid Web Push management-link redemption issue a scoped Secure/HttpOnly browser cookie. Repeated activation of an existing subscription does not grant new authority or send another confirmation. Missing browser authority opens the recovery explanation; recovery uses an explicitly requested notification, rotates authority and invalidates older access. Browser mutations require a same-origin Origin header.
- Verify first message, event receipt, click destination, current-device recovery, scoped stop and no subsequent send, including queued/stale work. Provider HTTP acceptance is not proof of on-screen display. The shared stop action controls only the selected channel.
- A 404/410 retires the exact stale Web Push generation; do not indiscriminately resend, clear ledgers or affect sibling channels. Subscription DNS/egress assurance remains a conditional security review concern before adding private-network bindings; no private Workers egress exploit was demonstrated in the release review.

## Provider callbacks and logs

Configure Brevo email at `/api/notifications/brevo-events` and the optional transactional SMS webhook at `/api/notifications/brevo-events-sms`, using `Authorization: Bearer <NUXT_BREVO_CALLBACK_SECRET>`. Both routes authenticate before reading bodies and bound body/event sizes. Never put the secret in a URL.

The SMS route accepts documented `msg_status`, `messageId`, numeric webhook `id` and UTC `ts_event`; correlation uses a stored provider message ID, not a telephone number or arbitrary reference. Unsubscribe/bounce suppression stays channel-local; a subscribe callback cannot reactivate a stopped contact. Lifecycle SMS IDs are not retained by the outbox schema, so the SMS webhook does not prove lifecycle-message receipt. Do not claim account-specific interoperability before a real authenticated callback test.

Do not publish contacts, endpoint URLs, auth keys, provider bodies/IDs, management bearers or secrets in logs, evidence or analytics. Queue messages contain pointers, not delivery authority; current D1 state is rechecked before transport. No blind resend follows a timeout or ambiguous provider result.

## Readiness diagnostics

`GET /api/notifications/readiness` returns only `{email,sms,webPush}` with `Cache-Control: no-store`. Server warnings use `[notifications] Readiness unavailable` and a fixed `reason`. Disabled email/SMS switches are listed separately at info level. No configured value or raw exception is logged.

| Reason | Check |
|---|---|
| `root-key-invalid` | Private 32-byte unpadded base64url notification root |
| `turnstile-secret-invalid` | Missing/malformed private secret; validity still requires a real challenge |
| `turnstile-hostname-invalid` | Private expected hostname; test builds require a `*.workers.dev` host |
| `turnstile-public-site-key-missing-or-invalid` | Public key in build and runtime; runtime changes cannot update prerendered pages |
| `vapid-configuration-missing-invalid-or-mismatched` | Public/private P-256 keys, subject and cryptographically checked pair correspondence |
| `brevo-api-key-missing-or-invalid` | Brevo API key presence/shape; not proof of provider acceptance |
| `email-callback-secret-missing-or-invalid` | Private callback secret presence/shape |
| `email-sender-missing-or-invalid` | Sender name and exact `noreply@jednadvacet.org` address |
| `sms-provider-configuration-invalid` | API key and independent SMS sender |
| `database-binding-missing` | Intended D1 binding |
| `database-schema-unavailable-or-incompatible` | Actual database availability and migrated schema, without raw D1 errors |
| `configuration-or-crypto-unavailable` | Unexpected internal configuration/crypto failure, with raw details suppressed |

Readiness makes no provider call or notification send. It cannot authenticate Turnstile/Brevo credentials, check credits/DNS or prove that the browser received the matching build-time public values. Provider failures after an attempted send have sanitized status/transport diagnostics. Confirm actual device receipt separately.

The existing observation-review/probe CLI can still validate private review artifacts if needed; those artifacts never authorize runtime sending. Do not install obsolete evidence variables or mark unperformed checklist items passed.
