import assert from 'node:assert/strict'
import test from 'node:test'

import { dueEventEmailReasons } from '../server/utils/eventEmailNotifications.ts'

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
