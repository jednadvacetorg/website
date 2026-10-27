import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

import { dueEventEmailReasons, planEventNotifications } from '../server/utils/eventEmailNotifications.ts'
import { composeBrevoEventSms } from '../server/utils/brevoSms.ts'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { activateNotificationChannel, readNotificationManagement, requestNotificationManagementRecovery, stopNotificationChannel, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'
import type { PortalCalendarEvent } from '../server/utils/portalEvents.ts'

const config = { ...await notificationConfig({
  notificationCommunitySlugs: 'brno,praha', notificationRootKey: btoa('01234567890123456789012345678901').replace(/=+$/g, ''),
  notificationTurnstileSecret: 'synthetic', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09',
  notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
}), emailDeliveryReady: true }
const schema = ['0000_majestic_lightspeed', '0001_phase_7_columns', '0002_detach_event_callback_fk', '0003_restore_event_ledger_checks', '0004_restore_event_callback_fk', '0005_lifecycle_email_columns', '0006_lifecycle_email_constraints'].map(name => readFileSync(new URL(`../server/db/migrations/sqlite/${name}.sql`, import.meta.url), 'utf8')).join('\n')
const fixture = (fail?: (sql: string) => boolean) => {
  const sqlite = new Database(':memory:')
  sqlite.exec(schema)
  sqlite.exec('PRAGMA foreign_keys = ON')
  const executions = new WeakMap<NotificationStatement, () => unknown>()
  const database: NotificationDatabase = {
    prepare: sql => {
      let values: unknown[] = []
      const execute = () => {
        if (fail?.(sql)) throw new Error('Injected D1 failure')
        return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }
      }
      const statement: NotificationStatement = {
        bind: (...bound) => { values = bound; return statement },
        first: async <T>() => sqlite.prepare(sql).get(...values) as T ?? null,
        all: async <T>() => ({ results: sqlite.prepare(sql).all(...values) as T[] }),
        run: async () => execute(),
      }
      executions.set(statement, execute)
      return statement
    },
    batch: async statements => sqlite.transaction(() => statements.map(statement => executions.get(statement)!()))(),
  }
  let now = new Date('2026-01-01T10:00:00.000Z')
  const dependencies = { database, config, now: () => now }
  return { sqlite, database, dependencies, setNow: (value: string) => { now = new Date(value) } }
}
const signup = (dependencies: Parameters<typeof activateNotificationChannel>[1], frequencies = ['created'], contact = 'alice@example.test', community = 'brno') => activateNotificationChannel({ channel: 'email', contact, communitySlugs: [community], frequencies, consentAt: '2026-01-01T00:00:00.000Z', consentVersion: '2026-09' }, dependencies)
const item = (overrides: Partial<PortalCalendarEvent> = {}): PortalCalendarEvent => ({
  event: { id: '12', title: 'Meetup', start: '2026-01-12T12:00:00.000Z', end: null, location: 'Venue', tags: [] },
  community: { id: 'brno', title: 'Brno', path: '/brno' }, sequence: 72, changedAt: '2026-01-01T00:00:00.000Z', cancelled: false, ...overrides,
})
const decode = (value: string) => Uint8Array.from(Buffer.from(value, 'base64url'))
const payloads = async (sqlite: Database.Database) => Promise.all((sqlite.prepare("SELECT payload_ciphertext, payload_iv FROM notification_outbox WHERE kind = 'event-email' AND payload_ciphertext IS NOT NULL").all() as { payload_ciphertext: string, payload_iv: string }[]).map(async row => JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(row.payload_iv) }, config.outboxTransportKey, decode(row.payload_ciphertext))))))

test('one shared traversal plans three independently deduped channels with exact selected scope', async () => {
  const { sqlite, dependencies } = fixture()
  const ready = { ...dependencies, config: { ...config, smsEnabled: true, smsEventDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true, webPushEnabled: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true, eventWebPushOutboxSupported: true } }
  await signup(ready)
  for (const channel of ['sms', 'web-push']) {
    sqlite.prepare("INSERT INTO notification_contacts (channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'consent', '2026-09', 'created', 'updated')").run(channel, `${channel}-destination`, `${channel}-hash`, `${channel}-digest`)
    sqlite.prepare("INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) SELECT id, 'brno', 'created', 'created', 'updated' FROM notification_contacts WHERE channel = ?").run(channel)
  }
  const source = item({ event: { ...item().event, osm_name: 'Bar', osm_address: 'Ulice 1, Brno', location: 'Zadní salonek' } })
  const results = await Promise.all([planEventNotifications([source], ready), planEventNotifications([source], ready)])
  assert.equal(results.reduce((sum, result) => sum + result.planned, 0), 3)
  assert.deepEqual(sqlite.prepare('SELECT channel, community_slug, eligibility_frequency FROM notification_event_deliveries ORDER BY channel').all(), ['email', 'sms', 'web-push'].map(channel => ({ channel, community_slug: 'brno', eligibility_frequency: 'created' })))
  assert.deepEqual(sqlite.prepare("SELECT kind FROM notification_outbox WHERE kind LIKE 'event-%' ORDER BY kind").all(), [{ kind: 'event-email' }, { kind: 'event-sms' }, { kind: 'event-web-push' }])
  const smsRow = sqlite.prepare("SELECT payload_ciphertext, payload_iv FROM notification_outbox WHERE kind = 'event-sms'").get() as { payload_ciphertext: string, payload_iv: string }
  const smsPayload = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(smsRow.payload_iv) }, config.outboxTransportKey, decode(smsRow.payload_ciphertext))))
  assert.equal(smsPayload.event.location, 'Bar, Ulice 1, Brno, Zadní salonek')
  assert.equal(smsPayload.event.communityUrl, 'https://jednadvacet.org/brno')
  assert.equal(composeBrevoEventSms({ ...smsPayload, recipient: smsPayload.destination }), 'Meetup\n12. 1. 2026 13:00\nBar, Ulice 1, Brno, Zadni salonek\n\nhttps://jednadvacet.org/brno')
  const updated = item({ event: { ...item().event, location: 'New venue' }, changedAt: '2026-01-02T00:00:00Z' })
  sqlite.prepare("UPDATE notification_event_deliveries SET status = 'submitted'").run()
  assert.equal((await planEventNotifications([updated], ready)).planned, 3)
  assert.equal((await planEventNotifications([item({ ...updated, cancelled: true, changedAt: '2026-01-03T00:00:00Z' })], ready)).planned, 3)
})

test('a disabled channel consumes discovery without sendable backlog and leaves other channels independent', async () => {
  const { sqlite, dependencies } = fixture()
  await signup(dependencies)
  for (const channel of ['sms', 'web-push']) {
    sqlite.prepare("INSERT INTO notification_contacts (channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'consent', '2026-09', 'created', 'updated')").run(channel, `${channel}-destination`, `${channel}-hash`, `${channel}-digest`)
    sqlite.prepare("INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) SELECT id, 'brno', 'created', 'created', 'updated' FROM notification_contacts WHERE channel = ?").run(channel)
  }
  const ready = { ...dependencies, config: { ...config, smsEnabled: true, smsEventDeliveryReady: true, smsDeliveryReady: false, eventSmsOutboxSupported: true, webPushEnabled: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true, eventWebPushOutboxSupported: true } }
  assert.deepEqual((await planEventNotifications([item()], ready)).plannedByChannel, { email: 1, sms: 0, 'web-push': 1 })
  assert.deepEqual(sqlite.prepare('SELECT channel, status FROM notification_event_deliveries ORDER BY channel').all(), [{ channel: 'email', status: 'pending' }, { channel: 'sms', status: 'failed' }, { channel: 'web-push', status: 'pending' }])
  assert.equal((await planEventNotifications([item()], { ...ready, config: { ...ready.config, smsDeliveryReady: true } })).planned, 0)
  assert.equal(sqlite.prepare("SELECT count(*) n FROM notification_outbox WHERE kind = 'event-sms'").get().n, 0)
})

test('signup to event outbox gives one unpredictable usable management bearer and truthful repeat count', async () => {
  const { sqlite, dependencies } = fixture()
  await signup(dependencies)
  assert.deepEqual(await planEventNotifications([item()], dependencies), { planned: 1, plannedByChannel: { email: 1, sms: 0, 'web-push': 0 } })
  assert.deepEqual(await planEventNotifications([item()], dependencies), { planned: 0, plannedByChannel: { email: 0, sms: 0, 'web-push': 0 } })
  const [payload] = await payloads(sqlite)
  assert.equal(decode(payload.managementCapability).length, 32)
  const guessed = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('capability:1:brno-12@jednadvacet.org:72:created'))).toString('base64url')
  assert.equal((await readNotificationManagement(guessed, dependencies)).state, 'unavailable')
  assert.equal((await readNotificationManagement(payload.managementCapability, dependencies)).state, 'active')
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_management_capabilities').get().n, 1)
  assert.equal(sqlite.prepare('SELECT notification_revision FROM notification_event_state').get().notification_revision, 0)
  await stopNotificationChannel(payload.managementCapability, dependencies)
  assert.equal((await readNotificationManagement(payload.managementCapability, dependencies)).state, 'unavailable')
})

const event = (start: string) => ({ event: { start }, cancelled: false })

test('Prague 09:00 reminder projection handles CET and CEST boundaries', () => {
  assert.deepEqual(dueEventEmailReasons(event('2026-01-08T12:00:00.000Z'), new Date('2026-01-01T08:00:00.000Z')), ['week-before'])
  assert.deepEqual(dueEventEmailReasons(event('2026-04-01T12:00:00.000Z'), new Date('2026-03-31T07:00:00.000Z')), ['day-before'])
  assert.deepEqual(dueEventEmailReasons(event('2026-04-01T12:00:00.000Z'), new Date('2026-03-31T08:00:00.000Z')), ['day-before'])
})

test('an already-known event recovers one selected reminder after a missed Prague 09:00 hour', async () => {
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies, ['day-before'])
  const source = item()
  await planEventNotifications([source], dependencies)
  setNow('2026-01-11T09:15:00.000Z')
  assert.deepEqual(await planEventNotifications([source], dependencies), { planned: 1, plannedByChannel: { email: 1, sms: 0, 'web-push': 0 } })
  assert.equal((await payloads(sqlite)).find(payload => payload.reason === 'day-before')?.reason, 'day-before')
  assert.equal((await planEventNotifications([source], dependencies)).planned, 0)
})

test('Prague reminder recovery is bounded by local day, start, and DST calendar dates', () => {
  for (const { start, now, expected } of [
    { start: '2026-01-08T12:00:00.000Z', now: '2026-01-01T07:59:59.000Z', expected: [] },
    { start: '2026-01-08T12:00:00.000Z', now: '2026-01-01T08:00:00.000Z', expected: ['week-before'] },
    { start: '2026-01-08T12:00:00.000Z', now: '2026-01-07T22:59:59.000Z', expected: ['day-before'] },
    { start: '2026-01-08T12:00:00.000Z', now: '2026-01-07T23:00:00.000Z', expected: [] },
    { start: '2026-04-05T12:00:00.000Z', now: '2026-03-29T07:00:00.000Z', expected: ['week-before'] },
    { start: '2026-11-01T12:00:00.000Z', now: '2026-10-25T08:00:00.000Z', expected: ['week-before'] },
    { start: '2026-04-01T07:00:00.000Z', now: '2026-04-01T07:00:00.000Z', expected: [] },
  ]) assert.deepEqual(dueEventEmailReasons(event(start), new Date(now)), expected)
})

test('a due reminder revision collides with carry-forward once and never revives terminal work', async () => {
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies, ['day-before'])
  const source = item()
  await planEventNotifications([source], dependencies)
  setNow('2026-01-11T08:00:00.000Z')
  assert.equal((await planEventNotifications([source], dependencies)).planned, 1)
  setNow('2026-01-11T09:15:00.000Z')
  const edited = item({ changedAt: '2026-01-02T00:00:00.000Z', event: { ...source.event, location: 'Revised venue' } })
  assert.equal((await planEventNotifications([edited], dependencies)).planned, 1)
  assert.deepEqual(sqlite.prepare("SELECT reason, event_revision, status FROM notification_event_deliveries WHERE event_revision = 1").all(), [{ reason: 'day-before', event_revision: 1, status: 'pending' }])
  for (const [status, submittedAt] of [['submitted', null], ['delivered', null], ['failed', null], ['pending', '2026-01-11T09:15:00.000Z']] as const) {
    sqlite.prepare('UPDATE notification_event_deliveries SET status = ?, submitted_at = ? WHERE event_revision = 1').run(status, submittedAt)
    assert.equal((await planEventNotifications([edited], dependencies)).planned, 0)
  }
})

test('cancelled and elapsed events never produce due reminders', () => {
  assert.deepEqual(dueEventEmailReasons({ ...event('2026-01-08T12:00:00.000Z'), cancelled: true }, new Date('2026-01-01T08:00:00.000Z')), [])
  assert.deepEqual(dueEventEmailReasons(event('2026-01-01T07:00:00.000Z'), new Date('2026-01-01T08:00:00.000Z')), [])
})

test('overlapping planners commit one alias/outbox/ledger and sum only committed work', async () => {
  const { sqlite, dependencies } = fixture()
  await signup(dependencies)
  const results = await Promise.all(Array.from({ length: 6 }, () => planEventNotifications([item()], dependencies)))
  assert.equal(results.reduce((total, result) => total + result.planned, 0), 1)
  for (const table of ['notification_event_deliveries', 'notification_management_capabilities', 'notification_event_state']) assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n, 1)
  assert.equal((await payloads(sqlite)).length, 1)
})

test('late alias/state failures roll back every event write and allow a complete retry', async () => {
  for (const prefix of ['INSERT INTO notification_management_capabilities', 'INSERT INTO notification_event_state']) {
    let failing = false
    const { sqlite, dependencies } = fixture(sql => failing && sql.startsWith(prefix))
    await signup(dependencies)
    failing = true
    await assert.rejects(planEventNotifications([item()], dependencies), /Injected D1 failure/)
    for (const table of ['notification_event_deliveries', 'notification_management_capabilities', 'notification_event_state']) assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0)
    assert.equal((await payloads(sqlite)).length, 0)
    failing = false
    assert.equal((await planEventNotifications([item()], dependencies)).planned, 1)
  }
})

test('unsent recovery repairs once with a new generation bearer; submitted work never resends', async () => {
  for (const status of ['pending', 'submitted', 'delivered', 'failed']) {
    const { sqlite, dependencies } = fixture()
    await signup(dependencies)
    await planEventNotifications([item()], dependencies)
    const [old] = await payloads(sqlite)
    sqlite.prepare('UPDATE notification_event_deliveries SET status = ?').run(status)
    await requestNotificationManagementRecovery({ channel: 'email', contact: 'alice@example.test' }, dependencies)
    assert.equal((await readNotificationManagement(old.managementCapability, dependencies)).state, 'unavailable')
    assert.equal((await planEventNotifications([item()], dependencies)).planned, status === 'pending' ? 1 : 0)
    assert.equal((await planEventNotifications([item()], dependencies)).planned, 0)
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_event_deliveries').get().n, 1)
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_management_capabilities').get().n, status === 'pending' ? 1 : 0)
    const rows = await payloads(sqlite)
    if (status === 'pending') {
      assert.equal(rows.length, 1)
      assert.notEqual(rows[0].managementCapability, old.managementCapability)
      assert.equal((await readNotificationManagement(rows[0].managementCapability, dependencies)).state, 'active')
      assert.equal(sqlite.prepare("SELECT expected_capability_generation FROM notification_event_deliveries").get().expected_capability_generation, 2)
    } else assert.equal(rows.length, 0)
    assert.equal(sqlite.prepare("SELECT payload_ciphertext FROM notification_outbox WHERE kind = 'event-email' AND expected_capability_generation = 1").get().payload_ciphertext, null)
  }
})

test('planner paused before atomic batch loses to recovery, then overlapping repairs create one replacement', async () => {
  const { sqlite, dependencies, database } = fixture()
  await signup(dependencies)
  let entered!: () => void
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { entered = resolve })
  const delayed = planEventNotifications([item()], { ...dependencies, database: { ...database, batch: async statements => { entered(); await paused; return database.batch(statements) } } })
  await ready
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'alice@example.test' }, dependencies)
  release()
  assert.equal((await delayed).planned, 0)
  // Discovery was consumed by a generation change before any work could be committed.
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 1)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_management_capabilities').get().n, 1)
  await requestNotificationManagementRecovery({ channel: 'email', contact: 'alice@example.test' }, dependencies)
  const repairs = await Promise.all([planEventNotifications([item()], dependencies), planEventNotifications([item()], dependencies)])
  assert.equal(repairs.reduce((total, result) => total + result.planned, 0), 1)
  assert.equal((await payloads(sqlite)).length, 1)
})

test('event aliases expire in 30 days while the primary lifecycle bearer remains usable', async () => {
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies)
  const lifecycle = sqlite.prepare("SELECT payload_ciphertext, payload_iv FROM notification_outbox WHERE kind = 'first-activation'").get()
  const primary = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(lifecycle.payload_iv) }, config.outboxTransportKey, decode(lifecycle.payload_ciphertext)))).capability
  await planEventNotifications([item()], dependencies)
  const [payload] = await payloads(sqlite)
  assert.equal(sqlite.prepare('SELECT expires_at FROM notification_management_capabilities').get().expires_at, '2026-01-31T10:00:00.000Z')
  setNow('2026-01-31T10:00:00.000Z')
  assert.equal((await readNotificationManagement(payload.managementCapability, dependencies)).state, 'unavailable')
  assert.equal((await readNotificationManagement(primary, dependencies)).state, 'active')
  await planEventNotifications([], dependencies)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_management_capabilities').get().n, 0)
})

test('first discovery collapses elapsed selected reminders and retains future reminders, through CET/CEST', async () => {
  for (const season of [
    { discovery: '2026-01-06T10:00:00Z', start: '2026-01-08T12:00:00Z', due: '2026-01-07T08:00:00Z' },
    { discovery: '2026-03-30T10:00:00Z', start: '2026-04-01T12:00:00Z', due: '2026-03-31T07:00:00Z' },
  ]) {
    const { sqlite, dependencies, setNow } = fixture()
    await signup(dependencies, ['week-before', 'day-before'])
    setNow(season.discovery)
    const discovered = item({ event: { ...item().event, start: season.start } })
    assert.equal((await planEventNotifications([discovered], dependencies)).planned, 1)
    assert.deepEqual((await payloads(sqlite)).map(payload => payload.reason), ['created'])
    assert.deepEqual(sqlite.prepare('SELECT reason, eligibility_frequency FROM notification_event_deliveries').all(), [{ reason: 'created', eligibility_frequency: 'week-before' }])
    assert.equal((await planEventNotifications([discovered], dependencies)).planned, 0)
    setNow(season.due)
    assert.equal((await planEventNotifications([discovered], dependencies)).planned, 1)
    assert.equal((await planEventNotifications([discovered], dependencies)).planned, 0)
    assert.deepEqual((await payloads(sqlite)).map(payload => payload.reason), ['created', 'day-before'])
  }
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies, ['week-before', 'day-before'])
  setNow('2026-01-12T11:59:59Z')
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 1)
  assert.deepEqual((await payloads(sqlite)).map(payload => payload.reason), ['created'])
})

test('cancelled discovery and start boundary never send created; later subscribers do not get rediscovery catchup', async () => {
  for (const cancelled of [true, false]) {
    const { sqlite, dependencies, setNow } = fixture()
    await signup(dependencies)
    if (!cancelled) setNow(item().event.start)
    assert.equal((await planEventNotifications([item({ cancelled })], dependencies)).planned, 0)
    assert.equal((await payloads(sqlite)).length, 0)
    assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_event_state').get().n, 1)
  }
  const { sqlite, dependencies, setNow } = fixture()
  await planEventNotifications([item()], dependencies)
  await signup(dependencies, ['created', 'day-before'])
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 0)
  setNow('2026-01-11T08:00:00Z')
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 1)
  assert.deepEqual((await payloads(sqlite)).map(payload => payload.reason), ['day-before'])
})

test('minor refresh updates source watermark without sequence bump and later reminder carries latest text', async () => {
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies, ['created', 'day-before'])
  await planEventNotifications([item()], dependencies)
  const minor = item({ sequence: 900, changedAt: '2026-01-02T00:00:00Z', event: { ...item().event, title: 'New title', description: 'Minor text' } })
  assert.equal((await planEventNotifications([minor], dependencies)).planned, 0)
  assert.deepEqual(sqlite.prepare('SELECT notification_revision, updated_at FROM notification_event_state').get(), { notification_revision: 0, updated_at: '2026-01-02T00:00:00.000Z' })
  setNow('2026-01-11T08:00:00Z')
  assert.equal((await planEventNotifications([minor], dependencies)).planned, 1)
  const reminder = (await payloads(sqlite)).find(payload => payload.reason === 'day-before')
  assert.equal(reminder.event.sequence, 0)
  assert.equal(reminder.event.title, 'New title')
  assert.equal(reminder.event.description, 'Minor text')
})

test('time/end/venue revisions carry pending announcements while notifying only prior recipients of changes', async () => {
  for (const change of [
    { start: '2026-01-13T12:00:00Z' }, { end: '2026-01-12T14:00:00Z' }, { location: 'Other venue' }, { cancelled: true },
  ]) {
    const { sqlite, dependencies } = fixture()
    await signup(dependencies, ['created'], 'prior@example.test')
    await signup(dependencies, ['created'], 'pending@example.test')
    await signup(dependencies, ['created'], 'suppressed@example.test')
    await signup(dependencies, ['created'], 'removed@example.test')
    await planEventNotifications([item()], dependencies)
    sqlite.prepare('UPDATE notification_event_deliveries SET status = ? WHERE contact_id IN (1, 3, 4)').run(change.cancelled ? 'delivered' : 'submitted')
    sqlite.exec("INSERT INTO notification_suppressions (channel, destination_hash, reason, suppressed_at) SELECT channel, destination_hash, 'provider-bounce', '2026-01-01' FROM notification_contacts WHERE id = 3; DELETE FROM notification_subscriptions WHERE contact_id = 4")
    const updated = item({ changedAt: '2026-01-02T00:00:00Z', sequence: 1, cancelled: change.cancelled ?? false, event: { ...item().event, ...('cancelled' in change ? {} : change) } })
    const results = await Promise.all([planEventNotifications([updated], dependencies), planEventNotifications([updated], dependencies)])
    assert.equal(results.reduce((total, result) => total + result.planned, 0), change.cancelled ? 1 : 2)
    assert.deepEqual(sqlite.prepare('SELECT contact_id, reason, event_revision FROM notification_event_deliveries WHERE event_revision = 1 ORDER BY contact_id, reason').all(), [
      { contact_id: 1, reason: change.cancelled ? 'cancelled' : 'updated', event_revision: 1 },
      ...(change.cancelled ? [] : [{ contact_id: 2, reason: 'created', event_revision: 1 }]),
    ])
    const revision = (await payloads(sqlite)).find(payload => payload.event.sequence === 1)
    assert.equal(revision.event.uid, 'brno-12@jednadvacet.org')
    assert.equal(revision.event.cancelled, Boolean(change.cancelled))
    assert.equal((await planEventNotifications([updated], dependencies)).planned, 0)
    assert.equal((await planEventNotifications([item()], dependencies)).planned, 0)
    assert.equal(sqlite.prepare('SELECT notification_revision FROM notification_event_state').get().notification_revision, 1)
  }
})

test('a replacement revalidates queued work for every enabled channel and preserves the current event payload', async () => {
  const { sqlite, dependencies } = fixture()
  const ready = { ...dependencies, config: { ...config, smsEnabled: true, smsEventDeliveryReady: true, smsDeliveryReady: true, eventSmsOutboxSupported: true, webPushEnabled: true, webPushEventDeliveryReady: true, webPushDeliveryReady: true, eventWebPushOutboxSupported: true } }
  await signup(ready)
  for (const channel of ['sms', 'web-push']) {
    sqlite.prepare("INSERT INTO notification_contacts (channel, destination, destination_hash, management_token_digest, capability_generation, state, consent_at, consent_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', 'consent', '2026-09', 'created', 'updated')").run(channel, `${channel}-destination`, `${channel}-hash`, `${channel}-digest`)
    sqlite.prepare("INSERT INTO notification_subscriptions (contact_id, community_slug, frequency, created_at, updated_at) SELECT id, 'brno', 'created', 'created', 'updated' FROM notification_contacts WHERE channel = ?").run(channel)
  }
  await planEventNotifications([item({ event: { ...item().event, osm_name: 'Old bar', osm_address: 'Old address' } })], ready)
  sqlite.prepare("UPDATE notification_outbox SET status = 'queued' WHERE kind LIKE 'event-%'").run()
  const edited = item({ changedAt: '2026-01-02T00:00:00Z', event: { ...item().event, location: 'New venue', osm_name: 'New bar', osm_address: 'New address' } })
  assert.equal((await planEventNotifications([edited], ready)).planned, 3)
  const rows = sqlite.prepare("SELECT kind, payload_ciphertext, payload_iv FROM notification_outbox WHERE kind LIKE 'event-%' AND status = 'pending' ORDER BY kind").all() as { kind: string, payload_ciphertext: string, payload_iv: string }[]
  assert.equal(rows.length, 3)
  const replacements = await Promise.all(rows.map(async row => ({ kind: row.kind, payload: JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(row.payload_iv) }, config.outboxTransportKey, decode(row.payload_ciphertext)))) })))
  assert.deepEqual(replacements.map(({ kind, payload }) => [kind, payload.event.location, payload.event.sequence]), [
    ['event-email', 'New bar, New address', 1], ['event-sms', 'New bar, New address, New venue', 1], ['event-web-push', 'New bar, New address', 1],
  ])
  assert.ok(replacements.every(({ payload }) => payload.event.uid === 'brno-12@jednadvacet.org'))
})

test('a reservation prevents carry-forward while a late batch failure preserves the predecessor for retry', async () => {
  const { sqlite, dependencies, database } = fixture()
  await signup(dependencies)
  await planEventNotifications([item()], dependencies)
  const edited = item({ changedAt: '2026-01-02T00:00:00Z', event: { ...item().event, location: 'New venue' } })
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  const delayed = planEventNotifications([edited], { ...dependencies, database: { ...database, batch: async statements => { entered(); await paused; return database.batch(statements) } } })
  await ready
  sqlite.prepare("UPDATE notification_event_deliveries SET submitted_at = '2026-01-01T10:00:00.000Z'").run()
  release()
  assert.equal((await delayed).planned, 0)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_event_deliveries WHERE event_revision = 1').get().n, 0)
  let failState = false
  const retry = fixture(sql => failState && sql.startsWith('UPDATE notification_event_state'))
  await signup(retry.dependencies)
  await planEventNotifications([item()], retry.dependencies)
  const original = retry.sqlite.prepare("SELECT payload_ciphertext, status FROM notification_outbox WHERE kind = 'event-email'").get() as { payload_ciphertext: string, status: string }
  failState = true
  await assert.rejects(planEventNotifications([edited], retry.dependencies), /Injected D1 failure/)
  const previous = retry.sqlite.prepare("SELECT payload_ciphertext, status FROM notification_outbox WHERE kind = 'event-email'").get() as { payload_ciphertext: string, status: string }
  assert.equal(previous.payload_ciphertext, original.payload_ciphertext)
  assert.equal(previous.status, 'pending')
  failState = false
  assert.equal((await planEventNotifications([edited], retry.dependencies)).planned, 1)
})

test('moving earlier gives no catchup to never-notified contacts, but preserves future selected reminders', async () => {
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies, ['week-before', 'day-before'])
  await planEventNotifications([item()], dependencies)
  setNow('2026-01-05T10:00:00Z')
  const earlier = item({ changedAt: '2026-01-05T00:00:00Z', event: { ...item().event, start: '2026-01-07T12:00:00Z' } })
  assert.equal((await planEventNotifications([earlier], dependencies)).planned, 0)
  setNow('2026-01-06T08:00:00Z')
  assert.equal((await planEventNotifications([earlier], dependencies)).planned, 1)
  assert.deepEqual((await payloads(sqlite)).map(payload => payload.reason), ['day-before'])
})

test('switch-off due discovery/reminders are failed evidence without backlog on enablement', async () => {
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies, ['created', 'day-before'])
  const disabled = { ...dependencies, config: { ...config, emailDeliveryReady: false } }
  assert.equal((await planEventNotifications([item()], disabled)).planned, 0)
  setNow('2026-01-11T08:00:00Z')
  assert.equal((await planEventNotifications([item()], disabled)).planned, 0)
  assert.deepEqual(sqlite.prepare('SELECT reason, status FROM notification_event_deliveries ORDER BY reason').all(), [{ reason: 'created', status: 'failed' }, { reason: 'day-before', status: 'failed' }])
  assert.equal((await payloads(sqlite)).length, 0)
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 0)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_management_capabilities').get().n, 0)
})

test('switch-off also retires already pending due work rather than preserving a re-enable backlog', async () => {
  const { sqlite, dependencies } = fixture()
  await signup(dependencies)
  await planEventNotifications([item()], dependencies)
  await planEventNotifications([item()], { ...dependencies, config: { ...config, emailDeliveryReady: false } })
  assert.equal(sqlite.prepare('SELECT status FROM notification_event_deliveries').get().status, 'failed')
  assert.equal((await payloads(sqlite)).length, 0)
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 0)
})

test('overlapping stale snapshots cannot overwrite a newer material or minor watermark', async () => {
  const { sqlite, dependencies, database } = fixture()
  await signup(dependencies)
  await planEventNotifications([item()], dependencies)
  sqlite.exec("UPDATE notification_event_deliveries SET status = 'delivered'")
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  const older = item({ changedAt: '2026-01-02T00:00:00Z', event: { ...item().event, location: 'Older venue' } })
  const newer = item({ changedAt: '2026-01-03T00:00:00Z', event: { ...item().event, location: 'Newest venue' } })
  const stale = planEventNotifications([older], { ...dependencies, database: { ...database, batch: async statements => { entered(); await paused; return database.batch(statements) } } })
  await ready
  assert.equal((await planEventNotifications([newer], dependencies)).planned, 1)
  release()
  assert.equal((await stale).planned, 0)
  assert.deepEqual(sqlite.prepare('SELECT venue, notification_revision, updated_at FROM notification_event_state').get(), { venue: 'Newest venue', notification_revision: 1, updated_at: '2026-01-03T00:00:00.000Z' })
  assert.equal((await planEventNotifications([older], dependencies)).planned, 0)
  const minor = { ...newer, changedAt: '2026-01-04T00:00:00Z', event: { ...newer.event, title: 'Minor edit' } }
  assert.equal((await planEventNotifications([minor], dependencies)).planned, 0)
  assert.equal((await planEventNotifications([older], dependencies)).planned, 0)
  assert.equal(sqlite.prepare('SELECT updated_at FROM notification_event_state').get().updated_at, '2026-01-04T00:00:00.000Z')
})

test('revision state and all recipient work roll back together after a late update failure', async () => {
  let failing = false
  const { sqlite, dependencies } = fixture(sql => failing && sql.startsWith('UPDATE notification_event_state'))
  await signup(dependencies)
  await planEventNotifications([item()], dependencies)
  sqlite.exec("UPDATE notification_event_deliveries SET status = 'delivered'")
  const updated = item({ changedAt: '2026-01-02T00:00:00Z', cancelled: true })
  failing = true
  await assert.rejects(planEventNotifications([updated], dependencies), /Injected D1 failure/)
  assert.equal(sqlite.prepare('SELECT notification_revision FROM notification_event_state').get().notification_revision, 0)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_event_deliveries').get().n, 1)
  assert.equal(sqlite.prepare('SELECT count(*) n FROM notification_management_capabilities').get().n, 1)
  failing = false
  assert.equal((await planEventNotifications([updated], dependencies)).planned, 1)
  assert.equal((await planEventNotifications([updated], dependencies)).planned, 0)
})

test('exact communities and frequencies stay isolated; normalized venue whitespace is minor', async () => {
  const { sqlite, dependencies, setNow } = fixture()
  await signup(dependencies, ['day-before'], 'brno@example.test')
  await signup(dependencies, ['week-before'], 'week@example.test')
  await signup(dependencies, ['created'], 'praha@example.test', 'praha')
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 0)
  setNow('2026-01-05T08:00:00Z')
  assert.equal((await planEventNotifications([item()], dependencies)).planned, 1)
  assert.deepEqual((await payloads(sqlite)).map(payload => [payload.destination, payload.reason]), [['week@example.test', 'week-before']])
  const sameVenue = item({ changedAt: '2026-01-06T00:00:00Z', event: { ...item().event, location: '  Venue  ' } })
  assert.equal((await planEventNotifications([sameVenue], dependencies)).planned, 0)
  setNow('2026-01-11T08:00:00Z')
  assert.equal((await planEventNotifications([sameVenue], dependencies)).planned, 1)
  assert.equal(sqlite.prepare('SELECT notification_revision FROM notification_event_state').get().notification_revision, 0)
})
