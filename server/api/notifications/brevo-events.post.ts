import { createError, defineEventHandler, getHeader, readRawBody, setResponseStatus } from 'h3'
import { applyBrevoCallback, normalizeBrevoCallback } from '../../utils/brevoCallbacks.ts'
import type { NotificationDatabase } from '../../utils/notifications.ts'

const maxBytes = 64 * 1024
const maxEvents = 50

const secureEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

/** Processes already-bounded normalized callbacks; exported for boundary tests. */
export const processBrevoCallbackBody = async (rawBody: string, secret: unknown, authorization: string | undefined, database: NotificationDatabase) => {
  if (typeof secret !== 'string' || !secret.trim() || !authorization || !secureEqual(authorization, `Bearer ${secret}`)) throw createError({ statusCode: 401, statusMessage: 'Invalid callback authorization' })
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) throw createError({ statusCode: 413, statusMessage: 'Invalid callback payload' })
  let body: unknown
  try { body = JSON.parse(rawBody) } catch { throw createError({ statusCode: 400, statusMessage: 'Invalid callback payload' }) }
  const values = Array.isArray(body) ? body : [body]
  if (!values.length || values.length > maxEvents) throw createError({ statusCode: 400, statusMessage: 'Invalid callback payload' })
  for (const value of values) {
    const callback = normalizeBrevoCallback(value)
    if (callback) await applyBrevoCallback(callback, database)
  }
}

export default defineEventHandler(async (event) => {
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  if (!database?.prepare || !database.batch) throw createError({ statusCode: 503, statusMessage: 'Notification callback unavailable' })
  const rawBody = await readRawBody(event)
  if (rawBody === undefined) throw createError({ statusCode: 400, statusMessage: 'Invalid callback payload' })
  await processBrevoCallbackBody(rawBody, useRuntimeConfig(event).brevoCallbackSecret, getHeader(event, 'authorization'), database)
  setResponseStatus(event, 202)
  return { ok: true }
})
