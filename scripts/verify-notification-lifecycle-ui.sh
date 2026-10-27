#!/usr/bin/env bash
set -euo pipefail

mode="${1:---all}"
if [[ "$mode" != "--all" && "$mode" != "--push" && "$mode" != "--fake-doors" && "$mode" != "--guide" && "$mode" != "--management" && "$mode" != "--manual-management" && "$mode" != "--test-manual-management" ]]; then
  echo "Usage: $0 [--all|--push|--fake-doors|--guide|--management|--manual-management|--test-manual-management]" >&2
  exit 64
fi

guide_port=2104
ready_port=2105
manual_port=2106
server_pids=()
browser_session=""
push_init=""
challenge_init=""
temporary_dir="${TMPDIR:-/tmp}"
screenshot_dir="${AGENT_BROWSER_SCREENSHOT_DIR:-/tmp/screenshots}"

assert_port_free() {
  local listeners
  if ! command -v ss >/dev/null || ! listeners="$(ss -H -ltn "sport = :$1")"; then
    echo "Cannot determine occupancy of port $1; refusing to launch." >&2
    exit 1
  fi
  if [[ -n "$listeners" ]]; then
    echo "Port $1 is occupied; refusing to launch or stop any server." >&2
    exit 1
  fi
}

# Check the entire journey before starting anything, not just its first server.
case "$mode" in
  --all|--guide) ports=("$guide_port" "$ready_port") ;;
  --management) ports=("$guide_port") ;;
  --fake-doors) ports=("$guide_port") ;;
  --push) ports=("$guide_port") ;;
  --manual-management|--test-manual-management) ports=("$manual_port") ;;
esac
for port in "${ports[@]}"; do assert_port_free "$port"; done

if [[ "$mode" != "--manual-management" && "$mode" != "--test-manual-management" ]]; then
  browser_session="$(agent-browser session id --scope worktree --prefix notification-lifecycle)"
fi

stop_servers() {
  for server_pid in "${server_pids[@]}"; do
    kill -- "-$server_pid" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      if ! ps -eo pgid=,stat= | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.exit(s.split("\n").some(l=>{const [g,t]=l.trim().split(/\s+/);return g===process.argv[1]&&t&&!t.startsWith("Z")})?0:1))' "$server_pid"; then break; fi
      sleep 0.1
    done
    kill -KILL -- "-$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" 2>/dev/null || true
    sleep 0.1
    if ps -eo pgid=,stat= | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.exit(s.split("\n").some(l=>{const [g,t]=l.trim().split(/\s+/);return g===process.argv[1]&&t&&!t.startsWith("Z")})?0:1))' "$server_pid"; then
      echo "Owned server group $server_pid still has live descendants; cleanup failed." >&2
      exit 1
    fi
  done
  server_pids=()
}

cleanup() {
  local result=$?
  if [[ -n "$browser_session" ]]; then
    if [[ "$mode" == "--fake-doors" && "$result" != 0 ]]; then
      agent-browser --session "$browser_session" --no-auto-dialog snapshot >"$screenshot_dir/notification-fake-doors-failure.txt" 2>&1 || true
      agent-browser --session "$browser_session" --no-auto-dialog network requests --json >"$screenshot_dir/notification-fake-doors-failure-network.json" 2>&1 || true
      agent-browser --session "$browser_session" --no-auto-dialog errors --json >"$screenshot_dir/notification-fake-doors-failure-errors.json" 2>&1 || true
      agent-browser --session "$browser_session" --no-auto-dialog eval '({url:location.href,hydrating:document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating})' --json >"$screenshot_dir/notification-fake-doors-failure-state.json" 2>&1 || true
    fi
    agent-browser --session "$browser_session" close >/dev/null 2>&1 || true
  fi
  stop_servers
  if [[ -n "$push_init" ]]; then rm -f "$push_init"; fi
  if [[ -n "$challenge_init" ]]; then rm -f "$challenge_init"; fi
}

start_server() {
  local port="$1"
  local fixture="$2"
  base_url="http://localhost:${port}"
  assert_port_free "$port"
  local log_file
  log_file="$(mktemp "${temporary_dir%/}/notification-lifecycle-ui-${port}-XXXXXX.log")"
  local owned_dir
  owned_dir="$(mktemp -d "${temporary_dir%/}/notification-lifecycle-cache-${port}-XXXXXXXX")"
  mkdir "$owned_dir/home"
  local isolated_env=(env -i "PATH=$PATH" "HOME=$owned_dir/home" "NUXT_BUILD_DIR=$owned_dir/nuxt" "CONTENT_LOCAL_DATABASE_PATH=$owned_dir/content.sqlite" NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 NO_PROXY=localhost,127.0.0.1 CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_SEND_METRICS=false)
  local dev_args=(--port "$port" --dotenv /dev/null)
  if [[ -n "${NOTIFICATION_UI_VERIFY_LAYER:-}" ]]; then
    local layer
    layer="$(realpath -- "$NOTIFICATION_UI_VERIFY_LAYER")"
    [[ "$layer" == /tmp/opencode/* && -f "$layer/nuxt.config.ts" ]] || { echo 'Verification layer must be an owned local Nuxt layer under /tmp/opencode.' >&2; exit 1; }
    local layer_run
    case "$port" in
      "$guide_port") layer_run=guide ;;
      "$ready_port") layer_run=ready ;;
      "$manual_port") layer_run=manual ;;
    esac
    isolated_env+=("VERIFY_RUN=$layer_run")
    dev_args+=(--extends "$layer")
  fi

  if [[ "$fixture" == true ]]; then
    if [[ "$mode" == --push ]]; then
      # Public-only ephemeral identity: no root/private/provider material is needed
      # for this explicitly synthetic browser boundary.
      push_public_key="$(node --input-type=module -e 'import { createECDH } from "node:crypto"; const key=createECDH("prime256v1");key.generateKeys();console.log(key.getPublicKey().toString("base64url"))')"
      isolated_env+=("NUXT_PUBLIC_NOTIFICATION_VAPID_PUBLIC_KEY=$push_public_key")
    fi
    setsid "${isolated_env[@]}" NUXT_NOTIFICATION_UI_VERIFICATION_FIXTURE=true NUXT_PUBLIC_NOTIFICATION_TURNSTILE_SITE_KEY=notification-ui-verification-site-key npm run dev -- "${dev_args[@]}" >"$log_file" 2>&1 &
  else
    setsid "${isolated_env[@]}" npm run dev -- "${dev_args[@]}" >"$log_file" 2>&1 &
  fi
  server_pids+=("$!")
  local server_pid="${server_pids[-1]}"
  echo "Owned server launch: port=$port fixture=$fixture process_group=$server_pid log=$log_file"
  # setsid creates the owned group asynchronously after the shell forks.
  for _ in {1..20}; do
    if kill -0 -- "-$server_pid" 2>/dev/null; then break; fi
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 0.05
  done
  for _ in {1..60}; do
    if ! kill -0 -- "-$server_pid" 2>/dev/null; then
      echo "Owned server group $server_pid exited during startup." >&2
      break
    fi
    if curl --silent --fail --max-time 1 "$base_url/kalendar" >/dev/null; then
      kill -0 -- "-$server_pid" 2>/dev/null || exit 1
      return
    fi
    sleep 1
  done
  printf 'Notification lifecycle UI server failed to start:\n' >&2
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done < "$log_file"
  exit 1
}

trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

if [[ "$mode" == --all || "$mode" == --guide || "$mode" == --management || "$mode" == --push ]]; then
  challenge_init="$(mktemp "${temporary_dir%/}/notification-challenge-init-XXXXXXXX.js")"
  cat >"$challenge_init" <<'JS'
const challenge = window.__notificationChallengeProof = {
  expectedSiteKey: 'notification-ui-verification-site-key', token: 'notification-ui-verification-token',
  widgets: [], posts: [], events: [], errors: [], failNextRender: false,
  live(label) { return this.widgets.filter(w => !w.removed && w.container.isConnected && w.label === label && (!document.querySelector('[role=dialog]') || w.container.closest('[role=dialog]') === document.querySelector('[role=dialog]'))) },
  postCount() { return window.__pushProof ? window.__pushProof.posts.length : this.posts.length },
  snapshot() { return { events: this.events, errors: this.errors, posts: this.posts, widgets: this.widgets.map(w => ({ id:w.id, label:w.label, sitekey:w.options.sitekey, action:w.options.action, size:w.options.size, responseField:w.options['response-field'], width:w.width, issued:w.issued, resets:w.resets, removed:w.removed })) } },
}
window.turnstile = {
  ready(callback) { challenge.events.push(['ready']); queueMicrotask(callback) },
  render(container, options) {
    if (!(container instanceof HTMLElement) || !container.isConnected || options.sitekey !== challenge.expectedSiteKey || options.action !== 'notification-operation' || options['response-field'] !== false || options.size !== (container.clientWidth < 300 ? 'compact' : 'flexible') || !Object.keys(options).every(key => ['sitekey','action','size','response-field','callback','expired-callback','error-callback','timeout-callback'].includes(key)) || !['callback','expired-callback','error-callback','timeout-callback'].every(key => typeof options[key] === 'function')) {
      challenge.errors.push('Invalid native widget contract'); throw Error('Invalid native widget contract')
    }
    if (challenge.failNextRender) { challenge.failNextRender=false; challenge.events.push(['render-failure']); return undefined }
    let field = container.parentElement
    while (field && !field.querySelector('label')) field = field.parentElement
    const label = field?.querySelector('label')?.textContent.trim()
    const id = 'owned-' + challenge.widgets.length
    const button = document.createElement('button')
    button.type='button'; button.textContent='Dokončit lokální ověření ' + id; button.setAttribute('data-verification-widget',id)
    button.style.width=options.size === 'compact' ? '150px' : '100%'
    button.style.minWidth=options.size === 'compact' ? '150px' : '300px'
    button.style.height=options.size === 'compact' ? '140px' : '65px'
    const widget={ id, container, options, label, button, width:container.clientWidth, removed:false, resets:0, issued:0 }
    button.onclick=() => { if (widget.removed || widget.issued) return; widget.issued++; challenge.events.push(['success',id]); options.callback(challenge.token); button.disabled=true }
    container.append(button); challenge.widgets.push(widget); challenge.events.push(['render',id,label]); return id
  },
  reset(id) { const w=challenge.widgets.find(w=>w.id===id); if (!w || w.removed) { challenge.errors.push('Invalid reset'); return }; w.resets++; challenge.events.push(['reset',id]) },
  remove(id) { const w=challenge.widgets.find(w=>w.id===id); if (!w || w.removed) { challenge.errors.push('Invalid remove'); return }; w.removed=true; w.button.remove(); challenge.events.push(['remove',id]) },
}
const challengeFetch=window.fetch.bind(window)
window.fetch=async (input, options={}) => {
  const url=new URL(typeof input==='string'?input:input.url,location.href)
  if (url.origin===location.origin && String(options.method || input.method || 'GET').toUpperCase()==='POST' && ['/api/notifications/activate','/api/notifications/manage-request'].includes(url.pathname)) {
    const row={path:url.pathname,body:JSON.parse(options.body),status:null};challenge.posts.push(row)
    const response=await challengeFetch(input,options);row.status=response.status;return response
  }
  return challengeFetch(input,options)
}
JS
  export AGENT_BROWSER_INIT_SCRIPTS="${AGENT_BROWSER_INIT_SCRIPTS:+$AGENT_BROWSER_INIT_SCRIPTS,}$challenge_init"
fi

acquire_challenge() {
  local label="$1" token="$2" submit="${3:-Poslat odkaz pro správu}" id
  agent-browser --session "$browser_session" wait --text "$label" >/dev/null
  agent-browser --session "$browser_session" wait --fn "window.__notificationChallengeProof.live('$label').length === 1 && !document.querySelector('input[name=turnstile-token], input[name=cf-turnstile-response]')" >/dev/null
  agent-browser --session "$browser_session" eval "window.__notificationChallengeProof.token='$token'; window.__notificationChallengeProof.baseline=window.__notificationChallengeProof.postCount()" >/dev/null
  agent-browser --session "$browser_session" wait --fn "!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='$submit'&&!b.disabled)" >/dev/null
  id="$(agent-browser --session "$browser_session" eval "window.__notificationChallengeProof.live('$label')[0].id" | tr -d '"')"
  agent-browser --session "$browser_session" focus "button[data-verification-widget='$id']" >/dev/null
  agent-browser --session "$browser_session" press Enter >/dev/null
  agent-browser --session "$browser_session" wait --fn 'window.__notificationChallengeProof.postCount() === window.__notificationChallengeProof.baseline' >/dev/null
  # Expiry/error exercise the actual component retry path, without another POST.
  agent-browser --session "$browser_session" eval "window.__notificationChallengeProof.retired=window.__notificationChallengeProof.widgets.find(w=>w.id==='$id'); window.__notificationChallengeProof.retired.options['expired-callback']()" >/dev/null
  agent-browser --session "$browser_session" wait --text 'Ověření vypršelo.' >/dev/null
  agent-browser --session "$browser_session" eval 'window.__notificationChallengeProof.retired.options.callback("retired-token")' >/dev/null
  agent-browser --session "$browser_session" wait --fn "!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='$submit'&&!b.disabled)" >/dev/null
  agent-browser --session "$browser_session" wait --fn 'window.__notificationChallengeProof.retired.removed && window.__notificationChallengeProof.retired.resets === 1 && window.__notificationChallengeProof.postCount() === window.__notificationChallengeProof.baseline' >/dev/null
  agent-browser --session "$browser_session" find role button click --name 'Zkusit ověření znovu' --exact >/dev/null
  agent-browser --session "$browser_session" wait --fn "window.__notificationChallengeProof.live('$label').length === 1" >/dev/null
  agent-browser --session "$browser_session" eval "window.__notificationChallengeProof.live('$label')[0].options['error-callback']()" >/dev/null
  agent-browser --session "$browser_session" wait --text 'Ověření se nepodařilo.' >/dev/null
  agent-browser --session "$browser_session" find role button click --name 'Zkusit ověření znovu' --exact >/dev/null
  agent-browser --session "$browser_session" wait --fn "window.__notificationChallengeProof.live('$label').length === 1" >/dev/null
  id="$(agent-browser --session "$browser_session" eval "window.__notificationChallengeProof.live('$label')[0].id" | tr -d '"')"
  agent-browser --session "$browser_session" focus "button[data-verification-widget='$id']" >/dev/null
  agent-browser --session "$browser_session" press Enter >/dev/null
  agent-browser --session "$browser_session" wait --fn 'window.__notificationChallengeProof.postCount() === window.__notificationChallengeProof.baseline && window.__notificationChallengeProof.errors.length === 0' >/dev/null
  agent-browser --session "$browser_session" wait --fn "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='$submit'&&!b.disabled)" >/dev/null
}

capture_challenge_proof() {
  local name="$1"
  agent-browser --session "$browser_session" eval 'window.__notificationChallengeProof.snapshot()' --json >"$screenshot_dir/$name-challenge.json"
  agent-browser --session "$browser_session" network requests --json >"$screenshot_dir/$name-challenge-network.json"
  node --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const n=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(!p.success||p.data.result.errors.length||!n.success||n.data.requests.some(r=>r.url.startsWith("https://challenges.cloudflare.com/turnstile/")))throw Error("Native challenge boundary failed")' "$screenshot_dir/$name-challenge.json" "$screenshot_dir/$name-challenge-network.json"
}

if [[ "$mode" == '--push' ]]; then
  if [[ -n "${NOTIFICATION_UI_BASE_URL:-}" ]]; then
    [[ "$NOTIFICATION_UI_BASE_URL" == http://127.0.0.1:* || "$NOTIFICATION_UI_BASE_URL" == http://localhost:* ]] || { echo 'Push verification requires an owned loopback server.' >&2; exit 1; }
    base_url="$NOTIFICATION_UI_BASE_URL"
  else
    start_server "$guide_port" true
  fi
  mkdir -p "$screenshot_dir"
  push_init="$(mktemp "${temporary_dir%/}/notification-push-init-XXXXXXXX.js")"
  cat >"$push_init" <<'JS'
const proof = window.__pushProof = { permission: 'default', outcome: 'granted', permissionCalls: 0, registers: 0, subscribes: 0, existing: false, activation: 'active', status: 200, recoveryStatus: 202, posts: [], analytics: [] }
const subscription = { toJSON: () => ({ endpoint: 'https://push.example.test/browser-proof', expirationTime: null, keys: { p256dh: proof.publicKey, auth: 'AAECAwQFBgcICQoLDA0ODw' } }) }
const registration = { pushManager: { getSubscription: async () => proof.existing ? subscription : null, subscribe: async options => { const bytes=Array.from(options.applicationServerKey); if (!options.userVisibleOnly || JSON.stringify(bytes)!==JSON.stringify(proof.publicKeyBytes)) throw Error('Native subscription key differs from compiled public key'); (proof.subscriptionKeys ??= []).push(bytes); proof.subscribes++; proof.existing = true; return subscription } } }
Object.defineProperty(window, 'PushManager', { configurable: true, value: function() {} })
Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return proof.permission }, requestPermission() { if (!navigator.userActivation.isActive) throw Error('Permission lost user gesture'); proof.permissionCalls++; proof.permission = proof.outcome; return Promise.resolve(proof.outcome) } } })
Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async (scriptURL) => { const url = new URL(String(scriptURL), location.href); if (url.origin === location.origin && url.pathname === '/notification-sw.js') { proof.registers++; if (proof.permission !== 'granted') throw Error('Registration before permission') } else (proof.otherRegistrationCalls ??= []).push(url.href); return registration }, ready: Promise.resolve(registration), getRegistration: async () => registration } })
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, options = {}) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input)
  if (url.includes('/api/notifications/readiness')) return new Response(JSON.stringify({ email: false, sms: false, webPush: true }), { headers: { 'content-type': 'application/json' } })
  if (url.includes('/api/notifications/activate') || url.includes('/api/notifications/manage-request')) {
    const body = JSON.parse(options.body); proof.posts.push({ url, body })
    const status = url.includes('activate') ? proof.status : proof.recoveryStatus
    return new Response(JSON.stringify(status >= 400 ? { statusCode: status } : url.includes('activate') ? { state: proof.activation } : { message: 'Pokud pro tento prohlížeč existuje správa oznámení, pošleme ti odkaz.' }), { status, headers: { 'content-type': 'application/json' } })
  }
  return originalFetch(input, options)
}
JS
  export AGENT_BROWSER_INIT_SCRIPTS="$AGENT_BROWSER_INIT_SCRIPTS,$push_init"
  # Shared challenge helpers must launch with the same containment settings;
  # changing an allowlist per command restarts Chromium and loses the live widget.
  export AGENT_BROWSER_ALLOWED_DOMAINS=localhost,127.0.0.1
  ab() { agent-browser --session "$browser_session" --screenshot-dir "$screenshot_dir" "$@"; }
  check_push() { ab wait --fn "$1" >/dev/null; }
  push_browser_session="$browser_session"
  for width in 1280 320; do
    for surface in kalendar brno; do
      browser_session="${push_browser_session}-${surface}-${width}"
      ab set viewport "$width" 900 >/dev/null
      ab open "$base_url/lide" >/dev/null
      check_push 'document.getElementById("__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false'
      # Same-origin readiness is controlled local UI I/O, not provider evidence.
      # Payloads and compiled public runtime configuration remain untouched.
      ab network route '**/api/notifications/readiness' --body '{"email":false,"sms":false,"webPush":true}' >/dev/null
      ab eval --stdin <<'JS' >/dev/null
(async () => {
const nuxt = document.getElementById('__nuxt').__vue_app__.config.globalProperties.$nuxt
const key=nuxt.$config.public.notificationVapidPublicKey
const html=await fetch(location.href).then(r=>r.text())
const scripts=Array.from(new DOMParser().parseFromString(html,'text/html').scripts)
const raw=scripts.find(s=>s.textContent.includes('notificationVapidPublicKey'))?.textContent
const bytes=Array.from(Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)))
if (!raw?.includes(JSON.stringify(key)) || bytes.length!==65 || bytes[0]!==4 || !nuxt.$config.public.notificationTurnstileSiteKey) throw Error('Invalid compiled public identity')
window.__pushProof.publicKey=key;window.__pushProof.publicKeyBytes=bytes
window.__notificationChallengeProof.expectedSiteKey=nuxt.$config.public.notificationTurnstileSiteKey
for (const name of ['trackWebIntent', 'trackSmsIntent', 'trackEmailIntent', 'trackSubscriptionGuide', 'trackICalendarCopy']) nuxt.$counterscale[name] = (...args) => { if (args.length) throw Error('Sensitive analytics arguments'); window.__pushProof.analytics.push(name) }
})()
JS
      if [[ -n "${push_public_key:-}" ]]; then check_push "window.__pushProof.publicKey === '$push_public_key'"; fi
      ab eval "document.getElementById('__nuxt').__vue_app__.config.globalProperties.\$router.push('/$surface')" >/dev/null
      if [[ "$surface" == brno ]]; then
        ab wait --text 'Nadcházející události' >/dev/null
        ab find role button click --name 'Sledovat události' >/dev/null
      fi
      ab wait --text 'Aktivovat oznámení v prohlížeči' >/dev/null
      check_push 'window.__pushProof.permissionCalls === 0 && window.__pushProof.posts.length === 0'
      activate_push() { ab find role button click --name 'Aktivovat oznámení v prohlížeči' >/dev/null; }
      # Dismissed permission is distinct from unsupported and never posts.
      ab eval 'window.__pushProof.outcome = "default"' >/dev/null
      activate_push
      ab wait --text 'Oznámení jsi zatím nepovolil' >/dev/null
      check_push 'window.__pushProof.posts.length === 0 && window.__pushProof.subscribes === 0'
      ab eval 'window.__pushProof.permission = "denied"' >/dev/null
      activate_push
      ab wait --text 'Oznámení máš v prohlížeči zakázaná' >/dev/null
      check_push 'window.__pushProof.permissionCalls === 1'
      # The challenge reuses one canonical native JSON body and subscription.
      ab eval 'Object.assign(window.__pushProof,{permission:"default",outcome:"granted",status:403})' >/dev/null
      activate_push
      ab wait --text 'Ověřit aktivaci oznámení' >/dev/null
      check_push 'window.__pushProof.subscribes === 1 && window.__pushProof.registers === 1 && window.__pushProof.permissionCalls === 2'
      acquire_challenge 'Ověřit aktivaci oznámení' 'synthetic-body-token' 'Aktivovat oznámení v prohlížeči'
      ab eval 'Object.assign(window.__pushProof,{status:200,activation:"pending-reactivation"})' >/dev/null
      activate_push
      ab wait --text 'Obnovení potvrď přes odkaz pro správu' >/dev/null
      check_push 'window.__pushProof.posts.length === 2 && JSON.stringify(window.__pushProof.posts[0].body.contact) === JSON.stringify(window.__pushProof.posts[1].body.contact) && window.__pushProof.posts[1].body.turnstileToken === "synthetic-body-token" && window.__pushProof.permissionCalls === 2 && window.__pushProof.subscribes === 1'
      for state in updated active; do
        ab eval "window.__pushProof.activation = '$state'" >/dev/null
        activate_push
        if [[ "$state" == updated ]]; then ab wait --text 'Nastavení oznámení jsme aktualizovali' >/dev/null
        else ab wait --text 'Oznámení jsou pro tento prohlížeč aktivní' >/dev/null; fi
        check_push '!window.__pushProof.posts.at(-1).body.turnstileToken && window.__pushProof.subscribes === 1'
      done
      ab eval 'window.__pushProof.status = 429' >/dev/null
      activate_push
      ab wait --text 'Počkej prosím alespoň minutu' >/dev/null
      check_push 'window.__pushProof.posts.filter(p=>p.url.includes("activate")).length === 5'
      ab eval 'window.__pushProof.recoveryStatus = 403' >/dev/null
      ab find role button click --name 'Poslat odkaz pro správu tohoto prohlížeče' >/dev/null
      ab wait --text 'Ověřit správu prohlížeče' >/dev/null
      acquire_challenge 'Ověřit správu prohlížeče' 'synthetic-recovery-token' 'Poslat odkaz pro správu tohoto prohlížeče'
      ab eval 'window.__pushProof.recoveryStatus = 202' >/dev/null
      ab find role button click --name 'Poslat odkaz pro správu tohoto prohlížeče' >/dev/null
      ab wait --text 'Pokud pro tento prohlížeč existuje správa oznámení' >/dev/null
      check_push 'window.__pushProof.posts.at(-1).body.turnstileToken === "synthetic-recovery-token" && window.__pushProof.posts.at(-1).body.contact.expirationTime === null && window.__pushProof.permissionCalls === 2 && window.__pushProof.subscribes === 1'
      ab eval 'window.__pushProof.existing = false; window.__pushProof.beforeRecovery = window.__pushProof.posts.length' >/dev/null
      ab find role button click --name 'Poslat odkaz pro správu tohoto prohlížeče' >/dev/null
      check_push 'window.__pushProof.posts.length === window.__pushProof.beforeRecovery && document.documentElement.scrollWidth <= innerWidth'
      ab eval 'window.__pushProof.status = 503' >/dev/null
      activate_push
      ab wait --text 'Aktivaci se teď nepodařilo potvrdit' >/dev/null
      ab eval 'delete window.PushManager' >/dev/null
      activate_push
      ab wait --text 'Tento prohlížeč teď oznámení nepodporuje' >/dev/null
      ab eval 'Object.defineProperty(navigator,"userAgent",{configurable:true,value:"iPhone"})' >/dev/null
      activate_push
      ab wait --text 'Na iPhonu nebo iPadu si nejdřív přidej web na plochu' >/dev/null
      # A desktop-mode iPad with actual capabilities is not rejected by UA alone.
      ab eval 'Object.defineProperty(navigator,"userAgent",{configurable:true,value:"Macintosh"});Object.defineProperty(navigator,"platform",{configurable:true,value:"MacIntel"});Object.defineProperty(navigator,"maxTouchPoints",{configurable:true,value:5});Object.defineProperty(window,"PushManager",{configurable:true,value:function(){}});window.__pushProof.status=200' >/dev/null
      activate_push
      ab wait --text 'Oznámení jsou pro tento prohlížeč aktivní' >/dev/null
      check_push 'window.__pushProof.registers === 6 && window.__pushProof.permissionCalls === 2 && window.__pushProof.subscribes === 2 && window.__pushProof.posts.length === 9 && document.getElementById("__nuxt").__vue_app__.config.globalProperties.$nuxt.$config.public.notificationVapidPublicKey === window.__pushProof.publicKey'
      ab screenshot "$screenshot_dir/notification-push-$surface-$width.png" >/dev/null
      ab eval 'JSON.stringify(window.__pushProof)' --json >"$screenshot_dir/notification-push-$surface-$width.json"
      capture_challenge_proof "notification-push-$surface-$width"
      ab close >/dev/null
    done
  done
  echo 'Push permission/challenge/pending/recovery browser boundary verification passed (synthetic browser/route I/O only).'
  exit 0
fi

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
  manual_log="$(mktemp "${temporary_dir%/}/notification-manual-management-XXXXXX.log")"
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

if [[ "$mode" == "--fake-doors" ]]; then
  start_server "$guide_port" false
  # Chromium resolves *.localhost to loopback. The real tracker intentionally
  # suppresses exact localhost; this local origin exercises its serialization.
  base_url="http://notification-ui.localhost:$guide_port"
  ab() { agent-browser --session "$browser_session" --no-auto-dialog --screenshot-dir "$screenshot_dir" "$@"; }
  assert_browser() { ab wait --fn "$1" >/dev/null; }
  inspect_capture() {
    ab network requests --json >"$screenshot_dir/${case_name}-requests.json"
    node --input-type=module -e '
      import fs from "node:fs";
      const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!response.success || !Array.isArray(response.data?.requests)) throw Error("Missing request capture");
      const requests = response.data.requests;
      if (requests.some(r => /15551234567|fake-door@example\.test/.test(JSON.stringify(r)))) throw Error("Browser-local contact crossed a network boundary");
      const readiness = requests.filter(r => new URL(r.url).pathname === "/api/notifications/readiness");
      if (!readiness.some(r => r.status === 200)) throw Error("Readiness interception was not consumed");
      const forbidden = requests.filter(r => (/\/api\/notifications\//.test(r.url) && !r.url.includes("/readiness")) || /\/notifications\/manage\/|brevo|twilio|fcm\.googleapis|push\.services\.mozilla/.test(r.url) || new URL(r.url).pathname === "/notification-sw.js");
      if (forbidden.length) throw Error("Forbidden notification attempt: " + JSON.stringify(forbidden));
      const analytics = requests.filter(r => new URL(r.url).pathname === "/cntrsclc");
      const expected = JSON.parse(process.argv[2]);
      const publicViews = {};
      const events = [];
      for (const request of analytics) {
        const url = new URL(request.url);
        if ([...url.searchParams.keys()].some(k => !["p","h","r","sid","ht"].includes(k))) throw Error("Unexpected analytics metadata");
        if (/15551234567|fake-door|example\.test|week-before|day-before|all-czech-communities|notifications\/manage/i.test(decodeURIComponent(JSON.stringify(request)))) throw Error("Private data in emitted tracker request");
        const referrer = Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === "referer")?.[1];
        if (referrer && (new URL(referrer).search || new URL(referrer).hash)) throw Error("Identifying referrer query");
        if (!url.searchParams.has("p")) continue; // SDK cache request, audited above.
        const observed = new URL(url.searchParams.get("p"), url.origin);
        if (observed.origin !== url.origin || observed.search || observed.hash || url.searchParams.get("r") !== "") throw Error("Unexpected pageview identity");
        const path = observed.pathname;
        if (Object.hasOwn(expected, path)) events.push({request,path});
        // /lide is the explicit neutral entry audited before each count reset.
        else if (["/kalendar","/brno","/lide"].includes(path)) publicViews[path]=(publicViews[path] || 0)+1;
        else throw Error("Unexpected analytics path: " + path);
      }
      for (const [path, count] of Object.entries(expected)) {
        const actual = events.filter(event => event.path === path).map(event => event.request);
        if (actual.length !== count) throw Error(`${path}: expected ${count}, captured ${actual.length}`);
        for (const request of actual) {
          const url = new URL(request.url);
          if (url.searchParams.get("r") !== "" || [...url.searchParams.keys()].some(k => !["p","h","r","sid","ht"].includes(k))) throw Error("Unexpected analytics metadata");
          const serialized = JSON.stringify(request);
          if (/15551234567|fake-door|example\.test|week-before|day-before|all-czech-communities/.test(serialized)) throw Error("Private data in emitted tracker request");
          const referrer = Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === "referer")?.[1];
          if (referrer && (new URL(referrer).search || new URL(referrer).hash)) throw Error("Identifying referrer query");
        }
      }
      console.log(JSON.stringify({readiness: readiness.length, counts: expected, publicViews, analyticsRequests:analytics.length, notificationAttempts: forbidden.length}));
    ' "$screenshot_dir/${case_name}-requests.json" "$counts"
    assert_browser 'window.__notificationVerification?.permission === 0 && window.__notificationVerification?.subscribe === 0'
  }
  navigate_guide() {
    ab open "$base_url/lide" >/dev/null
    assert_browser 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false'
    ab eval 'window.__notificationVerification = {permission:0,subscribe:0}; if (window.Notification) Notification.requestPermission = () => { window.__notificationVerification.permission++; return Promise.reject(Error("Forbidden permission request")); }; if (window.PushManager) PushManager.prototype.subscribe = () => { window.__notificationVerification.subscribe++; return Promise.reject(Error("Forbidden push subscription")); }' >/dev/null
    # Audit reload/neutral-page traffic before resetting the per-journey counts.
    if [[ -n "${counts:-}" ]]; then inspect_capture; fi
    ab network requests --clear >/dev/null
    ab eval "document.querySelector('#__nuxt').__vue_app__.config.globalProperties.\$router.push('/$surface')" >/dev/null
    if [[ "$surface" == brno ]]; then
      ab wait --text 'Nadcházející události' >/dev/null
      assert_browser 'Array.from(document.querySelectorAll("button")).some(b => b.textContent.trim() === "Sledovat události" && !b.disabled)'
      ab eval 'Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "Sledovat události").focus()' >/dev/null
      ab press Enter >/dev/null
    fi
    ab wait --text 'Kalendářový feed' >/dev/null
    assert_browser 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false && !Array.from(document.querySelectorAll("[role=status]")).some(node => node.textContent.includes("Ověřujeme dostupné možnosti upozornění…")) && ["Mám zájem o SMS", "Mám zájem o e-mail", "Mám zájem o oznámení ve webu"].every(name => Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === name)) && !Array.from(document.querySelectorAll("button")).some(button => ["Spravovat SMS notifikace", "Spravovat e-mailové notifikace"].includes(button.getAttribute("aria-label")))'
    assert_browser 'Array.from(document.querySelectorAll("button")).filter(b => b.textContent.trim().startsWith("Mám zájem o")).length === 3 && !Array.from(document.querySelectorAll("button")).some(b => /Aktivovat|Spravovat.*notifikace/.test(b.textContent))'
    assert_browser 'Array.from(document.querySelectorAll("h3")).map(h => h.textContent.trim()).filter(t => ["SMS","E-mail","Oznámení ve webu","Kalendářový feed"].includes(t)).join("|") === "SMS|E-mail|Oznámení ve webu|Kalendářový feed"'
    if [[ "$surface" == brno ]]; then assert_browser 'document.querySelector("[role=dialog]")?.contains(document.activeElement)'; fi
    counts='{"/kalendar/signin-sms":0,"/kalendar/signin-mail":0,"/kalendar/signin-web":0,"/kalendar/copy-ical":0,"/kalendar/subscription-guide":1}'
    inspect_capture
  }
  for width in 1280 320; do
    for surface in kalendar brno; do
      case_name="notification-fake-doors-${surface}-${width}"
      browser_session="${case_name}-$$"
      counts=""
      ab open "$base_url/robots.txt" >/dev/null
      ab set viewport "$width" 800 >/dev/null
      # The installed CLI chooses the first matching interception rule.
      ab network route '**/api/notifications/readiness' --body '{"email":false,"sms":false,"webPush":false}' >/dev/null
      ab network route '**/api/notifications/*' --abort >/dev/null
      ab network route '**/cntrsclc*' --body '{"ht":1}' >/dev/null
      for destination in '**/notifications/manage/*' '*brevo*' '*twilio*' '*fcm.googleapis*' '*push.services.mozilla*'; do
        ab network route "$destination" --abort >/dev/null
      done
      navigate_guide
      assert_browser 'Array.from(document.querySelectorAll("button")).filter(b => ["Mám zájem o SMS","Mám zájem o e-mail"].includes(b.textContent.trim())).every(b => b.disabled)'
      expected_scope=all
      if [[ "$surface" == brno ]]; then expected_scope=brno; fi
      assert_browser "document.querySelector('code[aria-label]')?.textContent.trim() === '$base_url/ical/$expected_scope'"
      ab find label 'Telefonní číslo' fill '+15551234567' >/dev/null
      ab find label 'E-mail' fill 'fake-door@example.test' >/dev/null
      ab find role button click --name 'Upravit' --exact >/dev/null
      ab find role checkbox click --name 'týden předem' --exact >/dev/null
      ab find role checkbox click --name 'den předem' --exact >/dev/null
      ab find role button click --name 'Hotovo' --exact >/dev/null
      assert_browser 'document.body.innerText.includes("při vytvoření události, týden předem, den předem")'
      for repeat in 1 2; do
        if [[ "$repeat" == 2 ]]; then
          selections=(Praha)
          if [[ "$surface" == kalendar ]]; then selections=(Brno Praha); fi
          for selection in "${selections[@]}"; do
            ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
            ab find role option click --name "$selection" --exact >/dev/null
            ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
            assert_browser '!document.querySelector("[role=listbox]")'
          done
          assert_browser "document.querySelector('code[aria-label]')?.textContent.trim() === '$base_url/ical/brno,praha'"
        fi
        for channel in sms mail web; do
          case "$channel" in
            sms) label='Mám zájem o SMS' ;;
            mail) label='Mám zájem o e-mail' ;;
            web) label='Mám zájem o oznámení ve webu' ;;
          esac
          inspect_capture
          ab eval "Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '$label').focus()" >/dev/null
          if [[ "$repeat" == 2 && "$channel" == sms ]]; then
            # CDP keyboard dispatch can stay pending while the native dialog
            # pauses the renderer. Require the exact dialog proof below.
            if ! ab press Enter >"$screenshot_dir/${case_name}-${channel}-${repeat}-input.txt" 2>&1; then
              if ! grep -q 'A JavaScript alert dialog is blocking the page' "$screenshot_dir/${case_name}-${channel}-${repeat}-input.txt"; then
                exit 1
              fi
            fi
          else
            ab find role button click --name "$label" --exact >"$screenshot_dir/${case_name}-${channel}-${repeat}-input.txt" 2>&1
          fi
          sleep 0.5
          ab dialog status --json >"$screenshot_dir/${case_name}-${channel}-${repeat}-dialog.json"
          node --input-type=module -e '
            import fs from "node:fs";
            const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            if (!response.success || response.data?.hasDialog !== true || response.data.type !== "alert") throw Error("Missing native alert");
            const expected = "Promiň, tato možnost ještě není připravená, takže jsme nic neaktivovali. Sleduj prosím naše sociální sítě; už teď můžeš odebírat kalendář přes iCalendar.";
            if (response.data.message !== expected) throw Error("Unexpected native alert copy");
          ' "$screenshot_dir/${case_name}-${channel}-${repeat}-dialog.json"
          ab dialog accept >/dev/null
          assert_browser "document.activeElement?.textContent.trim() === '$label'"
          assert_browser 'document.querySelector("input[name=telephone]")?.value === "+15551234567" && document.querySelector("input[name=email]")?.value === "fake-door@example.test" && localStorage.getItem("subscription-guide-telephone") === "+15551234567" && localStorage.getItem("subscription-guide-email") === "fake-door@example.test"'
          counts="$(node -e 'const c=JSON.parse(process.argv[1]); c["/kalendar/signin-"+process.argv[2]]++; console.log(JSON.stringify(c))' "$counts" "$channel")"
          sleep 0.3
          inspect_capture
          ab dialog status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const r=JSON.parse(s);if(!r.success||r.data?.hasDialog!==false)process.exit(1)})'
        done
      done
      ab network requests --json >"$screenshot_dir/${case_name}-intent-requests.json"
      # Selection/frequency/copy/help share the same rendered guide controls.
      assert_browser 'document.body.innerText.includes("při vytvoření události, týden předem, den předem")'
      ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
      ab find role option click --name 'Celé Česko' --exact >/dev/null
      ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
      assert_browser '!document.querySelector("[role=listbox]")'
      ab eval 'window.__originalClipboardWrite = navigator.clipboard.writeText; window.__copiedCalendarUrls = []; navigator.clipboard.writeText = async function(url) { await window.__originalClipboardWrite.call(this, url); window.__copiedCalendarUrls.push(url); }' >/dev/null
      for selection in Brno Praha 'Celé Česko'; do
        ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
        ab find role option click --name "$selection" --exact >/dev/null
        ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
        assert_browser '!document.querySelector("[role=listbox]")'
        if [[ "$selection" == Praha ]]; then
          assert_browser "document.querySelector('code[aria-label]')?.textContent.trim() === '$base_url/ical/brno,praha'"
        elif [[ "$selection" == 'Celé Česko' ]]; then
          assert_browser "document.querySelector('code[aria-label]')?.textContent.trim() === '$base_url/ical/all'"
        fi
        ab find role button click --name 'Kopírovat adresu kalendáře' --exact >/dev/null
        assert_browser '!!document.querySelector("button[aria-label=\"Adresa zkopírována\"]") && window.__copiedCalendarUrls.at(-1) === document.querySelector("code[aria-label]")?.textContent.trim()'
        ab eval 'fetch(window.__copiedCalendarUrls.at(-1)).then(async r => ({url:r.url,status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()}))' --json >"$screenshot_dir/${case_name}-feed-${selection// /-}.json"
        node --input-type=module -e '
          import fs from "node:fs";
          const response = JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
          if (!response.success || !response.data?.result) throw Error("Missing copied-feed response");
          const r = response.data.result;
          if (/attachment/i.test(r.headers["content-disposition"] ?? "")) throw Error("Download disposition");
          if (r.status === 200) {
            if (!r.headers["content-type"]?.includes("text/calendar") || !r.body.includes("BEGIN:VCALENDAR")) throw Error("Invalid inline calendar");
          } else {
            if (![404,503].includes(r.status) || !r.headers["content-type"]?.includes("application/json") || !JSON.parse(r.body).statusMessage) throw Error("Unreadable feed error");
            console.log("Populated feed/client evidence BLOCKED: " + r.url + " HTTP " + r.status);
          }
        ' "$screenshot_dir/${case_name}-feed-${selection// /-}.json"
      done
      counts="$(node -e 'const c=JSON.parse(process.argv[1]);c["/kalendar/copy-ical"]=3;console.log(JSON.stringify(c))' "$counts")"
      inspect_capture
      ab wait --fn '!!document.querySelector("button[aria-label=\"Adresa zkopírována\"]")' >/dev/null
      assert_browser "window.__copiedCalendarUrls.length === 3 && window.__copiedCalendarUrls[0] === '$base_url/ical/brno' && window.__copiedCalendarUrls[1] === '$base_url/ical/brno,praha' && window.__copiedCalendarUrls[2] === '$base_url/ical/all'"
      ab eval 'window.__copiedCalendarUrls' --json >"$screenshot_dir/${case_name}-clipboard-write.json"
      ab eval 'navigator.clipboard.writeText = () => Promise.reject(Error("Local clipboard denial"))' >/dev/null
      ab find role button click --name 'Adresa zkopírována' --exact >/dev/null
      ab wait --text 'Adresu se nepodařilo zkopírovat. Označ ji a zkopíruj ručně.' >/dev/null
      counts="$(node -e 'const c=JSON.parse(process.argv[1]);c["/kalendar/copy-ical"]=4;console.log(JSON.stringify(c))' "$counts")"
      assert_browser "document.querySelector('code[aria-label]')?.textContent.trim() === '$base_url/ical/all'"
      ab eval 'navigator.clipboard.writeText = window.__originalClipboardWrite' >/dev/null
      for help in 'Google Calendar' 'Apple Kalendář' Outlook 'Jiná aplikace'; do
        case "$help" in
          'Google Calendar') instruction='V Kalendáři Google otevři' ;;
          'Apple Kalendář') instruction='iPhone/iPad: Nastavení' ;;
          Outlook) instruction='V Outlooku na webu vyber' ;;
          'Jiná aplikace') instruction='V aplikaci hledej volbu' ;;
        esac
        ab find role button click --name "$help" --exact >/dev/null
        assert_browser "document.querySelector('button[aria-label=\"$help\"]')?.getAttribute('aria-expanded') === 'true' && document.body.innerText.includes('$instruction')"
        ab press Escape >/dev/null
        assert_browser "document.querySelector('button[aria-label=\"$help\"]')?.getAttribute('aria-expanded') === 'false'"
      done
      assert_browser 'document.body.innerText.includes("Stažený soubor .ics je jen jednorázová kopie.") && document.body.innerText.includes("Čas obnovení určuje tvoje kalendářová aplikace.")'
      ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
      ab find role option click --name 'Celé Česko' --exact >/dev/null
      ab find role button click --name 'Komunity, které chceš sledovat' >/dev/null
      assert_browser '!document.querySelector("[role=listbox]")'
      assert_browser 'Array.from(document.querySelectorAll("button")).filter(b => b.textContent.trim().startsWith("Mám zájem o")).every(b => b.disabled) && !document.querySelector("code[aria-label]")'
      assert_browser 'document.body.innerText.includes("při vytvoření události, týden předem, den předem")'
      inspect_capture
      if [[ "$surface" == brno ]]; then
        ab press Escape >/dev/null
        assert_browser '!document.querySelector("[role=dialog]") && document.activeElement?.textContent.trim() === "Sledovat události"'
        ab press Enter >/dev/null
        ab wait --text 'Kalendářový feed' >/dev/null
        assert_browser "document.querySelector('code[aria-label]')?.textContent.trim() === '$base_url/ical/brno'"
        counts="$(node -e 'const c=JSON.parse(process.argv[1]);c["/kalendar/subscription-guide"]=2;console.log(JSON.stringify(c))' "$counts")"
      fi
      ab reload >/dev/null
      assert_browser 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false'
      sleep 0.3
      if [[ "$surface" == kalendar ]]; then
        ab wait --text 'Kalendářový feed' >/dev/null
        counts="$(node -e 'const c=JSON.parse(process.argv[1]);c["/kalendar/subscription-guide"]++;console.log(JSON.stringify(c))' "$counts")"
      fi
      # SSR payload is never used as readiness proof after reload.
      navigate_guide
      assert_browser 'document.querySelector("input[name=telephone]")?.value === "+15551234567" && document.querySelector("input[name=email]")?.value === "fake-door@example.test"'
      ab find label 'Telefonní číslo' fill '' >/dev/null
      ab find label 'E-mail' fill '' >/dev/null
      assert_browser '!localStorage.getItem("subscription-guide-telephone") && !localStorage.getItem("subscription-guide-email")'
      ab reload >/dev/null
      assert_browser 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false'
      sleep 0.3
      if [[ "$surface" == kalendar ]]; then
        ab wait --text 'Kalendářový feed' >/dev/null
        counts="$(node -e 'const c=JSON.parse(process.argv[1]);c["/kalendar/subscription-guide"]++;console.log(JSON.stringify(c))' "$counts")"
      fi
      navigate_guide
      assert_browser 'document.querySelector("input[name=telephone]")?.value === "" && document.querySelector("input[name=email]")?.value === ""'
      for theme in light dark; do
        ab set media "$theme" >/dev/null
        assert_browser 'document.documentElement.scrollWidth <= window.innerWidth'
        ab scrollintoview 'input[name=telephone]' >/dev/null
        ab screenshot "$screenshot_dir/${case_name}-${theme}.png" >/dev/null
      done
      ab errors --json >"$screenshot_dir/${case_name}-errors.json"
      node --input-type=module -e 'import fs from "node:fs";const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.success||!Array.isArray(r.data?.errors)||r.data.errors.length)throw Error("Browser page errors")' "$screenshot_dir/${case_name}-errors.json"
      ab console --json >"$screenshot_dir/${case_name}-console.json"
      node --input-type=module -e 'import fs from "node:fs";const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!r.success||!Array.isArray(r.data?.messages)||/hydration[^"\n]*mismatch/i.test(JSON.stringify(r.data.messages)))throw Error("Hydration evidence failed")' "$screenshot_dir/${case_name}-console.json"
      inspect_capture
      ab close >/dev/null
      browser_session=""
    done
  done
  echo 'False-readiness native-dialog verification passed.'
  exit 0
fi

if [[ "$mode" == "--all" || "$mode" == "--guide" ]]; then
  start_server "$guide_port" false
  agent-browser --session "$browser_session" open "$base_url/kalendar" >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --text "Kalendářový feed" >/dev/null
  # The deployed fake door owns convenience values only in browser-local storage.
  agent-browser --session "$browser_session" wait --fn 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false && !Array.from(document.querySelectorAll("[role=status]")).some(node => node.textContent.includes("Ověřujeme dostupné možnosti upozornění…")) && ["Mám zájem o SMS", "Mám zájem o e-mail", "Mám zájem o oznámení ve webu"].every(name => Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === name))' >/dev/null
  agent-browser --session "$browser_session" eval 'localStorage.setItem("subscription-guide-telephone", "+15551234567"); localStorage.setItem("subscription-guide-email", "fake@example.test")' >/dev/null
  agent-browser --session "$browser_session" reload >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --text "Kalendářový feed" >/dev/null
  agent-browser --session "$browser_session" wait --fn '!Array.from(document.querySelectorAll("[role=status]")).some(node => node.textContent.includes("Ověřujeme dostupné možnosti upozornění…")) && ["Mám zájem o SMS", "Mám zájem o e-mail", "Mám zájem o oznámení ve webu"].every(name => Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === name))' >/dev/null
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
  agent-browser --session "$browser_session" wait --fn '!Array.from(document.querySelectorAll("[role=status]")).some(node => node.textContent.includes("Ověřujeme dostupné možnosti upozornění…")) && ["Mám zájem o SMS", "Mám zájem o e-mail", "Mám zájem o oznámení ve webu"].every(name => Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === name))' >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[role=status]")).filter(status => status.textContent?.includes("Tato možnost ještě není připravená. Nic jsme neaktivovali")).length === 3' | grep -q true
  agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-guide-desktop.png" >/dev/null
  agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
  agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-guide-mobile.png" >/dev/null
  agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true

  # The private development fixture makes email/SMS ready while keeping push false.
  stop_servers
  start_server "$ready_port" true
  agent-browser --session "$browser_session" open "$base_url/kalendar" >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --text "Kalendářový feed" >/dev/null
  agent-browser --session "$browser_session" wait --fn 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false && !Array.from(document.querySelectorAll("[role=status]")).some(node => node.textContent.includes("Ověřujeme dostupné možnosti upozornění…")) && ["Spravovat SMS notifikace", "Spravovat e-mailové notifikace"].every(label => Array.from(document.querySelectorAll("button")).some(button => button.getAttribute("aria-label") === label && !button.disabled && button.getClientRects().length))' >/dev/null
  agent-browser --session "$browser_session" eval 'localStorage.setItem("subscription-guide-telephone", "+15551234567"); localStorage.setItem("subscription-guide-email", "fake@example.test")' >/dev/null
  agent-browser --session "$browser_session" reload >/dev/null
  agent-browser --session "$browser_session" wait --load networkidle >/dev/null
  agent-browser --session "$browser_session" wait --fn 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false && !Array.from(document.querySelectorAll("[role=status]")).some(node => node.textContent.includes("Ověřujeme dostupné možnosti upozornění…")) && ["Spravovat SMS notifikace", "Spravovat e-mailové notifikace"].every(label => Array.from(document.querySelectorAll("button")).some(button => button.getAttribute("aria-label") === label && !button.disabled && button.getClientRects().length))' >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("input[name=telephone]")?.value === "" && document.querySelector("input[name=email]")?.value === ""' | grep -q true
  agent-browser --session "$browser_session" find role button click --name "Spravovat e-mailové notifikace" --exact >/dev/null
  agent-browser --session "$browser_session" fill 'input[name="recovery-contact"]' 'recovery@example.test' >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Poslat odkaz pro správu" >/dev/null
  acquire_challenge 'Ověřit požadavek' 'notification-ui-verification-token'
  agent-browser --session "$browser_session" find role button click --name "Poslat odkaz pro správu" >/dev/null
  agent-browser --session "$browser_session" wait --text "Pokud máš na tomto kontaktu odběr" >/dev/null
  agent-browser --session "$browser_session" find role button click --name "Zrušit" >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("button")).some(button => button.textContent?.trim() === "Mám zájem o oznámení ve webu" && !button.disabled)' | grep -q true
  capture_challenge_proof notification-guide-recovery
  for width in 1280 320; do
    for channel in email sms; do
      agent-browser --session "$browser_session" set viewport "$width" 900 >/dev/null
      agent-browser --session "$browser_session" open "$base_url/kalendar" >/dev/null
      agent-browser --session "$browser_session" wait --fn 'document.querySelectorAll("button[aria-label^=Spravovat]").length === 2 && !document.body.innerText.includes("Ověřujeme dostupné možnosti upozornění…")' >/dev/null
      agent-browser --session "$browser_session" find role button click --name 'Komunity, které chceš sledovat' --exact >/dev/null
      agent-browser --session "$browser_session" find role option click --name Brno --exact >/dev/null
      agent-browser --session "$browser_session" find role button click --name 'Komunity, které chceš sledovat' --exact >/dev/null
      agent-browser --session "$browser_session" wait --fn '!document.querySelector("[role=listbox]")' >/dev/null
      contact=recovery@example.test
      input=email
      if [[ "$channel" == sms ]]; then contact=+15551234567; input=telephone; fi
      agent-browser --session "$browser_session" fill "input[name=$input]" "$contact" >/dev/null
      control="section:has(input[name=$input]):not(:has(section)) > button:first-of-type"
      agent-browser --session "$browser_session" click "$control" >/dev/null
      acquire_challenge 'Ověřit požadavek' 'notification-ui-verification-token' 'Aktivovat odběr'
      agent-browser --session "$browser_session" click "$control" >/dev/null
      agent-browser --session "$browser_session" wait --text 'Odběr je aktivní.' >/dev/null
      agent-browser --session "$browser_session" wait --fn 'window.__notificationChallengeProof.posts.length === 2 && window.__notificationChallengeProof.posts[0].status === 403 && window.__notificationChallengeProof.posts[1].status === 200 && window.__notificationChallengeProof.posts[1].body.turnstileToken === "notification-ui-verification-token" && window.__notificationChallengeProof.widgets.every(w=>w.removed) && document.documentElement.scrollWidth <= innerWidth' >/dev/null
      capture_challenge_proof "notification-guide-$channel-$width"
    done
  done
fi

if [[ "$mode" == "--all" || "$mode" == "--management" ]]; then
  stop_servers
  start_server "$guide_port" true
  management_browser_session="$(agent-browser session id --scope worktree --prefix management)"

  capture_management_state() {
    local token="$1"
    local name="$2"
    local expected_text="$3"
    agent-browser --session "$browser_session" close >/dev/null
    browser_session="${management_browser_session}-${name}"
    agent-browser --session "$browser_session" set viewport 1440 900 >/dev/null
    agent-browser --session "$browser_session" open "$base_url/notifications/manage/$token" >/dev/null
    agent-browser --session "$browser_session" wait --fn 'document.querySelector("#__nuxt")?.__vue_app__?.config.globalProperties.$nuxt?.isHydrating === false' >/dev/null
    agent-browser --session "$browser_session" wait --text "$expected_text" >/dev/null
    agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
    agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-management-${name}-desktop.png" >/dev/null
    agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
    agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
    agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-management-${name}-mobile.png" >/dev/null
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
  agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-management-stop-confirmation-desktop.png" >/dev/null
  agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
  agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
  agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-management-stop-confirmation-mobile.png" >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[role=dialog] button")).find(button => button.textContent?.trim() === "Neukončovat")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --fn '!document.querySelector("[role=dialog]") && document.activeElement?.textContent?.includes("Ukončit odběr")' >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("[data-testid=\"notification-stop-trigger\"]")?.focus(); document.querySelector("[data-testid=\"notification-stop-trigger\"]")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --text "Opravdu chceš ukončit odběr" >/dev/null
  agent-browser --session "$browser_session" eval 'Array.from(document.querySelectorAll("[role=dialog] button")).find(button => button.textContent?.trim() === "Ukončit odběr")?.click()' >/dev/null
  agent-browser --session "$browser_session" wait --text "Odběr je ukončený" >/dev/null
  agent-browser --session "$browser_session" set viewport 1440 900 >/dev/null
  agent-browser --session "$browser_session" scrollintoview 'h1' >/dev/null
  agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-management-stopped-desktop.png" >/dev/null
  agent-browser --session "$browser_session" set viewport 320 800 >/dev/null
  agent-browser --session "$browser_session" scrollintoview 'h1' >/dev/null
  agent-browser --session "$browser_session" eval 'document.documentElement.scrollWidth <= window.innerWidth' | grep -q true
  agent-browser --session "$browser_session" screenshot "$screenshot_dir/notification-management-stopped-mobile.png" >/dev/null

  capture_management_state 'notification-ui-management-pending-reactivation' pending-reactivation 'Znovu aktivovat odběr'
  agent-browser --session "$browser_session" eval 'document.body.innerText.includes("+1555 ••• ••••") && !document.body.innerText.includes("notification-ui")' | grep -q true
  capture_management_state 'not-a-valid-token' malformed 'Odkaz pro správu není dostupný'
  capture_management_state 'notification-ui-management-old' old 'Odkaz pro správu není dostupný'
  capture_management_state 'notification-ui-management-unavailable' unavailable 'Odkaz pro správu není dostupný'
  agent-browser --session "$browser_session" eval 'document.body.innerText.includes("Zkontroluj celý odkaz nebo si nech poslat nový odkaz pro správu.")' | grep -q true
  agent-browser --session "$browser_session" eval '!document.body.innerText.includes("Oznámení ve webu") && document.body.innerText.includes("Nechat si poslat nový odkaz")' | grep -q true
  agent-browser --session "$browser_session" click 'button[role=combobox]' >/dev/null
  agent-browser --session "$browser_session" find role option click --name 'SMS' --exact >/dev/null
  agent-browser --session "$browser_session" wait --fn 'document.querySelector("input[name=recovery-contact]")?.getAttribute("autocomplete") === "tel" && !document.querySelector("[role=listbox]")' >/dev/null
  agent-browser --session "$browser_session" eval 'document.querySelector("input[name=recovery-contact]")?.getAttribute("autocomplete") === "tel"' | grep -q true
  agent-browser --session "$browser_session" click 'button[role=combobox]' >/dev/null
  agent-browser --session "$browser_session" find role option click --name 'E-mail' --exact >/dev/null
  agent-browser --session "$browser_session" wait --fn 'document.querySelector("input[name=recovery-contact]")?.getAttribute("autocomplete") === "email" && !document.querySelector("[role=listbox]")' >/dev/null
  agent-browser --session "$browser_session" fill 'input[name="recovery-contact"]' 'recovery@example.test' >/dev/null
  agent-browser --session "$browser_session" wait --fn '(() => { const input = document.querySelector("input[name=recovery-contact]"); const submit = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Poslat odkaz pro správu"); if (!input?.value || !input.checkValidity() || !submit || submit.disabled || document.querySelector("[role=listbox]")) return false; const rect = submit.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && submit.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })()' >/dev/null
  agent-browser --session "$browser_session" eval 'window.__notificationChallengeProof.failNextRender=true' >/dev/null
  agent-browser --session "$browser_session" find role button click --name 'Poslat odkaz pro správu' >/dev/null
  agent-browser --session "$browser_session" wait --text 'Ověření se nepodařilo načíst.' >/dev/null
  agent-browser --session "$browser_session" find role button click --name 'Zkusit ověření znovu' --exact >/dev/null
  acquire_challenge 'Ověřit požadavek' 'notification-ui-verification-token'
  agent-browser --session "$browser_session" wait --fn '(() => { const input = document.querySelector("input[name=recovery-contact]"); const submit = Array.from(document.querySelectorAll("button")).find(button => button.textContent?.trim() === "Poslat odkaz pro správu"); if (!input?.value || !input.checkValidity() || !submit || submit.disabled || document.querySelector("[role=listbox]")) return false; const rect = submit.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && submit.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })()' >/dev/null
  agent-browser --session "$browser_session" find role button click --name 'Poslat odkaz pro správu' >/dev/null
  agent-browser --session "$browser_session" wait --text 'Pokud máš na tomto kontaktu odběr' >/dev/null
  capture_challenge_proof notification-management
fi

echo "Notification lifecycle UI verification passed (${mode})."
