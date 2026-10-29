// CI guard: temporary previews must never bind production resources or routes.
type Json = Record<string, unknown>

const object = (value: unknown, message = 'invalid JSON') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Json
}
const objects = (value: unknown) => Array.isArray(value) ? value.map(item => object(item)) : []

export const validatePreviewConfiguration = (input: unknown) => {
  const config = object(input)
  if (config.name !== 'jednadvacetorg-web' || typeof config.main !== 'string') throw new Error('preview Worker identity is invalid')
  if (config.account_id) throw new Error('temporary preview must not pin an account')
  const d1 = objects(config.d1_databases)
  if (d1.length !== 1 || d1[0]!.binding !== 'DB' || d1[0]!.database_name !== 'web-preview' || d1[0]!.database_id === '76d271b2-5335-40ba-81dd-bf7e1ef79522') throw new Error('preview D1 is invalid')
  const kv = objects(config.kv_namespaces)
  if (kv.length !== 1 || kv[0]!.binding !== 'PORTAL_EVENT_SNAPSHOTS' || kv[0]!.id === 'fc1c8f97503145fd8f6563fd22358ab6') throw new Error('preview KV is invalid')
  for (const field of ['r2_buckets', 'services', 'dispatch_namespaces']) if (objects(config[field]).length) throw new Error(`preview must not include ${field}`)
  const text = JSON.stringify(config)
  if (text.includes('COMMUNITY_MAPS_QUEUE') || text.includes('community-maps') || text.includes('files-jednadvacet-org')) throw new Error('preview must not include maps/R2 resources')
  const queueConfig = object(config.queues, 'preview queues are required')
  const producers = objects(queueConfig.producers)
  const consumers = objects(queueConfig.consumers)
  for (const queue of ['portal-events', 'notification-messages']) if (!producers.some(item => item.queue === queue)) throw new Error(`preview producer missing: ${queue}`)
  if (!consumers.some(item => item.queue === 'portal-events') || !consumers.some(item => item.queue === 'notification-messages' && item.dead_letter_queue === 'notification-messages-dlq')) throw new Error('preview consumer/DLQ missing')
  const crons = object(config.triggers, 'preview triggers are required').crons
  if (!Array.isArray(crons) || !['47 3 * * *', '13 * * * *', '* * * * *'].every(cron => crons.includes(cron))) throw new Error('preview schedules are invalid')
  if (config.routes || config.route || config.custom_domains) throw new Error('preview must not configure production routes')
}
