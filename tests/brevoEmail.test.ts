import assert from 'node:assert/strict'
import test from 'node:test'

import { composeBrevoEventEmail, sendBrevoEventEmail } from '../server/utils/brevoEmail.ts'

const message = {
  deliveryId: 'opaque-delivery-id', recipient: 'operator@example.test', managementUrl: 'https://jednadvacet.org/notifications/manage/token', uid: 'event@jednadvacet.org', sequence: 2,
  event: { title: '<akce>', description: 'Ahoj\nčau', location: 'Brno, CZ', url: 'https://example.test/event', start: '2026-10-10T09:00:00.000Z', end: '2026-10-10T10:00:00.000Z' },
}

test('composer escapes HTML and creates a non-interactive PUBLISH attachment', () => {
  const composed = composeBrevoEventEmail(message)
  assert.match(composed.html, /&lt;akce&gt;/)
  assert.match(composed.text, /Nastavení odběru/)
  assert.match(composed.ics, /METHOD:PUBLISH/)
  assert.match(composed.ics, /SEQUENCE:2/)
  assert.doesNotMatch(composed.ics, /ATTENDEE/)
})

test('adapter sends exactly one narrow transactional request', async () => {
  const requests: RequestInit[] = []
  const result = await sendBrevoEventEmail({ apiKey: 'key', senderName: 'Jednadvacet.org', senderEmail: 'noreply@b.jednadvacet.org', sandbox: true }, message, async (_url, request) => {
    requests.push(request)
    return new Response(JSON.stringify({ messageId: 'provider-id' }), { status: 201 })
  })
  assert.deepEqual(result, { attempted: true, status: 'submitted', httpStatus: 201, providerMessageId: 'provider-id' })
  assert.equal(requests.length, 1)
  assert.equal((requests[0]?.headers as Record<string, string>)['X-Sib-Sandbox'], 'drop')
})
