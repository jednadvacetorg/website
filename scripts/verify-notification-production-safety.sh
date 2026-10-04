#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${1:-}" || "${1:-}" == '--config-isolation' ]]; then
  evidence_dir="$(mktemp -d /tmp/notification-config-isolation-XXXXXXXX)"
  mkdir "$evidence_dir/home"
  worker_pid=''
  browser_session="notification-isolation-${evidence_dir##*/}"
  browser_started=false
  cleanup_isolation() {
    local failed=0
    if [[ "$browser_started" == true ]]; then agent-browser --session "$browser_session" close || failed=1; fi
    if [[ -n "$worker_pid" ]]; then
      kill -- "-$worker_pid" 2>/dev/null || true
      wait "$worker_pid" 2>/dev/null || true
      if ps -eo pgid=,stat= | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.exit(s.split("\n").some(l=>{const [p,state]=l.trim().split(/\s+/);return p===process.argv[1]&&!state?.startsWith("Z")})?0:1)' "$worker_pid"; then
        echo 'Owned Worker descendants remain.' >&2; failed=1
      fi
    fi
    echo "Configuration isolation evidence: $evidence_dir"
    return "$failed"
  }
  trap cleanup_isolation EXIT
  # Empty dotenv and an allowlisted environment: inherited secrets/configuration
  # and Wrangler auth profiles cannot enter either build or local execution.
  clean_env=(env -i "PATH=$PATH" "HOME=$evidence_dir/home" "TMPDIR=/tmp" NODE_ENV=production NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 NO_PROXY=localhost,127.0.0.1 WRANGLER_SEND_METRICS=false)
  while IFS= read -r variable; do clean_env+=("$variable"); done < <(node --input-type=module <<'JS'
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto'
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const key = pair.privateKey.export({ format: 'jwk' })
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(key.x, 'base64url'), Buffer.from(key.y, 'base64url')]).toString('base64url')
const vars = {
  NUXT_NOTIFICATION_ROOT_KEY: randomBytes(32).toString('base64url'),
  NUXT_NOTIFICATION_VAPID_PRIVATE_KEY: key.d,
  NUXT_PUBLIC_NOTIFICATION_VAPID_PUBLIC_KEY: publicKey,
  NUXT_NOTIFICATION_VAPID_SUBJECT: 'mailto:synthetic@example.test',
  NUXT_BREVO_API_KEY: 'synthetic-api-' + randomBytes(24).toString('hex'),
  NUXT_BREVO_CALLBACK_SECRET: 'synthetic-callback-' + randomBytes(24).toString('hex'),
  NUXT_NOTIFICATION_EMAIL_EVIDENCE: 'synthetic-email-' + randomBytes(24).toString('hex'),
  NUXT_NOTIFICATION_SMS_EVIDENCE: 'synthetic-sms-' + randomBytes(24).toString('hex'),
  NUXT_NOTIFICATION_WEB_PUSH_EVIDENCE: 'synthetic-push-' + randomBytes(24).toString('hex'),
  NUXT_NOTIFICATION_TURNSTILE_SECRET: 'synthetic-turnstile-' + randomBytes(24).toString('hex'),
  NUXT_NOTIFICATION_TURNSTILE_EXPECTED_HOSTNAME: 'example.test',
  NUXT_NOTIFICATION_COMMUNITY_SLUGS: 'brno', NUXT_NOTIFICATION_CONSENT_VERSION: '2026-09',
  NUXT_NOTIFICATION_UI_VERIFICATION_FIXTURE: 'true',
  NUXT_PUBLIC_NOTIFICATION_TURNSTILE_SITE_KEY: 'notification-ui-verification-site-key',
  NUXT_NOTIFICATION_EMAIL_SMS_ENABLED: 'true', NUXT_NOTIFICATION_EMAIL_SMS_FIRST_MESSAGE_READY: 'true', NUXT_NOTIFICATION_EMAIL_SMS_EVENT_DELIVERY_READY: 'true', NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED: 'true',
  NUXT_NOTIFICATION_SMS_ENABLED: 'true', NUXT_NOTIFICATION_SMS_FIRST_MESSAGE_READY: 'true', NUXT_NOTIFICATION_SMS_EVENT_DELIVERY_READY: 'true',
  NUXT_NOTIFICATION_WEB_PUSH_ENABLED: 'true', NUXT_NOTIFICATION_WEB_PUSH_FIRST_MESSAGE_READY: 'true', NUXT_NOTIFICATION_WEB_PUSH_EVENT_DELIVERY_READY: 'true',
  NUXT_BREVO_SENDER_NAME: 'Jednadvacet', NUXT_BREVO_SENDER_EMAIL: 'noreply@jednadvacet.org',
  // Old asserted gates are also true: their defaults must not explain rejection.
  NUXT_BREVO_SENDER_VERIFIED: 'true', NUXT_BREVO_SPF_VERIFIED: 'true', NUXT_BREVO_DKIM_VERIFIED: 'true', NUXT_BREVO_DMARC_VERIFIED: 'true', NUXT_BREVO_CALLBACK_VERIFIED: 'true',
  NUXT_BREVO_SANDBOX_VERIFIED: 'true', NUXT_BREVO_LIVE_CANARY_VERIFIED: 'true', NUXT_NOTIFICATION_PRODUCTION_BINDINGS_VERIFIED: 'true', NUXT_NOTIFICATION_MIGRATION_VERIFIED: 'true',
  NOTIFICATION_SYNTHETIC_PUSH_CONTACT: JSON.stringify({ endpoint: 'https://push.example.test/local-proof', expirationTime: null, keys: { p256dh: publicKey, auth: randomBytes(16).toString('base64url') } }),
}
// Structurally complete local attestations must be rejected because of kind,
// rather than merely because invalid JSON or missing prerequisite fields fail.
const identities = { targetIdentity: '1'.repeat(64), bundleHash: '2'.repeat(64), migrationHash: '3'.repeat(64), configHash: '4'.repeat(64), deploymentId: '11111111-1111-1111-1111-111111111111' }
for (const [field, value] of Object.entries(identities)) vars[`NUXT_NOTIFICATION_EXPECTED_${field.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`] = value
for (const [channel, field, material, gates] of [
  ['email', 'EMAIL', [vars.NUXT_NOTIFICATION_ROOT_KEY, vars.NUXT_BREVO_API_KEY, vars.NUXT_BREVO_CALLBACK_SECRET, vars.NUXT_BREVO_SENDER_NAME, vars.NUXT_BREVO_SENDER_EMAIL], ['sender', 'dns', 'callbackMetadata', 'https', 'sandbox', 'callback', 'humanInbox', 'humanCalendar', 'humanLink', 'humanLogs']],
  ['sms', 'SMS', [vars.NUXT_NOTIFICATION_ROOT_KEY, vars.NUXT_BREVO_API_KEY, vars.NUXT_BREVO_SENDER_NAME], ['sender', 'account', 'credits', 'country', 'compliance', 'sharedManagementStop']],
  ['web-push', 'WEB_PUSH', [vars.NUXT_NOTIFICATION_ROOT_KEY, key.d, publicKey, vars.NUXT_NOTIFICATION_VAPID_SUBJECT], ['vapid', 'protocol', 'interoperability', 'browser:chromium', 'sharedManagementStop']],
]) vars[`NUXT_NOTIFICATION_${field}_EVIDENCE`] = JSON.stringify({ ...identities, channel, evidenceKind: 'local-candidate', mode: 'readiness', manualSwitch: true, verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), keyHash: createHash('sha256').update(JSON.stringify(material)).digest('hex'), interoperability: ['chromium'], gates: Object.fromEntries(['artifacts', 'deployment', 'bindings', 'migration', 'firstMessage', 'eventDelivery', 'liveCanary', ...gates].map(gate => [gate, 'passed'])) })
for (const [name, value] of Object.entries(vars)) console.log(`${name}=${value}`)
JS
  )
  for profile in production preview; do
    mkdir "$evidence_dir/$profile"
    preview_env=()
    if [[ "$profile" == preview ]]; then preview_env=(PREVIEW_DEPLOY=1); fi
    # The Cloudflare package command invokes npm run build; preserve its separator.
    if ! "${clean_env[@]}" "${preview_env[@]}" "NUXT_BUILD_DIR=$evidence_dir/$profile/nuxt" "CONTENT_LOCAL_DATABASE_PATH=$evidence_dir/$profile/content.sqlite" npm run build:cloudflare -- -- --dotenv /dev/null >"$evidence_dir/$profile/build.log" 2>&1; then
      echo "$profile build failed; see retained build.log." >&2; exit 1
    fi
    # CLI exit 0 is not a clean build when prerender/runtime reports errors.
    if node --input-type=module - "$evidence_dir/$profile/build.log" <<'JS'
import { readFileSync } from 'node:fs'
process.exit(/(?:\bERROR\b|\[500\]|Prerender Error)/.test(readFileSync(process.argv[2], 'utf8')) ? 0 : 1)
JS
    then echo "$profile build contains errors; retaining the actual artifact for diagnosis, not a passing build." >&2; fi
    cp -a .output "$evidence_dir/$profile/output"
    [[ -f "$evidence_dir/$profile/output/server/wrangler.json" ]] || { echo 'Actual generated Wrangler JSON missing.' >&2; exit 1; }
  done
  "${clean_env[@]}" NOTIFICATION_CONFIG_ISOLATION=true "NOTIFICATION_PRODUCTION_CONFIG=$evidence_dir/production/output/server/wrangler.json" "NOTIFICATION_PREVIEW_CONFIG=$evidence_dir/preview/output/server/wrangler.json" node --experimental-strip-types --test --test-name-pattern='generated notification configuration' tests/emailDeliveryOperations.test.ts >"$evidence_dir/generated-config-tests.log" 2>&1
  for profile in production preview; do
    port=8791
    base_url="http://127.0.0.1:$port"
    if curl --silent --max-time 1 "$base_url" >/dev/null 2>&1; then echo 'Owned port is already occupied.' >&2; exit 1; fi
    for migration in "$evidence_dir/$profile/output/server/db/migrations/sqlite/"*.sql; do
      "${clean_env[@]}" npm exec --offline -- wrangler d1 execute DB --local --config "$evidence_dir/$profile/output/server/wrangler.json" --file "$migration" --persist-to "$evidence_dir/$profile/storage" >"$evidence_dir/$profile/$(basename "$migration").apply.log" 2>&1
    done
    # Installed Wrangler API supports an outboundService boundary; CLI --local
    # alone does not deny Worker fetches. No substitute Worker or remote binding.
    setsid "${clean_env[@]}" "NOTIFICATION_WORKER_CONFIG=$evidence_dir/$profile/output/server/wrangler.json" "NOTIFICATION_WORKER_STORAGE=$evidence_dir/$profile/storage" node --input-type=module >"$evidence_dir/$profile/worker.log" 2>&1 <<'JS' &
import { unstable_startWorker } from 'wrangler'
let worker
const stop = async () => { await worker?.dispose(); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
try {
  worker = await unstable_startWorker({ config: process.env.NOTIFICATION_WORKER_CONFIG, dev: { remote: false, watch: false, persist: process.env.NOTIFICATION_WORKER_STORAGE, server: { hostname: '127.0.0.1', port: 8791 }, outboundService() { throw new Error('External network denied by local verification') } } })
  await worker.ready
  await new Promise(() => {})
} catch (error) { console.error(error); await worker?.dispose(); process.exit(1) }
JS
    worker_pid=$!
    ready=false
    for _ in {1..60}; do
      if curl --silent --fail --max-time 1 "$base_url/api/notifications/readiness" >/dev/null; then ready=true; break; fi
      if ! kill -0 "$worker_pid" 2>/dev/null; then break; fi
      sleep 1
    done
    [[ "$ready" == true ]] || { echo "$profile built Worker startup unsupported/failed; see worker.log. Stop for a tooling decision." >&2; exit 1; }
    "${clean_env[@]}" "NOTIFICATION_BASE_URL=$base_url" node --input-type=module <<'JS'
import assert from 'node:assert/strict'
const base = process.env.NOTIFICATION_BASE_URL
const privateValues = Object.entries(process.env).filter(([name]) => name.startsWith('NUXT_') && !name.startsWith('NUXT_PUBLIC_')).map(([, value]) => value).filter(value => value.length > 24)
const safe = text => { for (const value of privateValues) assert.ok(!text.includes(value), 'private sentinel leaked') }
const readiness = await fetch(`${base}/api/notifications/readiness`)
assert.equal(readiness.headers.get('cache-control'), 'no-store')
assert.deepEqual(await readiness.json(), { email: false, sms: false, webPush: false })
let requester = 1
const headers = () => ({ 'content-type': 'application/json', 'CF-Connecting-IP': `192.0.2.${requester++}` })
for (const channel of ['email', 'sms', 'web-push']) {
  const body = { channel, contact: channel === 'email' ? 'guide@example.test' : channel === 'sms' ? '+420777123456' : JSON.parse(process.env.NOTIFICATION_SYNTHETIC_PUSH_CONTACT), communitySlugs: ['brno'], frequencies: ['created'], consentAt: '2026-10-04', consentVersion: '2026-09', turnstileToken: 'notification-ui-verification-token' }
  const activation = await fetch(`${base}/api/notifications/activate`, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  assert.equal(activation.status, 503, 'valid native/contact requests must fail the readiness gate')
  safe(await activation.text())
  const results = []
  for (const token of [undefined, 'notification-ui-verification-token']) {
    const recovery = await fetch(`${base}/api/notifications/manage-request`, { method: 'POST', headers: headers(), body: JSON.stringify({ channel, contact: body.contact, turnstileToken: token }) })
    assert.equal(recovery.status, 202)
    const text = await recovery.text(); safe(text); results.push(text)
  }
  assert.equal(results[0], results[1])
}
for (const token of ['notification-ui-management-active', 'notification-ui-management-pending-reactivation', 'notification-ui-management-stopped', 'notification-ui-management-old', 'notification-ui-management-unavailable', 'malformed', 'A'.repeat(43)]) {
  const response = await fetch(`${base}/api/notifications/manage/${token}`)
  assert.deepEqual(await response.json(), { state: 'unavailable' })
  const stopped = await fetch(`${base}/api/notifications/manage/${token}`, { method: 'POST', headers: headers(), body: JSON.stringify({ action: 'stop-channel' }) })
  assert.deepEqual(await stopped.json(), { state: 'unavailable' })
}
const html = await (await fetch(`${base}/kalendar`)).text(); safe(html)
assert.ok(html.includes(process.env.NUXT_PUBLIC_NOTIFICATION_VAPID_PUBLIC_KEY), 'public key positive control')
JS
    browser_started=true
    agent-browser --session "$browser_session" --allowed-domains 127.0.0.1 open "$base_url/kalendar"
    agent-browser --session "$browser_session" wait --fn '!!document.getElementById("__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.$config.public'
    browser_result="$(agent-browser --session "$browser_session" eval 'JSON.stringify({public:document.getElementById("__nuxt").__vue_app__.config.globalProperties.$nuxt.$config.public,html:document.documentElement.outerHTML})' --json)"
    "${clean_env[@]}" "NOTIFICATION_BROWSER_RESULT=$browser_result" node --input-type=module <<'JS'
import assert from 'node:assert/strict'
const result = JSON.parse(process.env.NOTIFICATION_BROWSER_RESULT)
assert.equal(result.success, true)
const data = JSON.parse(result.data.result)
assert.equal(data.public.notificationVapidPublicKey, process.env.NUXT_PUBLIC_NOTIFICATION_VAPID_PUBLIC_KEY)
for (const [name, value] of Object.entries(process.env)) if (name.startsWith('NUXT_') && !name.startsWith('NUXT_PUBLIC_') && value.length > 24) assert.ok(!JSON.stringify(data).includes(value), name)
for (const key of ['notificationRootKey', 'notificationVapidPrivateKey', 'brevoApiKey', 'brevoCallbackSecret', 'notificationEmailEvidence', 'notificationSmsEvidence', 'notificationWebPushEvidence']) {
  assert.equal(key in data.public, false, key)
  assert.ok(!data.html.includes(`"${key}"`), 'private property serialized in SSR/hydrated HTML')
}
JS
    mkdir -p /tmp/screenshots
    agent-browser --session "$browser_session" screenshot "/tmp/screenshots/notification-isolation-$profile-${evidence_dir##*/}-desktop.png"
    agent-browser --session "$browser_session" set viewport 320 900
    agent-browser --session "$browser_session" screenshot "/tmp/screenshots/notification-isolation-$profile-${evidence_dir##*/}-mobile.png"
    agent-browser --session "$browser_session" close
    browser_started=false
    kill -- "-$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
    if ps -eo pgid=,stat= | node --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;process.exit(s.split("\n").some(l=>{const [p,state]=l.trim().split(/\s+/);return p===process.argv[1]&&!state?.startsWith("Z")})?0:1)' "$worker_pid"; then
      echo 'Owned Worker descendants remain after profile stop.' >&2; exit 1
    fi
    worker_pid=''
    echo "$profile actual generated configuration, applied local schema, three-channel API and hydrated-browser isolation controls PASS (local only)."
  done
  # Error-bearing builds stay failed even when diagnostics later gates succeed.
  for profile in production preview; do
    node --input-type=module - "$evidence_dir/$profile/build.log" "$evidence_dir/$profile/worker.log" <<'JS'
import { readFileSync } from 'node:fs'
if (/(?:\bERROR\b|\[500\]|Prerender Error)/.test(readFileSync(process.argv[2], 'utf8'))) throw new Error('Build errors retained; configuration isolation is not a clean gate')
if (/(?:\bERROR\b|\[500\]|Uncaught|unhandled rejection)/i.test(readFileSync(process.argv[3], 'utf8'))) throw new Error('Local Worker runtime errors retained; safety gate failed')
JS
  done
  echo 'Both generated profiles and actual built Workers passed configuration isolation.'
  exit 0
fi

echo 'Usage: verify-notification-production-safety.sh [--config-isolation]' >&2
exit 1
