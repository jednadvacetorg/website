import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'

import { dueEventEmailReasons, planEventNotifications } from '../server/utils/eventEmailNotifications.ts'
import { notificationConfig } from '../server/utils/notificationConfig.ts'
import { activateNotificationChannel, readNotificationManagement, requestNotificationManagementRecovery, stopNotificationChannel, type NotificationDatabase, type NotificationStatement } from '../server/utils/notifications.ts'
import type { PortalCalendarEvent } from '../server/utils/portalEvents.ts'

const config = { ...await notificationConfig({
  notificationCommunitySlugs: 'brno,praha', notificationRootKey: btoa('01234567890123456789012345678901').replace(/=+$/g, ''),
  notificationTurnstileSecret: 'synthetic', notificationTurnstileExpectedHostname: 'jednadvacet.org', notificationConsentVersion: '2026-09',
  notificationEmailSmsEnabled: true, notificationEmailSmsFirstMessageReady: true, notificationEmailSmsEventDeliveryReady: true,
}), emailDeliveryReady: true }
const schema = readFileSync(new URL('../server/db/migrations/sqlite/0000_majestic_lightspeed.sql', import.meta.url), 'utf8')
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

test('signup to event outbox gives one unpredictable usable management bearer and truthful repeat count', async () => {
  const { sqlite, dependencies } = fixture()
  await signup(dependencies)
  assert.deepEqual(await planEventNotifications([item()], dependencies), { planned: 1 })
  assert.deepEqual(await planEventNotifications([item()], dependencies), { planned: 0 })
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
  assert.deepEqual(dueEventEmailReasons(event('2026-04-01T12:00:00.000Z'), new Date('2026-03-31T08:00:00.000Z')), [])
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

test('time/end/venue/cancellation revisions target only still-eligible prior submitted or delivered recipients', async () => {
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
    assert.equal(results.reduce((total, result) => total + result.planned, 0), 1)
    assert.deepEqual(sqlite.prepare('SELECT contact_id, reason, event_revision FROM notification_event_deliveries WHERE event_revision = 1').all(), [{ contact_id: 1, reason: change.cancelled ? 'cancelled' : 'updated', event_revision: 1 }])
    const revision = (await payloads(sqlite)).find(payload => payload.event.sequence === 1)
    assert.equal(revision.event.uid, 'brno-12@jednadvacet.org')
    assert.equal(revision.event.cancelled, Boolean(change.cancelled))
    assert.equal((await planEventNotifications([updated], dependencies)).planned, 0)
    assert.equal((await planEventNotifications([item()], dependencies)).planned, 0)
    assert.equal(sqlite.prepare('SELECT notification_revision FROM notification_event_state').get().notification_revision, 1)
  }
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
