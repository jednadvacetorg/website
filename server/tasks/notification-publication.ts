import { drainNotificationMessages } from './notification-messages.ts'

export default defineTask({
  meta: {
    name: 'notification-publication',
    description: 'Expire idle abuse attempts and publish bounded notification pointers without event planning',
  },
  async run(event) {
    return { result: await drainNotificationMessages(event.context, {}, { planning: false }) }
  },
})
