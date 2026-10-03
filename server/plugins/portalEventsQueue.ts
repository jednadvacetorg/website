import {
  getPortalCommunities,
  refreshPortalMeetups,
  type PortalChangeSignal,
} from '../utils/portalEvents.ts'
import {
  getGoogleCalendarConfig,
  GoogleCalendarError,
  importGoogleCalendarEvents,
  reconcileGoogleCalendar,
  syncGoogleCalendarChanges,
} from '../utils/googleCalendar.ts'
import {
  parsePortalEventsQueueBatch,
  portalEventsQueueName,
  type PortalEventsQueueEnvelope,
  type PortalEventsQueueMessage,
} from '../utils/portalEventsQueue.ts'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch }) => {
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
      if (result.preservedCommunities.length > 0) {
        console.warn(`[portal-events] Preserved snapshots for removed meetups: ${result.preservedCommunities.join(', ')}`)
      }
      if (refreshAll) {
        // Use the materialized state that was just written. An immediate KV read is not
        // guaranteed to observe that write, even from the same Cloudflare location.
        const runtimeConfig = useRuntimeConfig() as unknown as Record<string, unknown>
        const googleConfig = getGoogleCalendarConfig(runtimeConfig)
        await reconcileGoogleCalendar(result.calendarEvents, googleConfig)
        // The reverse direction is opt-in: without a Portal API token manual Google events stay untouched.
        if (typeof runtimeConfig.portalApiToken === 'string' && runtimeConfig.portalApiToken) {
          try {
            const imported = await importGoogleCalendarEvents(
              result.calendarEvents,
              selected,
              googleConfig,
              runtimeConfig.portalApiToken,
            )
            console.info('[portal-events] Imported manual Google Calendar events', imported)
          } catch (error) {
            // Publishing Portal events already succeeded; a failed import must not retry the whole refresh.
            console.error(`[portal-events] Google Calendar import failed: ${error instanceof Error ? error.message : typeof error}`)
          }
        }
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
