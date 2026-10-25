import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePreviewDeployArgs, validatePreviewConfiguration } from '../scripts/deploy-preview.ts'

const preview = () => ({
  name: 'jednadvacetorg-web', main: 'index.mjs',
  d1_databases: [{ binding: 'DB', database_name: 'web-preview', database_id: '8d615dae-df24-49f6-9465-681826d6ae02' }],
  kv_namespaces: [{ binding: 'PORTAL_EVENT_SNAPSHOTS', id: 'preview-kv-id' }],
  queues: { producers: [{ binding: 'PORTAL_EVENTS_QUEUE', queue: 'portal-events' }, { binding: 'NOTIFICATION_MESSAGES_QUEUE', queue: 'notification-messages' }], consumers: [{ queue: 'portal-events' }, { queue: 'notification-messages', dead_letter_queue: 'notification-messages-dlq' }] },
  triggers: { crons: ['47 3 * * *', '13 * * * *', '* * * * *'] }, observability: { logs: { enabled: true } },
})

test('preview deployment accepts only the two explicit invocation shapes', () => {
  assert.deepEqual(parsePreviewDeployArgs(['--target', 'claimed', '--config', '/tmp/target.json', '--dry-run']).target, 'claimed')
  assert.deepEqual(parsePreviewDeployArgs(['--target', 'temporary']).target, 'temporary')
  for (const args of [[], ['--target', 'claimed'], ['--target', 'temporary', '--config', '/tmp/x'], ['--target', 'production']]) assert.throws(() => parsePreviewDeployArgs(args), /Usage/)
})

test('preview deployment configuration requires isolated durable bindings and rejects production surfaces', () => {
  validatePreviewConfiguration(preview(), { accountId: '714b23e75ab1b6d8ea3267b59c6ee76f', databaseId: '8d615dae-df24-49f6-9465-681826d6ae02' })
  for (const mutation of [
    (value: Record<string, unknown>) => { value.r2_buckets = [{ binding: 'BLOB' }] },
    (value: Record<string, unknown>) => { (value.d1_databases as { database_id: string }[])[0]!.database_id = '76d271b2-5335-40ba-81dd-bf7e1ef79522' },
    (value: Record<string, unknown>) => { (value.kv_namespaces as { id: string }[])[0]!.id = 'fc1c8f97503145fd8f6563fd22358ab6' },
    (value: Record<string, unknown>) => { delete (value.queues as { consumers: unknown[] }).consumers },
    (value: Record<string, unknown>) => { (value.triggers as { crons: string[] }).crons.pop() },
  ]) {
    const candidate = structuredClone(preview())
    mutation(candidate)
    assert.throws(() => validatePreviewConfiguration(candidate, { accountId: '714b23e75ab1b6d8ea3267b59c6ee76f', databaseId: '8d615dae-df24-49f6-9465-681826d6ae02' }))
  }
})
