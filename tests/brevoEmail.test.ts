import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { composeBrevoEventEmail, composeBrevoLifecycleEmail, eventIcs, sendBrevoEventEmail, sendBrevoLifecycleEmail } from '../server/utils/brevoEmail.ts'

const message = {
  deliveryId: 'opaque-delivery-id', recipient: 'operator@example.test', managementUrl: 'https://jednadvacet.org/notifications/manage/token', uid: 'event@jednadvacet.org', sequence: 2,
  event: { title: '<akce>', description: 'Ahoj\nčau', location: 'Brno, CZ', url: 'https://example.test/event', start: '2026-10-10T09:00:00.000Z', end: '2026-10-10T10:00:00.000Z' },
}

const config = { apiKey: 'synthetic', senderName: 'Jednadvacet', senderEmail: 'noreply@jednadvacet.org' as const }
const senders = {
  event: (fetcher: typeof fetch) => sendBrevoEventEmail(config, message, fetcher),
  lifecycle: (fetcher: typeof fetch) => sendBrevoLifecycleEmail(config, { destination: 'synthetic@example.test', capability: 'a'.repeat(43), kind: 'first-activation' }, fetcher),
}

for (const [kind, send] of Object.entries(senders)) for (const stall of ['headers', 'body', 'read']) test(`${kind} email settles at the shared 10000ms deadline despite ignored ${stall} abort`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | undefined
  let resolveFetch!: (response: Response) => void
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; return new Promise(() => {}) } })
  const response = new Response(stream, { status: 201 })
  if (stall === 'read') {
    const reader = stream.getReader()
    t.mock.method(reader, 'read', () => new Promise(() => {}))
    t.mock.method(stream, 'getReader', () => reader)
  }
  let settled = false
  const attempt = send(async (_url, request) => {
    signal = request?.signal ?? undefined
    if (stall !== 'headers') return response
    return new Promise(resolve => { resolveFetch = resolve })
  }).then(result => { settled = true; return result })
  await setImmediate()
  t.mock.timers.tick(9999)
  await setImmediate()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.equal(settled, true, 'public attempt must settle even when I/O ignores abort')
  assert.deepEqual(await attempt, { attempted: true, status: 'transport' })
  assert.equal(signal?.aborted, true)
  if (stall === 'headers') resolveFetch(response)
  await setImmediate()
  assert.equal(cancelled, 1, 'late/body disposal never waits for cancellation')
  assert.equal(stream.locked, false)
  t.mock.timers.runAll()
})

for (const [kind, send] of Object.entries(senders)) for (const scenario of ['exact-cap', 'multibyte', 'false-small-length', 'invalid-length', 'early-length', 'malformed', 'read-error', 'fetch-error', 'cancel-reject', '429', '503']) test(`${kind} email bounded stream and cleanup: ${scenario}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clear = t.mock.method(globalThis, 'clearTimeout')
  let signal: AbortSignal | undefined, reads = 0, cancels = 0
  const prefix = JSON.stringify({ messageId: '<provider+ID@relay.test>' })
  const bytes = new TextEncoder().encode(scenario === 'exact-cap' ? prefix + ' '.repeat(16384 - prefix.length) : scenario === 'multibyte' ? JSON.stringify({ messageId: 'ž'.repeat(100) }) : scenario === 'malformed' ? 'private-provider-text' : JSON.stringify({ messageId: 'provider', padding: 'ž'.repeat(9000) }))
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++
      if (scenario === 'read-error') { controller.error(Error('private-provider-text')); return }
      const offset = (reads - 1) * 101
      if (offset >= bytes.length) controller.close()
      else controller.enqueue(bytes.subarray(offset, offset + 101))
    },
    cancel() { cancels++; if (scenario === 'cancel-reject') return Promise.reject(Error('private-provider-text')) },
  }, { highWaterMark: 0 })
  const response = new Response(stream, { status: scenario === '429' ? 429 : scenario === '503' ? 503 : 201, headers: scenario === 'early-length' ? { 'content-length': '16385' } : scenario === 'invalid-length' ? { 'content-length': 'oops' } : scenario === 'false-small-length' ? { 'content-length': '1' } : {} })
  response.json = async () => { assert.fail('unbounded json forbidden') }
  response.text = async () => { assert.fail('unbounded text forbidden') }
  const result = await send(async (_url, request) => { signal = request?.signal ?? undefined; if (scenario === 'fetch-error') throw Error('private-provider-text'); return response })
  assert.equal(result.attempted, true)
  assert.equal(result.status, scenario === 'exact-cap' || scenario === 'multibyte' ? 'submitted' : scenario === 'read-error' || scenario === 'fetch-error' ? 'transport' : scenario === '429' ? 'rate-limited' : scenario === '503' ? 'provider-5xx' : 'invalid-request')
  if (scenario === 'multibyte') assert.equal(result.providerMessageId, 'ž'.repeat(100))
  assert.doesNotMatch(JSON.stringify(result), /private-provider-text/)
  if (['early-length', '429', '503'].includes(scenario)) { assert.equal(reads, 0); assert.equal(cancels, 1) }
  if (['false-small-length', 'invalid-length', 'cancel-reject'].includes(scenario)) { assert.equal(reads, 163); assert.equal(cancels, 1) }
  assert.equal(stream.locked, false)
  assert.equal(clear.mock.calls.length, 1)
  t.mock.timers.runAll()
  assert.equal(signal?.aborted, false, 'completed attempt leaves no deadline timer')
  await setImmediate()
})

for (const [kind, send] of Object.entries(senders)) test(`${kind} email uses one deadline across delayed headers plus body and catches late fetch rejection`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: (response: Response) => void
  let settled = false
  const stream = new ReadableStream<Uint8Array>({ cancel: () => Promise.reject(Error('private-provider-text')) })
  const attempt = send(async () => new Promise(resolve => { release = resolve })).then(result => { settled = true; return result })
  t.mock.timers.tick(6000)
  release(new Response(stream, { status: 201 }))
  await setImmediate()
  t.mock.timers.tick(3999)
  await setImmediate()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.equal(settled, true)
  assert.deepEqual(await attempt, { attempted: true, status: 'transport' })
  assert.equal(stream.locked, false)
  let reject!: (error: Error) => void
  const late = send(async () => new Promise((_resolve, fail) => { reject = fail }))
  t.mock.timers.tick(10000)
  assert.deepEqual(await late, { attempted: true, status: 'transport' })
  reject(Error('private-provider-text'))
  await setImmediate()
})

test('email preparation errors never invoke transport', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('no transport for invalid preparation') }
  assert.deepEqual(await sendBrevoLifecycleEmail(config, { destination: 'synthetic@example.test', capability: '<bad>', kind: 'first-activation' }, fetcher), { attempted: false, status: 'invalid-request' })
  assert.deepEqual(await sendBrevoEventEmail(config, { ...message, event: { ...message.event, start: 'invalid' } }, fetcher), { attempted: false, status: 'invalid-request' })
})

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

test('adapter canonicalizes the official bracketed message identifier without rewriting its interior', async () => {
  const result = await sendBrevoEventEmail({ apiKey: 'key', senderName: 'Jednadvacet.org', senderEmail: 'noreply@jednadvacet.org' }, message, async () => {
    return Response.json({ messageId: '<201798300811.5787683@relay.domain.com>' }, { status: 201 })
  })
  assert.deepEqual(result, {
    attempted: true,
    status: 'submitted',
    httpStatus: 201,
    providerMessageId: '201798300811.5787683@relay.domain.com',
  })
})

for (const [label, value, expected] of [
  ['plain provider ID', 'provider-id', 'provider-id'],
  ['official plain ID', '201798300811.5787683@relay.domain.com', '201798300811.5787683@relay.domain.com'],
  ['punctuation and case', '<Provider.ID+Case/Part:tag=@Relay.Domain>', 'Provider.ID+Case/Part:tag=@Relay.Domain'],
  ['256 UTF-8 bytes', 'ž'.repeat(128), 'ž'.repeat(128)],
  ['256 wrapped UTF-8 bytes', `<${'ž'.repeat(127)}>`, 'ž'.repeat(127)],
  ['257 UTF-8 bytes', `${'ž'.repeat(128)}x`, undefined],
  ['257 wrapped UTF-8 bytes', `<${'ž'.repeat(127)}x>`, undefined],
  ['257 ASCII bytes', 'x'.repeat(257), undefined],
  ['empty', '', undefined],
  ['empty brackets', '<>', undefined],
  ['unclosed', '<provider-id', undefined],
  ['unopened', 'provider-id>', undefined],
  ['nested', '<<provider-id>>', undefined],
  ['interior bracket in wrapper', '<provider<id>', undefined],
  ['C0 control', 'provider\u0000id', undefined],
  ['newline', 'provider\nid', undefined],
  ['DEL control', 'provider\u007fid', undefined],
  ['C1 control', 'provider\u0085id', undefined],
  ['non-string', 26224, undefined],
] as const) test(`adapter provider-ID contract: ${label}`, async () => {
  let calls = 0
  const result = await sendBrevoEventEmail({ apiKey: 'key', senderName: 'Jednadvacet.org', senderEmail: 'noreply@jednadvacet.org' }, message, async () => {
    calls++
    return Response.json({ messageId: value, detail: 'private-provider-body' }, { status: 201 })
  })
  assert.equal(calls, 1)
  assert.deepEqual(result, { attempted: true, status: expected ? 'submitted' : 'invalid-request', httpStatus: 201, providerMessageId: expected })
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
