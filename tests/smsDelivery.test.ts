import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

import { composeBrevoEventSms, composeBrevoLifecycleSms, gsm7OneSegment, sendBrevoEventSms, sendBrevoLifecycleSms } from '../server/utils/brevoSms.ts'

const config = { apiKey: 'synthetic', sender: 'Jednadvacet' }
const message = { deliveryId: 'synthetic-delivery', recipient: '+420777123456', event: { title: 'Meetup', start: '2026-10-12T12:00:00Z' } }
const senders = {
  event: (fetcher: typeof fetch) => sendBrevoEventSms(config, message, fetcher),
  lifecycle: (fetcher: typeof fetch) => sendBrevoLifecycleSms(config, { recipient: message.recipient, capability: 'a'.repeat(43), kind: 'first-activation' }, fetcher),
}

test('preview lifecycle SMS never shortens a capability URL or sends multiple segments', async () => {
  const managementOrigin = 'https://jednadvacetorg-web.learned-mantis.workers.dev'
  for (const kind of ['first-activation', 'management-recovery', 'reactivation'] as const) {
    const lifecycle = { recipient: message.recipient, capability: 'a'.repeat(43), kind }
    if (kind !== 'reactivation') {
      assert.throws(() => composeBrevoLifecycleSms(lifecycle, managementOrigin), /one GSM-7 segment/)
      assert.deepEqual(await sendBrevoLifecycleSms({ ...config, managementOrigin }, lifecycle, async () => assert.fail('oversized SMS must not send')), { attempted: false, status: 'invalid-request' })
      continue
    }
    const content = composeBrevoLifecycleSms(lifecycle, managementOrigin)
    assert.ok(content.includes(`${managementOrigin}/notifications/manage/${lifecycle.capability}`))
    assert.equal(gsm7OneSegment(content), content)
    assert.ok(content.length <= 160)
    const result = await sendBrevoLifecycleSms({ ...config, managementOrigin }, lifecycle, async (_url, request) => {
      assert.equal(JSON.parse(request!.body as string).content, content)
      return Response.json({ messageId: 123 }, { status: 201 })
    })
    assert.equal(result.status, 'submitted')
  }
})

for (const [kind, send] of Object.entries(senders)) for (const stall of ['headers', 'body', 'read']) test(`${kind} SMS settles at the shared 10000ms deadline despite ignored ${stall} abort`, async t => {
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

for (const [kind, send] of Object.entries(senders)) for (const scenario of ['exact-cap', 'multibyte', 'false-small-length', 'invalid-length', 'early-length', 'malformed', 'read-error', 'fetch-error', 'cancel-reject', '429', '503', 'credits', 'auth']) test(`${kind} SMS bounded stream and cleanup: ${scenario}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const clear = t.mock.method(globalThis, 'clearTimeout')
  let signal: AbortSignal | undefined, reads = 0, cancels = 0
  const prefix = JSON.stringify({ messageId: 123 })
  const bytes = new TextEncoder().encode(scenario === 'exact-cap' ? prefix + ' '.repeat(16384 - prefix.length) : scenario === 'multibyte' ? JSON.stringify({ messageId: 'ž'.repeat(100) }) : scenario === 'malformed' ? 'private-provider-text' : scenario === 'credits' ? JSON.stringify({ code: 'not_enough_credits' }) : scenario === 'auth' ? JSON.stringify({ code: 'permission_denied' }) : JSON.stringify({ messageId: 'provider', padding: 'ž'.repeat(9000) }))
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
  const response = new Response(stream, { status: scenario === '429' ? 429 : scenario === '503' ? 503 : scenario === 'credits' || scenario === 'auth' ? 400 : 201, headers: scenario === 'early-length' ? { 'content-length': '16385' } : scenario === 'invalid-length' ? { 'content-length': 'oops' } : scenario === 'false-small-length' ? { 'content-length': '1' } : {} })
  response.json = async () => { assert.fail('unbounded json forbidden') }
  response.text = async () => { assert.fail('unbounded text forbidden') }
  const result = await send(async (_url, request) => { signal = request?.signal ?? undefined; if (scenario === 'fetch-error') throw Error('private-provider-text'); return response })
  assert.equal(result.attempted, true)
  assert.equal(result.status, scenario === 'exact-cap' || scenario === 'multibyte' ? 'submitted' : scenario === 'read-error' || scenario === 'fetch-error' ? 'transport' : scenario === '429' ? 'rate-limited' : scenario === '503' ? 'provider-5xx' : scenario === 'credits' ? 'credits' : scenario === 'auth' ? 'auth' : 'invalid-request')
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

for (const [kind, send] of Object.entries(senders)) test(`${kind} SMS uses one deadline across delayed headers plus body and catches late fetch rejection`, async t => {
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

test('SMS invalid preparation and UTF-8 provider identifiers remain bounded', async () => {
  const fetcher: typeof fetch = async () => { assert.fail('no transport for invalid preparation') }
  assert.deepEqual(await sendBrevoEventSms(config, { ...message, event: { ...message.event, title: 'x'.repeat(161) } }, fetcher), { attempted: false, status: 'invalid-request' })
  assert.deepEqual(await sendBrevoEventSms(config, { ...message, event: { ...message.event, start: 'invalid' } }, fetcher), { attempted: false, status: 'invalid-request' })
  for (const id of ['ž'.repeat(129), 'private\u0085text', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await senders.event(async () => Response.json({ messageId: id }, { status: 201 }))).status, 'invalid-request')
})

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

test('event SMS uses whole lines, full location and a separate community link', () => {
  const event = { title: 'Bitcoin v Brně', start: '2026-10-01T17:00:00Z', location: 'Bar, Ulice 1, Brno, vzadu', url: 'https://example.test/e', communityUrl: 'https://jednadvacet.org/brno' }
  const expected = 'Bitcoin v Brne\n1. 10. 2026 19:00\nBar, Ulice 1, Brno, vzadu\nhttps://example.test/e\n\nhttps://jednadvacet.org/brno'
  for (const reason of ['created', 'week-before', 'day-before'] as const) assert.equal(composeBrevoEventSms({ ...message, event, reason }), expected)
  assert.equal(composeBrevoEventSms({ ...message, event, reason: 'updated' }), `Zmena akce:\n${expected}`)
  assert.equal(composeBrevoEventSms({ ...message, event, reason: 'cancelled' }), `Akce zrusena:\n${expected}`)
})

test('event SMS removes only trailing whole lines, counting GSM extension escapes', () => {
  const base = { ...message, event: { ...message.event, title: 'x'.repeat(100), location: 'Bar, Ulice 1', url: 'https://example.test/event', communityUrl: 'https://jednadvacet.org/brno' } }
  assert.equal(composeBrevoEventSms(base), `${base.event.title}\n12. 10. 2026 14:00\nBar, Ulice 1\nhttps://example.test/event`)
  const extensions = { ...base, event: { ...base.event, title: '^'.repeat(65) } }
  assert.equal(composeBrevoEventSms(extensions), `${extensions.event.title}\n12. 10. 2026 14:00`)
  const longLocation = { ...base, event: { ...base.event, title: 'Meetup', location: 'x'.repeat(161) } }
  assert.equal(composeBrevoEventSms(longLocation), 'Meetup\n12. 10. 2026 14:00')
  const multilineTitle = { ...message, event: { ...message.event, title: 'Meetup\r\nBrno' } }
  assert.equal(composeBrevoEventSms(multilineTitle), 'Meetup Brno\n12. 10. 2026 14:00')
  assert.throws(() => composeBrevoEventSms({ ...message, event: { ...message.event, title: 'x'.repeat(150) } }), /one GSM-7 segment/)
})

test('event SMS applies Prague winter, summer and DST transition times', () => {
  for (const [start, date] of [
    ['2026-01-15T18:00:00Z', '15. 1. 2026 19:00'],
    ['2026-07-15T18:00:00Z', '15. 7. 2026 20:00'],
    ['2026-03-29T00:30:00Z', '29. 3. 2026 1:30'],
    ['2026-03-29T01:30:00Z', '29. 3. 2026 3:30'],
  ]) assert.equal(composeBrevoEventSms({ ...message, event: { title: 'Meetup', start: start! } }), `Meetup\n${date}`)
})

test('production activation and recovery SMS use the requested copy and keep the whole management URL', () => {
  for (const kind of ['first-activation', 'management-recovery'] as const) {
    const capability = 'a'.repeat(43)
    const text = composeBrevoLifecycleSms({ recipient: message.recipient, capability, kind })
    assert.equal(text, `Prihlaseno k odberu kalendare 21.\n\nNotifikace muzes nastavit zde: https://jednadvacet.org/notifications/manage/${capability}`)
    assert.equal(gsm7OneSegment(text), text)
  }
})
