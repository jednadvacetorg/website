#!/usr/bin/env bash
set -euo pipefail

mode="${1:---all}"
if [[ "$mode" != "--all" && "$mode" != "--guide" && "$mode" != "--management" && "$mode" != "--manual-management" && "$mode" != "--test-manual-management" ]]; then
  echo "Usage: $0 [--guide|--management|--manual-management|--test-manual-management]" >&2
  exit 64
fi

guide_port=2104
ready_port=2105
manual_port=2106
server_pids=()
browser_session=""
if [[ "$mode" != "--manual-management" && "$mode" != "--test-manual-management" ]]; then
  browser_session="$(agent-browser session id --scope worktree --prefix notification-lifecycle)"
fi

stop_servers() {
  for server_pid in "${server_pids[@]}"; do
    kill -- "-$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
  done
  server_pids=()
}

cleanup() {
  if [[ -n "$browser_session" ]]; then
    agent-browser --session "$browser_session" close >/dev/null 2>&1 || true
  fi
  stop_servers
}

start_server() {
  local port="$1"
  local fixture="$2"
  base_url="http://localhost:${port}"
  local log_file="/tmp/notification-lifecycle-ui-${port}.log"

  if [[ "$fixture" == true ]]; then
    setsid env NUXT_NOTIFICATION_UI_VERIFICATION_FIXTURE=true NUXT_PUBLIC_NOTIFICATION_TURNSTILE_SITE_KEY=notification-ui-verification-site-key npm run dev -- --port "$port" >"$log_file" 2>&1 &
  else
    setsid npm run dev -- --port "$port" >"$log_file" 2>&1 &
  fi
  server_pids+=("$!")
  for _ in {1..60}; do
    if curl --silent --fail --max-time 1 "$base_url/kalendar" >/dev/null; then return; fi
    sleep 1
  done
  printf 'Notification lifecycle UI server failed to start:\n' >&2
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$log_file"
  exit 1
}

trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

if [[ "$mode" == "--manual-management" ]]; then
  start_server "$manual_port" true
  echo "Management fixture is ready. Press Ctrl+C to stop it."
  echo "active: $base_url/notifications/manage/notification-ui-management-active"
  echo "pending-reactivation: $base_url/notifications/manage/notification-ui-management-pending-reactivation"
  echo "stopped: $base_url/notifications/manage/notification-ui-management-stopped"
  echo "malformed: $base_url/notifications/manage/not-a-valid-token"
  echo "old: $base_url/notifications/manage/notification-ui-management-old"
  echo "unavailable: $base_url/notifications/manage/notification-ui-management-unavailable"
  while :; do sleep 1; done
fi

if [[ "$mode" == "--test-manual-management" ]]; then
  manual_log="/tmp/notification-manual-management-$$.log"
  setsid env --default-signal=INT bash "$0" --manual-management >"$manual_log" 2>&1 &
  manual_pid=$!
  trap 'kill -INT "-$manual_pid" >/dev/null 2>&1 || true; wait "$manual_pid" 2>/dev/null || true; cleanup' EXIT
  for _ in {1..60}; do
    if grep -q '^unavailable: http://localhost:2106/' "$manual_log"; then break; fi
    sleep 1
  done
  for state in active pending-reactivation stopped malformed old unavailable; do
    grep -q "^${state}: http://localhost:2106/notifications/manage/" "$manual_log"
  done
  for token in notification-ui-management-active notification-ui-management-pending-reactivation notification-ui-management-stopped not-a-valid-token notification-ui-management-old notification-ui-management-unavailable; do
    curl --silent --fail --max-time 5 "http://localhost:${manual_port}/notifications/manage/${token}" >/dev/null
  done
  kill -INT "-$manual_pid"
  wait "$manual_pid"
  trap cleanup EXIT
  ! curl --silent --fail --max-time 2 "http://localhost:${manual_port}/notifications/manage/notification-ui-management-active" >/dev/null
  echo "Manual management fixture lifecycle verification passed."
  exit 0
fi
trap cleanup EXIT

if [[ "$mode" == "--all" || "$mode" == "--guide" ]]; then
  start_server "$guide_port" false
  agent-browser --session "$browser_session" open "$base_url/kalendar" >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --text "Kalendářový feed" >/dev/null
  # The deployed fake door owns convenience values only in browser-local storage.
  agent-browser --session "$browser_session" eval 'localStorage.setItem("subscription-guide-telephone", "+15551234567"); localStorage.setItem("subscription-guide-email", "fake@example.test")' >/dev/null
  agent-browser --session "$browser_session" reload >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --text "Kalendářový feed" >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("input[name=telephone]")?.value === "+15551234567" && document.querySelector("input[name=email]")?.value === "fake@example.test"' | grep -q true
  agent-browser --session "$browser_session" network requests --clear >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Mám zájem o SMS" >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Mám zájem o e-mail" >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Mám zájem o oznámení ve webu" >/dev/null
  ! agent-browser --session "$browser_session" network requests --filter '/api/notifications/' | grep -q '/api/notifications/'
  agent-browser --session "$browser_session" find label "Telefonní číslo" fill '' >/dev/null
  agent-browser --session "$browser_session" find label "E-mail" fill '' >/dev/null
  agent-browser --session "$browser_session" eval '!localStorage.getItem("subscription-guide-telephone") && !localStorage.getItem("subscription-guide-email")' | grep -q true
  agent-browser --session "$browser_session" reload >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --text "Kalendářový feed" >/dev/null
  agent-browser --session "$browser_session" screenshot /tmp/screenshots/notification-guide-desktop.png >/dev/null
  agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
  agent-browser --session "$browser_session" screenshot /tmp/screenshots/notification-guide-mobile.png >/dev/null
  agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true

  # The private development fixture makes email/SMS ready while keeping push false.
  stop_servers
  start_server "$ready_port" true
  agent-browser --session "$browser_session" open "$base_url/kalendar" >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --text "Kalendářový feed" >/dev/null
  agent-browser --session "$browser_session" eval 'localStorage.setItem("subscription-guide-telephone", "+15551234567"); localStorage.setItem("subscription-guide-email", "fake@example.test")' >/dev/null
  agent-browser --session "$browser_session" reload >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("input[name=telephone]")?.value === "" && document.querySelector("input[name=email]")?.value === ""' | grep -q true
  agent-browser --session "$browser_session" find role button click --name "Spravovat e-mailové notifikace" >/dev/null
  agent-browser --session "$browser_session" fill 'input[name="recovery-contact"]' 'recovery@example.test' >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Poslat odkaz pro správu" >/dev/null
  agent-browser --session "$browser_session" wait --text "Ověřovací kód" >/dev/null
  agent-browser --session "$browser_session" find label "Ověřovací kód" fill 'notification-ui-verification-token' >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Poslat odkaz pro správu" >/dev/null
  agent-browser --session "$browser_session" wait --text "Pokud pro tento kontakt existuje" >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Zrušit" >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("button")).some(button => button.textContent?.trim() === "Mám zájem o oznámení ve webu" && !button.disabled)' | grep -q true
fi

if [[ "$mode" == "--all" || "$mode" == "--management" ]]; then
  stop_servers
  start_server "$guide_port" true

  capture_management_state() {
    local token="$1"
    local name="$2"
    local expected_text="$3"
    agent-browser --session "$browser_session" set viewport 1440 900 >/dev/null
    agent-browser --session "$browser_session" open "$base_url/notifications/manage/$token" >/dev/null
    agent-browser --session "$browser_session" wait --load networkidle >/dev/null
    agent-browser --session "$browser_session" wait --text "$expected_text" >/dev/null
    agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
    agent-browser --session "$browser_session" screenshot "/tmp/screenshots/notification-management-${name}-desktop.png" >/dev/null
    agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
    agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
    agent-browser --session "$browser_session" screenshot "/tmp/screenshots/notification-management-${name}-mobile.png" >/dev/null
  }

  capture_management_state 'notification-ui-management-active' active 'Správa upozornění'
  agent-browser --session "$browser_session" eval '!document.body.innerText.includes("notification-ui") && !document.body.innerText.includes("user@example.test") && document.body.innerText.includes("u•••@example.test")' | grep -q true
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("section[aria-label=\"Nastavení komunit\"] button")).filter(button => button.getAttribute("aria-expanded") === "false").length === 6' | grep -q true
  agent-browser --session "$browser_session" set viewport 1440 900 >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("section[aria-label=\"Nastavení komunit\"] [data-slot=root] button")?.focus()' >/dev/null
  agent-browser --session "$browser_session" press Enter >/dev/null
  agent-browser --session "$browser_session" wait --text 'Uložit změny' >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[data-community-slug=\"brno\"] input")).find(input => input.closest("label")?.textContent?.includes("týden předem"))?.click()' >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[data-community-slug=\"brno\"] button")).find(button => button.textContent?.trim() === "Uložit změny")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --text 'Nastavení jsme uložili.' >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("section[aria-label=\"Nastavení komunit\"] [data-slot=root]"))[0]?.querySelector("button")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --fn 'Array.from(document.querySelectorAll("section[aria-label=\"Nastavení komunit\"] [data-slot=root]"))[0]?.querySelector("button")?.getAttribute("aria-expanded") === "false"' >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("section[aria-label=\"Nastavení komunit\"] [data-community-slug=\"praha\"] button")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --text 'Odebrat komunitu' >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[data-community-slug=\"praha\"] button")).find(button => button.textContent?.trim() === "Odebrat komunitu")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --fn '!document.body.innerText.includes("Praha") && document.body.innerText.includes("Brno s mimořádně dlouhým názvem")' >/dev/null
  agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
  agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth && Array.from(document.querySelectorAll("section[aria-label=\"Nastavení komunit\"] button[aria-expanded]")).every(button => button.getBoundingClientRect().height >= 44)' | grep -q true

  agent-browser --session "$browser_session" set viewport 1440 900 >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("[data-testid=\"notification-stop-trigger\"]")?.focus(); document.querySelector("[data-testid=\"notification-stop-trigger\"]")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --text "Opravdu chceš ukončit odběr" >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("[role=dialog]")?.contains(document.activeElement)' | grep -q true
  agent-browser --session "$browser_session" screenshot /tmp/screenshots/notification-management-stop-confirmation-desktop.png >/dev/null
  agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
  agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
  agent-browser --session "$browser_session" screenshot /tmp/screenshots/notification-management-stop-confirmation-mobile.png >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[role=dialog] button")).find(button => button.textContent?.trim() === "Neukončovat")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --fn '!document.querySelector("[role=dialog]") && document.activeElement?.textContent?.includes("Ukončit odběr")' >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("[data-testid=\"notification-stop-trigger\"]")?.focus(); document.querySelector("[data-testid=\"notification-stop-trigger\"]")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --text "Opravdu chceš ukončit odběr" >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[role=dialog] button")).find(button => button.textContent?.trim() === "Ukončit odběr")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --text "Odběr je ukončený" >/dev/null
  agent-browser --session "$browser_session" screenshot /tmp/screenshots/notification-management-stopped-desktop.png >/dev/null
  agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
  agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
  agent-browser --session "$browser_session" screenshot /tmp/screenshots/notification-management-stopped-mobile.png >/dev/null

  capture_management_state 'notification-ui-management-pending-reactivation' pending-reactivation 'Znovu aktivovat odběr'
  agent-browser --session "$browser_session" eval 'document.body.innerText.includes("+1555 ••• ••••") && !document.body.innerText.includes("notification-ui")' | grep -q true
  capture_management_state 'not-a-valid-token' malformed 'Odkaz pro správu není dostupný'
  capture_management_state 'notification-ui-management-old' old 'Odkaz pro správu není dostupný'
  capture_management_state 'notification-ui-management-unavailable' unavailable 'Odkaz pro správu není dostupný'
  agent-browser --session "$browser_session" eval 'document.body.innerText.includes("Zkontroluj celý odkaz nebo si nech poslat nový odkaz pro správu.")' | grep -q true
  agent-browser --session "$browser_session" eval '!document.body.innerText.includes("Oznámení ve webu") && document.body.innerText.includes("Nechat si poslat nový odkaz")' | grep -q true
  agent-browser --session "$browser_session" fill 'input[name="recovery-contact"]' 'recovery@example.test' >/dev/null
  agent-browser --session "$browser_session" find role button click --name 'Poslat odkaz pro správu' >/dev/null
  agent-browser --session "$browser_session" wait --text 'Ověřovací kód' >/dev/null
  agent-browser --session "$browser_session" fill 'input[name="turnstile-token"]' 'notification-ui-verification-token' >/dev/null
  agent-browser --session "$browser_session" find role button click --name 'Poslat odkaz pro správu' >/dev/null
  agent-browser --session "$browser_session" wait --text 'Pokud pro tento kontakt existuje správa notifikací' >/dev/null
fi

echo "Notification lifecycle UI verification passed (${mode})."
