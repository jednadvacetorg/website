import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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
// The pre-adoption reference must not move when this replacement history is committed.
const preservedHistoryCommit = '85bd4e597d03aa9f733cae578147de0bbd556e84'
const immutable = {
  '0000_majestic_lightspeed.sql': 'a1addce2b5571d2939bd36cb20995ebbb4874b8614a6db4cd7d42ea9e8234701',
  'meta/0000_snapshot.json': 'd062ed79d7e492a622082471c6a830550392239987632e2b8b3171203a0d9b62',
  '0001_phase_7_columns.sql': '49c000ce01c3ea3e042494747894557a65236a38b2563ff764ac63306b6f4f92',
  'meta/0001_snapshot.json': '526917342aef28b2b40a6c3c0e9aa799effa1565025e70d9ef1da70bf55c71da',
  '0002_detach_event_callback_fk.sql': 'a92986e490c39f6bd3ba95ac19aa224659f31872a0100558d33f856c6d74d4dd',
  'meta/0002_snapshot.json': '242af3d7d3618916c032d9198bacdb0de789ae0d5ea26b53d029081f3a819324',
  '0003_restore_event_ledger_checks.sql': '73f2283572afeedda5f4ae91e130094799ccb967e55e989d8c096d29d23717b8',
  'meta/0003_snapshot.json': 'ade85a430112e47423cfb2cd1842665f4cac60c057b12a04dc22eca8a6dc2760',
  '0004_restore_event_callback_fk.sql': '597edddf6276bdedbc1afeebb8488d6dc78f6b7ee5c5efa3dbe70bb22b99ef55',
  'meta/0004_snapshot.json': '100687f929fcef627b48adef43b2fff7065ddc8a030ed4ce5f4f77f584355fc6',
}
const approvedSql = {
  ...Object.fromEntries(Object.entries(immutable).filter(([file]) => file.endsWith('.sql'))),
  '0002_detach_event_callback_fk.sql': 'a92986e490c39f6bd3ba95ac19aa224659f31872a0100558d33f856c6d74d4dd',
  '0003_restore_event_ledger_checks.sql': '73f2283572afeedda5f4ae91e130094799ccb967e55e989d8c096d29d23717b8',
  '0004_restore_event_callback_fk.sql': '597edddf6276bdedbc1afeebb8488d6dc78f6b7ee5c5efa3dbe70bb22b99ef55',
  '0005_lifecycle_email_columns.sql': '6504c301f85ea1503f7bf0f62653452d53eddeb9136d315919f96571592e577e',
  '0006_lifecycle_email_constraints.sql': '35ce64741e6896ab566a601739cfa5d390b330942d3bafa4bcbff4272e055c36',
}
const repairSchemaHash = 'd865e972463311730b3771a67aa2a3984e70145781d27b25bc82d3e89477c05f'
const finalSchemaHash = '5bc72d17fcca41694dae1576df89ea882967192409bc65bba751c1d969f8608e'
const candidateMetadata = {
  'meta/0005_snapshot.json': 'e951e04eda9f7d7729ca7602b7e1e2e36511f1da7602b6d015363eae00e84691',
  'meta/0006_snapshot.json': 'f254574b4c3edee434a3fd72f0ad654c55a8ee5c334b04993675f0adddcff65b',
  'meta/_journal.json': '8d961871686abe432fe4f4aae86f6106a9630f6f83ff1753fc08692eff99f23a',
}
const stageInputs = {
  'repair-A.ts': '3ea8beca42339355c8decfde26e42f0d985df1aae985d43b8276d0df7c7beff8',
  'repair-B.ts': '08c52599c8e7287c2279b659b74f6e3ade745cb1eca3fdaa60a64a2d9449c6bf',
  'repair-C.ts': repairSchemaHash,
  'stage-A.ts': 'a79d182f338cf3e7cd2829b5f57248402dc6b847a1450fcc137e940f84c255be',
  'stage-B.ts': finalSchemaHash,
}
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const emittedSchemaPath = join(resolve(process.env.NUXT_BUILD_DIR || join(root, '.nuxt')), 'hub/db/schema.mjs')
const assertStageInputs = async (directory: string) => {
  for (const [file, expected] of Object.entries(stageInputs)) assert.equal(hash(await readFile(join(directory, file))), expected, `${file} approved independent schema input`)
}
const generationInventory = async () => {
  const paths = ['server/db/schema.ts', emittedSchemaPath,
    ...(await readdir(join(root, migrationDirectory))).filter(file => file.endsWith('.sql')).map(file => `${migrationDirectory}/${file}`),
    ...(await readdir(join(root, migrationDirectory, 'meta'))).filter(file => file.endsWith('.json')).map(file => `${migrationDirectory}/meta/${file}`)]
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, hash(await readFile(resolve(root, path)))])))
}
const assertImmutable = async (directory: string) => {
  for (const [file, expected] of Object.entries(immutable)) assert.equal(hash(await readFile(join(directory, file))), expected, `${file} immutable hash`)
}
const historyInventory = async (directory: string) => {
  const files = [...Object.keys(approvedSql), ...Object.keys(approvedSql).map((_, index) => `meta/${String(index).padStart(4, '0')}_snapshot.json`), 'meta/_journal.json']
  return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(directory, file)))])))
}
const generationBaseline = async (directory: string, intermediate: boolean) => {
  assertWithinTmp(directory)
  await assertImmutable(join(root, migrationDirectory))
  assert.equal(hash(await readFile(join(root, 'server/db/schema.ts'))), finalSchemaHash, 'final approved schema must remain exact')
  await assertStageInputs(directory)
  if (intermediate) {
    await mkdir(join(directory, 'replay/meta'), { recursive: true })
    assert.deepEqual(await readdir(join(directory, 'replay')), ['meta'], 'replay baseline must start empty')
    assert.deepEqual(await readdir(join(directory, 'replay/meta')), [], 'replay metadata must start empty')
    for (const file of Object.keys(immutable)) await cp(join(root, migrationDirectory, file), join(directory, 'replay', file))
    const journal = JSON.parse(await readFile(join(root, migrationDirectory, 'meta/_journal.json'), 'utf8')) as Journal
    await writeFile(join(directory, 'replay/meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 5) }, null, 2))
    const inputs = Object.fromEntries(await Promise.all(Object.keys(stageInputs).map(async file => [file, hash(await readFile(join(directory, file)))])))
    await writeFile(join(directory, 'stage-inputs.json'), JSON.stringify(inputs, null, 2))
  } else {
    await assertImmutable(join(directory, 'replay'))
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'stage-inputs.json'), 'utf8')), stageInputs, 'stage inputs must predate replay generation')
    await compareGeneratedHistory(join(root, migrationDirectory), join(directory, 'replay'))
    await cp(emittedSchemaPath, join(directory, 'final-schema.mjs'))
    const inputs = Object.fromEntries(await Promise.all([...Object.keys(stageInputs), 'stage-inputs.json', 'final-schema.mjs'].map(async file => [file, hash(await readFile(join(directory, file)))])))
    await writeFile(join(directory, 'inventory.json'), JSON.stringify({ working: await generationInventory(), replay: await historyInventory(join(directory, 'replay')), inputs }, null, 2))
  }
  return { mode: intermediate ? 'approved repair and lifecycle inputs recorded; immutable 0000–0004 replay parent copied; run upstream columns/constraints generation next' : 'final candidate inventory recorded; run upstream final-schema no-drift generation next', directory }
}
interface Journal { version: string, dialect: string, entries: Array<{ idx: number, version: string, when: number, tag: string, breakpoints: boolean }> }
interface Snapshot { id: string, prevId: string, tables: Record<string, { columns: Record<string, { type: string }> }> }
const compareGeneratedHistory = async (working: string, replay: string) => {
  await assertImmutable(working)
  await assertImmutable(replay)
  assert.equal(hash(await readFile(join(root, 'server/db/schema.ts'))), finalSchemaHash, 'approved final schema hash')
  for (const [file, expected] of Object.entries(candidateMetadata)) assert.equal(hash(await readFile(join(working, file))), expected, `${file} adopted candidate metadata`)
  const parseJournal = async (directory: string) => JSON.parse(await readFile(join(directory, 'meta/_journal.json'), 'utf8')) as Journal
  const actual = await parseJournal(working)
  const reproduced = await parseJournal(replay)
  const expectedTags = Object.keys(approvedSql).map(file => file.slice(0, -4))
  assert.deepEqual(actual.entries.map(entry => entry.tag), expectedTags)
  assert.deepEqual(reproduced.entries.map(entry => entry.tag), expectedTags)
  const original = JSON.parse(execFileSync('git', ['show', `${preservedHistoryCommit}:${migrationDirectory}/meta/_journal.json`], { cwd: root, encoding: 'utf8' })) as Journal
  for (const journal of [actual, reproduced]) {
    assert.equal(journal.version, original.version)
    assert.equal(journal.dialect, original.dialect)
    assert.deepEqual(journal.entries[0], original.entries[0])
    assert.deepEqual(journal.entries[1], original.entries[1])
    assert.deepEqual(journal.entries.slice(2, 5), [
      { idx: 2, version: '6', when: 1792064604426, tag: '0002_detach_event_callback_fk', breakpoints: true },
      { idx: 3, version: '6', when: 1792064604706, tag: '0003_restore_event_ledger_checks', breakpoints: true },
      { idx: 4, version: '6', when: 1792064604956, tag: '0004_restore_event_callback_fk', breakpoints: true },
    ])
    assert.deepEqual(journal.entries.map(entry => entry.idx), [0, 1, 2, 3, 4, 5, 6])
  }
  const withoutTimestamps = (journal: Journal) => ({ ...journal, entries: journal.entries.map((entry, index) => index >= 5 ? { ...entry, when: 0 } : entry) })
  assert.deepEqual(withoutTimestamps(actual), withoutTimestamps(reproduced), 'journal structure differs')
  let workingParent = '00000000-0000-0000-0000-000000000000'
  let replayParent = workingParent
  const workingIds = new Set<string>()
  const replayIds = new Set<string>()
  for (const [index, tag] of expectedTags.entries()) {
    for (const directory of [working, replay]) assert.equal(hash(await readFile(join(directory, `${tag}.sql`))), approvedSql[`${tag}.sql` as keyof typeof approvedSql], `${tag} approved SQL hash`)
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
    const originalFinal = JSON.parse(execFileSync('git', ['show', `${preservedHistoryCommit}:${migrationDirectory}/meta/0002_snapshot.json`], { cwd: root, encoding: 'utf8' })) as Snapshot
    const { id: _originalId, prevId: _originalParent, ...expectedSchema } = originalFinal
    if (index === 2 || index === 3) {
      const tables = expectedSchema.tables as Record<string, { foreignKeys: Record<string, unknown>, checkConstraints: Record<string, unknown>, columns: Record<string, { type: string }> }>
      tables.notification_delivery_callbacks!.foreignKeys = {}
      if (index === 2) for (const code of ['channel', 'frequency', 'reason']) delete tables.notification_event_deliveries!.checkConstraints[`notification_event_deliveries_${code}_check`]
    }
    if (index >= 2 && index <= 4) assert.deepEqual(leftSchema, expectedSchema, `${file} differs from approved repair-stage schema responsibility`)
    if (index >= 5) {
      const final = JSON.parse(await readFile(join(working, 'meta/0006_snapshot.json'), 'utf8'))
      const { id: _finalId, prevId: _finalParent, ...expectedLifecycle } = final
      if (index === 5) {
        delete expectedLifecycle.tables.notification_lifecycle_email_callbacks
        const checks = expectedLifecycle.tables.notification_outbox.checkConstraints
        for (const key of Object.keys(checks)) if (!['notification_outbox_kind_check', 'notification_outbox_status_check'].includes(key)) delete checks[key]
      }
      assert.deepEqual(leftSchema, expectedLifecycle, `${file} differs from approved lifecycle-stage responsibility`)
    }
    workingParent = left.id
    replayParent = right.id
  }
  for (const directory of [working, replay]) {
    assert.deepEqual((await readdir(directory)).filter(file => file.endsWith('.sql')).sort(), expectedTags.map(tag => `${tag}.sql`))
    assert.deepEqual((await readdir(join(directory, 'meta'))).sort(), [...expectedTags.map((_, index) => `${String(index).padStart(4, '0')}_snapshot.json`), '_journal.json'])
  }
}
const generationContract = async (directory: string) => {
  assertWithinTmp(directory)
  assert.equal(hash(await readFile(join(root, 'server/db/schema.ts'))), finalSchemaHash, 'final approved source schema changed')
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'stage-inputs.json'), 'utf8')), stageInputs)
  await assertStageInputs(directory)
  const baseline = JSON.parse(await readFile(join(directory, 'inventory.json'), 'utf8'))
  assert.deepEqual(await generationInventory(), baseline.working, 'source/emitted schema or working history changed; unexpected migration')
  assert.deepEqual(await historyInventory(join(directory, 'replay')), baseline.replay, 'upstream replay no-drift probe changed history')
  for (const [file, expected] of Object.entries(baseline.inputs)) assert.equal(hash(await readFile(join(directory, file))), expected, `${file} generation input changed`)
  const working = join(root, migrationDirectory)
  const replay = join(directory, 'replay')
  await compareGeneratedHistory(working, replay)
  const negatives = [
    { file: '0001_phase_7_columns.sql', mutate: (value: string) => `${value}\nSELECT 1;` },
    { file: 'meta/0004_snapshot.json', mutate: (value: string) => { const snapshot = JSON.parse(value) as Snapshot; snapshot.tables.notification_event_deliveries!.columns.channel!.type = 'integer'; return JSON.stringify(snapshot) } },
    { file: 'meta/0002_snapshot.json', mutate: (value: string) => JSON.stringify({ ...JSON.parse(value), prevId: '00000000-0000-0000-0000-000000000000' }) },
    { file: 'meta/_journal.json', mutate: (value: string) => { const journal = JSON.parse(value) as Journal; journal.entries[1]!.tag = '0001_wrong'; return JSON.stringify(journal) } },
    { file: '0000_majestic_lightspeed.sql', mutate: (value: string) => `${value}\nSELECT 1;` },
    { file: 'meta/_journal.json', mutate: (value: string) => { const journal = JSON.parse(value) as Journal; journal.entries[1]!.when++; return JSON.stringify(journal) } },
    { file: '0003_restore_event_ledger_checks.sql', mutate: (value: string) => `${value}\nSELECT 1;` },
    { file: 'meta/0003_snapshot.json', mutate: (value: string) => { const snapshot = JSON.parse(value); snapshot.tables.notification_delivery_callbacks.foreignKeys = { unexpected: {} }; return JSON.stringify(snapshot) } },
    { file: '0005_lifecycle_email_columns.sql', mutate: (value: string) => `${value}\nSELECT 1;` },
    { file: '0006_lifecycle_email_constraints.sql', mutate: (value: string) => `${value}\nSELECT 1;` },
    { file: 'meta/0005_snapshot.json', mutate: (value: string) => JSON.stringify({ ...JSON.parse(value), prevId: '00000000-0000-0000-0000-000000000000' }) },
    { file: 'meta/0006_snapshot.json', mutate: (value: string) => { const snapshot = JSON.parse(value); snapshot.tables.notification_outbox.columns.email_attempt_version.type = 'text'; return JSON.stringify(snapshot) } },
    { file: 'meta/_journal.json', mutate: (value: string) => { const journal = JSON.parse(value); journal.entries[4].when++; return JSON.stringify(journal) } },
    ...Object.keys(immutable).map(file => ({ file, mutate: (value: string) => file.endsWith('.sql') ? `${value}\nSELECT 1;` : JSON.stringify({ ...JSON.parse(value), id: '00000000-0000-0000-0000-000000000000' }) })),
  ]
  for (const [index, negative] of negatives.entries()) {
    const copy = join(directory, `negative-${index}`)
    await cp(replay, copy, { recursive: true })
    await writeFile(join(copy, negative.file), negative.mutate(await readFile(join(copy, negative.file), 'utf8')))
    await assert.rejects(compareGeneratedHistory(working, copy), `negative control ${negative.file} was accepted`)
  }
  const unexpected = join(directory, 'negative-extra')
  await cp(replay, unexpected, { recursive: true })
  await writeFile(join(unexpected, '0007_unexpected.sql'), 'SELECT 1;')
  await assert.rejects(compareGeneratedHistory(working, unexpected), 'unexpected next migration was accepted')
  const wrongInput = join(directory, 'negative-schema-input')
  await mkdir(wrongInput, { recursive: true })
  for (const file of Object.keys(stageInputs)) await cp(join(directory, file), join(wrongInput, file))
  await writeFile(join(wrongInput, 'stage-A.ts'), `${await readFile(join(wrongInput, 'stage-A.ts'), 'utf8')}\n// drift`)
  await assert.rejects(assertStageInputs(wrongInput), 'wrong schema input was accepted')
  return { inventory: baseline, replay: 'exact seven SQL and semantic snapshots/journal; pinned 0000–0004 and independently linked columns→constraints ancestry; repair and lifecycle schema inputs pinned', negativeControls: negatives.length + 2, noDrift: 'working and replay inventories unchanged since pre-probe baseline' }
}
const notificationTables = {
  notification_abuse_attempts: ['id', 'requester_hash', 'attempted_at', 'expires_at'],
  notification_contacts: ['id', 'channel', 'destination', 'destination_hash', 'management_token_digest', 'capability_generation', 'state', 'consent_at', 'consent_version', 'created_at', 'updated_at'],
  notification_delivery_callbacks: ['provider_event_id', 'delivery_id', 'event', 'provider_message_id', 'received_at'],
  notification_event_deliveries: ['id', 'contact_id', 'channel', 'community_slug', 'eligibility_frequency', 'expected_capability_generation', 'destination_hash', 'event_uid', 'event_revision', 'reason', 'status', 'provider_message_id', 'created_at', 'updated_at', 'submitted_at'],
  notification_event_state: ['event_key', 'uid', 'starts_at', 'ends_at', 'venue', 'cancelled', 'notification_revision', 'updated_at'],
  notification_management_capabilities: ['token_digest', 'contact_id', 'expected_capability_generation', 'created_at', 'expires_at'],
  notification_lifecycle_email_callbacks: ['receipt_key', 'outbox_id', 'attempt_version', 'event', 'provider_message_id', 'received_at'],
  notification_outbox: ['id', 'contact_id', 'version', 'expected_capability_generation', 'status', 'claim_token', 'claim_expires_at', 'payload_ciphertext', 'payload_iv', 'kind', 'created_at', 'updated_at', 'terminal_at', 'email_destination_hash', 'email_provider_message_id', 'email_delivery_status', 'email_attempted_at', 'email_attempt_version'],
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
  notification_lifecycle_email_callbacks: ['notification_lifecycle_email_callbacks_outbox_idx'],
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
  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(notification_lifecycle_email_callbacks)').all().map(row => [row.table, row.from, row.to, row.on_delete]), [['notification_outbox', 'outbox_id', 'id', 'CASCADE']])
  for (const table of ['notification_contacts', 'notification_event_deliveries', 'notification_outbox', 'notification_subscriptions', 'notification_suppressions', 'notification_lifecycle_email_callbacks']) {
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
  const attemptedAt = '2026-09-17T00:00:00.000Z'
  const destinationHash = 'A'.repeat(43)
  database.prepare("UPDATE notification_outbox SET email_destination_hash = ?, email_provider_message_id = ?, email_delivery_status = 'pending', email_attempted_at = ?, email_attempt_version = 7 WHERE id = 'outbox-pending'").run(destinationHash, 'Case/é@provider.test', attemptedAt)
  for (const [column, values] of Object.entries({
    email_destination_hash: ['', 'short', `${'A'.repeat(42)}!`],
    email_provider_message_id: ['', 'é'.repeat(129), '<wrapped>', 'line\nfeed', 'nul\u0000byte', 'x\u007Fx', 'x\u0085x'],
    email_delivery_status: ['unknown'],
    email_attempted_at: ['bad'],
    email_attempt_version: [0, -1, 1.5, 9, 'invalid'],
  })) for (const value of values) assert.throws(() => database.prepare(`UPDATE notification_outbox SET ${column} = ? WHERE id = 'outbox-pending'`).run(value), `${column} invalid value must fail`)
  for (const status of ['pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed']) database.prepare("UPDATE notification_outbox SET email_delivery_status = ? WHERE id = 'outbox-pending'").run(status)
  database.prepare("UPDATE notification_outbox SET email_provider_message_id = ? WHERE id = 'outbox-pending'").run('é'.repeat(128))
  assert.throws(() => database.prepare("UPDATE notification_outbox SET email_delivery_status = 'pending' WHERE id = 'event-sms'").run(), 'event outbox cannot acquire lifecycle evidence')
  const insertReceipt = (key: string, outboxId: string, version: unknown, event: string, providerId: string | null, receivedAt = attemptedAt) => database.prepare('INSERT INTO notification_lifecycle_email_callbacks VALUES (?, ?, ?, ?, ?, ?)').run(key, outboxId, version, event, providerId, receivedAt)
  for (const [index, event] of ['delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed'].entries()) insertReceipt(String(index).repeat(64), 'outbox-pending', 7, event, 'Case/é@provider.test')
  assert.throws(() => insertReceipt('0'.repeat(64), 'outbox-pending', 7, 'delivered', 'provider'), 'duplicate receipt rejected')
  assert.throws(() => insertReceipt('a'.repeat(64), 'missing', 7, 'delivered', 'provider'), 'receipt orphan rejected')
  for (const version of [0, -1, 1.5, 'bad']) assert.throws(() => insertReceipt('a'.repeat(64), 'outbox-pending', version, 'delivered', 'provider'))
  assert.throws(() => insertReceipt('a'.repeat(64), 'outbox-pending', 7, 'unknown', 'provider'))
  assert.throws(() => insertReceipt('bad', 'outbox-pending', 7, 'delivered', 'provider'))
  for (const provider of ['', null, 'é'.repeat(129), '<wrapped>', 'x\u0000x', 'x\u0085x']) assert.throws(() => insertReceipt('a'.repeat(64), 'outbox-pending', 7, 'delivered', provider))
  assert.throws(() => insertReceipt('a'.repeat(64), 'outbox-pending', 7, 'delivered', 'provider', 'bad'))
  database.exec('BEGIN')
  try {
    database.prepare("UPDATE notification_outbox SET email_delivery_status = 'delivered' WHERE id = 'outbox-pending'").run()
    assert.throws(() => insertReceipt('a'.repeat(64), 'outbox-pending', 0, 'delivered', 'provider'))
  } finally { database.exec('ROLLBACK') }
  assert.equal(database.prepare("SELECT email_delivery_status FROM notification_outbox WHERE id = 'outbox-pending'").get()?.email_delivery_status, 'failed', 'rollback restores preceding valid change')
  const eventHistory = database.prepare('SELECT * FROM notification_delivery_callbacks ORDER BY provider_event_id').all()
  const suppressions = database.prepare('SELECT * FROM notification_suppressions ORDER BY id').all()
  // This is a persistence rehearsal, not the deferred 06-18 runtime integration.
  database.prepare("UPDATE notification_outbox SET contact_id = NULL, payload_ciphertext = NULL, payload_iv = NULL, claim_token = NULL, claim_expires_at = NULL WHERE id = 'outbox-pending'").run()
  database.prepare('DELETE FROM notification_contacts WHERE id = ?').run(1)
  assert.deepEqual(database.prepare('SELECT contact_id, destination_hash FROM notification_event_deliveries WHERE id = ?').get('delivery-1'), { contact_id: null, destination_hash: 'destination-hash' }, 'delivery audit evidence must survive contact deletion without a recipient')
  assert.deepEqual(database.prepare("SELECT contact_id, payload_ciphertext, payload_iv, claim_token, claim_expires_at, email_destination_hash, email_attempt_version FROM notification_outbox WHERE id = 'outbox-pending'").get(), { contact_id: null, payload_ciphertext: null, payload_iv: null, claim_token: null, claim_expires_at: null, email_destination_hash: destinationHash, email_attempt_version: 7 })
  assert.equal(database.prepare('SELECT COUNT(*) count FROM notification_lifecycle_email_callbacks').get()?.count, 6)
  assert.deepEqual(database.prepare('SELECT * FROM notification_delivery_callbacks ORDER BY provider_event_id').all(), eventHistory)
  assert.deepEqual(database.prepare('SELECT * FROM notification_suppressions ORDER BY id').all(), suppressions)
  const evidence = JSON.stringify(database.prepare('SELECT * FROM notification_lifecycle_email_callbacks').all())
  for (const raw of ['alice@example.test', 'token-digest', 'alias-digest', 'ciphertext']) assert.ok(!evidence.includes(raw), 'receipt evidence must not retain contact/capability/payload')
  database.prepare("INSERT INTO notification_outbox (id, version, expected_capability_generation, status, kind, created_at, updated_at) VALUES ('receipt-cleanup', 1, 1, 'consumed', 'first-activation', ?, ?)").run(attemptedAt, attemptedAt)
  insertReceipt('f'.repeat(64), 'receipt-cleanup', 1, 'delivered', 'provider')
  database.prepare("DELETE FROM notification_outbox WHERE id = 'receipt-cleanup'").run()
  assert.equal(database.prepare("SELECT COUNT(*) count FROM notification_lifecycle_email_callbacks WHERE outbox_id = 'receipt-cleanup'").get()?.count, 0)
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
  await compareGeneratedHistory(join(root, migrationDirectory), join(root, migrationDirectory))
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
      const before = Object.fromEntries(upgrade.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'notification_%'").all().map(row => [String(row.name), upgrade.prepare(`SELECT * FROM ${row.name}`).all()]))
      await applyWithNuxtHubRunner(upgrade, join(temporaryDirectory, 'upgrade-hub'), migrations.slice(0, 6))
      assert.equal(upgrade.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE name = 'notification_lifecycle_email_callbacks'").get()?.count, 0, 'columns stage must not create the receipt child')
      assert.deepEqual(upgrade.prepare("SELECT email_destination_hash, email_provider_message_id, email_delivery_status, email_attempted_at, email_attempt_version FROM notification_outbox WHERE id = 'legacy-outbox'").get(), { email_destination_hash: null, email_provider_message_id: null, email_delivery_status: null, email_attempted_at: null, email_attempt_version: null })
      await applyWithNuxtHubRunner(upgrade, join(temporaryDirectory, 'upgrade-hub'), migrations)
      inspectContract(upgrade)
      assert.deepEqual(upgrade.prepare("SELECT email_destination_hash, email_provider_message_id, email_delivery_status, email_attempted_at, email_attempt_version FROM notification_outbox WHERE id = 'legacy-outbox'").get(), { email_destination_hash: null, email_provider_message_id: null, email_delivery_status: null, email_attempted_at: null, email_attempt_version: null }, 'constraint stage must preserve null old evidence without backfill')
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
      lifecycleReceipt: planDetail(database, 'SELECT receipt_key FROM notification_lifecycle_email_callbacks WHERE outbox_id = ?', ['outbox-pending'], 'notification_lifecycle_email_callbacks_outbox_idx'),
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
  await compareGeneratedHistory(join(root, migrationDirectory), join(root, migrationDirectory))
  const resolvedConfigPath = resolve(root, configPath)
  const actualConfigPath = await realpath(resolvedConfigPath)
  if (!actualConfigPath.startsWith(`${await realpath(root)}${sep}`)) {
    const ownedRoot = await realpath(tmpdir())
    assert.ok(ownedRoot.startsWith('/tmp/opencode/') && actualConfigPath.startsWith(`${ownedRoot}${sep}`), 'external bundle config must remain within the explicitly owned /tmp/opencode TMPDIR')
    assert.ok(actualConfigPath.endsWith(`${sep}output${sep}server${sep}wrangler.json`), 'owned bundle config must be the actual generated output/server/wrangler.json')
  }
  const config = JSON.parse(await readFile(resolvedConfigPath, 'utf8')) as { d1_databases?: Array<{ binding?: string, migrations_dir?: string, migrations_table?: string }> }
  const database = config.d1_databases?.find(candidate => candidate.binding === 'DB')
  assert.ok(database?.migrations_dir, 'generated Wrangler config must include DB migration packaging')
  assert.equal(database.migrations_table, '_hub_migrations', 'generated config must retain the NuxtHub migration ledger')
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
