import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ICAL from 'ical.js'

type Target = 'claimed' | 'temporary'
type Options = { target: Target, config?: string, dryRun: boolean }
type Json = Record<string, unknown>
type Command = (args: string[], options?: { input?: string }) => Promise<string>

const claimedAccountId = '714b23e75ab1b6d8ea3267b59c6ee76f'
const claimedDatabaseId = '8d615dae-df24-49f6-9465-681826d6ae02'
const workerName = 'jednadvacetorg-web'
const previewDatabase = 'web-preview'
const productionDatabaseId = '76d271b2-5335-40ba-81dd-bf7e1ef79522'
const productionKvId = 'fc1c8f97503145fd8f6563fd22358ab6'
const crons = ['47 3 * * *', '13 * * * *', '* * * * *']

const object = (value: unknown, message = 'invalid JSON') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  return value as Json
}
const objects = (value: unknown) => Array.isArray(value) ? value.map(item => object(item)) : []
const readJson = async (path: string) => object(JSON.parse(await readFile(path, 'utf8')))

export const parsePreviewDeployArgs = (args: string[]): Options => {
  let target: Target | undefined; let config: string | undefined; let dryRun = false
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

/** Validates generated configuration structurally; resolved target IDs are checked separately. */
export const validatePreviewConfiguration = (input: unknown, target?: { accountId: string, databaseId: string, kvId?: string }) => {
  const config = object(input)
  if (config.name !== workerName || typeof config.main !== 'string') throw new Error('preview Worker identity is invalid')
  if (config.account_id && config.account_id !== target?.accountId) throw new Error('preview account identity is invalid')
  const d1 = objects(config.d1_databases).filter(item => item.binding === 'DB')
  if (d1.length !== 1 || d1[0]!.database_name !== previewDatabase || d1[0]!.database_id === productionDatabaseId || (target && d1[0]!.database_id !== target.databaseId)) throw new Error('preview D1 is invalid')
  const kv = objects(config.kv_namespaces).filter(item => item.binding === 'PORTAL_EVENT_SNAPSHOTS')
  if (kv.length !== 1 || kv[0]!.id === productionKvId || (target?.kvId && kv[0]!.id !== target.kvId)) throw new Error('preview KV is invalid')
  for (const field of ['r2_buckets', 'services', 'dispatch_namespaces']) if (objects(config[field]).length) throw new Error(`preview must not include ${field}`)
  const text = JSON.stringify(config)
  if (text.includes('COMMUNITY_MAPS_QUEUE') || text.includes('community-maps') || text.includes('files-jednadvacet-org')) throw new Error('preview must not include maps/R2 resources')
  const queueConfig = object(config.queues, 'preview queues are required')
  const producers = objects(queueConfig.producers); const consumers = objects(queueConfig.consumers)
  for (const queue of ['portal-events', 'notification-messages']) if (!producers.some(item => item.queue === queue)) throw new Error(`preview producer missing: ${queue}`)
  if (!consumers.some(item => item.queue === 'portal-events') || !consumers.some(item => item.queue === 'notification-messages' && item.dead_letter_queue === 'notification-messages-dlq')) throw new Error('preview consumer/DLQ missing')
  const configuredCrons = object(config.triggers, 'preview triggers are required').crons
  if (!Array.isArray(configuredCrons) || !crons.every(cron => configuredCrons.includes(cron))) throw new Error('preview schedules are invalid')
  if (config.routes || config.route || config.custom_domains) throw new Error('preview must not configure production routes')
}

const wrangler = resolve('node_modules/.bin/wrangler')
const command: Command = (args, options = {}) => new Promise((accept, reject) => {
  const child = execFile(wrangler, [...args, '--env-file', '/dev/null'], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_WRITE_LOGS: 'false',
      ...(process.env.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN } : {}),
    },
    maxBuffer: 2 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    // Never pass raw Wrangler output (claim URLs and temporary tokens can occur there).
    if (error) reject(new Error(`Cloudflare command failed: ${args.slice(0, 3).join(' ')}`))
    else accept(`${stdout}${stderr}`)
  })
  if (options.input !== undefined) child.stdin?.end(options.input)
})
const jsonCommand = async (run: Command, args: string[]) => JSON.parse(await run(args)) as unknown

const targetInput = async (path: string) => {
  const target = await readJson(path)
  if (target.account_id !== claimedAccountId || target.name !== workerName || Object.keys(target).some(key => !['name', 'account_id'].includes(key))) throw new Error('claimed target config must contain only the pinned Worker and account identity')
  return { accountId: claimedAccountId, databaseId: claimedDatabaseId }
}
const configArgs = (config: string) => ['--config', config]
const accountIds = (value: unknown) => {
  const response = object(value); const accountRows = response.accounts ?? (response.result && typeof response.result === 'object' ? object(response.result).accounts : [])
  return objects(accountRows).map(row => String(row.id ?? row.account_id ?? ''))
}
const workerUrl = (receipt: string) => receipt.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\/?/i)?.[0]?.replace(/\/$/, '')

const buildPreview = async () => {
  // Keep Nuxt's generated modules out of the shared default build directory. A stale
  // directory resolves Nuxt Image's internal aliases from the wrong package root.
  const buildDir = await mkdtemp(join(tmpdir(), 'jednadvacet-preview-build-'))
  try {
    await new Promise<void>((accept, reject) => {
      execFile('npm', ['run', 'build:cloudflare'], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          PREVIEW_DEPLOY: '1',
          NUXT_BUILD_DIR: join(buildDir, 'nuxt'),
          CONTENT_LOCAL_DATABASE_PATH: join(buildDir, 'content.sqlite'),
          NODE_OPTIONS: '--max-old-space-size=4096',
        },
        maxBuffer: 8 * 1024 * 1024,
      }, error => error ? reject(new Error('preview build failed')) : accept())
    })
  } finally {
    await rm(buildDir, { recursive: true, force: true })
  }
}

const resolvedConfig = async (target: Target, input?: { accountId: string, databaseId: string }) => {
  const original = join(process.cwd(), '.output', 'server', 'wrangler.json')
  const config = await readJson(original)
  if (target === 'claimed') {
    config.account_id = input!.accountId
    const d1 = objects(config.d1_databases).find(item => item.binding === 'DB')!
    d1.database_id = input!.databaseId
  }
  // Keep main/assets/migrations paths relative to the generated server directory.
  const path = join(process.cwd(), '.output', 'server', 'wrangler.preview.json')
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return path
}

const verifyClaimedDatabase = async (run: Command, config: string, target: { accountId: string, databaseId: string }) => {
  const databases = objects(await jsonCommand(run, ['d1', 'list', '--json', ...configArgs(config)]))
  if (!databases.some(row => row.uuid === target.databaseId && row.name === previewDatabase)) throw new Error('pinned preview D1 ownership could not be verified')
}

const migrate = async (config: string, target: { accountId: string, databaseId: string }, run: Command) => {
  const tool = resolve('node_modules/.bin/nuxt-db')
  // Use Wrangler's supported credential export, not its private on-disk cache.
  const apiToken = process.env.CLOUDFLARE_API_TOKEN
    || object(await jsonCommand(run, ['auth', 'token', '--json', ...configArgs(config)])).token
  if (typeof apiToken !== 'string' || !apiToken) throw new Error('native migration requires a Wrangler login or scoped API token')
  await new Promise<void>((accept, reject) => execFile(tool, ['migrate', '--dotenv', '/dev/null'], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PREVIEW_DEPLOY: '1',
      NUXT_BUILD_DIR: resolve('.nuxt'),
      NUXT_HUB_CLOUDFLARE_ACCOUNT_ID: target.accountId,
      NUXT_HUB_CLOUDFLARE_DATABASE_ID: target.databaseId,
      NUXT_HUB_CLOUDFLARE_API_TOKEN: apiToken,
    },
    maxBuffer: 2 * 1024 * 1024,
  }, error => error ? reject(new Error('native NuxtHub migration failed')) : accept()))
  void config
}

/** Check the public JSON/iCalendar contract, including matching event identity and time. */
export const previewFeedsReady = (events: unknown, calendar: string, readiness: unknown) => {
  if (!Array.isArray(events) || !events.length) return false
  const state = object(readiness)
  if (state.email !== false || state.sms !== false || state.webPush !== false) return false
  try {
    const feed = new ICAL.Component(ICAL.parse(calendar))
    if (feed.name !== 'vcalendar') return false
    const entries = feed.getAllSubcomponents('vevent').map(item => new ICAL.Event(item))
    return events.every(value => {
      const event = object(value)
      return typeof event.id === 'string' && typeof event.title === 'string'
        && typeof event.start === 'string' && entries.some(entry => entry.uid === `meetup-event-${event.id}@einundzwanzig.space`
          && entry.startDate.toJSDate().getTime() === Date.parse(event.start as string))
    })
  } catch { return false }
}

const refreshAndWait = async (url: string, adminToken: string) => {
  const headers = { authorization: `Bearer ${adminToken}` }
  const refresh = await fetch(`${url}/api/events/refresh`, { method: 'POST', headers, signal: AbortSignal.timeout(15_000) })
  if (refresh.status !== 202) throw new Error('preview refresh was not accepted')
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const [events, ical, readiness] = await Promise.all(['/api/events?community=all', '/ical/all', '/api/notifications/readiness'].map(path => fetch(`${url}${path}`, { signal: AbortSignal.timeout(15_000) })))
    const eventBody = await events.text(); const calendar = await ical.text()
    if (events.ok && ical.ok && readiness.ok && previewFeedsReady(JSON.parse(eventBody), calendar, await readiness.json())) {
      const repeat = await fetch(`${url}/api/events?community=all`, { signal: AbortSignal.timeout(15_000) })
      if (repeat.ok) return
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error('preview refresh did not produce persistent events and iCalendar before timeout')
}

export const runPreviewDeployment = async (options: Options, run: Command = command) => {
  const target = options.target === 'claimed' ? await targetInput(options.config!) : undefined
  if (target && !accountIds(await jsonCommand(run, ['whoami', '--json'])).includes(target.accountId)) throw new Error('authenticated account does not own the pinned preview target')
  await buildPreview()
  const config = await resolvedConfig(options.target, target)
  validatePreviewConfiguration(await readJson(config), target)
  if (options.dryRun) {
    await run(['deploy', '--dry-run', '--keep-vars', ...configArgs(config)])
    process.stdout.write(JSON.stringify({ target: options.target, dryRun: true, worker: workerName }) + '\n')
    return
  }
  if (!target) throw new Error('temporary mode cannot run native NuxtHub migrations because Wrangler does not expose temporary credentials to its other supported CLI commands')
  await verifyClaimedDatabase(run, config, target)
  await migrate(config, target, run)
  const before = objects(await jsonCommand(run, ['secret', 'list', '--name', workerName, '--format', 'json', ...configArgs(config)])).map(row => String(row.name)).sort()
  const adminToken = randomBytes(32).toString('base64url')
  await run(['secret', 'put', 'NUXT_EVENTS_ADMIN_TOKEN', '--name', workerName, ...configArgs(config)], { input: adminToken })
  const receipt = await run(['deploy', '--keep-vars', ...configArgs(config)])
  const url = workerUrl(receipt)
  if (!url) throw new Error('Cloudflare did not return a preview URL')
  const after = objects(await jsonCommand(run, ['secret', 'list', '--name', workerName, '--format', 'json', ...configArgs(config)])).map(row => String(row.name)).sort()
  if (!before.every(name => after.includes(name))) throw new Error('deployment removed an existing Worker secret')
  await refreshAndWait(url, adminToken)
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `preview_url=${url}\n`, { mode: 0o600 })
  process.stdout.write(JSON.stringify({ target: options.target, deployed: true, worker: workerName, previewUrl: url }) + '\n')
}

if (process.argv[1]?.endsWith('deploy-preview.ts')) runPreviewDeployment(parsePreviewDeployArgs(process.argv.slice(2))).catch(error => {
  process.stderr.write(`Preview deployment failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  process.exitCode = 1
})
