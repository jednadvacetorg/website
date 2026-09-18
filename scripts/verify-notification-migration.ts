import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
const notificationTables = {
  notification_abuse_attempts: ['id', 'requester_hash', 'requester_hash_key_version', 'attempted_at', 'expires_at'],
  notification_contacts: ['id', 'channel', 'destination', 'destination_hash', 'destination_hash_key_version', 'management_token_digest', 'capability_generation', 'state', 'consent_at', 'consent_version', 'created_at', 'updated_at'],
  notification_outbox: ['id', 'contact_id', 'version', 'expected_capability_generation', 'status', 'claim_token', 'claim_expires_at', 'payload_ciphertext', 'payload_iv', 'transport_key_version', 'kind', 'created_at', 'updated_at', 'terminal_at'],
  notification_subscriptions: ['id', 'contact_id', 'community_slug', 'frequency', 'created_at', 'updated_at'],
  notification_suppressions: ['id', 'channel', 'destination_hash', 'destination_hash_key_version', 'reason', 'suppressed_at'],
} as const

const expectedIndexes = {
  notification_abuse_attempts: ['notification_abuse_attempts_requester_attempted_idx'],
  notification_contacts: ['notification_contacts_identity_unique', 'notification_contacts_token_digest_unique', 'notification_contacts_destination_hash_idx'],
  notification_outbox: ['notification_outbox_contact_status_idx'],
  notification_subscriptions: ['notification_subscriptions_identity_unique'],
  notification_suppressions: ['notification_suppressions_identity_unique'],
} as const

const assertWithinTmp = (path: string) => {
  const temporaryRoot = resolve(tmpdir())
  const resolved = resolve(path)
  assert.ok(resolved === temporaryRoot || resolved.startsWith(`${temporaryRoot}${sep}`), `disposable path must remain within ${temporaryRoot}`)
}

const trackedMigrations = () => {
  const files = execFileSync('git', ['ls-files', '--', 'server/db/migrations/sqlite'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(file => file.endsWith('.sql'))
    .sort()
  assert.deepEqual(files, [migrationPath], 'exactly one generated initial notification migration is required')
  return files
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
    assert.deepEqual(indexNames(database, table), [...expectedIndexes[table]].sort(), `${table} indexes drifted from the schema contract`)
  }

  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(notification_subscriptions)').all().map(row => [row.table, row.from, row.to, row.on_delete]), [['notification_contacts', 'contact_id', 'id', 'CASCADE']])
  for (const table of ['notification_contacts', 'notification_outbox', 'notification_subscriptions', 'notification_suppressions']) {
    const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)?.sql
    assert.ok(schema?.includes('CHECK'), `${table} must enforce its fixed codes in SQLite`)
  }
}

const insertContact = (database: InstanceType<typeof Database>, overrides: Partial<Record<string, unknown>> = {}) => {
  const contact = {
    channel: 'email',
    destination: 'alice@example.test',
    destination_hash: 'destination-hash',
    destination_hash_key_version: 'v1',
    management_token_digest: 'token-digest',
    capability_generation: 3,
    state: 'active',
    consent_at: '2026-09-17T00:00:00.000Z',
    consent_version: '2026-09',
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
    ...overrides,
  }
  database.prepare('INSERT INTO notification_contacts (channel, destination, destination_hash, destination_hash_key_version, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (@channel, @destination, @destination_hash, @destination_hash_key_version, @management_token_digest, @capability_generation, @state, @consent_at, @consent_version, @created_at, @updated_at)').run(contact)
}

const exerciseConstraints = (database: InstanceType<typeof Database>) => {
  insertContact(database)
  assert.throws(() => insertContact(database))
  assert.throws(() => insertContact(database, { destination: 'other@example.test', management_token_digest: 'other-digest', channel: 'fax' }))
  assert.throws(() => insertContact(database, { destination: 'third@example.test', management_token_digest: 'third-digest', state: 'stopped' }))

  assert.throws(() => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(999, 'brno', 'created', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))
  database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(1, 'brno', 'created', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(1, 'brno', 'created', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))
  assert.throws(() => database.prepare('INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(1, 'brno', 'monthly', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))

  database.prepare('INSERT INTO notification_suppressions (channel, destination_hash, destination_hash_key_version, reason, suppressed_at) VALUES (?, ?, ?, ?, ?)').run('email', 'suppression-hash', 'v1', 'user-stop', '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_suppressions (channel, destination_hash, destination_hash_key_version, reason, suppressed_at) VALUES (?, ?, ?, ?, ?)').run('email', 'bad-reason-hash', 'v1', 'freeform', '2026-09-17T00:00:00.000Z'))

  database.prepare('INSERT INTO notification_abuse_attempts (requester_hash, requester_hash_key_version, attempted_at, expires_at) VALUES (?, ?, ?, ?)').run('requester-hash', 'v1', '2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z')

  database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, claim_token, claim_expires_at, payload_ciphertext, payload_iv, transport_key_version, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('outbox-pending', 1, 7, 3, 'pending', 'claim', '2026-09-17T00:01:00.000Z', 'ciphertext', 'iv', 'v1', 'first-activation', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')
  assert.throws(() => database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('outbox-invalid', 1, 1, 3, 'retrying', 'first-activation', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z'))

  const staleCas = database.prepare('UPDATE notification_outbox SET status = ? WHERE id = ? AND version = ? AND status = ?').run('claimed', 'outbox-pending', 6, 'pending')
  assert.equal(staleCas.changes, 0, 'a stale outbox version CAS must not mutate state')
  const currentCas = database.prepare('UPDATE notification_outbox SET status = ?, claim_token = ? WHERE id = ? AND version = ? AND status = ?').run('claimed', 'claim-2', 'outbox-pending', 7, 'pending')
  assert.equal(currentCas.changes, 1, 'the current outbox version/status CAS must mutate exactly one row')
  const terminal = database.prepare('UPDATE notification_outbox SET version = version + 1, status = ?, payload_ciphertext = NULL, payload_iv = NULL, transport_key_version = NULL, claim_token = NULL, claim_expires_at = NULL, terminal_at = ? WHERE id = ? AND version = ? AND status = ?').run('invalidated', '2026-09-17T00:02:00.000Z', 'outbox-pending', 7, 'claimed')
  assert.equal(terminal.changes, 1, 'a current claimed row must support lifecycle invalidation')
  assert.deepEqual(database.prepare('SELECT version, status, payload_ciphertext, payload_iv, transport_key_version, claim_token, claim_expires_at FROM notification_outbox WHERE id = ?').get('outbox-pending'), { version: 8, status: 'invalidated', payload_ciphertext: null, payload_iv: null, transport_key_version: null, claim_token: null, claim_expires_at: null })

  database.prepare('INSERT INTO notification_outbox (id, contact_id, version, expected_capability_generation, status, payload_ciphertext, payload_iv, transport_key_version, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('outbox-retained', 1, 1, 3, 'queued', 'retained-ciphertext', 'retained-iv', 'v2', 'reactivation', '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z')
  assert.deepEqual(database.prepare("SELECT id, transport_key_version FROM notification_outbox WHERE status IN ('pending', 'queued', 'claimed') AND payload_ciphertext IS NOT NULL AND payload_iv IS NOT NULL AND transport_key_version IS NOT NULL ORDER BY id").all(), [{ id: 'outbox-retained', transport_key_version: 'v2' }], 'only nonterminal payload rows may retain transport-key references')
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
  const result = await applyDatabaseMigrations({ dir: hubDirectory, db: { dialect: 'sqlite' } }, runnerDatabase as never)
  assert.notEqual(result, false, 'NuxtHub migration runner rejected the generated migration')
}

const fullRehearsal = async () => {
  const migrations = trackedMigrations()
  const migrationHashes = await Promise.all(migrations.map(async migration => ({ migration: basename(migration), hash: createHash('sha256').update(await readFile(join(root, migration))).digest('hex') })))
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'notification-migration-'))
  assertWithinTmp(temporaryDirectory)
  const databasePath = join(temporaryDirectory, 'notification.sqlite')

  try {
    const database = new Database(databasePath)
    database.exec('PRAGMA foreign_keys = ON;')
    const sentinelBefore = seededSentinels(database)
    await applyWithNuxtHubRunner(database, join(temporaryDirectory, 'hub'), migrations)
    inspectContract(database)
    assert.deepEqual(database.prepare('SELECT hex(payload) AS content FROM content_sentinel WHERE id = 1').get(), sentinelBefore, 'migration altered Content sentinel data')
    assert.equal(database.prepare('SELECT hex(payload) AS portal FROM portal_sentinel WHERE id = 1').get()?.portal, Buffer.from('portal-owned sentinel\u0000value').toString('hex').toUpperCase(), 'migration altered Portal sentinel data')
    exerciseConstraints(database)
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
    assert.deepEqual(reconnected.prepare('SELECT id, transport_key_version FROM notification_outbox WHERE id = ?').get('outbox-retained'), { id: 'outbox-retained', transport_key_version: 'v2' }, 'retained outbox state did not survive reconnect')
    reconnected.close()

    return { cleanup: 'pending', migrations: migrationHashes, objects: Object.keys(notificationTables), indexes: expectedIndexes, queryPlans, sentinels: 'preserved', constraints: 'fixed codes, foreign keys, uniqueness, and CAS enforced', reconnect: 'versioned state survived a fresh SQLite handle', temporaryDirectory }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

const bundleContract = async (configPath: string) => {
  const migrations = trackedMigrations()
  const resolvedConfigPath = resolve(root, configPath)
  assert.ok(resolvedConfigPath.startsWith(`${root}${sep}`), 'bundle config must remain within the repository')
  const config = JSON.parse(await readFile(resolvedConfigPath, 'utf8')) as { d1_databases?: Array<{ binding?: string, migrations_dir?: string }> }
  const database = config.d1_databases?.find(candidate => candidate.binding === 'DB')
  assert.ok(database?.migrations_dir, 'generated Wrangler config must include DB migration packaging')
  const packagedDirectory = resolve(dirname(resolvedConfigPath), database.migrations_dir)
  assert.ok(packagedDirectory.startsWith(`${dirname(resolvedConfigPath)}${sep}`), 'DB migration directory must remain inside generated output')
  const packaged = (await readdir(packagedDirectory)).filter(file => file.endsWith('.sql')).sort()
  assert.deepEqual(packaged, migrations.map(migration => basename(migration)), 'DB must package exactly the rehearsed sole migration')
  const migrationHashes = await Promise.all(migrations.map(async migration => {
    const source = createHash('sha256').update(await readFile(join(root, migration))).digest('hex')
    const packagedHash = createHash('sha256').update(await readFile(join(packagedDirectory, basename(migration)))).digest('hex')
    assert.equal(packagedHash, source, `generated migrations directory does not contain the rehearsed ${basename(migration)} hash`)
    return { migration: basename(migration), hash: source }
  }))
  return { migrations: migrationHashes, binding: 'DB', migrationsDirectory: database.migrations_dir }
}

const mode = process.argv[2]

if (mode === '--schema-contract' || mode === '--full-rehearsal') {
  const result = await fullRehearsal()
  process.stdout.write(`${JSON.stringify({ ...result, cleanup: 'complete', temporaryDirectory: 'confined to /tmp and removed' }, null, 2)}\n`)
} else if (mode === '--bundle-contract' && process.argv[3]) {
  process.stdout.write(`${JSON.stringify(await bundleContract(process.argv[3]), null, 2)}\n`)
} else {
  throw new Error('Usage: verify-notification-migration.ts --schema-contract | --full-rehearsal | --bundle-contract <wrangler.json>')
}
