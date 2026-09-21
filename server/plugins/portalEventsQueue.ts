import {
  getPortalCommunities,
  refreshPortalMeetups,
  type PortalChangeSignal,
} from '../utils/portalEvents.ts'
import { getGoogleCalendarConfig, GoogleCalendarError, reconcileGoogleCalendar, syncGoogleCalendarChanges } from '../utils/googleCalendar.ts'
import { planEventEmailNotifications } from '../utils/eventEmailNotifications.ts'
import { notificationConfig } from '../utils/notificationConfig.ts'
import type { NotificationDatabase } from '../utils/notifications.ts'
import {
  parsePortalEventsQueueBatch,
  portalEventsQueueName,
  type PortalEventsQueueEnvelope,
  type PortalEventsQueueMessage,
} from '../utils/portalEventsQueue.ts'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async queueEvent => {
    const { batch } = queueEvent
    if (batch.queue !== portalEventsQueueName) return

    try {
      const parsedBatch = parsePortalEventsQueueBatch(batch.messages as PortalEventsQueueEnvelope[])
      for (const messageId of parsedBatch.invalidMessageIds) {
        console.error(`[portal-events] Discarded invalid queue message: ${messageId}`)
      }
      const messages = parsedBatch.messages
      if (messages.length === 0) return
      const refreshAll = messages.some((message: PortalEventsQueueMessage) => message.kind === 'refresh-all')
      const changes = messages.flatMap<PortalChangeSignal>((message: PortalEventsQueueMessage) => message.kind === 'portal-change'
        ? [{
            resource: message.resource,
            action: message.action,
            meetupId: message.meetupId,
            ...(message.eventId ? { eventId: message.eventId } : {}),
            sequence: message.sequence,
            occurredAt: message.occurredAt,
          }]
        : [])
      const communities = await getPortalCommunities()
      const affectedMeetupIds = new Set(changes.map(change => change.meetupId))
      const selected = refreshAll
        ? communities
        : communities.filter(community => community.portalMeetupId !== undefined
          && affectedMeetupIds.has(community.portalMeetupId))
      if (selected.length === 0) {
        console.info('[portal-events] No configured communities were affected')
        return
      }

      const storage = useStorage('portalEvents')
      const result = await refreshPortalMeetups(selected, storage, $fetch, new Date(), changes)
      const database = (queueEvent as unknown as { context?: { cloudflare?: { env?: { DB?: NotificationDatabase } } } }).context?.cloudflare?.env?.DB
      if (database) {
        try {
          const planned = await planEventEmailNotifications(result.calendarEvents, {
            database,
            config: await notificationConfig(useRuntimeConfig() as unknown as Record<string, unknown>),
          })
          console.info(`[notifications] Planned ${planned.planned} event email deliveries after Portal refresh`)
        } catch (error) {
          // A disabled or incomplete private email configuration must not prevent Portal
          // snapshots from becoming public state. No recipient or provider data is logged.
          console.warn('[notifications] Event email planning is unavailable', { errorType: error instanceof Error ? error.name : typeof error })
        }
      }
      if (result.preservedCommunities.length > 0) {
        console.warn(`[portal-events] Preserved snapshots for removed meetups: ${result.preservedCommunities.join(', ')}`)
      }
      if (refreshAll) {
        // Use the materialized state that was just written. An immediate KV read is not
        // guaranteed to observe that write, even from the same Cloudflare location.
        await reconcileGoogleCalendar(
          result.calendarEvents,
          getGoogleCalendarConfig(useRuntimeConfig() as unknown as Record<string, unknown>),
        )
      } else {
        const eventIds = new Set(changes.flatMap(change => change.eventId ? [change.eventId] : []))
        if (eventIds.size > 0) {
          const events = result.calendarEvents
            .filter(item => eventIds.has(item.event.id))
          await syncGoogleCalendarChanges(
            events,
            getGoogleCalendarConfig(useRuntimeConfig() as unknown as Record<string, unknown>),
            fetch,
            result.deletedEventIds,
          )
        }
      }
      console.info(`[portal-events] Refreshed ${selected.length} communities from ${messages.length} messages`)
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : `non-Error rejection (${typeof error})`
      if (error instanceof GoogleCalendarError) {
        console.error(`[portal-events] Queue processing failed: ${detail}`, {
          ...(error.status !== undefined ? { googleStatus: error.status } : {}),
          ...(error.reason ? { googleReason: error.reason } : {}),
          ...(error.transport ? { googleTransport: error.transport } : {}),
          ...(error.failures ? { googleFailures: error.failures } : {}),
        })
      } else {
        console.error(`[portal-events] Queue processing failed: ${detail}`)
      }
      throw error
    }
  })
})
