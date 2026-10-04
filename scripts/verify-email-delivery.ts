import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { sendBrevoEventEmail } from '../server/utils/brevoEmail.ts'

export type EmailVerificationMode = 'preflight' | 'sandbox' | 'callback' | 'live-canary' | 'readiness'
type EvidenceKind = 'local-candidate' | 'production-observation'
type Gate = 'artifacts' | 'deployment' | 'bindings' | 'migration' | 'sender' | 'dns' | 'callbackMetadata' | 'https' | 'switch' | 'publicReadiness' | 'sandbox' | 'callback' | 'liveCanary' | 'humanInbox' | 'humanCalendar' | 'humanLink' | 'humanLogs'
const gates: Gate[] = ['artifacts', 'deployment', 'bindings', 'migration', 'sender', 'dns', 'callbackMetadata', 'https', 'switch', 'publicReadiness', 'sandbox', 'callback', 'liveCanary', 'humanInbox', 'humanCalendar', 'humanLink', 'humanLogs']
const modes = new Set<EmailVerificationMode>(['preflight', 'sandbox', 'callback', 'live-canary', 'readiness'])
const day = 24 * 60 * 60 * 1000
const maximumBytes = 16 * 1024 * 1024
const timeoutMs = 15_000
const callbackEvents = ['delivered', 'softBounce', 'hardBounce', 'blocked', 'spam', 'unsubscribed']

export interface EmailVerificationOptions {
  mode: EmailVerificationMode
  target: 'production'
  configPath: string
  expectationsPath: string
  artifactsPath: string
  expectedSwitch: boolean
  authorizeProbe?: boolean
  approveReadiness?: boolean
  evidencePath?: string
}

export interface EmailVerificationDependencies {
  fetch: typeof fetch
  command: (args: readonly string[], options: { timeoutMs: number, maxBytes: number, accountId: string }) => Promise<string>
  readFile: (path: string) => Promise<Uint8Array>
  now: () => number
  environment: NodeJS.ProcessEnv
  evidenceKind: EvidenceKind
}

export interface EmailVerificationEvidence {
  channel: 'email'
  targetIdentity: string
  deploymentId: string
  bundleHash: string
  migrationHash: string
  configHash: string
  manualSwitch: boolean
  verifiedAt: string
  expiresAt: string
  evidenceKind: EvidenceKind
  mode: EmailVerificationMode
  gates: Record<Gate, 'passed' | 'pending'>
}

const fail = (code: string): never => { throw new Error(`Email verification failed: ${code}`) }
const check: (value: unknown, code: string) => asserts value = (value, code) => { if (!value) fail(code) }
const record = (value: unknown): Record<string, unknown> => {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), 'shape')
  return value as Record<string, unknown>
}
const rows = (value: unknown): Record<string, unknown>[] => {
  check(Array.isArray(value) && value.length <= 10_000, 'shape')
  return value.map(record)
}
const text = (value: unknown, pattern = /^[A-Za-z0-9_.-]{1,128}$/) => {
  check(typeof value === 'string' && pattern.test(value), 'configuration')
  return value
}
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown) => text(value, /^[a-f0-9]{64}$/)
const json = (bytes: Uint8Array | string): unknown => {
  check(Buffer.byteLength(bytes) <= maximumBytes, 'size')
  try { return JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8')) } catch { return fail('json') }
}
const required = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]
  check(typeof value === 'string' && value.trim(), 'credentials')
  return value
}
const bounded = async <T>(operation: Promise<T>, milliseconds = timeoutMs): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), milliseconds) })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Validates generated JSON, shared by the CLI and the local built-Worker safety gate. */
export const validateNotificationDeploymentConfiguration = (input: unknown, profile: 'production' | 'preview', expected = { worker: 'jednadvacetorg-web', d1Id: '76d271b2-5335-40ba-81dd-bf7e1ef79522', d1Name: 'web', queue: 'notification-messages', dlq: 'notification-messages-dlq' }) => {
  const config = record(input)
  check(config.name === expected.worker && typeof config.main === 'string', 'worker')
  const databases = rows(config.d1_databases)
  const d1 = databases.filter(binding => binding.binding === 'DB')
  check(d1.length === 1, 'd1')
  // Every binding is local-only in this gate, including non-notification bindings.
  for (const field of ['d1_databases', 'kv_namespaces', 'r2_buckets', 'services', 'dispatch_namespaces']) for (const binding of rows(config[field] ?? [])) check(binding.remote !== true, 'remote-binding')
  check(!config.services || rows(config.services).length === 0, 'service-binding')
  const queues = config.queues ? record(config.queues) : {}
  const producers = rows(queues.producers ?? [])
  const consumers = rows(queues.consumers ?? [])
  for (const binding of producers) check(binding.remote !== true, 'remote-binding')
  check(!config.ai && !config.browser && !config.images && rows(config.hyperdrive ?? []).length === 0 && rows(config.vectorize ?? []).length === 0 && rows(config.dispatch_namespaces ?? []).length === 0, 'external-binding')
  const crons = config.triggers ? record(config.triggers).crons : []
  check(Array.isArray(crons), 'cron')
  if (profile === 'preview') {
    check(databases.length === 1 && d1[0]!.database_name === 'web-preview' && !d1[0]!.database_id, 'preview-d1')
    check(rows(config.kv_namespaces ?? []).length === 0 && rows(config.r2_buckets ?? []).length === 0 && producers.length === 0 && consumers.length === 0 && crons.length === 0, 'preview-production-binding')
  } else {
    check(d1[0]!.database_id === expected.d1Id && d1[0]!.database_name === expected.d1Name, 'd1')
    check(producers.filter(binding => binding.binding === 'NOTIFICATION_MESSAGES_QUEUE' && binding.queue === expected.queue).length === 1, 'queue')
    check(consumers.filter(binding => binding.queue === expected.queue && binding.dead_letter_queue === expected.dlq).length === 1, 'dlq')
    check(crons.includes('13 * * * *'), 'cron')
  }
  const logs = record(record(config.observability).logs)
  check(logs.enabled === true && logs.persist === true && logs.invocation_logs === true, 'observability')
}

export const emailVerificationTarget = (value: unknown): 'production' => {
  check(value === 'production', 'target production')
  return value
}

export const parseEmailVerificationArgs = (args: string[]): EmailVerificationOptions => {
  const mode = args[0] as EmailVerificationMode
  const values = new Map<string, string>()
  const switches = new Set(['--authorize-probe', '--approve-readiness'])
  const flags = new Set(['--target', '--config', '--expectations', '--artifacts', '--expect-switch', '--evidence', ...switches])
  check(modes.has(mode), 'Usage')
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!
    check(flags.has(flag) && !values.has(flag), 'Usage')
    const value = switches.has(flag) ? 'true' : args[++index]
    check(value && !value.startsWith('--'), 'Usage')
    values.set(flag, value)
  }
  check(['--target', '--config', '--expectations', '--artifacts', '--expect-switch'].every(flag => values.has(flag)), 'Usage')
  check(['true', 'false'].includes(values.get('--expect-switch')!), 'Usage')
  check(!values.has('--authorize-probe') || ['sandbox', 'callback', 'live-canary'].includes(mode), 'Usage')
  check(!values.has('--approve-readiness') || mode === 'readiness', 'Usage')
  check(!values.has('--evidence') || mode === 'readiness', 'Usage')
  return {
    mode, target: emailVerificationTarget(values.get('--target')),
    configPath: values.get('--config')!, expectationsPath: values.get('--expectations')!, artifactsPath: values.get('--artifacts')!,
    expectedSwitch: values.get('--expect-switch') === 'true', authorizeProbe: values.has('--authorize-probe'),
    approveReadiness: values.has('--approve-readiness'), evidencePath: values.get('--evidence'),
  }
}

/** The only command shape this verifier can construct: read-only D1 SQL, no shell or write commands. */
const d1Args = (databaseId: string, configPath: string, sql: string) => ['d1', 'execute', databaseId, '--remote', '--config', resolve(configPath), '--json', '--command', sql]
const migrationSql = 'SELECT name FROM _hub_migrations ORDER BY name'
const callbackSql = (id: string, contactId?: number) => `SELECT d.id, d.status, d.provider_message_id, d.contact_id, (SELECT c.destination FROM notification_contacts c WHERE c.id = d.contact_id AND c.channel = 'email' AND c.capability_generation = d.expected_capability_generation AND c.state = 'active') AS destination, (SELECT COUNT(*) FROM notification_delivery_callbacks c WHERE c.delivery_id = d.id) AS receipts, EXISTS(SELECT 1 FROM notification_suppressions s WHERE s.channel = 'email' AND s.destination_hash = d.destination_hash) AS suppressed, EXISTS(SELECT 1 FROM notification_contacts c WHERE c.id = d.contact_id) AS contact_present, (SELECT COUNT(*) FROM notification_outbox o WHERE o.contact_id = ${contactId ?? 'd.contact_id'} AND (o.status IN ('pending','queued','claimed') OR (o.status = 'invalidated' AND (o.payload_ciphertext IS NOT NULL OR o.payload_iv IS NOT NULL)))) AS nonterminal FROM notification_event_deliveries d WHERE d.id = '${id}'`

/** One dispatcher for both the CLI and offline tests. It never installs evidence or enables delivery. */
export const runEmailVerification = async (options: EmailVerificationOptions, dependencies: EmailVerificationDependencies): Promise<EmailVerificationEvidence> => {
  // Never forward adapter, provider, file or command errors across this boundary.
  let stage = 'configuration'
  try {
    check(modes.has(options.mode) && options.target === 'production' && typeof options.expectedSwitch === 'boolean', stage)
    check(['local-candidate', 'production-observation'].includes(dependencies.evidenceKind), stage)
    if (['sandbox', 'callback', 'live-canary'].includes(options.mode)) check(options.authorizeProbe && options.expectedSwitch === false, 'probe-authorization')
    if (options.mode === 'readiness') check(options.approveReadiness && options.expectedSwitch && options.evidencePath, 'readiness-approval')
    const env = dependencies.environment
    const apiKey = required(env, 'NUXT_BREVO_API_KEY')
    const callbackSecret = required(env, 'NUXT_BREVO_CALLBACK_SECRET')
    check(/^[A-Za-z0-9_-]{43}$/.test(required(env, 'NUXT_NOTIFICATION_ROOT_KEY')) && Buffer.from(env.NUXT_NOTIFICATION_ROOT_KEY!, 'base64url').length === 32 && Buffer.from(env.NUXT_NOTIFICATION_ROOT_KEY!, 'base64url').toString('base64url') === env.NUXT_NOTIFICATION_ROOT_KEY, 'root')
    const cfToken = required(env, 'CLOUDFLARE_API_TOKEN')
    const read = async (path: string) => {
      const bytes = await bounded(dependencies.readFile(resolve(path)))
      check(bytes.byteLength <= maximumBytes, 'size')
      return bytes
    }
    const expected = record(json(await read(options.expectationsPath)))
    const target = {
      accountId: text(expected.accountId, /^[a-f0-9]{32}$/), worker: text(expected.worker),
      d1Id: text(expected.d1Id, /^[a-f0-9-]{36}$/), d1Name: text(expected.d1Name),
      queue: text(expected.queue), queueId: text(expected.queueId, /^[a-f0-9]{32}$/),
      dlq: text(expected.dlq), dlqId: text(expected.dlqId, /^[a-f0-9]{32}$/),
      zoneId: text(expected.zoneId, /^[a-f0-9]{32}$/),
    }
    check(target.worker === 'jednadvacetorg-web' && target.d1Name === 'web' && target.queue === 'notification-messages' && target.dlq === 'notification-messages-dlq', 'target')
    const deploymentId = text(expected.deploymentId, /^[a-f0-9-]{36}$/)
    const versionId = text(expected.versionId, /^[a-f0-9-]{36}$/)
    const targetIdentity = hash(JSON.stringify(target))
    const origin = 'https://jednadvacet.org'
    check(expected.managementBaseUrl === `${origin}/notifications/manage/` && expected.callbackUrl === `${origin}/api/notifications/brevo-events`, 'https')
    const configBytes = await read(options.configPath)
    const config = record(json(configBytes))
    const configHash = hash(configBytes)
    check(configHash === digest(expected.configHash), 'config-hash')
    validateNotificationDeploymentConfiguration(config, 'production', target)
    const logging = (settings: Record<string, unknown>) => {
      const logs = record(record(settings.observability).logs)
      check(logs.enabled === true && logs.persist === true && logs.invocation_logs === true, 'observability')
    }
    logging(config)

    stage = 'artifacts'
    const inventory = record(json(await read(options.artifactsPath)))
    const root = dirname(resolve(options.configPath))
    const modules = rows(inventory.modules)
    check(modules.length > 0 && modules.length <= 1000, stage)
    const moduleHashes: [string, string][] = []
    for (const module of modules) {
      const name = text(module.name, /^[A-Za-z0-9_./-]{1,256}$/)
      check(!name.split('/').includes('..') && !name.startsWith('/') && !moduleHashes.some(([key]) => key === name), stage)
      moduleHashes.push([name, hash(await read(resolve(root, name)))])
    }
    const main = text(config.main, /^[A-Za-z0-9_./-]{1,256}$/).replace(/^\.\//, '')
    check(moduleHashes.some(([name]) => name === main), stage)
    moduleHashes.sort(([left], [right]) => left.localeCompare(right))
    // This is the emitted assets manifest, not a claim that the files were uploaded.
    const assetsHash = hash(await read(text(inventory.assetsManifest, /^.{1,1024}$/)))
    const bundleHash = hash(JSON.stringify({ modules: moduleHashes, assetsHash }))
    const migrations = rows(inventory.migrations)
    check(migrations.length > 0 && migrations.length <= 100, stage)
    const migrationHashes: [string, string][] = []
    for (const migration of migrations) {
      const name = text(migration.name)
      check(!migrationHashes.some(([key]) => key === name), stage)
      migrationHashes.push([name, hash(await read(text(migration.path, /^.{1,1024}$/)))])
    }
    check(migrationHashes.every(([name], index) => index === 0 || migrationHashes[index - 1]![0] < name), 'migration-order')
    const migrationHash = hash(JSON.stringify(migrationHashes))
    check(bundleHash === digest(expected.bundleHash) && migrationHash === digest(expected.migrationHash), 'artifact-hash')

    const fetchResponse = async (url: string, init: RequestInit = {}) => bounded(dependencies.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }))
    const responseBytes = (response: Response) => bounded((async () => {
      check(response.body, 'body')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { value, done } = await bounded(reader.read())
          if (done) break
          size += value.byteLength
          check(size <= maximumBytes, 'size')
          chunks.push(value)
        }
      } finally { void reader.cancel().catch(() => {}) }
      return Buffer.concat(chunks)
    })())
    const getJson = async (url: string, headers: Record<string, string>) => {
      const response = await fetchResponse(url, { headers })
      check(response.ok, 'http')
      return record(json(await responseBytes(response)))
    }
    const cf = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}`
    const worker = `${cf}/workers/scripts/${target.worker}`
    const cfHeaders = { authorization: `Bearer ${cfToken}` }
    const api = async (url: string) => {
      const result = await getJson(url, cfHeaders)
      check(result.success === true, 'api')
      return result.result
    }
    const observeDeployment = async () => {
      const latest = rows(record(await api(`${worker}/deployments`)).deployments)[0]
      check(latest && latest.id === deploymentId, 'deployment')
      const versions = rows(latest.versions)
      check(versions.length === 1 && versions[0]!.version_id === versionId && versions[0]!.percentage === 100, 'deployment')
      return latest
    }
    stage = 'deployment'
    const deployed = await observeDeployment()
    // Authenticated release annotation binds the assets manifest and reviewed migration bytes.
    // D1 stores names, not SQL hashes; an independent migration rehearsal remains mandatory.
    check(record(deployed.annotations)['workers/message'] === `email:${bundleHash}:${migrationHash}:${configHash}`, 'release-binding')
    const downloaded = await fetchResponse(worker, { headers: cfHeaders })
    check(downloaded.ok && downloaded.headers.get('content-type')?.startsWith('multipart/form-data'), 'worker-content')
    check(downloaded.headers.get('cf-entrypoint') === main, 'worker-entrypoint')
    const parts = await new Response(await responseBytes(downloaded), { headers: { 'content-type': downloaded.headers.get('content-type')! } }).formData()
    const remoteHashes: [string, string][] = []
    for (const [name, value] of parts) {
      if (name === 'metadata') continue
      check(!remoteHashes.some(([key]) => key === name), 'worker-content')
      remoteHashes.push([name, hash(typeof value === 'string' ? value : new Uint8Array(await value.arrayBuffer()))])
    }
    remoteHashes.sort(([left], [right]) => left.localeCompare(right))
    check(JSON.stringify(remoteHashes) === JSON.stringify(moduleHashes), 'worker-bytes')

    stage = 'bindings'
    const settings = record(await api(`${worker}/settings`))
    logging(settings)
    const bindings = rows(settings.bindings)
    check(bindings.filter(binding => binding.type === 'd1' && binding.name === 'DB' && binding.id === target.d1Id).length === 1, 'd1')
    check(bindings.filter(binding => binding.type === 'queue' && binding.name === 'NOTIFICATION_MESSAGES_QUEUE' && binding.queue_name === target.queue).length === 1, 'queue')
    for (const name of ['NUXT_BREVO_API_KEY', 'NUXT_BREVO_CALLBACK_SECRET', 'NUXT_NOTIFICATION_ROOT_KEY']) check(bindings.some(binding => binding.type === 'secret_text' && binding.name === name), 'secrets')
    for (const [name, value] of [['NUXT_BREVO_SENDER_NAME', 'Jednadvacet.org'], ['NUXT_BREVO_SENDER_EMAIL', 'noreply@jednadvacet.org']]) check(bindings.filter(binding => binding.type === 'plain_text' && binding.name === name && binding.text === value).length === 1, 'sender-config')
    const manual = bindings.filter(binding => binding.type === 'plain_text' && binding.name === 'NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED')
    check(manual.length === 1 && typeof manual[0]!.text === 'string' && ['true', 'false'].includes(manual[0]!.text), 'switch')
    const manualSwitch = manual[0]!.text === 'true'
    check(manualSwitch === options.expectedSwitch, 'switch')
    check(rows(await api(`${worker}/schedules`)).some(schedule => schedule.cron === '13 * * * *'), 'cron')
    const queue = record(await api(`${cf}/queues/${target.queueId}`))
    const dlq = record(await api(`${cf}/queues/${target.dlqId}`))
    check(queue.queue_id === target.queueId && queue.queue_name === target.queue && dlq.queue_id === target.dlqId && dlq.queue_name === target.dlq, 'queue-identity')
    check(rows(queue.producers).some(producer => producer.type === 'worker' && producer.script === target.worker), 'queue-producer')
    check(rows(queue.consumers).some(consumer => consumer.type === 'worker' && consumer.script_name === target.worker && consumer.dead_letter_queue === target.dlq), 'queue-consumer')
    const domains = rows(await api(`${cf}/workers/domains?hostname=jednadvacet.org`))
    check(domains.filter(domain => domain.hostname === 'jednadvacet.org' && domain.service === target.worker && domain.zone_id === target.zoneId && domain.environment === 'production').length === 1, 'https-target')

    const commandRows = async (sql: string) => {
      const output = await bounded(dependencies.command(d1Args(target.d1Id, options.configPath, sql), { timeoutMs, maxBytes: maximumBytes, accountId: target.accountId }))
      const results = rows(json(output))
      check(results.length === 1 && results[0]!.success === true, 'd1-read')
      return rows(results[0]!.results)
    }
    stage = 'migration'
    const applied = await commandRows(migrationSql)
    check(JSON.stringify(applied.map(row => row.name)) === JSON.stringify(migrationHashes.map(([name]) => name)), stage)

    stage = 'provider-metadata'
    const brevoHeaders = { 'api-key': apiKey }
    await getJson('https://api.brevo.com/v3/account', brevoHeaders)
    const senders = await getJson('https://api.brevo.com/v3/senders', brevoHeaders)
    check(rows(senders.senders).some(sender => sender.name === 'Jednadvacet.org' && sender.email === 'noreply@jednadvacet.org' && sender.active === true), 'sender')
    const domain = await getJson('https://api.brevo.com/v3/senders/domains/jednadvacet.org', brevoHeaders)
    check(domain.domain === 'jednadvacet.org' && domain.verified === true && domain.authenticated === true, 'domain')
    const dns = record(domain.dns_records)
    for (const name of ['brevo_code', 'dkim_record', 'dmarc_record']) check(record(dns[name]).status === true, 'dns')
    const zoneUrl = `https://api.cloudflare.com/client/v4/zones/${target.zoneId}`
    const zone = record(await api(zoneUrl))
    check(zone.name === 'jednadvacet.org' && record(zone.account).id === target.accountId, 'dns-zone')
    const spfValue = text(expected.spfValue, /^v=spf1 [^\r\n]{1,1000} [~-]all$/)
    const rootTxt = rows(await api(`${zoneUrl}/dns_records?type=TXT&name=jednadvacet.org`)).filter(row => typeof row.content === 'string' && row.content.startsWith('v=spf1 '))
    check(rootTxt.length === 1 && rootTxt[0]!.name === 'jednadvacet.org' && rootTxt[0]!.content === spfValue, 'spf')
    for (const name of ['brevo_code', 'dkim_record', 'dmarc_record']) {
      const entry = record(dns[name])
      const host = text(entry.host_name, /^[A-Za-z0-9_.@-]{1,256}$/)
      const fqdn = host === '@' ? 'jednadvacet.org' : host.endsWith('.jednadvacet.org') ? host : `${host}.jednadvacet.org`
      check(entry.type === 'TXT' || entry.type === 'CNAME', 'dns-type')
      check(rows(await api(`${zoneUrl}/dns_records?type=${entry.type}&name=${encodeURIComponent(fqdn)}`)).some(row => row.name === fqdn && row.content === entry.value), 'dns-record')
    }
    const webhooks = await getJson('https://api.brevo.com/v3/webhooks?type=transactional', brevoHeaders)
    check(rows(webhooks.webhooks).some(hook => {
      const events = hook.events
      return hook.url === expected.callbackUrl && hook.type === 'transactional' && Array.isArray(events) && callbackEvents.every(event => events.includes(event)) && record(hook.auth).type === 'bearer' && record(hook.auth).token === callbackSecret
    }), 'callback-metadata')

    const outcomes = Object.fromEntries(gates.map(gate => [gate, 'pending'])) as EmailVerificationEvidence['gates']
    for (const gate of gates.slice(0, 10)) outcomes[gate] = 'passed'
    stage = 'public-readiness'
    const publicResponse = await fetchResponse(`${origin}/api/notifications/readiness`)
    check(publicResponse.ok && publicResponse.headers.get('cache-control')?.includes('no-store'), stage)
    const readiness = record(json(await responseBytes(publicResponse)))
    check(Object.keys(readiness).sort().join(',') === 'email,sms,webPush' && readiness.sms === false && readiness.webPush === false && readiness.email === (options.mode === 'readiness'), stage)

    if (options.mode === 'sandbox' || options.mode === 'live-canary') {
      stage = 'send'
      const suppressionRecipient = required(env, 'EMAIL_VERIFY_SUPPRESSION_RECIPIENT').trim().toLowerCase()
      const recipient = required(env, 'EMAIL_VERIFY_FINAL_RECIPIENT').trim().toLowerCase()
      check(recipient !== suppressionRecipient && /^[^\s@]+@[^\s@]+$/.test(recipient) && /^[^\s@]+@[^\s@]+$/.test(suppressionRecipient), 'canary-identity')
      const deliveryId = text(required(env, 'EMAIL_VERIFY_DELIVERY_ID'), /^[A-Za-z0-9_-]{12,128}$/)
      check(deliveryId !== text(required(env, 'EMAIL_VERIFY_SUPPRESSION_DELIVERY_ID'), /^[A-Za-z0-9_-]{12,128}$/), 'canary-identity')
      const capability = text(required(env, 'EMAIL_VERIFY_MANAGEMENT_TOKEN'), /^[A-Za-z0-9_-]{43}$/)
      if (options.mode === 'live-canary') {
        const durable = (await commandRows(callbackSql(deliveryId)))[0]
        check(durable && durable.id === deliveryId && durable.destination === recipient && durable.status === 'pending' && durable.provider_message_id === null && durable.receipts === 0 && durable.suppressed === 0 && durable.contact_present === 1 && durable.nonterminal === 0, 'live-fixture')
      }
      const result = await sendBrevoEventEmail({ apiKey, senderName: 'Jednadvacet.org', senderEmail: 'noreply@jednadvacet.org', sandbox: options.mode === 'sandbox' }, {
        deliveryId, recipient, managementUrl: `${origin}/notifications/manage/${capability}`, uid: `${deliveryId}@jednadvacet.org`, sequence: 0,
        event: { title: 'Ověření upozornění na bitcoinový sraz', start: new Date(dependencies.now() + day).toISOString(), end: new Date(dependencies.now() + day + 3_600_000).toISOString(), location: 'Testovací místo' },
      }, (async (url, init) => {
        const response = await fetchResponse(String(url), init)
        return new Response(await responseBytes(response), { status: response.status, headers: response.headers })
      }) as typeof fetch)
      check(result.attempted && result.status === 'submitted', 'send-result')
      outcomes[options.mode === 'sandbox' ? 'sandbox' : 'liveCanary'] = 'passed'
      if (options.mode === 'live-canary') {
        // The operator must have prepared a durable canary delivery through existing lifecycle tools.
        const durable = (await commandRows(callbackSql(deliveryId)))[0]
        check(durable && durable.id === deliveryId && durable.status === 'delivered' && durable.provider_message_id === result.providerMessageId && durable.receipts === 1 && durable.suppressed === 0, 'live-correlation')
      }
    }

    if (options.mode === 'callback') {
      stage = 'callback-probe'
      const deliveryId = text(required(env, 'EMAIL_VERIFY_SUPPRESSION_DELIVERY_ID'), /^[A-Za-z0-9_-]{12,128}$/)
      const finalId = text(required(env, 'EMAIL_VERIFY_DELIVERY_ID'), /^[A-Za-z0-9_-]{12,128}$/)
      check(deliveryId !== finalId && required(env, 'EMAIL_VERIFY_SUPPRESSION_RECIPIENT').trim().toLowerCase() !== required(env, 'EMAIL_VERIFY_FINAL_RECIPIENT').trim().toLowerCase(), 'canary-identity')
      const eventId = text(required(env, 'EMAIL_VERIFY_CALLBACK_EVENT_ID'), /^[A-Za-z0-9_-]{12,128}$/)
      const before = (await commandRows(callbackSql(deliveryId)))[0]
      check(before && before.id === deliveryId && before.destination === required(env, 'EMAIL_VERIFY_SUPPRESSION_RECIPIENT').trim().toLowerCase() && before.status === 'submitted' && before.receipts === 0 && before.suppressed === 0 && before.contact_present === 1 && Number.isSafeInteger(before.contact_id) && Number(before.contact_id) > 0, 'callback-fixture')
      const contactId = Number(before.contact_id)
      const payload = { id: eventId, event: 'hardbounce', 'X-Mailin-custom': deliveryId, messageId: text(before.provider_message_id, /^[A-Za-z0-9_-]{12,256}$/), date: new Date(dependencies.now()).toISOString() }
      const post = async (body: unknown, authenticated: boolean) => {
        const response = await fetchResponse(String(expected.callbackUrl), { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${callbackSecret}` } : {}) }, body: JSON.stringify(body) })
        await responseBytes(response)
        return response
      }
      check((await post(payload, false)).status === 401, 'callback-auth')
      check(JSON.stringify((await commandRows(callbackSql(deliveryId)))[0]) === JSON.stringify(before), 'callback-auth-state')
      check((await post({ ...payload, 'X-Mailin-custom': `${deliveryId}_unmapped` }, true)).ok, 'callback-correlation')
      check(JSON.stringify((await commandRows(callbackSql(deliveryId)))[0]) === JSON.stringify(before), 'callback-correlation')
      check((await post(payload, true)).ok, 'callback-http')
      const after = (await commandRows(callbackSql(deliveryId, contactId)))[0]
      check(after && after.id === deliveryId && after.provider_message_id === before.provider_message_id && after.status === 'hard-bounce' && after.receipts === 1 && after.suppressed === 1 && after.contact_present === 0 && after.nonterminal === 0, 'callback-durable')
      check((await post(payload, true)).ok, 'callback-replay')
      check(JSON.stringify((await commandRows(callbackSql(deliveryId, contactId)))[0]) === JSON.stringify(after), 'callback-replay-state')
      outcomes.callback = 'passed'
    }

    let evidenceExpiry = dependencies.now() + day
    if (options.mode === 'readiness') {
      stage = 'evidence'
      const evidence = rows(json(await read(options.evidencePath!)))
      const probeDeploymentId = expected.probeDeploymentId === undefined ? deploymentId : text(expected.probeDeploymentId, /^[a-f0-9-]{36}$/)
      if (probeDeploymentId !== deploymentId) {
        const history = rows(record(await api(`${worker}/deployments`)).deployments)
        const probe = history.find(deployment => deployment.id === probeDeploymentId)
        check(probe && record(probe.annotations)['workers/message'] === `email:${bundleHash}:${migrationHash}:${configHash}`, 'evidence-deployment')
      }
      const requiredModes: EmailVerificationMode[] = ['preflight', 'sandbox', 'callback', 'live-canary']
      check(evidence.length === requiredModes.length && new Set(evidence.map(item => item.mode)).size === requiredModes.length, stage)
      for (const mode of requiredModes) {
        const item = evidence.find(item => item.mode === mode)
        check(item && item.channel === 'email' && item.evidenceKind === dependencies.evidenceKind && item.targetIdentity === targetIdentity && item.deploymentId === probeDeploymentId && item.bundleHash === bundleHash && item.migrationHash === migrationHash && item.configHash === configHash && item.manualSwitch === false, stage)
        const verifiedAt = Date.parse(String(item.verifiedAt))
        const expiresAt = Date.parse(String(item.expiresAt))
        const now = dependencies.now()
        check(Number.isFinite(verifiedAt) && Number.isFinite(expiresAt) && verifiedAt <= now + 300_000 && now - verifiedAt <= day && expiresAt > now && expiresAt > verifiedAt && expiresAt - verifiedAt <= day, 'evidence-time')
        evidenceExpiry = Math.min(evidenceExpiry, expiresAt)
        const proven = record(item.gates)
        for (const gate of gates.slice(0, 10)) check(proven[gate] === 'passed', 'evidence-gate')
        if (mode !== 'preflight') check(proven[mode === 'live-canary' ? 'liveCanary' : mode] === 'passed', 'evidence-gate')
        if (mode === 'live-canary') for (const gate of ['humanInbox', 'humanCalendar', 'humanLink', 'humanLogs'] as Gate[]) check(proven[gate] === 'passed', 'human-evidence')
      }
      for (const gate of gates) outcomes[gate] = 'passed'
    }
    stage = 'deployment-recheck'
    await observeDeployment()
    const verifiedAt = dependencies.now()
    check(Number.isFinite(verifiedAt) && verifiedAt < evidenceExpiry, 'clock')
    return { channel: 'email', targetIdentity, deploymentId, bundleHash, migrationHash, configHash, manualSwitch, verifiedAt: new Date(verifiedAt).toISOString(), expiresAt: new Date(Math.min(verifiedAt + day, evidenceExpiry)).toISOString(), evidenceKind: dependencies.evidenceKind, mode: options.mode, gates: outcomes }
  } catch { return fail(stage) }
}

const main = async () => {
  try {
    const options = parseEmailVerificationArgs(process.argv.slice(2))
    const result = await runEmailVerification(options, {
      readFile, fetch, now: Date.now, environment: process.env, evidenceKind: 'production-observation',
      command: (args, limits) => new Promise((accept, reject) => {
        execFile(resolve('node_modules/.bin/wrangler'), [...args], {
          timeout: limits.timeoutMs, maxBuffer: limits.maxBytes,
          // Do not discover credentials or inherit unrelated provider secrets in child commands.
          env: { PATH: process.env.PATH, HOME: process.env.HOME, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: limits.accountId, WRANGLER_SEND_METRICS: 'false' },
        }, (error, stdout) => error ? reject(new Error('command')) : accept(stdout))
      }),
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stderr.write('Email verification failed; consult the operations runbook.\n')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
