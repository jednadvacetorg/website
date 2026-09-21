import assert from 'node:assert/strict'
import test from 'node:test'

import { projectNotificationReadiness } from '../server/api/notifications/readiness.get.ts'

test('public readiness fails closed without a database or private configuration', async () => {
  const readiness = await projectNotificationReadiness({})
  assert.deepEqual(readiness, { email: false, emailReasons: ['unavailable'], sms: false, webPush: false })
  assert.doesNotMatch(JSON.stringify(readiness), /key|secret|bearer/i)
})
