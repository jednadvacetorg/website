import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBrevoCallback } from '../server/utils/brevoCallbacks.ts'

test('Brevo callbacks retain only opaque correlation and fixed categories', () => {
  const callback = normalizeBrevoCallback({ id: 'event_123456789', event: 'hard-bounce', 'X-Mailin-custom': 'delivery_123456789', messageId: 'message_123456789', email: 'must-not-be-used@example.test', date: '2026-09-21T10:00:00.000Z' })
  assert.deepEqual(callback, { id: 'event_123456789', deliveryId: 'delivery_123456789', kind: 'hard-bounce', providerMessageId: 'message_123456789', occurredAt: '2026-09-21T10:00:00.000Z' })
  assert.equal(normalizeBrevoCallback({ event: 'delivered', email: 'not-authority@example.test' }), undefined)
  assert.equal(normalizeBrevoCallback({ id: 'event_123456789', event: 'unknown', 'X-Mailin-custom': 'delivery_123456789' }), undefined)
})
