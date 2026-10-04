import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { applyDatabaseMigrations } from '@nuxthub/core/db'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as new (filename: string) => {
  close(): void
  exec(sql: string): void
  prepare(sql: string): {
    all(...values: unknown[]): Array<Record<string, unknown>>
    get(...values: unknown[]): Record<string, unknown> | undefined
    run(...values: unknown[]): { changes: number }
  }
}

const root = resolve(process.cwd())
const migrationPath = 'server/db/migrations/sqlite/0000_majestic_lightspeed.sql'
const migrationDirectory = 'server/db/migrations/sqlite'
const immutable = {
  '0000_majestic_lightspeed.sql': 'a1addce2b5571d2939bd36cb20995ebbb4874b8614a6db4cd7d42ea9e8234701',
  'meta/0000_snapshot.json': 'd062ed79d7e492a622082471c6a830550392239987632e2b8b3171203a0d9b62',
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const generationInventory = async () => {
  const paths = ['server/db/schema.ts', '.nuxt/hub/db/schema.mjs',
    ...(await readdir(join(root, migrationDirectory))).filter(file => file.endsWith('.sql')).map(file => `${migrationDirectory}/${file}`),
    ...(await readdir(join(root, migrationDirectory, 'meta'))).filter(file => file.endsWith('.json')).map(file => `${migrationDirectory}/meta/${file}`)]
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, hash(await readFile(join(root, path)))])))
}
const assertImmutable = async (directory: string) => {
  for (const [file, expected] of Object.entries(immutable)) assert.equal(hash(await readFile(join(directory, file))), expected, `${file} immutable hash`)
}
const generationBaseline = async (directory: string, intermediate: boolean) => {
  assertWithinTmp(directory)
  await assertImmutable(join(root, migrationDirectory))
  if (intermediate) {
    await mkdir(join(directory, 'replay/meta'), { recursive: true })
    for (const file of [...Object.keys(immutable), 'meta/_journal.json']) {
      const original = execFileSync('git', ['show', `335ddfb:${migrationDirectory}/${file}`], { cwd: root })
      await writeFile(join(directory, 'replay', file), original)
    }
    await cp(join(root, '.nuxt/hub/db/schema.mjs'), join(directory, 'intermediate-schema.mjs'))
    await cp(join(root, 'server/db/schema.ts'), join(directory, 'intermediate-schema.ts'))
  } else {
    await assertImmutable(join(directory, 'replay'))
    assert.equal(hash(await readFile(join(root, 'server/db/schema.ts'))), 'd865e972463311730b3771a67aa2a3984e70145781d27b25bc82d3e89477c05f', 'final approved schema must remain exact')
    await cp(join(root, '.nuxt/hub/db/schema.mjs'), join(directory, 'final-schema.mjs'))
    const inputs = Object.fromEntries(await Promise.all(['intermediate-schema.ts', 'intermediate-schema.mjs', 'final-schema.mjs'].map(async file => [file, hash(await readFile(join(directory, file)))])))
    await writeFile(join(directory, 'inventory.json'), JSON.stringify({ working: await generationInventory(), inputs }, null, 2))
  }
  return { mode: intermediate ? 'intermediate schema recorded; preserved history copied' : 'final candidate inventory recorded', directory }
}
interface Journal { version: string, dialect: string, entries: Array<{ idx: number, version: string, when: number, tag: string, breakpoints: boolean }> }
interface Snapshot { id: string, prevId: string, tables: Record<string, { columns: Record<string, { type: string }> }> }
const compareGeneratedHistory = async (working: string, replay: string) => {
  await assertImmutable(working)
  await assertImmutable(replay)
  const parseJournal = async (directory: string) => JSON.parse(await readFile(join(directory, 'meta/_journal.json'), 'utf8')) as Journal
  const actual = await parseJournal(working)
  const reproduced = await parseJournal(replay)
  const expectedTags = ['0000_majestic_lightspeed', '0001_phase_7_columns', '0002_phase_7_constraints']
  assert.deepEqual(actual.entries.map(entry => entry.tag), expectedTags)
  assert.deepEqual(reproduced.entries.map(entry => entry.tag), expectedTags)
  const original = JSON.parse(execFileSync('git', ['show', `335ddfb:${migrationDirectory}/meta/_journal.json`], { cwd: root, encoding: 'utf8' })) as Journal
  for (const journal of [actual, reproduced]) {
    assert.equal(journal.version, original.version)
    assert.equal(journal.dialect, original.dialect)
    assert.deepEqual(journal.entries[0], original.entries[0])
    assert.deepEqual(journal.entries.map(entry => entry.idx), [0, 1, 2])
  }
  const withoutTimestamps = (journal: Journal) => ({ ...journal, entries: journal.entries.map((entry, index) => index ? { ...entry, when: 0 } : entry) })
  assert.deepEqual(withoutTimestamps(actual), withoutTimestamps(reproduced), 'journal structure differs')
  let workingParent = '00000000-0000-0000-0000-000000000000'
  let replayParent = workingParent
  const workingIds = new Set<string>()
  const replayIds = new Set<string>()
  for (const [index, tag] of expectedTags.entries()) {
    assert.deepEqual(await readFile(join(working, `${tag}.sql`)), await readFile(join(replay, `${tag}.sql`)), `${tag} SQL replay differs`)
    const file = `meta/${String(index).padStart(4, '0')}_snapshot.json`
    const left = JSON.parse(await readFile(join(working, file), 'utf8')) as Snapshot
    const right = JSON.parse(await readFile(join(replay, file), 'utf8')) as Snapshot
    for (const [snapshot, parent, ids] of [[left, workingParent, workingIds], [right, replayParent, replayIds]] as const) {
      assert.equal(snapshot.prevId, parent, `${file} broken ancestry`)
      assert.match(snapshot.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
      assert.ok(!ids.has(snapshot.id), 'duplicate snapshot id')
      ids.add(snapshot.id)
    }
    const { id: _leftId, prevId: _leftParent, ...leftSchema } = left
    const { id: _rightId, prevId: _rightParent, ...rightSchema } = right
    assert.deepEqual(leftSchema, rightSchema, `${file} schema/index/check/FK drift`)
    workingParent = left.id
    replayParent = right.id
  }
  for (const directory of [working, replay]) {
    assert.deepEqual((await readdir(directory)).filter(file => file.endsWith('.sql')).sort(), expectedTags.map(tag => `${tag}.sql`))
    assert.deepEqual((await readdir(join(directory, 'meta'))).sort(), ['0000_snapshot.json', '0001_snapshot.json', '0002_snapshot.json', '_journal.json'])
  }
}
const generationContract = async (directory: string) => {
  assertWithinTmp(directory)
  const baseline = JSON.parse(await readFile(join(directory, 'inventory.json'), 'utf8'))
  assert.deepEqual(await generationInventory(), baseline.working, 'source/emitted schema or working history changed; unexpected migration')
  for (const [file, expected] of Object.entries(baseline.inputs)) assert.equal(hash(await readFile(join(directory, file))), expected, `${file} generation input changed`)
  const working = join(root, migrationDirectory)
  const replay = join(directory, 'replay')
  await compareGeneratedHistory(working, replay)
  const negatives = [
    { file: '0001_phase_7_columns.sql', mutate: (value: string) => `${value}\nSELECT 1;` },
    { file: 'meta/0002_snapshot.json', mutate: (value: string) => { const snapshot = JSON.parse(value) as Snapshot; snapshot.tables.notification_event_deliveries!.columns.channel!.type = 'integer'; return JSON.stringify(snapshot) } },
    { file: 'meta/0002_snapshot.json', mutate: (value: string) => JSON.stringify({ ...JSON.parse(value), prevId: '00000000-0000-0000-0000-000000000000' }) },
    { file: 'meta/_journal.json', mutate: (value: string) => { const journal = JSON.parse(value) as Journal; journal.entries[1]!.tag = '0001_wrong'; return JSON.stringify(journal) } },
    { file: '0000_majestic_lightspeed.sql', mutate: (value: string) => `${value}\nSELECT 1;` },
  ]
  for (const [index, negative] of negatives.entries()) {
    const copy = join(directory, `negative-${index}`)
    await cp(replay, copy, { recursive: true })
    await writeFile(join(copy, negative.file), negative.mutate(await readFile(join(copy, negative.file), 'utf8')))
    await assert.rejects(compareGeneratedHistory(working, copy), `negative control ${negative.file} was accepted`)
    await rm(copy, { recursive: true })
  }
  const unexpected = join(directory, 'negative-extra')
  await cp(replay, unexpected, { recursive: true })
  await writeFile(join(unexpected, '0003_unexpected.sql'), 'SELECT 1;')
  await assert.rejects(compareGeneratedHistory(working, unexpected), 'unexpected next migration was accepted')
  await rm(unexpected, { recursive: true })
  return { inventory: baseline, replay: 'exact SQL and semantic snapshots/journal with linked 0000→0001→0002 ancestry', negativeControls: negatives.length + 1, noDrift: true }
}
const notificationTables = {
  notification_abuse_attempts: ['id', 'requester_hash', 'attempted_at', 'expires_at'],
  notification_contacts: ['id', 'channel', 'destination', 'destination_hash', 'management_token_digest', 'capability_generation', 'state', 'consent_at', 'consent_version', 'created_at', 'updated_at'],
  notification_delivery_callbacks: ['provider_event_id', 'delivery_id', 'event', 'provider_message_id', 'received_at'],
  notification_event_deliveries: ['id', 'contact_id', 'channel', 'community_slug', 'eligibility_frequency', 'expected_capability_generation', 'destination_hash', 'event_uid', 'event_revision', 'reason', 'status', 'provider_message_id', 'created_at', 'updated_at', 'submitted_at'],
  notification_event_state: ['event_key', 'uid', 'starts_at', 'ends_at', 'venue', 'cancelled', 'notification_revision', 'updated_at'],
  notification_management_capabilities: ['token_digest', 'contact_id', 'expected_capability_generation', 'created_at', 'expires_at'],
  notification_outbox: ['id', 'contact_id', 'version', 'expected_capability_generation', 'status', 'claim_token', 'claim_expires_at', 'payload_ciphertext', 'payload_iv', 'kind', 'created_at', 'updated_at', 'terminal_at'],
  notification_subscriptions: ['id', 'contact_id', 'community_slug', 'frequency', 'created_at', 'updated_at'],
  notification_suppressions: ['id', 'channel', 'destination_hash', 'reason', 'suppressed_at'],
} as const

const expectedIndexes = {
  notification_abuse_attempts: ['notification_abuse_attempts_requester_attempted_idx'],
  notification_contacts: ['notification_contacts_identity_unique', 'notification_contacts_token_digest_unique', 'notification_contacts_destination_hash_idx'],
  notification_delivery_callbacks: ['notification_delivery_callbacks_delivery_idx'],
  notification_event_deliveries: ['notification_event_deliveries_dedupe_unique', 'notification_event_deliveries_status_idx', 'notification_event_deliveries_authority_idx'],
  notification_event_state: [],
  notification_management_capabilities: ['notification_management_capabilities_contact_idx'],
  notification_outbox: ['notification_outbox_contact_status_idx'],
  notification_subscriptions: ['notification_subscriptions_identity_unique'],
  notification_suppressions: ['notification_suppressions_identity_unique'],
} as const

const assertWithinTmp = (path: string) => {
  const temporaryRoot = resolve(tmpdir())
  const resolved = resolve(path)
  assert.ok(resolved === temporaryRoot || resolved.startsWith(`${temporaryRoot}${sep}`), `disposable path must remain within ${temporaryRoot}`)
}

const candidateMigrations = async () => {
  const directory = join(root, 'server/db/migrations/sqlite')
  const journal = JSON.parse(await readFile(join(directory, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number, tag: string }> }
  const files = (await readdir(directory)).filter(file => file.endsWith('.sql')).sort()
  assert.deepEqual(files, journal.entries.map(entry => `${entry.tag}.sql`), 'filesystem migrations must exactly match journal order, including uncommitted candidates')
  assert.deepEqual(journal.entries.map(entry => entry.idx), journal.entries.map((_, index) => index), 'journal sequence must be contiguous')
  assert.equal(files[0], basename(migrationPath), 'preserved initial migration must remain first')
  return files.map(file => join('server/db/migrations/sqlite', file))
}

const tableColumns = (database: InstanceType<typeof Database>, table: string) => database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)

const indexNames = (database: InstanceType<typeof Database>, table: string) => database.prepare(`PRAGMA index_list(${table})`).all()
  .map(row => String(row.name))
  .filter(name => !name.startsWith('sqlite_autoindex_'))
  .sort()

const seededSentinels = (database: InstanceType<typeof Database>) => {
  database.exec('CREATE TABLE content_sentinel (id INTEGER PRIMARY KEY, payload BLOB NOT NULL); CREATE TABLE portal_sentinel (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);')
  database.prepare('INSERT INTO content_sentinel (id, payload) VALUES (?, ?)').run(1, Buffer.from('content-owned sentinel\u0000value'))
  database.prepare('INSERT INTO portal_sentinel (id, payload) VALUES (?, ?)').run(1, Buffer.from('portal-owned sentinel\u0000value'))
  return database.prepare('SELECT hex(payload) AS content FROM content_sentinel WHERE id = 1').get()
}

const inspectContract = (database: InstanceType<typeof Database>) => {
  const actualTables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'notification_%' ORDER BY name").all().map(row => row.name).sort()
  assert.deepEqual(actualTables, Object.keys(notificationTables).sort(), 'migration created an unexpected notification-owned object')

  for (const [table, columns] of Object.entries(notificationTables)) {
    assert.deepEqual(tableColumns(database, table), columns, `${table} columns drifted from the schema contract`)
    assert.deepEqual(indexNames(database, table), [...expectedIndexes[table as keyof typeof expectedIndexes]].sort(), `${table} indexes drifted from the schema contract`)
  }

  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(notification_subscriptions)').all().map(row => [row.table, row.from, row.to, row.on_delete]), [['notification_contacts', 'contact_id', 'id', 'CASCADE']])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(notification_event_deliveries)').all().map(row => [row.table, row.from, row.to, row.on_delete]), [['notification_contacts', 'contact_id', 'id', 'SET NULL']])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(notification_delivery_callbacks)').all().map(row => [row.table, row.from, row.to, row.on_delete]), [['notification_event_deliveries', 'delivery_id', 'id', 'CASCADE']])
  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(notification_management_capabilities)').all().map(row => [row.table, row.from, row.to, row.on_delete]), [['notification_contacts', 'contact_id', 'id', 'CASCADE']])
  for (const table of ['notification_contacts', 'notification_event_deliveries', 'notification_outbox', 'notification_subscriptions', 'notification_suppressions']) {
    const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)?.sql
    assert.ok(typeof schema === 'string' && schema.includes('CHECK'), `${table} must enforce its fixed codes in SQLite`)
  }
}

const insertContact = (database: InstanceType<typeof Database>, overrides: Partial<Record<string, unknown>> = {}) => {
  const contact = {
    channel: 'email',
    destination: 'alice@example.test',
    destination_hash: 'destination-hash',
    management_token_digest: 'token-digest',
    capability_generation: 3,
    state: 'active',
    consent_at: '2026-09-17T00:00:00.000Z',
    consent_version: '2026-09',
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
  database.prepare('INSERT INTO notification_contacts (channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (@channel, @destination, @destination_hash, @management_token_digest, @capability_generation, @state, @consent_at, @consent_version, @created_at, @updated_at)').run(contact)
}

const exerciseConstraints = (database: InstanceType<typeof Database>) => {
  for (const kind of ['event-sms', 'event-web-push']) {
    database.prepare('INSERT INTO notification_outbox (id, version, expected_capability_generation, status, kind, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?)').run(kind, 'pending', kind, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')
  }
  insertContact(database)
  assert.throws(() => insertContact(database))
  assert.throws(() => insertContact(database, { destination: 'other@example.test', management_token_digest: 'other-digest', channel: 'fax' }))
  assert.throws(() => insertContact(database, { destination: 'third@example.test', management_token_digest: 'third-digest', state: 'stopped' }))

  assert.throws(() => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(999, 'brno', 'created', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))
  database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(1, 'brno', 'created', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(1, 'brno', 'created', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))
  assert.throws(() => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(1, 'brno', 'monthly', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))

  database.prepare('INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) VALUES (?, ?, ?, ?)').run('email', 'suppression-hash', 'user-stop', '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) VALUES (?, ?, ?, ?)').run('email', 'bad-reason-hash', 'freeform', '2026-09-17T00:00:00.000Z'))

  database.prepare('INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES (?, ?, ?)').run('requester-hash', '2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z')

  database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, claim_token, claim_expires_at, payload_ciphertext, payload_iv, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('outbox-pending', 1, 7, 3, 'pending', 'claim', '2026-09-17T00:01:00.000Z', 'ciphertext', 'iv', 'first-activation', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('outbox-invalid', 1, 1, 3, 'retrying', 'first-activation', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))

  const staleCas = database.prepare('UPDATE notification_outbox SET status = ? WHERE id = ? AND version = ? AND status = ?').run('claimed', 'outbox-pending', 6, 'pending')
  assert.equal(staleCas.changes, 0, 'a stale outbox version CAS must not mutate state')
  const currentCas = database.prepare('UPDATE notification_outbox SET status = ?, claim_token = ? WHERE id = ? AND version = ? AND status = ?').run('claimed', 'claim-2', 'outbox-pending', 7, 'pending')
  assert.equal(currentCas.changes, 1, 'the current outbox version/status CAS must mutate exactly one row')
  const terminal = database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL, terminal_at = ? WHERE id = ? AND version = ? AND status = ?').run('invalidated', '2026-09-17T00:02:00.000Z', 'outbox-pending', 7, 'claimed')
  assert.equal(terminal.changes, 1, 'a current claimed row must support lifecycle invalidation')
  assert.deepEqual(database.prepare('SELECT version, status, payload_ciphertext, payload_iv, claim_token, claim_expires_at FROM notification_outbox WHERE id = ?').get('outbox-pending'), { version: 8, status: 'invalidated', payload_ciphertext: null, payload_iv: null, claim_token: null, claim_expires_at: null })

  database.prepare('INSERT INTO notification_event_state (event_key, uid, starts_at, ends_at, venue, cancelled, notification_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('brno:event-1', 'uid-1', '2026-10-01T18:00:00.000Z', '2026-10-01T19:00:00.000Z', 'Brno', 0, 1, '2026-09-17T00:00:00.000Z')
  database.prepare('UPDATE notification_event_state SET notification_revision = ?, starts_at = ?, updated_at = ? WHERE event_key = ?').run(2, '2026-10-01T17:00:00.000Z', '2026-09-17T00:01:00.000Z', 'brno:event-1')
  assert.deepEqual(database.prepare('SELECT uid, notification_revision FROM notification_event_state WHERE event_key = ?').get('brno:event-1'), { uid: 'uid-1', notification_revision: 2 })

  database.prepare('INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('delivery-1', 1, 3, 'destination-hash', 'uid-1', 2, 'updated', 'pending', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')
  for (const [column, value] of [['channel', 'fax'], ['eligibility_frequency', 'monthly'], ['reason', 'arbitrary']]) {
    assert.throws(() => database.prepare(`UPDATE notification_event_deliveries SET ${column} = ? WHERE id = 'delivery-1'`).run(value), `${column} must reject unknown codes`)
  }
  assert.throws(() => database.prepare("UPDATE notification_outbox SET kind = 'event-fax' WHERE id = 'event-sms'").run())
  for (const channel of ['sms', 'web-push']) {
    insertContact(database, { channel, destination: `${channel}-synthetic`, destination_hash: `${channel}-hash`, management_token_digest: `${channel}-digest` })
    const contact = database.prepare('SELECT id FROM notification_contacts WHERE channel = ?').get(channel)!
    database.prepare('INSERT INTO notification_event_deliveries (id, contact_id, channel, community_slug, eligibility_frequency, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 3, ?, ?, 2, ?, ?, ?, ?)').run(`delivery-${channel}`, contact.id, channel, 'brno', 'created', `${channel}-hash`, 'uid-1', 'updated', 'pending', 'created', 'updated')
  }
  assert.throws(() => database.prepare('INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('delivery-duplicate', 1, 3, 'destination-hash', 'uid-1', 2, 'updated', 'pending', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))
  assert.throws(() => database.prepare('INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('delivery-invalid', 1, 3, 'destination-hash', 'uid-2', 1, 'created', 'unknown', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))
  database.prepare('INSERT INTO notification_delivery_callbacks (provider_event_id, delivery_id, event, received_at) VALUES (?, ?, ?, ?)').run('provider-event-1', 'delivery-1', 'delivered', '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_delivery_callbacks (provider_event_id, delivery_id, event, received_at) VALUES (?, ?, ?, ?)').run('provider-event-1', 'delivery-1', 'delivered', '2026-09-17T00:00:00.000Z'))
  database.prepare('INSERT INTO notification_management_capabilities (token_digest, contact_id, expected_capability_generation, created_at) VALUES (?, ?, ?, ?)').run('alias-digest', 1, 3, '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_management_capabilities (token_digest, contact_id, expected_capability_generation, created_at) VALUES (?, ?, ?, ?)').run('orphan-alias', 999, 3, '2026-09-17T00:00:00.000Z'))
  database.prepare('DELETE FROM notification_contacts WHERE id = ?').run(1)
  assert.deepEqual(database.prepare('SELECT contact_id, destination_hash FROM notification_event_deliveries WHERE id = ?').get('delivery-1'), { contact_id: null, destination_hash: 'destination-hash' }, 'delivery audit evidence must survive contact deletion without a recipient')
}

const planDetail = (database: InstanceType<typeof Database>, query: string, values: unknown[], index: string) => {
  const details = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values).map(row => String(row.detail))
  assert.ok(details.some(detail => detail.includes(index)), `query did not use ${index}: ${details.join(' | ')}`)
  return details
}

const copyMigrationsForRunner = async (directory: string, migrations: string[]) => {
  for (const migration of migrations) await cp(join(root, migration), join(directory, 'db/migrations/sqlite', relative('server/db/migrations/sqlite', migration)), { recursive: true })
}

const applyWithNuxtHubRunner = async (database: InstanceType<typeof Database>, hubDirectory: string, migrations: string[]) => {
  await copyMigrationsForRunner(hubDirectory, migrations)
  const runnerDatabase = {
    run: async (statement: { queryChunks: Array<{ value?: string[] }> }) => {
      const query = statement.queryChunks.flatMap(chunk => chunk.value ?? []).join('')
      if (query.trimStart().toLowerCase().startsWith('select')) return database.prepare(query).all()
      return database.prepare(query).run()
    },
  }
  // The installed runner consumes only dir/dialect here; driver bindings are replaced by the real SQLite adapter.
  const runnerConfig = { dir: hubDirectory, db: { dialect: 'sqlite' } } as Parameters<typeof applyDatabaseMigrations>[0]
  const result = await applyDatabaseMigrations(runnerConfig, runnerDatabase as never)
  assert.notEqual(result, false, 'NuxtHub migration runner rejected the generated migration')
}

const fullRehearsal = async () => {
  const migrations = await candidateMigrations()
  const migrationHashes = await Promise.all(migrations.map(async migration => ({ migration: basename(migration), hash: createHash('sha256').update(await readFile(join(root, migration))).digest('hex') })))
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'notification-migration-'))
  assertWithinTmp(temporaryDirectory)
  const databasePath = join(temporaryDirectory, 'notification.sqlite')

  try {
    const upgrade = new Database(join(temporaryDirectory, 'upgrade.sqlite'))
    try {
      upgrade.exec('PRAGMA foreign_keys = ON')
      seededSentinels(upgrade)
      await applyWithNuxtHubRunner(upgrade, join(temporaryDirectory, 'upgrade-hub'), migrations.slice(0, 1))
      insertContact(upgrade)
      upgrade.prepare("INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (1, 'brno', 'created', 'created', 'updated')").run()
      upgrade.prepare("INSERT INTO notification_event_deliveries (id, contact_id, expected_capability_generation, destination_hash, event_uid, event_revision, reason, status, provider_message_id, created_at, updated_at, submitted_at) VALUES ('legacy', 1, 3, 'destination-hash', 'legacy-uid', 4, 'updated', 'submitted', 'opaque-message', 'created', 'updated', 'submitted')").run()
      upgrade.prepare("INSERT INTO notification_delivery_callbacks VALUES ('opaque-receipt', 'legacy', 'delivered', 'opaque-message', 'received')").run()
      upgrade.prepare("INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, kind, created_at, updated_at, payload_ciphertext, payload_iv) VALUES ('legacy-outbox', 1, 7, 3, 'queued', 'event-email', 'created', 'updated', 'ciphertext', 'iv')").run()
      upgrade.prepare("INSERT INTO notification_management_capabilities VALUES ('legacy-alias', 1, 3, 'created', NULL)").run()
      upgrade.prepare("INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) VALUES ('sms', 'legacy-suppression', 'user-stop', 'suppressed')").run()
      upgrade.prepare("INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES ('legacy-requester', 'attempted', 'expires')").run()
      upgrade.prepare("INSERT INTO notification_event_state VALUES ('legacy-key', 'legacy-uid', 'start', 'end', 'venue', 0, 4, 'updated')").run()
      const before = Object.fromEntries(Object.keys(notificationTables).map(table => [table, upgrade.prepare(`SELECT * FROM ${table}`).all()]))
      await applyWithNuxtHubRunner(upgrade, join(temporaryDirectory, 'upgrade-hub'), migrations)
      inspectContract(upgrade)
      for (const [table, rows] of Object.entries(before)) {
        const after = upgrade.prepare(`SELECT * FROM ${table}`).all()
        assert.equal(after.length, rows.length, `${table} lost upgrade rows`)
        for (const [index, row] of rows.entries()) assert.deepEqual(Object.fromEntries(Object.keys(row).map(key => [key, after[index]![key]])), row, `${table} upgrade values changed`)
      }
      assert.deepEqual(upgrade.prepare("SELECT channel, community_slug, eligibility_frequency FROM notification_event_deliveries WHERE id = 'legacy'").get(), { channel: 'email', community_slug: null, eligibility_frequency: null }, 'legacy evidence must remain explicitly unscoped')
      assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), [])
      assert.equal(upgrade.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
      assert.equal(upgrade.prepare('SELECT hex(payload) value FROM content_sentinel').get()?.value, Buffer.from('content-owned sentinel\u0000value').toString('hex').toUpperCase())
      assert.equal(upgrade.prepare('SELECT hex(payload) value FROM portal_sentinel').get()?.value, Buffer.from('portal-owned sentinel\u0000value').toString('hex').toUpperCase())
      const ledger = upgrade.prepare('SELECT * FROM _hub_migrations ORDER BY id').all()
      await applyWithNuxtHubRunner(upgrade, join(temporaryDirectory, 'upgrade-hub'), migrations)
      assert.deepEqual(upgrade.prepare('SELECT * FROM _hub_migrations ORDER BY id').all(), ledger)
    } finally { upgrade.close() }
    const database = new Database(databasePath)
    database.exec('PRAGMA foreign_keys = ON;')
    const sentinelBefore = seededSentinels(database)
    await applyWithNuxtHubRunner(database, join(temporaryDirectory, 'hub'), migrations)
    inspectContract(database)
    assert.deepEqual(database.prepare('SELECT hex(payload) AS content FROM content_sentinel WHERE id = 1').get(), sentinelBefore, 'migration altered Content sentinel data')
    assert.equal(database.prepare('SELECT hex(payload) AS portal FROM portal_sentinel WHERE id = 1').get()?.portal, Buffer.from('portal-owned sentinel\u0000value').toString('hex').toUpperCase(), 'migration altered Portal sentinel data')
    exerciseConstraints(database)
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    const ledgerBefore = database.prepare('SELECT name FROM _hub_migrations ORDER BY id').all()
    await applyWithNuxtHubRunner(database, join(temporaryDirectory, 'hub'), migrations)
    assert.deepEqual(database.prepare('SELECT name FROM _hub_migrations ORDER BY id').all(), ledgerBefore, 'second migration apply was not a ledger no-op')
    const queryPlans = {
      token: planDetail(database, 'SELECT id FROM notification_contacts WHERE management_token_digest = ?', ['token-digest'], 'notification_contacts_token_digest_unique'),
      subscription: planDetail(database, 'SELECT id FROM notification_subscriptions WHERE contact_id = ? AND community_slug = ? AND frequency = ?', [1, 'brno', 'created'], 'notification_subscriptions_identity_unique'),
      outbox: planDetail(database, 'SELECT id FROM notification_outbox WHERE contact_id = ? AND status = ?', [1, 'queued'], 'notification_outbox_contact_status_idx'),
      abuse: planDetail(database, 'SELECT id FROM notification_abuse_attempts WHERE requester_hash = ? AND attempted_at >= ?', ['requester-hash', '2026-09-17T00:00:00.000Z'], 'notification_abuse_attempts_requester_attempted_idx'),
    }
    database.close()

    const reconnected = new Database(databasePath)
    assert.deepEqual(reconnected.prepare('SELECT id, version, status, expected_capability_generation FROM notification_outbox WHERE id = ?').get('outbox-pending'), { id: 'outbox-pending', version: 8, status: 'invalidated', expected_capability_generation: 3 }, 'versioned outbox tombstone did not survive reconnect')
    reconnected.close()

    return { cleanup: 'pending', migrations: migrationHashes, objects: Object.keys(notificationTables), indexes: expectedIndexes, queryPlans, populatedUpgrade: 'all old notification values, callbacks and sentinel blobs preserved; legacy scope null; repeat apply no-op', sentinels: 'preserved', constraints: 'fixed codes, foreign keys, independent channel dedupe, uniqueness, and CAS enforced', reconnect: 'outbox CAS state survived a fresh SQLite handle', temporaryDirectory }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

const bundleContract = async (configPath: string) => {
  const migrations = await candidateMigrations()
  const resolvedConfigPath = resolve(root, configPath)
  assert.ok(resolvedConfigPath.startsWith(`${root}${sep}`), 'bundle config must remain within the repository')
  const config = JSON.parse(await readFile(resolvedConfigPath, 'utf8')) as { d1_databases?: Array<{ binding?: string, migrations_dir?: string }> }
  const database = config.d1_databases?.find(candidate => candidate.binding === 'DB')
  assert.ok(database?.migrations_dir, 'generated Wrangler config must include DB migration packaging')
  const packagedDirectory = resolve(dirname(resolvedConfigPath), database.migrations_dir)
  assert.ok(packagedDirectory.startsWith(`${dirname(resolvedConfigPath)}${sep}`), 'DB migration directory must remain inside generated output')
  const packaged = (await readdir(packagedDirectory)).filter(file => file.endsWith('.sql')).sort()
  assert.deepEqual(packaged, migrations.map(migration => basename(migration)), 'DB must package exactly the rehearsed migration chain')
  const migrationHashes = await Promise.all(migrations.map(async migration => {
    const source = createHash('sha256').update(await readFile(join(root, migration))).digest('hex')
    const packagedHash = createHash('sha256').update(await readFile(join(packagedDirectory, basename(migration)))).digest('hex')
    assert.equal(packagedHash, source, `generated migrations directory does not contain the rehearsed ${basename(migration)} hash`)
    return { migration: basename(migration), hash: source }
  }))
  return { migrations: migrationHashes, binding: 'DB', migrationsDirectory: database.migrations_dir }
}

const mode = process.argv[2]

if (mode === '--generation-baseline' && process.argv[3]) {
  process.stdout.write(`${JSON.stringify(await generationBaseline(resolve(process.argv[3]), process.argv[4] === '--intermediate'), null, 2)}\n`)
} else if (mode === '--generation-contract' && process.argv[3]) {
  process.stdout.write(`${JSON.stringify(await generationContract(resolve(process.argv[3])), null, 2)}\n`)
} else if (mode === '--schema-contract' || mode === '--full-rehearsal') {
  const result = await fullRehearsal()
  process.stdout.write(`${JSON.stringify({ ...result, cleanup: 'complete', temporaryDirectory: 'confined to /tmp and removed' }, null, 2)}\n`)
} else if (mode === '--bundle-contract' && process.argv[3]) {
  process.stdout.write(`${JSON.stringify(await bundleContract(process.argv[3]), null, 2)}\n`)
} else {
  throw new Error('Usage: verify-notification-migration.ts --generation-baseline <owned /tmp directory> [--intermediate] | --generation-contract <owned /tmp directory> | --schema-contract | --full-rehearsal | --bundle-contract <wrangler.json>')
}
