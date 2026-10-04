import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
const sentinels = ['private-api-key', 'private-callback-bearer', 'private-cloudflare-token', 'suppression@example.test', 'final@example.test', 'private-provider-body', 'private-command-error', 'A'.repeat(43), 'message_123456789', 'callback_event_123456', 'final_delivery_123456']
const safe = (value: unknown) => { for (const sentinel of sentinels) assert.ok(!String(typeof value === 'string' ? value : JSON.stringify(value)).includes(sentinel), sentinel) }

const fixture = async (t: TestContext) => {
  const directory = await mkdtemp('/tmp/email-operations-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = {
    name: 'jednadvacetorg-web', main: 'index.mjs',
    d1_databases: [{ binding: 'DB', database_name: 'web', database_id: '11111111-1111-1111-1111-111111111111' }],
    queues: { producers: [{ binding: 'NOTIFICATION_MESSAGES_QUEUE', queue: 'notification-messages' }], consumers: [{ queue: 'notification-messages', dead_letter_queue: 'notification-messages-dlq' }] },
    triggers: { crons: ['13 * * * *'] }, observability: { logs: { enabled: true, persist: true, invocation_logs: true } },
  }
  const configBytes = JSON.stringify(config)
  const migrationBytes = await readFile(new URL('../server/db/migrations/sqlite/0000_majestic_lightspeed.sql', import.meta.url), 'utf8')
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
    migrationHash: sha(JSON.stringify([['0000_majestic_lightspeed', sha(migrationBytes)]])),
  }
  const options: operations.EmailVerificationOptions = { mode: 'preflight', target: 'production', configPath: join(directory, 'wrangler.json'), expectationsPath: join(directory, 'expectations.json'), artifactsPath: join(directory, 'artifacts.json'), expectedSwitch: false }
  const save = (name: string, value: unknown) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value))
  await Promise.all([
    save('wrangler.json', configBytes), save('expectations.json', expected), save('index.mjs', moduleBytes), save('chunk.mjs', chunkBytes),
    save('assets.json', manifestBytes), save('migration.sql', migrationBytes),
    save('artifacts.json', { modules: [{ name: 'index.mjs' }, { name: 'chunk.mjs' }], assetsManifest: join(directory, 'assets.json'), migrations: [{ name: '0000_majestic_lightspeed', path: join(directory, 'migration.sql') }] }),
  ])
  const sqlite = new Database(':memory:')
  t.after(() => sqlite.close())
  sqlite.exec(migrationBytes)
  sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE _hub_migrations (name TEXT); INSERT INTO _hub_migrations VALUES (\'0000_majestic_lightspeed\');')
  sqlite.exec("INSERT INTO notification_contacts (id, channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (1, 'email', 'suppression@example.test', 'synthetic-hash', 'synthetic-digest', 1, 'active', '2026-10-04', '1', '2026-10-04', '2026-10-04'); INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, provider_message_id, created_at, updated_at) VALUES ('suppression_delivery_123', 1, 1, 'synthetic-hash', 'synthetic-event', 0, 'created', 'submitted', 'message_123456789', '2026-10-04', '2026-10-04'); INSERT INTO notification_outbox (id, contact_id, expected_capability_generation, version, status, payload_ciphertext, payload_iv, kind, created_at, updated_at) VALUES ('outbox_123456789', 1, 1, 1, 'queued', 'encrypted', 'iv', 'event-email', '2026-10-04', '2026-10-04');")
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
          await processBrevoCallbackBody(String(init.body), environment.NUXT_BREVO_CALLBACK_SECRET, new Headers(init.headers).get('authorization') ?? undefined, database)
          return Response.json({ ok: true }, { status: 202 })
        } catch (error) { return Response.json({ error: 'private-provider-body' }, { status: (error as { statusCode: number }).statusCode }) }
      }
      if (url.endsWith('/api/notifications/readiness')) return Response.json({ email: publicEmail, sms: false, webPush: false }, { headers: { 'cache-control': 'no-store' } })
      if (url.endsWith('/v3/smtp/email')) {
        assert.equal(new Headers(init.headers).get('api-key'), environment.NUXT_BREVO_API_KEY)
        if (sendStatus === 201 && new Headers(init.headers).get('X-Sib-Sandbox') !== 'drop') {
          await processBrevoCallbackBody(JSON.stringify({ id: 'delivered_event_123456', event: 'delivered', 'X-Mailin-custom': environment.EMAIL_VERIFY_DELIVERY_ID, messageId: 'message_123456789' }), environment.NUXT_BREVO_CALLBACK_SECRET, `Bearer ${environment.NUXT_BREVO_CALLBACK_SECRET}`, database)
        }
        return Response.json({ messageId: 'message_123456789', extra: 'private-provider-body' }, { status: sendStatus })
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

test('readiness cannot extend the oldest source expiry', async t => {
  const f = await readinessFixture(t)
  f.evidence[0]!.verifiedAt = new Date(now - 1000).toISOString()
  f.evidence[0]!.expiresAt = new Date(now + 5000).toISOString()
  await f.save('evidence.json', f.evidence)
  assert.equal((await f.verify()).expiresAt, new Date(now + 5000).toISOString())
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
  f.sqlite.exec("UPDATE notification_contacts SET destination = 'other@example.test'")
  await assert.rejects(f.run(mode, { authorizeProbe: true }))
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
