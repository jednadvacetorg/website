import assert from 'node:assert/strict'
import test from 'node:test'

import { composeBrevoEventSms, composeBrevoLifecycleSms, gsm7OneSegment, sendBrevoEventSms, sendBrevoLifecycleSms } from '../server/utils/brevoSms.ts'

test('composes and submits one bounded transactional event SMS', async () => {
  const message = composeBrevoEventSms({
    deliveryId: 'opaque-delivery-id',
    recipient: '+420777123456',
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

test('numeric REST message IDs, bounded provider failures and shared lifecycle links', async () => {
  const message = { deliveryId: 'synthetic-delivery', recipient: '+420777123456', event: { title: 'Meetup', start: '2026-10-12T12:00:00Z' } }
  const cfg = { apiKey: 'synthetic', sender: 'Jednadvacet' }
  const result = await sendBrevoEventSms(cfg, message, async () => new Response(JSON.stringify({ messageId: 123456 }), { status: 201 }))
  assert.equal(result.providerMessageId, '123456')
  for (const kind of ['first-activation', 'management-recovery', 'reactivation'] as const) {
    const lifecycle = { recipient: message.recipient, capability: 'x'.repeat(43), kind }
    assert.ok(composeBrevoLifecycleSms(lifecycle).includes(`/notifications/manage/${lifecycle.capability}`))
    assert.equal((await sendBrevoLifecycleSms(cfg, lifecycle, async () => new Response(JSON.stringify({ messageId: 123 }), { status: 201 }))).status, 'submitted')
  }
  assert.match(composeBrevoEventSms({ ...message, reason: 'cancelled' }), /zrusena/i)
  assert.match(composeBrevoEventSms({ ...message, reason: 'updated' }), /zmena/i)
  assert.equal((await sendBrevoEventSms(cfg, message, async () => new Response(JSON.stringify({ code: 'not_enough_credits' }), { status: 400 }))).status, 'credits')
})

test('normalizes Czech and unsupported characters before enforcing one GSM-7 segment', () => {
  assert.equal(gsm7OneSegment('Příliš žluťoučký kůň €'), 'Prilis zlutoucky kun €')
  assert.equal(gsm7OneSegment('Bitcoin ⚡'), 'Bitcoin ?')
  assert.throws(() => gsm7OneSegment('^'.repeat(81)), /one GSM-7 segment/)
})
