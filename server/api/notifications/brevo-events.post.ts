import { createError, defineEventHandler, getHeader, getRequestWebStream, setResponseStatus } from 'h3'
import { applyBrevoCallback, normalizeBrevoCallback, normalizeBrevoSmsCallback } from '../../utils/brevoCallbacks.ts'
import type { NotificationDatabase } from '../../utils/notifications.ts'

const maxBytes = 64 * 1024
const maxEvents = 50

const secureEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

const assertCallbackAuthorization = (secret: unknown, authorization: string | undefined) => {
  if (typeof secret !== 'string' || !secret.trim() || !authorization || !secureEqual(authorization, `Bearer ${secret}`)) throw createError({ statusCode: 401, statusMessage: 'Invalid callback authorization' })
}

/** Processes already-bounded normalized callbacks; exported for boundary tests. */
export const processBrevoCallbackBody = async (rawBody: string, secret: unknown, authorization: string | undefined, database: NotificationDatabase, channel: 'email' | 'sms' = 'email') => {
  assertCallbackAuthorization(secret, authorization)
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) throw createError({ statusCode: 413, statusMessage: 'Invalid callback payload' })
  let body: unknown
  try { body = JSON.parse(rawBody) } catch { throw createError({ statusCode: 400, statusMessage: 'Invalid callback payload' }) }
  const values = Array.isArray(body) ? body : [body]
  if (!values.length || values.length > maxEvents) throw createError({ statusCode: 400, statusMessage: 'Invalid callback payload' })
  for (const value of values) {
    if (channel === 'sms') {
      const callback = normalizeBrevoSmsCallback(value)
      if (!callback) continue
      const matches = await database.prepare("SELECT id FROM notification_event_deliveries WHERE channel = 'sms' AND provider_message_id = ? LIMIT 2").bind(callback.providerMessageId).all<{ id: string }>()
      // Never guess by phone number, tags or references, nor choose an ambiguous attempt.
      if (matches.results.length === 1) await applyBrevoCallback({ ...callback, deliveryId: matches.results[0]!.id }, database, 'sms')
      continue
    }
    const callback = normalizeBrevoCallback(value)
    if (callback) await applyBrevoCallback(callback, database)
  }
}

export const createBrevoCallbackHandler = (channel: 'email' | 'sms') => defineEventHandler(async (event) => {
  const database = (event.context._platform as { cloudflare?: { env?: { DB?: NotificationDatabase } } } | undefined)?.cloudflare?.env?.DB
  if (!database?.prepare || !database.batch) throw createError({ statusCode: 503, statusMessage: 'Notification callback unavailable' })
  const secret = useRuntimeConfig(event).brevoCallbackSecret
  const authorization = getHeader(event, 'authorization')
  assertCallbackAuthorization(secret, authorization)
  if (Number(getHeader(event, 'content-length')) > maxBytes) throw createError({ statusCode: 413, statusMessage: 'Invalid callback payload' })
  const reader = getRequestWebStream(event)?.getReader()
  if (!reader) throw createError({ statusCode: 400, statusMessage: 'Invalid callback payload' })
  const decoder = new TextDecoder()
  let bytes = 0
  let rawBody = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        // Web requests (including Workers) propagate cancellation to the source.
        // H3's Node bridge has no cancel hook; pause it instead of letting its
        // data listener enqueue into a cancelled stream.
        if (event.web) await reader.cancel().catch(() => {})
        else event.node.req.pause()
        throw createError({ statusCode: 413, statusMessage: 'Invalid callback payload' })
      }
      rawBody += decoder.decode(value, { stream: true })
    }
    rawBody += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  await processBrevoCallbackBody(rawBody, secret, authorization, database, channel)
  setResponseStatus(event, 202)
  return { ok: true }
})

export default createBrevoCallbackHandler('email')
