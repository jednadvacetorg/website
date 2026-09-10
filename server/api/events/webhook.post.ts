import { createError, defineEventHandler, getHeader, readRawBody } from 'h3'
import {
  clearPortalEventCancellation,
  getPortalCalendarEvents,
  getPortalCommunities,
  markPortalEventCancelled,
  refreshPortalMeetups,
} from '../../utils/portalEvents.ts'
import {
  deleteGoogleCalendarEvent,
  getGoogleCalendarConfig,
  GoogleCalendarError,
  syncGoogleCalendarEvent,
} from '../../utils/googleCalendar.ts'

/**
 * Receives signed Portal change notifications and refreshes the affected community cache.
 * The webhook body is never applied directly; an authenticated notification triggers an authoritative refresh.
 */
const maxTimestampSkewSeconds = 5 * 60
const encoder = new TextEncoder()

/** Narrows unknown JSON values to non-array objects before reading webhook fields. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Encodes Web Crypto signature bytes as the lowercase hexadecimal header format used by Portal. */
const bytesToHex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** Compares same-length signatures without returning early on the first mismatched byte. */
const secureEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

/** Signs an exact raw webhook payload with the configured HMAC secret. */
const signatureFor = async (secret: string, payload: string) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return bytesToHex(new Uint8Array(signature))
}

/** Builds Portal's timestamp-dot-body HMAC payload and returns its signature. */
export const createPortalWebhookSignature = (secret: string, timestamp: string, rawBody: string) =>
  signatureFor(secret, `${timestamp}.${rawBody}`)

/** Rejects replayed, malformed, or incorrectly signed Portal webhook deliveries. */
export const isPortalWebhookSignatureValid = async (
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
) => {
  const timestampSeconds = Number(timestamp)
  return Number.isSafeInteger(timestampSeconds)
    && Math.abs(nowSeconds - timestampSeconds) <= maxTimestampSkewSeconds
    && secureEqual(signature, await createPortalWebhookSignature(secret, timestamp, rawBody))
}

/** Extracts the affected meetup ID from current data or deletion tombstone data. */
export const getPortalWebhookMeetupId = (payload: Record<string, unknown>) => {
  if (payload.resource === 'meetup') {
    if (isRecord(payload.data) && Number.isSafeInteger(payload.data.id)) return payload.data.id as number
    if (isRecord(payload.previous) && Number.isSafeInteger(payload.previous.id)) return payload.previous.id as number
  }
  if (isRecord(payload.data) && Number.isSafeInteger(payload.data.meetup_id)) return payload.data.meetup_id as number
  if (isRecord(payload.previous) && Number.isSafeInteger(payload.previous.meetup_id)) return payload.previous.meetup_id as number
  return null
}

/** Extracts the affected Portal event ID when the webhook addresses an event. */
export const getPortalWebhookEventId = (payload: Record<string, unknown>) => {
  if (payload.resource !== 'meetup-event') return null
  if (isRecord(payload.data) && Number.isSafeInteger(payload.data.id)) return String(payload.data.id)
  if (isRecord(payload.previous) && Number.isSafeInteger(payload.previous.id)) return String(payload.previous.id)
  return null
}

/** Validates a Portal webhook envelope and refreshes its configured community when applicable. */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const secret = config.portalWebhookSecret
  const eventName = getHeader(event, 'x-portal-event')
  const timestamp = getHeader(event, 'x-portal-timestamp')
  const signature = getHeader(event, 'x-portal-signature')
  const rawBody = await readRawBody(event)
  if (!secret || !eventName || !timestamp || !signature || rawBody === undefined) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid Portal webhook' })
  }

  if (!await isPortalWebhookSignatureValid(secret, timestamp, rawBody, signature)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid Portal webhook' })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid Portal webhook payload' })
  }
  if (!isRecord(payload) || !/^(?:meetup|meetup-event)\.(?:created|updated|deleted)$/.test(eventName)
    || `${payload.resource}.${payload.action}` !== eventName) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid Portal webhook payload' })
  }
  const meetupId = getPortalWebhookMeetupId(payload)
  if (meetupId === null) {
    throw createError({ statusCode: 400, statusMessage: 'Portal webhook has no meetup ID' })
  }

  const community = (await getPortalCommunities(event)).find(item => item.portalMeetupId === meetupId)
  if (community) {
    const storage = useStorage('portalEvents')
    const eventId = getPortalWebhookEventId(payload)
    let cancellationStored = false
    if (eventName === 'meetup-event.deleted') {
      if (eventId) cancellationStored = await markPortalEventCancelled(community, eventId, storage)
    } else if (eventId) {
      await clearPortalEventCancellation(community, eventId, storage)
    }
    await refreshPortalMeetups([community], storage, $fetch)
    if (eventName === 'meetup-event.deleted' && eventId && !cancellationStored) {
      await markPortalEventCancelled(community, eventId, storage)
    }
    if (eventId) {
      try {
        const googleConfig = getGoogleCalendarConfig(config as unknown as Record<string, unknown>)
        if (eventName === 'meetup-event.deleted') {
          await deleteGoogleCalendarEvent(eventId, googleConfig)
        } else {
          const calendarEvent = (await getPortalCalendarEvents([community.id], [community], storage, $fetch))
            .find(item => item.event.id === eventId && !item.cancelled)
          if (calendarEvent) await syncGoogleCalendarEvent(calendarEvent, googleConfig)
        }
      } catch (error) {
        console.error('Google Calendar webhook synchronization failed', {
          eventName,
          eventId,
          error: error instanceof Error ? error.message : 'Unknown error',
          ...(error instanceof GoogleCalendarError && error.status !== undefined ? { status: error.status } : {}),
          ...(error instanceof GoogleCalendarError && error.reason ? { reason: error.reason } : {}),
        })
        throw createError({ statusCode: 502, statusMessage: 'Google Calendar synchronization failed' })
      }
    }
  }
  return { ok: true }
})
