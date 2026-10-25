import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Target = 'claimed' | 'temporary'
type Options = { target: Target, config?: string, dryRun: boolean }
type Json = Record<string, unknown>

const claimedAccountId = '714b23e75ab1b6d8ea3267b59c6ee76f'
const claimedDatabaseId = '8d615dae-df24-49f6-9465-681826d6ae02'
const workerName = 'jednadvacetorg-web'
const previewDatabase = 'web-preview'
const productionDatabaseId = '76d271b2-5335-40ba-81dd-bf7e1ef79522'
const productionKvId = 'fc1c8f97503145fd8f6563fd22358ab6'
const queues = ['portal-events', 'notification-messages', 'notification-messages-dlq']
const crons = ['47 3 * * *', '13 * * * *', '* * * * *']

const object = (value: unknown, message = 'invalid JSON') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Json
}
const rows = (value: unknown) => Array.isArray(value) ? value.map(value => object(value)) : []

export const parsePreviewDeployArgs = (args: string[]): Options => {
  let target: Target | undefined
  let config: string | undefined
  let dryRun = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--dry-run' && !dryRun) { dryRun = true; continue }
    if ((arg === '--target' || arg === '--config') && args[index + 1]) {
      const value = args[++index]!
      if (arg === '--target' && !target && (value === 'claimed' || value === 'temporary')) { target = value; continue }
      if (arg === '--config' && !config) { config = resolve(value); continue }
    }
    throw new Error('Usage: deploy-preview.ts --target claimed --config PATH [--dry-run] | --target temporary [--dry-run]')
  }
  if (!target || (target === 'claimed') !== Boolean(config)) throw new Error('Usage: claimed target requires exactly one target config')
  return { target, config, dryRun }
}

/** Rejects generated profiles that could reach production or unsupported preview resources. */
export const validatePreviewConfiguration = (input: unknown, target?: { accountId: string, databaseId: string }) => {
  const config = object(input)
  if (config.name !== workerName || typeof config.main !== 'string') throw new Error('preview Worker identity is invalid')
  const d1 = rows(config.d1_databases).filter(item => item.binding === 'DB')
  if (d1.length !== 1 || d1[0]!.database_name !== previewDatabase) throw new Error('preview D1 is invalid')
  if (d1[0]!.database_id === productionDatabaseId || (d1[0]!.database_id && d1[0]!.database_id !== target?.databaseId)) throw new Error('preview D1 is not pinned to its isolated target')
  const kv = rows(config.kv_namespaces).filter(item => item.binding === 'PORTAL_EVENT_SNAPSHOTS')
  if (kv.length !== 1 || kv[0]!.id === productionKvId || !kv[0]!.id && target) throw new Error('preview Portal KV is invalid')
  for (const field of ['r2_buckets', 'services', 'dispatch_namespaces']) if (rows(config[field]).length) throw new Error(`preview must not include ${field}`)
  if (JSON.stringify(config).includes('COMMUNITY_MAPS_QUEUE') || JSON.stringify(config).includes('community-maps')) throw new Error('preview must not include maps resources')
  const queueConfig = object(config.queues, 'preview queues are required')
  const producers = rows(queueConfig.producers)
  const consumers = rows(queueConfig.consumers)
  for (const queue of ['portal-events', 'notification-messages']) if (!producers.some(item => item.queue === queue)) throw new Error(`preview producer missing: ${queue}`)
  if (!consumers.some(item => item.queue === 'portal-events')) throw new Error('preview Portal consumer missing')
  if (!consumers.some(item => item.queue === 'notification-messages' && item.dead_letter_queue === 'notification-messages-dlq')) throw new Error('preview notification DLQ missing')
  const configuredCrons = object(config.triggers, 'preview triggers are required').crons
  if (!Array.isArray(configuredCrons) || !configuredCrons.every(value => typeof value === 'string')) throw new Error('preview schedules are invalid')
  if (configuredCrons.length !== crons.length || !crons.every(cron => configuredCrons.includes(cron))) throw new Error('preview schedules are invalid')
  if (config.routes || config.route || config.custom_domains) throw new Error('preview must not configure production routes')
}

const wrangler = resolve('node_modules/.bin/wrangler')
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, WRANGLER_SEND_METRICS: 'false' })
const command = async (args: string[], options: { quiet?: boolean } = {}) => new Promise<string>((accept, reject) => {
  execFile(wrangler, [...args, '--env-file', '/dev/null'], { env: cleanEnv(), maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    // Wrangler can print temporary credentials and claim URLs. Never stream children.
    if (error) reject(new Error(options.quiet ? 'Cloudflare command failed' : `Cloudflare command failed: ${args.slice(0, 3).join(' ')}`))
    else accept(stdout + stderr)
  })
})
const jsonCommand = async (args: string[]) => JSON.parse(await command(args, { quiet: true })) as unknown
const accountIds = (input: unknown) => {
  const response = object(input)
  const result = response.accounts ?? (response.result && typeof response.result === 'object' ? object(response.result).accounts : undefined)
  return rows(result).map(account => String(account.id ?? account.account_id ?? '')).filter(Boolean)
}

const verifyClaimedIdentity = async () => {
  const whoami = await jsonCommand(['whoami', '--json'])
  if (!accountIds(whoami).includes(claimedAccountId)) throw new Error('authenticated account does not own the pinned preview target')
  const databases = rows(await jsonCommand(['d1', 'list', '--json']))
  if (!databases.some(item => item.uuid === claimedDatabaseId && item.name === previewDatabase)) throw new Error('pinned preview D1 identity is unavailable')
}

const build = async (directory: string) => {
  await new Promise<void>((accept, reject) => {
    execFile('npm', ['run', 'build:cloudflare'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PREVIEW_DEPLOY: '1', NUXT_BUILD_DIR: join(directory, 'nuxt'), CONTENT_LOCAL_DATABASE_PATH: join(directory, 'content.sqlite') },
      maxBuffer: 8 * 1024 * 1024,
    }, error => error ? reject(new Error('preview build failed')) : accept())
  })
  return join(directory, '.output', 'server', 'wrangler.json')
}

const resolvedConfig = async (generatedPath: string, directory: string, target: Target) => {
  const config = object(JSON.parse(await readFile(generatedPath, 'utf8')))
  config.account_id = target === 'claimed' ? claimedAccountId : undefined
  const d1 = rows(config.d1_databases).find(item => item.binding === 'DB')!
  if (target === 'claimed') d1.database_id = claimedDatabaseId
  const path = join(directory, 'wrangler.preview.json')
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return path
}

const createResources = async (configPath: string, target: Target) => {
  if (target === 'temporary') return
  // Supported Wrangler commands update only this private generated config. Existing
  // target resources are reused; provisioning failures are surfaced, never substituted.
  await command(['kv', 'namespace', 'create', 'PORTAL_EVENT_SNAPSHOTS', '--binding', 'PORTAL_EVENT_SNAPSHOTS', '--update-config', '--config', configPath], { quiet: true }).catch(async error => {
    const config = object(JSON.parse(await readFile(configPath, 'utf8')))
    const namespace = rows(config.kv_namespaces).find(item => item.binding === 'PORTAL_EVENT_SNAPSHOTS')
    if (!namespace?.id) throw error
  })
  for (const queue of queues) await command(['queues', 'create', queue, '--config', configPath], { quiet: true }).catch(async error => {
    const listing = await command(['queues', 'list', '--config', configPath], { quiet: true })
    if (!listing.includes(queue)) throw error
  })
}

export const runPreviewDeployment = async (options: Options) => {
  if (options.target === 'claimed') await verifyClaimedIdentity()
  const directory = await mkdtemp(join(tmpdir(), 'jednadvacet-preview-'))
  try {
    const generated = await build(directory)
    const configPath = await resolvedConfig(generated, directory, options.target)
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    validatePreviewConfiguration(config, options.target === 'claimed' ? { accountId: claimedAccountId, databaseId: claimedDatabaseId } : undefined)
    if (options.dryRun) {
      await command(['deploy', '--dry-run', '--keep-vars', '--config', configPath], { quiet: true })
      process.stdout.write(JSON.stringify({ target: options.target, dryRun: true, worker: workerName, database: previewDatabase }) + '\n')
      return
    }
    await createResources(configPath, options.target)
    const receipt = await command(['deploy', ...(options.target === 'temporary' ? ['--temporary'] : []), '--keep-vars', '--config', configPath], { quiet: true })
    const previewUrl = receipt.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\/?/i)?.[0]
    if (!previewUrl) throw new Error('Cloudflare did not return a preview URL')
    process.stdout.write(JSON.stringify({ target: options.target, deployed: true, worker: workerName, database: previewDatabase, previewUrl }) + '\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
}

if (process.argv[1]?.endsWith('deploy-preview.ts')) {
  runPreviewDeployment(parsePreviewDeployArgs(process.argv.slice(2))).catch(error => {
    process.stderr.write(`Preview deployment failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  })
}
