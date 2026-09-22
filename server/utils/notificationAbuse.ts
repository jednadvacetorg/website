import type { NotificationDatabase, NotificationLifecycleConfig } from './notifications.ts'

export type NotificationAbuseDecision = { allowed: true } | { allowed: false, reason: 'rate-limited' | 'challenge-required' | 'challenge-failed' }

export interface NotificationAbuseDependencies {
  database: NotificationDatabase
  config: Pick<NotificationLifecycleConfig, 'abuseHashKey' | 'turnstile'>
  fetch?: typeof fetch
  now?: () => Date
}

interface AttemptCount { count: unknown }

const encoder = new TextEncoder()
const abuseWindowMs = 24 * 60 * 60 * 1_000
const rateLimitMs = 60 * 1_000
const turnstileAction = 'notification-operation'

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const requesterHash = async (requesterIp: string, dependencies: NotificationAbuseDependencies) => {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', dependencies.config.abuseHashKey, encoder.encode(requesterIp))))
}

const verifyTurnstile = async (token: string | undefined, requesterIp: string, dependencies: NotificationAbuseDependencies) => {
  if (!token || !dependencies.config.turnstile.secret || !dependencies.config.turnstile.expectedHostname) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await (dependencies.fetch ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: dependencies.config.turnstile.secret, response: token, remoteip: requesterIp }),
      signal: controller.signal,
    })
    const result: unknown = await response.json()
    return response.ok && isRecord(result) && result.success === true
      && result.action === turnstileAction && result.hostname === dependencies.config.turnstile.expectedHostname
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

/** Applies the same bounded, state-independent requester policy to every anonymous notification operation. */
export const evaluateNotificationAbuse = async (requesterIp: unknown, challengeToken: unknown, dependencies: NotificationAbuseDependencies): Promise<NotificationAbuseDecision> => {
  if (typeof requesterIp !== 'string' || !requesterIp.trim() || requesterIp.length > 64) return { allowed: false, reason: 'challenge-failed' }
  const hash = await requesterHash(requesterIp, dependencies)
  if (!hash) return { allowed: false, reason: 'challenge-failed' }
  const now = dependencies.now?.() ?? new Date()
  const expiresAt = new Date(now.getTime() + abuseWindowMs).toISOString()
  const minuteStart = new Date(now.getTime() - rateLimitMs).toISOString()
  const windowStart = new Date(now.getTime() - abuseWindowMs).toISOString()
  try {
    await dependencies.database.batch([
      dependencies.database.prepare('DELETE FROM notification_abuse_attempts WHERE expires_at <= ?').bind(now.toISOString()),
      dependencies.database.prepare('INSERT INTO notification_abuse_attempts (requester_hash, attempted_at, expires_at) VALUES (?, ?, ?)').bind(hash, now.toISOString(), expiresAt),
    ])
    const count = await dependencies.database.prepare('SELECT COUNT(*) AS count FROM notification_abuse_attempts WHERE requester_hash = ? AND attempted_at >= ?').bind(hash, windowStart).first<AttemptCount>()
    const minuteCount = await dependencies.database.prepare('SELECT COUNT(*) AS count FROM notification_abuse_attempts WHERE requester_hash = ? AND attempted_at >= ?').bind(hash, minuteStart).first<AttemptCount>()
    if (!count || !Number.isSafeInteger(count.count) || !minuteCount || !Number.isSafeInteger(minuteCount.count)) return { allowed: false, reason: 'challenge-failed' }
    const attemptsInWindow = count.count as number
    const attemptsInMinute = minuteCount.count as number
    if (attemptsInMinute > 1) return { allowed: false, reason: 'rate-limited' }
    if (attemptsInWindow < 6) return { allowed: true }
    return await verifyTurnstile(typeof challengeToken === 'string' ? challengeToken : undefined, requesterIp, dependencies)
      ? { allowed: true }
      : { allowed: false, reason: typeof challengeToken === 'string' && challengeToken ? 'challenge-failed' : 'challenge-required' }
  } catch {
    return { allowed: false, reason: 'challenge-failed' }
  }
}
