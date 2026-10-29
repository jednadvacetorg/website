import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'

import * as operations from '../scripts/verify-email-delivery.ts'
import { processBrevoCallbackBody } from '../server/api/notifications/brevo-events.post.ts'
import type { NotificationDatabase, NotificationStatement } from '../server/utils/notifications.ts'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (filename: string) => {
  close(): void
  exec(sql: string): void
  prepare(sql: string): {
    all(...values: unknown[]): Record<string, unknown>[]
    get(...values: unknown[]): Record<string, unknown> | undefined
    run(...values: unknown[]): { changes: number }
  }
  transaction<T>(operation: () => T): () => T
}

const now = Date.parse('2026-10-04T12:00:00Z')
const day = 86_400_000
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const sentinels = ['private-api-key', 'private-callback-bearer', 'private-cloudflare-token', 'suppression@example.test', 'final@example.test', 'private-provider-body', 'private-command-error', 'A'.repeat(43), 'callback_event_123456', 'final_delivery_123456', '201798300811.5787683@relay.domain.com']
const safe = (value: unknown) => { for (const sentinel of sentinels) assert.ok(!String(typeof value === 'string' ? value : JSON.stringify(value)).includes(sentinel), sentinel) }

if (process.env.NOTIFICATION_CONFIG_ISOLATION === 'true') test('generated notification configuration production/preview isolation and negative controls', async () => {
  assert.ok(process.env.NOTIFICATION_PRODUCTION_CONFIG, 'actual production artifact path is required')
  assert.ok(process.env.NOTIFICATION_PREVIEW_CONFIG, 'actual preview artifact path is required')
  const production = JSON.parse(await readFile(process.env.NOTIFICATION_PRODUCTION_CONFIG, 'utf8'))
  const preview = JSON.parse(await readFile(process.env.NOTIFICATION_PREVIEW_CONFIG, 'utf8'))
  operations.validateNotificationDeploymentConfiguration(production, 'production')
  operations.validateNotificationDeploymentConfiguration(preview, 'preview')
  assert.ok(production.triggers.crons.includes('* * * * *'), 'minute publication cron is required')
  assert.ok(production.triggers.crons.includes('13 * * * *'), 'hourly planner cron is retained')
  for (const cron of ['* * * * *', '13 * * * *']) {
    const withoutCron = structuredClone(production)
    withoutCron.triggers.crons = withoutCron.triggers.crons.filter((value: string) => value !== cron)
    assert.throws(() => {
      operations.validateNotificationDeploymentConfiguration(withoutCron, 'production')
      assert.ok(withoutCron.triggers.crons.includes('* * * * *'), 'minute publication cron is required')
    })
  }
  for (const field of ['producers', 'consumers']) {
    const withoutQueue = structuredClone(production)
    withoutQueue.queues[field] = withoutQueue.queues[field].filter((binding: { queue: string }) => binding.queue !== 'notification-messages')
    assert.throws(() => operations.validateNotificationDeploymentConfiguration(withoutQueue, 'production'), field === 'producers' ? /queue/ : /dlq/)
  }
  const withoutDlq = structuredClone(production)
  delete withoutDlq.queues.consumers.find((binding: { queue: string }) => binding.queue === 'notification-messages').dead_letter_queue
  assert.throws(() => operations.validateNotificationDeploymentConfiguration(withoutDlq, 'production'), /dlq/)
  const withProductionDatabase = structuredClone(preview)
  withProductionDatabase.d1_databases = structuredClone(production.d1_databases)
  assert.throws(() => operations.validateNotificationDeploymentConfiguration(withProductionDatabase, 'preview'), /preview-d1/)
  for (const field of ['queues', 'kv_namespaces', 'r2_buckets', 'triggers']) {
    assert.throws(() => operations.validateNotificationDeploymentConfiguration({ ...preview, [field]: structuredClone(production[field]) }, 'preview'), field === 'kv_namespaces' ? /preview-kv/ : /preview-production-binding/, field)
  }
  const withRemoteDatabase = structuredClone(production)
  withRemoteDatabase.d1_databases[0].remote = true
  assert.throws(() => operations.validateNotificationDeploymentConfiguration(withRemoteDatabase, 'production'), /remote-binding/)
  const withoutLogs = structuredClone(production)
  withoutLogs.observability.logs.invocation_logs = false
  assert.throws(() => operations.validateNotificationDeploymentConfiguration(withoutLogs, 'production'), /observability/)
})

const fixture = async (t: TestContext, contract: {
  responseId?: unknown
  storedId?: string
  deliver?: boolean
  callback?: (payload: Record<string, unknown>) => Record<string, unknown>
} = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'email-operations-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = {
    name: 'jednadvacetorg-web', main: 'index.mjs',
    d1_databases: [{ binding: 'DB', database_name: 'web', database_id: '11111111-1111-1111-1111-111111111111' }],
    queues: { producers: [{ binding: 'NOTIFICATION_MESSAGES_QUEUE', queue: 'notification-messages' }], consumers: [{ queue: 'notification-messages', dead_letter_queue: 'notification-messages-dlq' }] },
    triggers: { crons: ['13 * * * *'] }, observability: { logs: { enabled: true, persist: true, invocation_logs: true } },
  }
  const configBytes = JSON.stringify(config)
  const migrationNames = ['0000_majestic_lightspeed']
  const migrationBytes = await Promise.all(migrationNames.map(name => readFile(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8')))
  const migrationPaths = ['migration.sql']
  const moduleBytes = 'import "./chunk.mjs"; export default {}'
  const chunkBytes = 'export const message = "candidate"'
  const manifestBytes = '{"/asset.css":{"hash":"asset-byte-hash","size":12}}'
  const expected = {
    accountId: 'a'.repeat(32), worker: config.name, d1Id: config.d1_databases[0]!.database_id, d1Name: 'web',
    queue: 'notification-messages', queueId: 'b'.repeat(32), dlq: 'notification-messages-dlq', dlqId: 'c'.repeat(32), zoneId: 'd'.repeat(32),
    deploymentId: '22222222-2222-2222-2222-222222222222', versionId: '33333333-3333-3333-3333-333333333333',
    managementBaseUrl: 'https://jednadvacet.org/notifications/manage/', callbackUrl: 'https://jednadvacet.org/api/notifications/brevo-events',
    spfValue: 'v=spf1 include:spf.sendinblue.com ~all',
    configHash: sha(configBytes), bundleHash: sha(JSON.stringify({ modules: [['chunk.mjs', sha(chunkBytes)], ['index.mjs', sha(moduleBytes)]], assetsHash: sha(manifestBytes) })),
    migrationHash: sha(JSON.stringify(migrationNames.map((name, index) => [name, sha(migrationBytes[index]!)]))),
  }
  const options: operations.EmailVerificationOptions = { mode: 'preflight', target: 'production', configPath: join(directory, 'wrangler.json'), expectationsPath: join(directory, 'expectations.json'), artifactsPath: join(directory, 'artifacts.json'), expectedSwitch: false }
  const save = (name: string, value: unknown) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value))
  await Promise.all([
    save('wrangler.json', configBytes), save('expectations.json', expected), save('index.mjs', moduleBytes), save('chunk.mjs', chunkBytes),
    save('assets.json', manifestBytes), ...migrationPaths.map((path, index) => save(path, migrationBytes[index]!)),
    save('artifacts.json', { modules: [{ name: 'index.mjs' }, { name: 'chunk.mjs' }], assetsManifest: join(directory, 'assets.json'), migrations: migrationNames.map((name, index) => ({ name, path: join(directory, migrationPaths[index]!) })) }),
  ])
  const sqlite = new Database(':memory:')
  t.after(() => sqlite.close())
  for (const sql of migrationBytes) sqlite.exec(sql)
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE _hub_migrations (name TEXT);')
  for (const name of migrationNames) sqlite.prepare('INSERT INTO _hub_migrations VALUES (?)').run(name)
  sqlite.exec("INSERT INTO notification_contacts (id, channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (1, 'email', 'suppression@example.test', 'synthetic-hash', 'synthetic-digest', 1, 'active', '2026-10-04', '1', '2026-10-04', '2026-10-04'); INSERT INTO notification_outbox (id, contact_id, expected_capability_generation, version, status, payload_ciphertext, payload_iv, kind, created_at, updated_at) VALUES ('outbox_123456789', 1, 1, 1, 'queued', 'encrypted', 'iv', 'event-email', '2026-10-04', '2026-10-04');")
  sqlite.prepare("INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, provider_message_id, created_at, updated_at) VALUES ('suppression_delivery_123', 1, 1, 'synthetic-hash', 'synthetic-event', 0, 'created', 'submitted', ?, '2026-10-04', '2026-10-04')").run(contract.storedId ?? '201798300811.5787683@relay.domain.com')
  sqlite.exec("INSERT INTO notification_contacts (id, channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (2, 'email', 'final@example.test', 'final-hash', 'final-digest', 1, 'active', '2026-10-04', '1', '2026-10-04', '2026-10-04'); INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, provider_message_id, created_at, updated_at) VALUES ('final_delivery_123456', 2, 1, 'final-hash', 'final-event', 0, 'created', 'pending', NULL, '2026-10-04', '2026-10-04')")
  const executions = new WeakMap<NotificationStatement, () => unknown>()
  const database: NotificationDatabase = {
    prepare(query) {
      let values: unknown[] = []
      const execute = () => ({ meta: { changes: sqlite.prepare(query).run(...values).changes } })
      const statement: NotificationStatement = {
        bind(...next) { values = next; return statement }, first: async <T>() => sqlite.prepare(query).get(...values) as T | null,
        all: async <T>() => ({ results: sqlite.prepare(query).all(...values) as T[] }), run: async () => execute(),
      }
      executions.set(statement, execute)
      return statement
    },
    batch: async statements => sqlite.transaction(() => statements.map(statement => executions.get(statement)!()))(),
  }
  const requests: { url: string, init: RequestInit }[] = []
  const commands: string[][] = []
  const deployments = { deployments: [{ id: expected.deploymentId, versions: [{ percentage: 100, version_id: expected.versionId }], annotations: { 'workers/message': `email:${expected.bundleHash}:${expected.migrationHash}:${expected.configHash}` } }] }
  const settings = {
    observability: config.observability,
    bindings: [
      { type: 'd1', name: 'DB', id: expected.d1Id }, { type: 'queue', name: 'NOTIFICATION_MESSAGES_QUEUE', queue_name: expected.queue },
      ...['NUXT_BREVO_API_KEY', 'NUXT_BREVO_CALLBACK_SECRET', 'NUXT_NOTIFICATION_ROOT_KEY'].map(name => ({ type: 'secret_text', name })),
      { type: 'plain_text', name: 'NUXT_BREVO_SENDER_NAME', text: 'Jednadvacet.org' },
      { type: 'plain_text', name: 'NUXT_BREVO_SENDER_EMAIL', text: 'noreply@jednadvacet.org' },
      { type: 'plain_text', name: 'NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED', text: 'false' },
    ] as { type: string, name: string, id?: string, queue_name?: string, text?: string }[],
  }
  const dns = {
    brevo_code: { host_name: '@', type: 'TXT', value: 'brevo-code=synthetic', status: true },
    dkim_record: { host_name: 'mail._domainkey', type: 'TXT', value: 'v=DKIM1; p=synthetic', status: true },
    dmarc_record: { host_name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=reject', status: true },
  }
  const payloads = new Map<string, unknown>([
    ['/deployments', deployments], ['/settings', settings], ['/schedules', [{ cron: '13 * * * *' }]],
    [`/queues/${expected.queueId}`, { queue_id: expected.queueId, queue_name: expected.queue, producers: [{ type: 'worker', script: expected.worker }], consumers: [{ type: 'worker', script_name: expected.worker, dead_letter_queue: expected.dlq }] }],
    [`/queues/${expected.dlqId}`, { queue_id: expected.dlqId, queue_name: expected.dlq }],
    ['/workers/domains?hostname=jednadvacet.org', [{ hostname: 'jednadvacet.org', service: expected.worker, zone_id: expected.zoneId, environment: 'production' }]],
    [`/zones/${expected.zoneId}`, { name: 'jednadvacet.org', account: { id: expected.accountId } }],
    ['/v3/account', { email: 'final@example.test' }], ['/v3/senders', { senders: [{ name: 'Jednadvacet.org', email: 'noreply@jednadvacet.org', active: true }] }],
    ['/v3/senders/domains/jednadvacet.org', { domain: 'jednadvacet.org', verified: true, authenticated: true, dns_records: dns }],
    ['/v3/webhooks?type=transactional', { webhooks: [{ url: expected.callbackUrl, type: 'transactional', events: ['delivered', 'softBounce', 'hardBounce', 'blocked', 'spam', 'unsubscribed'], auth: { type: 'bearer', token: sentinels[1] } }] }],
  ])
  const environment = {
    NUXT_BREVO_API_KEY: sentinels[0], NUXT_BREVO_CALLBACK_SECRET: sentinels[1], NUXT_NOTIFICATION_ROOT_KEY: 'A'.repeat(43), CLOUDFLARE_API_TOKEN: sentinels[2],
    EMAIL_VERIFY_SUPPRESSION_RECIPIENT: sentinels[3], EMAIL_VERIFY_FINAL_RECIPIENT: sentinels[4], EMAIL_VERIFY_MANAGEMENT_TOKEN: 'A'.repeat(43),
    EMAIL_VERIFY_DELIVERY_ID: 'final_delivery_123456', EMAIL_VERIFY_SUPPRESSION_DELIVERY_ID: 'suppression_delivery_123', EMAIL_VERIFY_CALLBACK_EVENT_ID: 'callback_event_123456',
  }
  let publicEmail = false
  let sendStatus = 201
  let remoteModule = moduleBytes
  const dependencies: operations.EmailVerificationDependencies = {
    readFile, now: () => now, environment, evidenceKind: 'local-candidate',
    command: async (args, limits) => {
      assert.deepEqual(args.slice(0, 5), ['d1', 'execute', expected.d1Id, '--remote', '--config'])
      assert.equal(args[5], options.configPath)
      assert.deepEqual(args.slice(6, 8), ['--json', '--command'])
      assert.equal(args.length, 9)
      assert.equal(limits.accountId, expected.accountId)
      assert.match(args[8]!, /^SELECT /)
      commands.push([...args])
      return JSON.stringify([{ success: true, results: sqlite.prepare(args[8]!).all() }])
    },
    fetch: (async (input, init = {}) => {
      const url = String(input)
      requests.push({ url, init })
      assert.equal(init.redirect, 'error')
      if (url === expected.callbackUrl) {
        try {
          const payload = JSON.parse(String(init.body))
          const body = contract.callback && payload['X-Mailin-custom'] === environment.EMAIL_VERIFY_SUPPRESSION_DELIVERY_ID ? JSON.stringify(contract.callback(payload)) : String(init.body)
          await processBrevoCallbackBody(body, environment.NUXT_BREVO_CALLBACK_SECRET, new Headers(init.headers).get('authorization') ?? undefined, database)
          return Response.json({ ok: true }, { status: 202 })
        } catch (error) { return Response.json({ error: 'private-provider-body' }, { status: (error as { statusCode: number }).statusCode }) }
      }
      if (url.endsWith('/api/notifications/readiness')) return Response.json({ email: publicEmail, sms: false, webPush: false }, { headers: { 'cache-control': 'no-store' } })
      if (url.endsWith('/v3/smtp/email')) {
        assert.equal(new Headers(init.headers).get('api-key'), environment.NUXT_BREVO_API_KEY)
        if (sendStatus === 201 && contract.deliver !== false && new Headers(init.headers).get('X-Sib-Sandbox') !== 'drop') {
          const payload = { id: 26224, event: 'delivered', 'X-Mailin-custom': environment.EMAIL_VERIFY_DELIVERY_ID, 'message-id': contract.responseId ?? '<201798300811.5787683@relay.domain.com>', ts_event: 1_604_933_654 }
          await processBrevoCallbackBody(JSON.stringify(contract.callback ? contract.callback(payload) : payload), environment.NUXT_BREVO_CALLBACK_SECRET, `Bearer ${environment.NUXT_BREVO_CALLBACK_SECRET}`, database)
        }
        return Response.json({ messageId: contract.responseId ?? '<201798300811.5787683@relay.domain.com>', extra: 'private-provider-body' }, { status: sendStatus })
      }
      if (url.endsWith(`/workers/scripts/${expected.worker}`)) {
        const form = new FormData()
        form.set('index.mjs', new Blob([remoteModule]), 'index.mjs')
        form.set('chunk.mjs', new Blob([chunkBytes]), 'chunk.mjs')
        return new Response(form, { headers: { 'cf-entrypoint': 'index.mjs' } })
      }
      if (url.includes('/dns_records?')) {
        const parsed = new URL(url)
        const name = parsed.searchParams.get('name')!
        const entries = [{ name: 'jednadvacet.org', content: expected.spfValue }, ...Object.values(dns).map(entry => ({ name: entry.host_name === '@' ? 'jednadvacet.org' : `${entry.host_name}.jednadvacet.org`, content: entry.value }))].filter(entry => entry.name === name)
        return Response.json({ success: true, result: entries })
      }
      for (const [suffix, payload] of payloads) if (url.endsWith(suffix)) {
        if (url.startsWith('https://api.cloudflare.com')) assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${environment.CLOUDFLARE_API_TOKEN}`)
        else assert.equal(new Headers(init.headers).get('api-key'), environment.NUXT_BREVO_API_KEY)
        return Response.json(url.startsWith('https://api.cloudflare.com') ? { success: true, result: payload } : payload)
      }
      throw new Error('Uninjected network request')
    }) as typeof fetch,
  }
  return { options, dependencies, expected, config, save, directory, payloads, settings, deployments, dns, requests, commands, sqlite,
    setPublic: (value: boolean) => { publicEmail = value }, setSendStatus: (value: number) => { sendStatus = value },
    setRemoteModule: (value: string) => { remoteModule = value },
    run: (mode: operations.EmailVerificationMode = 'preflight', overrides: Partial<operations.EmailVerificationOptions> = {}) => operations.runEmailVerification({ ...options, mode, ...overrides }, dependencies),
  }
}

test('operations rejects trailing, duplicate and ambiguous arguments', () => {
  assert.throws(() => operations.parseEmailVerificationArgs(['preflight', '--target', 'production', '--unexpected']), /Usage/)
  assert.throws(() => operations.parseEmailVerificationArgs(['preflight', '--target', 'production', '--target', 'production']), /Usage/)
})

test('local multichannel preflight hashes candidate bytes without reading credentials or external observations', async t => {
  const f = await fixture(t)
  const options = operations.parseEmailVerificationArgs(['local-preflight', '--channels', 'email,sms,web-push', '--target', 'local', '--config', f.options.configPath, '--expectations', f.options.expectationsPath, '--artifacts', f.options.artifactsPath, '--expect-switch', 'false'])
  const dependencies = { ...f.dependencies, environment: new Proxy({}, { get() { throw new Error('credential access') } }), fetch: (async () => { throw new Error('external I/O') }) as typeof fetch, command: async () => { throw new Error('external command') } }
  const result = await operations.runEmailVerification(options, dependencies)
  assert.equal(result.evidenceKind, 'local-candidate')
  assert.equal(result.bundleHash, f.expected.bundleHash)
  assert.equal(result.migrationHash, f.expected.migrationHash)
  assert.deepEqual(result.channels, ['email', 'sms', 'web-push'])
  assert.equal(result.gates.artifacts, 'passed')
  assert.equal(result.gates.liveCanary, 'pending')
  safe(result)
  await f.save('chunk.mjs', 'changed candidate')
  await assert.rejects(operations.runEmailVerification(options, dependencies), /artifacts/)
})

test('local multichannel arguments reject live authorization, switches and ambiguous channels', () => {
  const flags = ['local-preflight', '--channels', 'email,sms,web-push', '--target', 'local', '--config', '/tmp/config', '--expectations', '/tmp/expected', '--artifacts', '/tmp/artifacts', '--expect-switch', 'false']
  for (const extra of [['--authorize-probe'], ['--approve-readiness'], ['--evidence', '/tmp/evidence']]) assert.throws(() => operations.parseEmailVerificationArgs([...flags, ...extra]), /Usage/)
  for (const channels of ['email,email', 'sms', 'email,sms,push', 'email,sms,web-push,']) assert.throws(() => operations.parseEmailVerificationArgs(flags.map(value => value === 'email,sms,web-push' ? channels : value)), /Usage/)
  assert.throws(() => operations.parseEmailVerificationArgs(flags.map(value => value === 'false' ? 'true' : value)), /Usage/)
})

test('SMS operations probe submits once with private management link and never claims shared stop or live receipt', async t => {
  const f = await fixture(t)
  const flags = ['live-canary', '--channels', 'sms', '--target', 'production', '--config', f.options.configPath, '--expectations', f.options.expectationsPath, '--artifacts', f.options.artifactsPath, '--expect-switch', 'false', '--authorize-probe', '--evidence', join(f.directory, 'probe.json')]
  const options = operations.parseEmailVerificationArgs(flags)
  const identity = await operations.runEmailVerification({ ...f.options, mode: 'local-preflight', target: 'local', channels: ['email', 'sms', 'web-push'] }, f.dependencies)
  const observation = { ...identity, channel: 'sms', manualSwitch: false, evidenceKind: 'local-candidate', gates: Object.fromEntries(['account', 'credits', 'country', 'compliance', 'sender', 'sharedManagementStop'].map(gate => [gate, 'passed'])) }
  await f.save('probe.json', observation)
  let calls = 0
  const dependencies = { ...f.dependencies, environment: { NUXT_BREVO_API_KEY: 'private-api-key', NUXT_BREVO_SMS_SENDER: 'Jednadvacet', NOTIFICATION_VERIFY_RECIPIENT: '+420777123456', NOTIFICATION_VERIFY_MANAGEMENT_TOKEN: 'A'.repeat(43) }, command: async () => { throw Error('unexpected command') }, fetch: (async (url, init) => {
    calls++
    assert.equal(String(url), 'https://api.brevo.com/v3/transactionalSMS/send')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.type, 'transactional')
    assert.ok(body.content.includes(`/notifications/manage/${'A'.repeat(43)}`))
    return Response.json({ messageId: 12345, private: 'private-provider-body' }, { status: 201 })
  }) as typeof fetch }
  const result = await operations.runEmailVerification(options, dependencies)
  assert.equal(calls, 1)
  assert.deepEqual(result.probe, { acceptance: 'submitted', liveReceipt: 'pending', sharedManagementStop: 'pending', deliveryCallback: 'not-configured' })
  assert.equal(result.gates.liveCanary, 'pending')
  safe(result)
  for (const status of [400, 401, 429, 500]) {
    calls = 0
    await assert.rejects(operations.runEmailVerification(options, { ...dependencies, fetch: (async () => { calls++; return Response.json({ private: 'private-provider-body' }, { status }) }) as typeof fetch }), /probe/)
    assert.equal(calls, 1)
  }
  calls = 0
  await f.save('probe.json', { ...observation, gates: { ...observation.gates, sharedManagementStop: 'pending' } })
  await assert.rejects(operations.runEmailVerification(options, dependencies), /probe/)
  assert.equal(calls, 0)
  for (const configured of [true, 'true', 'unknown']) {
    await f.save('probe.json', { ...observation, deliveryCallbacksConfigured: configured })
    await assert.rejects(operations.runEmailVerification(options, dependencies), /probe/)
    assert.equal(calls, 0)
  }
  await f.save('probe.json', observation)
  for (const body of ['not-json private-provider-body', 'x'.repeat(16_385)]) {
    calls = 0
    await assert.rejects(operations.runEmailVerification(options, { ...dependencies, fetch: (async () => { calls++; return new Response(body, { status: 201 }) }) as typeof fetch }), error => { safe(String(error)); return String(error).includes('probe') })
    assert.equal(calls, 1)
  }
  calls = 0
  await assert.rejects(operations.runEmailVerification(options, { ...dependencies, fetch: (async () => { calls++; throw Error('private-provider-body') }) as typeof fetch }), error => { safe(String(error)); return String(error).includes('probe') })
  assert.equal(calls, 1)
})

test('native push operations probe uses matching VAPID and one encrypted request with honest acceptance-only output', async t => {
  const f = await fixture(t)
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const receiver = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const subscription = { endpoint: 'https://push.example.test/private-device', expirationTime: null, keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', receiver.publicKey)).toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } }
  const options = operations.parseEmailVerificationArgs(['live-canary', '--channels', 'web-push', '--target', 'production', '--config', f.options.configPath, '--expectations', f.options.expectationsPath, '--artifacts', f.options.artifactsPath, '--expect-switch', 'false', '--authorize-probe', '--evidence', join(f.directory, 'probe.json')])
  const identity = await operations.runEmailVerification({ ...f.options, mode: 'local-preflight', target: 'local', channels: ['email', 'sms', 'web-push'] }, f.dependencies)
  const observation = { ...identity, channel: 'web-push', manualSwitch: false, gates: Object.fromEntries(['vapid', 'protocol', 'https', 'sharedManagementStop'].map(gate => [gate, 'passed'])) }
  await f.save('probe.json', observation)
  const environment = { NUXT_NOTIFICATION_VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d!, NUXT_PUBLIC_NOTIFICATION_VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url'), NUXT_NOTIFICATION_VAPID_SUBJECT: 'mailto:synthetic@example.test', NOTIFICATION_VERIFY_MANAGEMENT_TOKEN: 'A'.repeat(43), NOTIFICATION_VERIFY_PUSH_SUBSCRIPTION: JSON.stringify(subscription) }
  let calls = 0
  const dependencies = { ...f.dependencies, environment, fetch: (async (url, init) => {
    calls++
    assert.equal(String(url), subscription.endpoint)
    assert.equal(new Headers(init?.headers).get('content-encoding'), 'aes128gcm')
    assert.ok(init?.body instanceof Uint8Array)
    assert.ok(!Buffer.from(init.body).includes(Buffer.from(environment.NOTIFICATION_VERIFY_MANAGEMENT_TOKEN)))
    return new Response(null, { status: 201 })
  }) as typeof fetch }
  const result = await operations.runEmailVerification(options, dependencies)
  assert.equal(calls, 1)
  assert.equal(result.probe?.liveReceipt, 'pending')
  assert.equal(result.evidenceKind, 'local-candidate')
  safe(result)
  assert.ok(!JSON.stringify(result).includes(subscription.endpoint))
  for (const status of [400, 401, 404, 410, 429, 500]) {
    calls = 0
    await assert.rejects(operations.runEmailVerification(options, { ...dependencies, fetch: (async () => { calls++; return new Response(null, { status }) }) as typeof fetch }), /probe/)
    assert.equal(calls, 1)
  }
  calls = 0
  for (const mutation of [{ evidenceKind: 'production-observation' }, { bundleHash: 'f'.repeat(64) }, { expiresAt: new Date(now).toISOString() }, { gates: {} }]) {
    await f.save('probe.json', { ...observation, ...mutation })
    await assert.rejects(operations.runEmailVerification(options, dependencies), /probe/)
  }
  assert.equal(calls, 0)
})

test('multichannel observation review reuses runtime gates without expiry or promoting evidence', async t => {
  const f = await fixture(t)
  const local = { ...f.options, mode: 'local-preflight' as const, target: 'local' as const, channels: ['email', 'sms', 'web-push'] as const }
  const options = { ...local, channels: [...local.channels] }
  const identity = await operations.runEmailVerification(options, f.dependencies)
  const runtime: Record<string, unknown> = {
    notificationSmsEnabled: true,
    notificationRootKey: 'private-root-material', brevoApiKey: 'private-api-key', brevoCallbackSecret: 'private-callback-bearer', brevoSenderName: 'Jednadvacet.org', brevoSmsSender: 'Jednadvacet', brevoSenderEmail: 'noreply@jednadvacet.org',
    notificationVapidPrivateKey: 'private-vapid-material', notificationVapidPublicKey: 'public-vapid', notificationVapidSubject: 'mailto:synthetic@example.test',
  }
  for (const field of ['targetIdentity', 'deploymentId', 'bundleHash', 'migrationHash', 'configHash'] as const) runtime[`notificationExpected${field[0]!.toUpperCase()}${field.slice(1)}`] = identity[field]
  const allGates = ['artifacts', 'deployment', 'bindings', 'migration', 'sender', 'dns', 'callbackMetadata', 'https', 'sandbox', 'callback', 'liveCanary', 'humanInbox', 'humanCalendar', 'humanLink', 'humanLogs', 'account', 'credits', 'country', 'compliance', 'sharedManagementStop', 'vapid', 'protocol', 'interoperability', 'browser:chromium', 'firstMessage', 'eventDelivery']
  for (const [channel, name, material] of [
    ['email', 'Email', [runtime.notificationRootKey, runtime.brevoApiKey, runtime.brevoCallbackSecret, runtime.brevoSenderName, runtime.brevoSenderEmail]],
    ['sms', 'Sms', [runtime.notificationRootKey, runtime.brevoApiKey, runtime.brevoSmsSender]],
    ['web-push', 'WebPush', [runtime.notificationRootKey, runtime.notificationVapidPrivateKey, runtime.notificationVapidPublicKey, runtime.notificationVapidSubject]],
  ] as const) runtime[`notification${name}Evidence`] = JSON.stringify({ ...identity, channel, evidenceKind: 'production-observation', mode: 'readiness', manualSwitch: true, verifiedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), keyHash: sha(JSON.stringify(material)), interoperability: ['chromium'], gates: Object.fromEntries(allGates.map(gate => [gate, 'passed'])) })
  const review = { ...options, mode: 'readiness' as const, target: 'production' as const, expectedSwitch: true, approveReadiness: true, evidencePath: join(f.directory, 'observations.json') }
  const dependencies = { ...f.dependencies, evidenceKind: 'production-observation' as const, fetch: (async () => { throw new Error('network') }) as typeof fetch, command: async () => { throw new Error('command') } }
  const run = async (input: Record<string, unknown>) => { await f.save('observations.json', input); return operations.runEmailVerification(review, dependencies) }
  const result = await run(runtime)
  assert.deepEqual(result.channelReadiness, { email: true, sms: true, 'web-push': true })
  assert.equal(result.evidenceKind, 'local-candidate')
  assert.equal(result.expiresAt, undefined)
  assert.equal(result.gates.liveCanary, 'pending', 'review does not perform live probes')
  safe(result)
  await assert.rejects(run({ ...runtime, notificationSmsEnabled: false }), /evidence/)
  for (const name of ['Email', 'Sms', 'WebPush']) {
    const field = `notification${name}Evidence`
    const original = JSON.parse(runtime[field] as string)
    await run({ ...runtime, [field]: JSON.stringify({ ...original, verifiedAt: new Date(now - 90 * 86400000).toISOString(), expiresAt: new Date(now - 1000).toISOString() }) })
    for (const mutation of [{ evidenceKind: 'local-candidate' }, { targetIdentity: 'f'.repeat(64) }, { bundleHash: 'f'.repeat(64) }, { migrationHash: 'f'.repeat(64) }, { configHash: 'f'.repeat(64) }, { keyHash: 'f'.repeat(64) }, { verifiedAt: new Date(now + 1).toISOString() }, { gates: { ...original.gates, sharedManagementStop: 'pending', callbackMetadata: 'pending' } }]) await assert.rejects(run({ ...runtime, [field]: JSON.stringify({ ...original, ...mutation }) }), /evidence/)
  }
  await assert.rejects(run({ ...runtime, notificationSmsDeliveryCallbacksConfigured: true }), /evidence/)
  const sms = JSON.parse(runtime.notificationSmsEvidence as string)
  await run({ ...runtime, notificationSmsDeliveryCallbacksConfigured: true, notificationSmsEvidence: JSON.stringify({ ...sms, gates: { ...sms.gates, deliveryCallbackAuth: 'passed' } }) })
  await run({ ...runtime, notificationSmsDeliveryCallbacksConfigured: false })
  const email = JSON.parse(runtime.notificationEmailEvidence as string)
  await assert.rejects(run({ ...runtime, notificationSmsDeliveryCallbacksConfigured: false, notificationEmailEvidence: JSON.stringify({ ...email, gates: { ...email.gates, callbackMetadata: 'pending' } }) }), /evidence/)
})

test('operations exposes the injectable real dispatcher without executing main on import', () => {
  assert.equal(typeof Reflect.get(operations, 'runEmailVerification'), 'function')
})

test('operations CLI emits only the fixed failure sentence for invalid flags and unauthorized probes', () => {
  const script = fileURLToPath(new URL('../scripts/verify-email-delivery.ts', import.meta.url))
  for (const mode of ['preflight', 'sandbox', 'callback', 'live-canary', 'readiness']) {
    const flags = [mode, '--target', 'production', '--config', '/tmp/config.json', '--expectations', '/tmp/expected.json', '--artifacts', '/tmp/artifacts.json', '--expect-switch', 'false']
    const attempts = [[...flags, '--secret', sentinels.join(' ')], ...(mode === 'preflight' ? [] : [flags])]
    for (const args of attempts) {
      const result = spawnSync(process.execPath, ['--experimental-strip-types', script, ...args], { encoding: 'utf8', env: {}, timeout: 5000, maxBuffer: 4096 })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, 'Email verification failed; consult the operations runbook.\n')
      safe(result.stdout + result.stderr)
    }
  }
})

test('strict CLI parses every advertised mode with exact required flags', () => {
  for (const mode of ['preflight', 'sandbox', 'callback', 'live-canary', 'readiness']) {
    const flags = [mode, '--target', 'production', '--config', '/tmp/config.json', '--expectations', '/tmp/expected.json', '--artifacts', '/tmp/artifacts.json', '--expect-switch', 'false']
    assert.equal(operations.parseEmailVerificationArgs(flags).mode, mode)
    for (const extra of [['positional'], ['--target', 'production'], ['--expect-switch', 'false'], ['--secret', sentinels[0]!]]) assert.throws(() => operations.parseEmailVerificationArgs([...flags, ...extra]), /Usage/)
  }
  assert.throws(() => operations.emailVerificationTarget('preview'), /target production/)
})

test('preflight hashes real bytes and emits only fixed bounded local evidence', async t => {
  const f = await fixture(t)
  const evidence = await f.run()
  assert.equal(evidence.bundleHash, f.expected.bundleHash)
  assert.equal(evidence.migrationHash, f.expected.migrationHash)
  assert.equal(evidence.manualSwitch, false)
  assert.equal(evidence.evidenceKind, 'local-candidate')
  assert.equal(Date.parse(evidence.expiresAt) - Date.parse(evidence.verifiedAt), day)
  assert.equal(evidence.gates.humanInbox, 'pending')
  safe(evidence)
  assert.deepEqual(Object.keys(evidence).sort(), ['bundleHash', 'channel', 'configHash', 'deploymentId', 'evidenceKind', 'expiresAt', 'gates', 'manualSwitch', 'migrationHash', 'mode', 'targetIdentity', 'verifiedAt'].sort())
})

for (const artifact of ['index.mjs', 'chunk.mjs', 'assets.json', 'migration.sql']) test(`unchanged wrangler JSON cannot hide ${artifact} drift`, async t => {
  const f = await fixture(t)
  await f.save(artifact, 'changed bytes')
  await assert.rejects(f.run(), error => { safe(String(error)); return /artifacts/.test(String(error)) })
  assert.equal(f.requests.length, 0)
})

for (const gate of ['D1', 'Queue', 'DLQ', 'cron', 'observability', 'sender', 'domain', 'SPF', 'DKIM', 'DMARC', 'callback auth', 'callback events', 'HTTPS', 'migration', 'deployment', 'remote bytes', 'switch', 'public readiness']) test(`preflight independently fails missing or drifted ${gate}`, async t => {
  const f = await fixture(t)
  if (gate === 'D1') f.settings.bindings = f.settings.bindings.filter(binding => binding.type !== 'd1')
  if (gate === 'Queue') f.settings.bindings = f.settings.bindings.filter(binding => binding.type !== 'queue')
  if (gate === 'DLQ') f.payloads.set(`/queues/${f.expected.dlqId}`, { queue_name: 'wrong' })
  if (gate === 'cron') f.payloads.set('/schedules', [])
  if (gate === 'observability') f.settings.observability.logs.enabled = false
  if (gate === 'sender') f.payloads.set('/v3/senders', { senders: [] })
  if (gate === 'domain') f.payloads.set('/v3/senders/domains/jednadvacet.org', { domain: 'other.test' })
  if (gate === 'SPF') { f.expected.spfValue = 'invalid'; await f.save('expectations.json', f.expected) }
  if (gate === 'DKIM') f.dns.dkim_record.status = false
  if (gate === 'DMARC') f.dns.dmarc_record.status = false
  if (gate === 'callback auth' || gate === 'callback events') f.payloads.set('/v3/webhooks?type=transactional', { webhooks: [{ url: f.expected.callbackUrl, type: 'transactional', events: gate === 'callback events' ? [] : ['delivered', 'softBounce', 'hardBounce', 'blocked', 'spam', 'unsubscribed'], auth: { type: 'bearer', token: 'wrong' } }] })
  if (gate === 'HTTPS') { f.expected.managementBaseUrl = 'http://jednadvacet.org/notifications/manage/'; await f.save('expectations.json', f.expected) }
  if (gate === 'migration') f.sqlite.exec('DELETE FROM _hub_migrations')
  if (gate === 'deployment') f.deployments.deployments[0]!.id = '44444444-4444-4444-4444-444444444444'
  if (gate === 'remote bytes') f.setRemoteModule('changed remote bytes')
  if (gate === 'switch') f.settings.bindings.find(binding => binding.name === 'NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED')!.text = 'true'
  if (gate === 'public readiness') f.setPublic(true)
  await assert.rejects(f.run(), error => { safe(String(error)); return /Email verification failed:/.test(String(error)) })
})

for (const mode of ['sandbox', 'callback', 'live-canary'] as const) test(`${mode} denies absent authorization before any I/O`, async t => {
  const f = await fixture(t)
  f.dependencies.readFile = async () => { assert.fail('unauthorized read') }
  await assert.rejects(f.run(mode), /configuration/)
  assert.equal(f.requests.length, 0)
  assert.equal(f.commands.length, 0)
})

test('sandbox uses the existing adapter, drop header and one representative PUBLISH attachment', async t => {
  const f = await fixture(t)
  const evidence = await f.run('sandbox', { authorizeProbe: true })
  const sends = f.requests.filter(request => request.url.endsWith('/smtp/email'))
  assert.equal(sends.length, 1)
  assert.equal(new Headers(sends[0]!.init.headers).get('X-Sib-Sandbox'), 'drop')
  const body = JSON.parse(String(sends[0]!.init.body))
  assert.equal(body.sender.email, 'noreply@jednadvacet.org')
  assert.equal(body.attachment.length, 1)
  const ics = Buffer.from(body.attachment[0].content, 'base64').toString()
  assert.match(ics, /METHOD:PUBLISH/)
  assert.ok(!ics.includes('ATTENDEE') && !ics.includes('METHOD:REQUEST'))
  assert.equal(evidence.gates.sandbox, 'passed')
  assert.equal(evidence.gates.liveCanary, 'pending')
  safe(evidence)
})

test('callback dispatcher proves rejection, correlation, suppression and replay against applied real SQL', async t => {
  const f = await fixture(t)
  const evidence = await f.run('callback', { authorizeProbe: true })
  assert.equal(evidence.gates.callback, 'passed')
  assert.equal(f.requests.filter(request => request.url === f.expected.callbackUrl).length, 4)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM notification_delivery_callbacks').get()!.count, 1)
  assert.equal(f.sqlite.prepare('SELECT status FROM notification_outbox').get()!.status, 'invalidated')
  safe(evidence)
})

for (const [label, responseId, storedId] of [
  ['provider-id', 'provider-id', 'provider-id'],
  ['official bracketed', '<201798300811.5787683@relay.domain.com>', '201798300811.5787683@relay.domain.com'],
  ['official plain', '201798300811.5787683@relay.domain.com', '201798300811.5787683@relay.domain.com'],
  ['punctuation and case', '<Provider.ID+Case/Part:tag=@Relay.Domain>', 'Provider.ID+Case/Part:tag=@Relay.Domain'],
  ['256 UTF-8 bytes', 'ž'.repeat(128), 'ž'.repeat(128)],
  ['256 wrapped UTF-8 bytes', `<${'ž'.repeat(127)}>`, 'ž'.repeat(127)],
] as const) test(`offline CLI agrees with adapter and callback provider-ID contract: ${label}`, async t => {
  let callbackCalls = 0
  const f = await fixture(t, { responseId, storedId, callback: payload => {
    // The real callback probe sends plain canonical IDs; replay an equivalent wrapper.
    if (payload.event !== 'hard_bounce' || ++callbackCalls !== 3 || Buffer.byteLength(storedId) > 254) return payload
    return { ...payload, 'message-id': `<${storedId}>` }
  } })
  for (const mode of ['sandbox', 'callback', 'live-canary'] as const) {
    const evidence = await f.run(mode, { authorizeProbe: true })
    assert.equal(evidence.evidenceKind, 'local-candidate')
    assert.equal(evidence.gates[mode === 'live-canary' ? 'liveCanary' : mode], 'passed')
    assert.equal(evidence.manualSwitch, false)
    assert.equal(evidence.targetIdentity.length, 64)
    assert.equal(evidence.bundleHash, f.expected.bundleHash)
    assert.equal(evidence.migrationHash, f.expected.migrationHash)
    assert.equal(evidence.configHash, f.expected.configHash)
    assert.equal(Date.parse(evidence.expiresAt) - Date.parse(evidence.verifiedAt), day)
    for (const gate of ['humanInbox', 'humanCalendar', 'humanLink', 'humanLogs'] as const) assert.equal(evidence.gates[gate], 'pending')
    assert.ok(!JSON.stringify(evidence).includes(storedId))
    safe(evidence)
  }
  assert.equal(f.requests.filter(request => request.url.endsWith('/smtp/email')).length, 2)
  assert.equal(f.requests.filter(request => request.url === f.expected.callbackUrl).length, 4)
  assert.deepEqual(f.sqlite.prepare('SELECT delivery_id, event, provider_message_id FROM notification_delivery_callbacks ORDER BY delivery_id').all(), [
    { delivery_id: 'final_delivery_123456', event: 'delivered', provider_message_id: storedId },
    { delivery_id: 'suppression_delivery_123', event: 'hard-bounce', provider_message_id: storedId },
  ])
  assert.deepEqual(f.sqlite.prepare('SELECT id, status, provider_message_id FROM notification_event_deliveries ORDER BY id').all(), [
    { id: 'final_delivery_123456', status: 'delivered', provider_message_id: storedId },
    { id: 'suppression_delivery_123', status: 'hard-bounce', provider_message_id: storedId },
  ])
  assert.deepEqual(f.sqlite.prepare('SELECT reason FROM notification_suppressions').all(), [{ reason: 'provider-bounce' }])
  assert.deepEqual(f.sqlite.prepare('SELECT id FROM notification_contacts').all(), [{ id: 2 }])
  assert.deepEqual(f.sqlite.prepare('SELECT status, payload_ciphertext, payload_iv FROM notification_outbox').get(), { status: 'invalidated', payload_ciphertext: null, payload_iv: null })
})

for (const [label, value] of [
  ['257 UTF-8 bytes', `${'ž'.repeat(128)}x`],
  ['257 wrapped UTF-8 bytes', `<${'ž'.repeat(127)}x>`],
  ['257 ASCII bytes', 'x'.repeat(257)],
  ['empty', ''], ['empty brackets', '<>'], ['unclosed', '<provider-id'], ['unopened', 'provider-id>'], ['nested', '<<provider-id>>'],
  ['C0', 'provider\u0000id'], ['newline', 'provider\nid'], ['DEL', 'provider\u007fid'], ['C1', 'provider\u0085id'],
] as const) test(`offline CLI rejects unsupported provider ID without evidence: ${label}`, async t => {
  for (const mode of ['sandbox', 'callback', 'live-canary'] as const) {
    const f = await fixture(t, { responseId: value, storedId: value, deliver: false })
    const before = f.sqlite.prepare('SELECT * FROM notification_event_deliveries').all()
    await assert.rejects(f.run(mode, { authorizeProbe: true }), error => {
      safe(String(error))
      assert.equal(String(error), `Error: Email verification failed: ${mode === 'callback' ? 'callback-probe' : 'send'}`)
      return true
    })
    assert.equal(f.requests.filter(request => request.url.endsWith('/smtp/email')).length, mode === 'callback' ? 0 : 1)
    assert.equal(f.requests.filter(request => request.url === f.expected.callbackUrl).length, 0)
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM notification_event_deliveries').all(), before)
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_delivery_callbacks').get()!.n, 0)
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_suppressions').get()!.n, 0)
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_contacts').get()!.n, 2)
    assert.equal(f.sqlite.prepare('SELECT status FROM notification_outbox').get()!.status, 'queued')
  }
})

for (const [label, mutation] of [
  ['provider message conflict', { 'message-id': 'wrong-provider-id' }],
  ['provider case conflict', { 'message-id': '201798300811.5787683@Relay.domain.com' }],
  ['unknown local correlation', { 'X-Mailin-custom': 'delivery_unknown_123' }],
  ['local alias only', { 'X-Mailin-custom': undefined, deliveryId: 'suppression_delivery_123' }],
  ['message alias only', { 'message-id': undefined, messageId: '201798300811.5787683@relay.domain.com' }],
  ['missing custom header', { 'X-Mailin-custom': undefined, email: 'suppression@example.test' }],
  ['invalid timestamp', { ts_event: '1604933654' }],
  ['unsafe timestamp', { ts_event: Number.MAX_SAFE_INTEGER + 1 }],
  ['date alias only', { ts_event: undefined, date: '2020-11-09 15:54:14' }],
  ['malformed message ID', { 'message-id': '<<provider-id>>' }],
] as const) test(`offline CLI callback proof rejects ${label} using actual callback SQL`, async t => {
  const f = await fixture(t, { callback: payload => ({ ...payload, ...mutation }) })
  const tables = ['notification_event_deliveries', 'notification_delivery_callbacks', 'notification_suppressions', 'notification_contacts', 'notification_outbox']
  const before = tables.map(table => f.sqlite.prepare(`SELECT * FROM ${table}`).all())
  await assert.rejects(f.run('callback', { authorizeProbe: true }), error => {
    safe(String(error))
    assert.equal(String(error), 'Error: Email verification failed: callback-probe')
    return true
  })
  assert.deepEqual(tables.map(table => f.sqlite.prepare(`SELECT * FROM ${table}`).all()), before)
  assert.equal(f.requests.filter(request => request.url.endsWith('/smtp/email')).length, 0)
  assert.equal(f.requests.filter(request => request.url === f.expected.callbackUrl).length, 3)
})

test('offline CLI live correlation rejects a callback message different from the adapter result', async t => {
  const f = await fixture(t, { callback: payload => ({ ...payload, 'message-id': 'wrong-provider-id' }) })
  await assert.rejects(f.run('live-canary', { authorizeProbe: true }), error => {
    safe(String(error))
    assert.equal(String(error), 'Error: Email verification failed: send')
    return true
  })
  assert.equal(f.requests.filter(request => request.url.endsWith('/smtp/email')).length, 1)
  assert.deepEqual(f.sqlite.prepare("SELECT status, provider_message_id FROM notification_event_deliveries WHERE id = 'final_delivery_123456'").get(), { status: 'delivered', provider_message_id: 'wrong-provider-id' })
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_delivery_callbacks').get()!.n, 1)
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM notification_suppressions').get()!.n, 0)
})

test('callback HTTP success without durable mutation is insufficient', async t => {
  const f = await fixture(t)
  const original = f.dependencies.fetch
  f.dependencies.fetch = (async (url, init) => {
    if (String(url) === f.expected.callbackUrl && new Headers(init?.headers).has('authorization')) return Response.json({ ok: true }, { status: 202 })
    return original(url, init)
  }) as typeof fetch
  await assert.rejects(f.run('callback', { authorizeProbe: true }), /callback-probe/)
})

test('live canary submits once, checks durable correlation and leaves all human observations pending', async t => {
  const f = await fixture(t)
  const evidence = await f.run('live-canary', { authorizeProbe: true })
  const sends = f.requests.filter(request => request.url.endsWith('/smtp/email'))
  assert.equal(sends.length, 1)
  assert.equal(new Headers(sends[0]!.init.headers).get('X-Sib-Sandbox'), null)
  for (const gate of ['humanInbox', 'humanCalendar', 'humanLink', 'humanLogs'] as const) assert.equal(evidence.gates[gate], 'pending')
  safe(evidence)
  await assert.rejects(f.run('live-canary', { authorizeProbe: true }), /send/)
  assert.equal(f.requests.filter(request => request.url.endsWith('/smtp/email')).length, 1)
})

for (const mode of ['sandbox', 'live-canary'] as const) for (const status of [429, 500, 401, 400]) test(`${mode} never retries provider ${status}`, async t => {
  const f = await fixture(t)
  f.setSendStatus(status)
  await assert.rejects(f.run(mode, { authorizeProbe: true }), error => { safe(String(error)); return /send/.test(String(error)) })
  assert.equal(f.requests.filter(request => request.url.endsWith('/smtp/email')).length, 1)
})

for (const mode of ['sandbox', 'callback', 'live-canary'] as const) test(`${mode} rejects reuse of suppression identity`, async t => {
  const f = await fixture(t)
  f.dependencies.environment.EMAIL_VERIFY_FINAL_RECIPIENT = f.dependencies.environment.EMAIL_VERIFY_SUPPRESSION_RECIPIENT
  await assert.rejects(f.run(mode, { authorizeProbe: true }))
  assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 0)
})

const readinessFixture = async (t: TestContext) => {
  const f = await fixture(t)
  const base = await f.run()
  const evidence = (['preflight', 'sandbox', 'callback', 'live-canary'] as const).map(mode => ({ ...base, mode, gates: { ...base.gates, sandbox: 'passed', callback: 'passed', liveCanary: 'passed', humanInbox: 'passed', humanCalendar: 'passed', humanLink: 'passed', humanLogs: 'passed' } }))
  await f.save('evidence.json', evidence)
  f.setPublic(true)
  f.settings.bindings.find(binding => binding.name === 'NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED')!.text = 'true'
  return { ...f, evidence, verify: () => f.run('readiness', { expectedSwitch: true, approveReadiness: true, evidencePath: join(f.directory, 'evidence.json') }) }
}

test('readiness requires explicit approval, current manual state and separate human attestations', async t => {
  const f = await readinessFixture(t)
  const evidence = await f.verify()
  assert.equal(evidence.manualSwitch, true)
  assert.equal(evidence.evidenceKind, 'local-candidate')
  assert.ok(Object.values(evidence.gates).every(value => value === 'passed'))
  safe(evidence)
  await assert.rejects(f.run('readiness', { expectedSwitch: true, evidencePath: join(f.directory, 'evidence.json') }), /configuration/)
})

for (const drift of ['old', 'future', 'overlong', 'expired', 'target', 'bundle', 'migration', 'config', 'deployment', 'kind', 'switch', 'human', 'gate', 'mode']) test(`readiness rejects ${drift} evidence`, async t => {
  const f = await readinessFixture(t)
  const item = f.evidence[3]!
  if (drift === 'old') item.verifiedAt = new Date(now - day - 1).toISOString()
  if (drift === 'future') item.verifiedAt = new Date(now + 300_001).toISOString()
  if (drift === 'overlong') item.expiresAt = new Date(now + day + 1).toISOString()
  if (drift === 'expired') item.expiresAt = new Date(now).toISOString()
  if (drift === 'target') item.targetIdentity = sha('wrong-target')
  if (drift === 'bundle') item.bundleHash = sha('wrong-bundle')
  if (drift === 'migration') item.migrationHash = sha('wrong-migration')
  if (drift === 'config') item.configHash = sha('wrong-config')
  if (drift === 'deployment') item.deploymentId = '44444444-4444-4444-4444-444444444444'
  if (drift === 'kind') item.evidenceKind = 'production-observation'
  if (drift === 'switch') item.manualSwitch = true
  if (drift === 'human') item.gates.humanInbox = 'pending'
  if (drift === 'gate') item.gates.migration = 'pending'
  if (drift === 'mode') f.evidence.pop()
  await f.save('evidence.json', f.evidence)
  await assert.rejects(f.verify(), error => { safe(String(error)); return /evidence/.test(String(error)) })
})

for (const mode of ['preflight', 'sandbox', 'callback', 'live-canary', 'readiness'] as const) for (const fault of ['fetch', 'command', 'malformed', 'oversized', 'missing-auth'] as const) test(`${mode} ${fault} failure does not disclose secrets or raw bodies`, async t => {
  const f = mode === 'readiness' ? await readinessFixture(t) : await fixture(t)
  const options = { authorizeProbe: true, ...(mode === 'readiness' ? { approveReadiness: true, expectedSwitch: true, evidencePath: join(f.directory, 'evidence.json') } : {}) }
  if (fault === 'fetch') f.dependencies.fetch = async () => { throw new Error(sentinels.join(' ')) }
  if (fault === 'command') f.dependencies.command = async () => { throw new Error(sentinels.join(' ')) }
  if (fault === 'malformed') f.dependencies.fetch = async () => new Response(`{${sentinels.join(' ')}`)
  if (fault === 'oversized') f.dependencies.fetch = async () => new Response('x'.repeat(16 * 1024 * 1024 + 1) + sentinels.join(' '))
  if (fault === 'missing-auth') delete f.dependencies.environment.CLOUDFLARE_API_TOKEN
  await assert.rejects(f.run(mode, options), error => { safe(String(error)); return /Email verification failed:/.test(String(error)) })
})

test('an unresponsive command times out with a bounded safe failure', async t => {
  const f = await fixture(t)
  f.dependencies.command = () => new Promise(() => {})
  await assert.rejects(f.run(), /migration/)
})

for (const mode of ['sandbox', 'live-canary'] as const) for (const fault of ['malformed', 'oversized', 'transport'] as const) test(`${mode} bounds and sanitizes attempted provider ${fault} responses`, async t => {
  const f = await fixture(t)
  const original = f.dependencies.fetch
  let attempts = 0
  f.dependencies.fetch = (async (url, init) => {
    if (!String(url).endsWith('/smtp/email')) return original(url, init)
    attempts++
    if (fault === 'transport') throw new Error(sentinels.join(' '))
    return new Response(fault === 'oversized' ? 'x'.repeat(16 * 1024 * 1024 + 1) + sentinels.join(' ') : `{${sentinels.join(' ')}`, { status: 201 })
  }) as typeof fetch
  await assert.rejects(f.run(mode, { authorizeProbe: true }), error => { safe(String(error)); return /send/.test(String(error)) })
  assert.equal(attempts, 1)
})

test('provider timeout attempts once and cannot turn into accepted evidence', async t => {
  const f = await fixture(t)
  const original = f.dependencies.fetch
  let attempts = 0
  f.dependencies.fetch = (async (url, init) => {
    if (!String(url).endsWith('/smtp/email')) return original(url, init)
    attempts++
    return new Promise<Response>(() => {})
  }) as typeof fetch
  await assert.rejects(f.run('sandbox', { authorizeProbe: true }), /send/)
  assert.equal(attempts, 1)
})

test('readiness records deployment verification without a delivery expiry', async t => {
  const f = await readinessFixture(t)
  f.evidence[0]!.verifiedAt = new Date(now - 1000).toISOString()
  f.evidence[0]!.expiresAt = new Date(now + 5000).toISOString()
  await f.save('evidence.json', f.evidence)
  assert.equal((await f.verify()).expiresAt, undefined)
})

test('readiness accepts an explicitly pinned switch-off deployment only with authenticated same-artifact history', async t => {
  const f = await readinessFixture(t)
  const probeDeploymentId = f.expected.deploymentId
  const currentId = '44444444-4444-4444-4444-444444444444'
  const prior = structuredClone(f.deployments.deployments[0]!)
  f.deployments.deployments[0]!.id = currentId
  f.deployments.deployments.push(prior)
  await f.save('expectations.json', { ...f.expected, deploymentId: currentId, probeDeploymentId })
  assert.equal((await f.verify()).deploymentId, currentId)
  f.deployments.deployments.pop()
  await assert.rejects(f.verify(), /evidence/)
})

test('deployment movement during verification invalidates the result', async t => {
  const f = await fixture(t)
  const original = f.dependencies.fetch
  let observations = 0
  f.dependencies.fetch = (async (url, init) => {
    if (String(url).endsWith('/deployments') && ++observations === 2) f.deployments.deployments[0]!.id = '44444444-4444-4444-4444-444444444444'
    return original(url, init)
  }) as typeof fetch
  await assert.rejects(f.run(), /deployment-recheck/)
})

for (const mode of ['callback', 'live-canary'] as const) test(`${mode} cannot operate on a different contact behind a supplied opaque ID`, async t => {
  const f = await fixture(t)
  const changed = f.sqlite.prepare("UPDATE notification_contacts SET destination = 'other@example.test' WHERE id = ?").run(mode === 'callback' ? 1 : 2)
  assert.equal(changed.changes, 1)
  await assert.rejects(f.run(mode, { authorizeProbe: true }), mode === 'callback' ? /callback-probe/ : /send/)
  assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 0)
})

for (const drift of ['config', 'extra module', 'entrypoint', 'HTTPS target', 'release annotation', 'switch boolean', 'sender config', 'migration order', 'missing root', 'noncanonical root', 'callback oversized']) test(`verifier rejects ${drift} without leaking raw evidence`, async t => {
  const f = await fixture(t)
  if (drift === 'config') await f.save('wrangler.json', `${JSON.stringify(f.config)} `)
  if (drift === 'extra module') {
    const original = f.dependencies.fetch
    f.dependencies.fetch = (async (url, init) => {
      const response = await original(url, init)
      if (!String(url).endsWith(`/workers/scripts/${f.expected.worker}`)) return response
      const form = await response.formData()
      form.set('unlisted.mjs', new Blob(['unlisted']), 'unlisted.mjs')
      return new Response(form, { headers: { 'cf-entrypoint': 'index.mjs' } })
    }) as typeof fetch
  }
  if (drift === 'release annotation') f.deployments.deployments[0]!.annotations['workers/message'] = sentinels.join(' ')
  if (drift === 'HTTPS target') f.payloads.set('/workers/domains?hostname=jednadvacet.org', [])
  if (drift === 'entrypoint') {
    const original = f.dependencies.fetch
    f.dependencies.fetch = (async (url, init) => {
      const response = await original(url, init)
      if (String(url).endsWith(`/workers/scripts/${f.expected.worker}`)) response.headers.set('cf-entrypoint', 'chunk.mjs')
      return response
    }) as typeof fetch
  }
  if (drift === 'switch boolean') (f.settings.bindings.find(binding => binding.name === 'NUXT_NOTIFICATION_EMAIL_MANUAL_ENABLED') as Record<string, unknown>).text = false
  if (drift === 'sender config') f.settings.bindings = f.settings.bindings.filter(binding => binding.name !== 'NUXT_BREVO_SENDER_EMAIL')
  if (drift === 'migration order') await f.save('artifacts.json', { modules: [{ name: 'index.mjs' }, { name: 'chunk.mjs' }], assetsManifest: join(f.directory, 'assets.json'), migrations: [{ name: 'z', path: join(f.directory, 'migration.sql') }, { name: 'a', path: join(f.directory, 'migration.sql') }] })
  if (drift === 'missing root') delete f.dependencies.environment.NUXT_NOTIFICATION_ROOT_KEY
  if (drift === 'noncanonical root') f.dependencies.environment.NUXT_NOTIFICATION_ROOT_KEY = `${'A'.repeat(42)}B`
  if (drift === 'callback oversized') {
    const original = f.dependencies.fetch
    f.dependencies.fetch = (async (url, init) => String(url) === f.expected.callbackUrl ? new Response('x'.repeat(16 * 1024 * 1024 + 1) + sentinels.join(' '), { status: 401 }) : original(url, init)) as typeof fetch
  }
  await assert.rejects(f.run(drift === 'callback oversized' ? 'callback' : 'preflight', { authorizeProbe: true }), error => { safe(String(error)); return /Email verification failed:/.test(String(error)) })
})
