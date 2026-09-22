import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type EmailVerificationMode = 'preflight' | 'sandbox' | 'callback' | 'live-canary' | 'readiness'

const modes = new Set<EmailVerificationMode>(['preflight', 'sandbox', 'callback', 'live-canary', 'readiness'])
const requiredSecrets = ['NUXT_BREVO_API_KEY', 'NUXT_BREVO_CALLBACK_SECRET', 'NUXT_NOTIFICATION_ROOT_KEY']

const required = (environment: NodeJS.ProcessEnv, name: string) => {
  const value = environment[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required configuration: ${name}`)
  return value
}

/** Validates an explicit production target without rendering any secret values. */
export const emailVerificationTarget = (value: unknown) => {
  if (value !== 'production') throw new Error('Email verification requires --target production')
  return value
}

export const parseEmailVerificationArgs = (args: string[]) => {
  const [mode, flag, target] = args
  if (!modes.has(mode as EmailVerificationMode) || flag !== '--target') throw new Error('Usage: verify:email-delivery <preflight|sandbox|callback|live-canary|readiness> --target production')
  return { mode: mode as EmailVerificationMode, target: emailVerificationTarget(target) }
}

/** Returns opaque proof of the built Worker configuration; it cannot authorize a send. */
export const preflightEmailDelivery = async (configPath: string, environment: NodeJS.ProcessEnv) => {
  for (const name of requiredSecrets) required(environment, name)
  const config = await readFile(resolve(configPath), 'utf8')
  const parsed = JSON.parse(config) as { name?: unknown, d1_databases?: unknown, queues?: unknown }
  if (parsed.name !== 'jednadvacetorg-web' || !Array.isArray(parsed.d1_databases) || !parsed.queues) throw new Error('Production Worker bindings are incomplete')
  return { target: 'production', bundleHash: createHash('sha256').update(config).digest('hex'), verifiedAt: new Date().toISOString(), manualSwitch: false }
}

const main = async () => {
  const { mode } = parseEmailVerificationArgs(process.argv.slice(2))
  if (mode !== 'preflight') throw new Error(`${mode} requires authenticated Brevo and Cloudflare production access; see docs/email-delivery-operations.md`)
  const result = await preflightEmailDelivery('.output/server/wrangler.json', process.env)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) await main()
