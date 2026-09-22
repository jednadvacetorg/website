import assert from 'node:assert/strict'
import test from 'node:test'

import { composeBrevoEventSms, sendBrevoEventSms } from '../server/utils/brevoSms.ts'

test('composes and submits one bounded transactional event SMS', async () => {
  const message = composeBrevoEventSms({
    deliveryId: 'opaque-delivery-id',
    recipient: '+420777123456',
    sender: 'Jednadvacet',
    event: { title: 'Bitcoin meetup', start: '2026-10-01T17:00:00.000Z', url: 'https://jednadvacet.org/kalendar' },
  })

  assert.ok(message.length <= 160)
  let request: RequestInit | undefined
  const result = await sendBrevoEventSms({ apiKey: 'a'.repeat(24), sender: 'Jednadvacet' }, {
    deliveryId: 'opaque-delivery-id',
    recipient: '+420777123456',
    event: { title: 'Bitcoin meetup', start: '2026-10-01T17:00:00.000Z', url: 'https://jednadvacet.org/kalendar' },
  }, async (_url, init) => {
    request = init
    return new Response(JSON.stringify({ messageId: 'provider-opaque-id' }), { status: 201 })
  })

  assert.deepEqual(result, { attempted: true, status: 'submitted', httpStatus: 201, providerMessageId: 'provider-opaque-id' })
  assert.equal(request?.method, 'POST')
  const body = JSON.parse(String(request?.body)) as Record<string, unknown>
  assert.equal(body.recipient, '+420777123456')
  assert.equal(body.sender, 'Jednadvacet')
  assert.equal(body.type, 'transactional')
})
