#!/usr/bin/env bash
set -euo pipefail

port=8791
base_url="http://127.0.0.1:${port}"
worker_pid=""
log_file="/tmp/notification-production-safety-${port}.log"

cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill -- "-$worker_pid" >/dev/null 2>&1 || true
    wait "$worker_pid" 2>/dev/null || true
    for _ in {1..10}; do
      if ! curl --silent --max-time 1 "$base_url/api/notifications/readiness" >/dev/null 2>&1; then return; fi
      sleep 1
    done
    echo "Wrangler process group still owns port ${port}." >&2
    return 1
  fi
}
trap cleanup EXIT

# Deliberately supply the development-only opt-in to the production build.
NODE_ENV=production NUXT_NOTIFICATION_UI_VERIFICATION_FIXTURE=true \
NUXT_PUBLIC_NOTIFICATION_TURNSTILE_SITE_KEY=notification-ui-verification-site-key \
npm run build:cloudflare

config_file=""
for candidate in .output/server/wrangler.json .output/wrangler.json .output/server/wrangler.toml; do
  if [[ -f "$candidate" ]]; then
    config_file="$candidate"
    break
  fi
done
if [[ -z "$config_file" ]]; then
  echo 'Generated Cloudflare Worker configuration was not found.' >&2
  exit 1
fi

setsid npx wrangler dev --config "$config_file" --port "$port" --local >"$log_file" 2>&1 &
worker_pid=$!
for _ in {1..60}; do
  if curl --silent --fail --max-time 1 "$base_url/api/notifications/readiness" >/dev/null; then break; fi
  sleep 1
done

readiness="$(curl --silent --fail --max-time 2 "$base_url/api/notifications/readiness")"
[[ "$readiness" == '{"email":false,"sms":false,"webPush":false}' ]] || { echo 'Production readiness was not fail-closed.' >&2; exit 1; }

activation_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --request POST "$base_url/api/notifications/activate" --header 'content-type: application/json' --data '{"channel":"email","contact":"guide@example.test","communitySlugs":["brno"],"frequencies":["created"],"consentAt":"2026-09-17T00:00:00.000Z","consentVersion":"2026-09","turnstileToken":"notification-ui-verification-token"}')"
[[ "$activation_status" != '200' && "$activation_status" != '202' ]] || { echo 'Production activation accepted the fixture.' >&2; exit 1; }

recovery_without_token="$(curl --silent --show-error --max-time 2 --request POST "$base_url/api/notifications/manage-request" --header 'content-type: application/json' --data '{"channel":"email","contact":"guide@example.test"}')"
recovery_with_token="$(curl --silent --show-error --max-time 2 --request POST "$base_url/api/notifications/manage-request" --header 'content-type: application/json' --data '{"channel":"email","contact":"guide@example.test","turnstileToken":"notification-ui-verification-token"}')"
[[ "$recovery_without_token" == "$recovery_with_token" ]] || { echo 'Production recovery response changed for the fixture token.' >&2; exit 1; }

for management_token in \
  notification-ui-management-active \
  notification-ui-management-pending-reactivation \
  notification-ui-management-stopped \
  notification-ui-management-old \
  notification-ui-management-unavailable; do
  management_result="$(curl --silent --fail --max-time 2 "$base_url/api/notifications/manage/$management_token")"
  [[ "$management_result" == '{"state":"unavailable"}' ]] || { echo 'Production management fixture token was not neutral.' >&2; exit 1; }
done

echo 'Production notification fixture isolation verification passed.'
