import assert from 'node:assert/strict'
import test from 'node:test'

import { composeBrevoEventEmail, composeBrevoLifecycleEmail, eventIcs, sendBrevoEventEmail, sendBrevoLifecycleEmail } from '../server/utils/brevoEmail.ts'

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

test('all lifecycle kinds carry the exact bounded HTTPS management link without event content', async () => {
  const capability = 'a'.repeat(43)
  for (const kind of ['first-activation', 'reactivation', 'management-recovery'] as const) {
    const lifecycle = { destination: 'synthetic@example.test', capability, kind }
    const content = composeBrevoLifecycleEmail(lifecycle)
    assert.ok(content.text.includes(`https://jednadvacet.org/notifications/manage/${capability}`))
    assert.ok(content.html.includes(`href="https://jednadvacet.org/notifications/manage/${capability}"`))
    assert.ok(content.text.length < 512)
    if (kind !== 'first-activation') assert.doesNotMatch(content.text, /je aktivní/)
    let calls = 0
    await sendBrevoLifecycleEmail({ apiKey: 'synthetic', senderName: 'Jednadvacet', senderEmail: 'noreply@jednadvacet.org' }, lifecycle, async (_url, request) => {
      calls++
      assert.deepEqual(Object.keys(JSON.parse(request!.body as string)).sort(), ['htmlContent', 'sender', 'subject', 'textContent', 'to'])
      return new Response(JSON.stringify({ messageId: 'synthetic' }), { status: 201 })
    })
    assert.equal(calls, 1)
  }
  assert.throws(() => composeBrevoLifecycleEmail({ destination: 'synthetic@example.test', capability: '<script>', kind: 'first-activation' }))
})

test('composer preserves Czech UTF-8, stable revisions, and cancellation semantics in a CRLF attachment', () => {
  const initial = eventIcs({ ...message, event: { ...message.event, title: 'Žluťoučký kůň' } })
  const cancelled = eventIcs({ ...message, sequence: 3, cancelled: true })

  assert.match(initial, /UID:event@jednadvacet.org/)
  assert.match(initial, /SEQUENCE:2/)
  assert.match(cancelled, /SEQUENCE:3/)
  assert.match(cancelled, /STATUS:CANCELLED/)
  assert.equal(initial.split('\n').every(line => line.endsWith('\r') || line === ''), true)
  assert.doesNotMatch(cancelled, /(?:METHOD:REQUEST|ATTENDEE)/)
})

test('adapter sends exactly one narrow transactional request', async () => {
  const requests: RequestInit[] = []
  const result = await sendBrevoEventEmail({ apiKey: 'key', senderName: 'Jednadvacet.org', senderEmail: 'noreply@jednadvacet.org', sandbox: true }, message, async (_url, request) => {
    requests.push(request)
    return new Response(JSON.stringify({ messageId: 'provider-id' }), { status: 201 })
  })
  assert.deepEqual(result, { attempted: true, status: 'submitted', httpStatus: 201, providerMessageId: 'provider-id' })
  assert.equal(requests.length, 1)
  assert.equal((requests[0]?.headers as Record<string, string>)['X-Sib-Sandbox'], 'drop')
  const payload = JSON.parse(requests[0]?.body as string) as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), ['attachment', 'headers', 'htmlContent', 'sender', 'subject', 'textContent', 'to'])
  assert.deepEqual(payload.sender, { name: 'Jednadvacet.org', email: 'noreply@jednadvacet.org' })
  assert.equal((payload.attachment as { name: string, content: string }[])[0]?.name, 'event.ics')
  assert.match(eventIcs(message), /ORGANIZER:mailto:noreply@jednadvacet\.org/)
})

test('adapter classifies malformed success and every bounded error after one request', async () => {
  for (const status of [202, 400, 401, 429, 503]) {
    let calls = 0
    const result = await sendBrevoEventEmail({ apiKey: 'key', senderName: 'Jednadvacet.org', senderEmail: 'noreply@jednadvacet.org' }, message, async () => {
      calls += 1
      return new Response(status === 202 ? '{}' : 'provider details that must not escape', { status })
    })
    assert.equal(calls, 1)
    assert.equal(result.attempted, true)
  }
})
