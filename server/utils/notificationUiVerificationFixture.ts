import type { NotificationChannel, NotificationManagementMutationResult, NotificationManagementResult } from './notifications.ts'

export const notificationUiVerificationToken = 'notification-ui-verification-token'
export const notificationUiVerificationManagementTokens = {
  active: 'notification-ui-management-active',
  pendingReactivation: 'notification-ui-management-pending-reactivation',
  stopped: 'notification-ui-management-stopped',
  old: 'notification-ui-management-old',
  unavailable: 'notification-ui-management-unavailable',
} as const

const fixtureEmail = /^[^\s@]+@[^\s@]+\.test$/i
const fixtureTelephone = /^\+1555\d{7}$/

/**
 * This private test seam exists only for the owned local browser verifier.  It
 * intentionally has no D1, Queue, provider, or persistent-state dependency.
 */
export const notificationUiVerificationFixtureEnabled = (runtimeConfig: Record<string, unknown>, development = process.env.NODE_ENV === 'development') =>
  development && (runtimeConfig.notificationUiVerificationFixture === true || runtimeConfig.notificationUiVerificationFixture === 'true')

export const isNotificationUiVerificationContact = (channel: NotificationChannel, contact: unknown) =>
  typeof contact === 'string' && (channel === 'email' ? fixtureEmail.test(contact) : channel === 'sms' ? fixtureTelephone.test(contact) : false)

export const notificationUiVerificationDecision = (runtimeConfig: Record<string, unknown>, channel: NotificationChannel, contact: unknown, token: unknown, development?: boolean) => {
  if (!notificationUiVerificationFixtureEnabled(runtimeConfig, development) || !isNotificationUiVerificationContact(channel, contact)) return null
  return token === notificationUiVerificationToken ? 'success' : 'challenge'
}

const activeManagementResult: NotificationManagementResult = {
  state: 'active',
  channel: 'email',
  maskedContact: 'u•••@example.test',
  communities: [
    { slug: 'brno', title: 'Brno s mimořádně dlouhým názvem pro ověření zalamování', frequencies: ['created', 'week-before'] },
    { slug: 'praha', title: 'Praha', frequencies: ['created', 'day-before'] },
    { slug: 'ostrava', title: 'Ostrava', frequencies: ['week-before'] },
    { slug: 'plzen', title: 'Plzeň', frequencies: ['created'] },
    { slug: 'olomouc', title: 'Olomouc', frequencies: ['week-before', 'day-before'] },
    { slug: 'ceske-budejovice', title: 'České Budějovice s dlouhým názvem městské komunity', frequencies: ['day-before'] },
  ],
}

const pendingManagementResult: NotificationManagementResult = {
  state: 'pending-reactivation',
  channel: 'sms',
  maskedContact: '+1555 ••• ••••',
  communities: [{
    slug: 'brno',
    title: 'Brno s mimořádně dlouhým názvem pro ověření zalamování',
    frequencies: ['created'],
  }],
}

const unavailableManagementResult: NotificationManagementResult = { state: 'unavailable' }

/**
 * Projects deterministic, non-sensitive management states for local visual UAT.
 * A disabled fixture deliberately returns null so production follows its real
 * token and D1 path without this seam changing any result.
 */
export const notificationUiVerificationManagementResult = (runtimeConfig: Record<string, unknown>, token: unknown, development?: boolean): NotificationManagementResult | null => {
  if (!notificationUiVerificationFixtureEnabled(runtimeConfig, development) || typeof token !== 'string') return null
  if (token === notificationUiVerificationManagementTokens.active) return activeManagementResult
  if (token === notificationUiVerificationManagementTokens.pendingReactivation) return pendingManagementResult
  if (Object.values(notificationUiVerificationManagementTokens).includes(token as typeof notificationUiVerificationManagementTokens[keyof typeof notificationUiVerificationManagementTokens])) return unavailableManagementResult
  return null
}

const cloneManagementResult = (result: NotificationManagementResult): NotificationManagementResult =>
  result.state === 'unavailable'
    ? result
    : { ...result, communities: result.communities.map(community => ({ ...community, frequencies: [...community.frequencies] })) }

const isFrequencyList = (value: unknown): value is Array<'created' | 'week-before' | 'day-before'> =>
  Array.isArray(value)
  && value.length > 0
  && value.every(frequency => frequency === 'created' || frequency === 'week-before' || frequency === 'day-before')

/** Applies deterministic, row-scoped projections only for the local fixture. */
export const mutateNotificationUiVerificationManagement = (runtimeConfig: Record<string, unknown>, token: unknown, action: unknown, body: Record<string, unknown>, development?: boolean): NotificationManagementMutationResult | null => {
  const current = notificationUiVerificationManagementResult(runtimeConfig, token, development)
  if (!current || current.state === 'unavailable') return current ? { outcome: 'unavailable' } : null
  if (action === 'stop-channel') return { outcome: 'stopped' }
  if (current.state === 'pending-reactivation' && action === 'confirm-reactivation') return { outcome: 'reactivated', management: activeManagementResult }
  if (current.state !== 'active' || typeof body.communitySlug !== 'string') return null

  const result = cloneManagementResult(current)
  if (result.state === 'unavailable') return { outcome: 'unavailable' }
  const communityIndex = result.communities.findIndex(community => community.slug === body.communitySlug)
  if (communityIndex < 0) return null
  if (action === 'update-frequencies' && isFrequencyList(body.frequencies)) {
    result.communities[communityIndex] = { ...result.communities[communityIndex]!, frequencies: [...new Set(body.frequencies)] }
    return { outcome: 'saved', management: result }
  }
  if (action === 'remove-community') {
    result.communities.splice(communityIndex, 1)
    return result.communities.length ? { outcome: 'removed', management: result } : { outcome: 'stopped' }
  }
  return null
}
