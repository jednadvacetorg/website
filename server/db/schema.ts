import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const notificationContacts = sqliteTable('notification_contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channel: text('channel').notNull(),
  destination: text('destination').notNull(),
  destinationHash: text('destination_hash').notNull(),
  managementTokenDigest: text('management_token_digest').notNull(),
  capabilityGeneration: integer('capability_generation').notNull(),
  state: text('state').notNull(),
  consentAt: text('consent_at').notNull(),
  consentVersion: text('consent_version').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('notification_contacts_identity_unique').on(table.channel, table.destination),
  uniqueIndex('notification_contacts_token_digest_unique').on(table.managementTokenDigest),
  index('notification_contacts_destination_hash_idx').on(table.channel, table.destinationHash),
  check('notification_contacts_channel_check', sql`${table.channel} IN ('email', 'sms', 'web-push')`),
  check('notification_contacts_state_check', sql`${table.state} IN ('active', 'pending-reactivation')`),
])

export const notificationSubscriptions = sqliteTable('notification_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  contactId: integer('contact_id').notNull().references(() => notificationContacts.id, { onDelete: 'cascade' }),
  communitySlug: text('community_slug').notNull(),
  frequency: text('frequency').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('notification_subscriptions_identity_unique').on(table.contactId, table.communitySlug, table.frequency),
  check('notification_subscriptions_frequency_check', sql`${table.frequency} IN ('created', 'week-before', 'day-before')`),
])

export const notificationSuppressions = sqliteTable('notification_suppressions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channel: text('channel').notNull(),
  destinationHash: text('destination_hash').notNull(),
  reason: text('reason').notNull(),
  suppressedAt: text('suppressed_at').notNull(),
}, table => [
  uniqueIndex('notification_suppressions_identity_unique').on(table.channel, table.destinationHash),
  check('notification_suppressions_channel_check', sql`${table.channel} IN ('email', 'sms', 'web-push')`),
  check('notification_suppressions_reason_check', sql`${table.reason} IN ('user-stop', 'provider-bounce', 'provider-complaint', 'provider-opt-out')`),
])

export const notificationOutbox = sqliteTable('notification_outbox', {
  id: text('id').primaryKey(),
  // Delivery evidence must survive privacy-preserving contact deletion after a provider callback.
  contactId: integer('contact_id'),
  version: integer('version').notNull(),
  expectedCapabilityGeneration: integer('expected_capability_generation').notNull(),
  status: text('status').notNull(),
  claimToken: text('claim_token'),
  claimExpiresAt: text('claim_expires_at'),
  payloadCiphertext: text('payload_ciphertext'),
  payloadIv: text('payload_iv'),
  kind: text('kind').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  terminalAt: text('terminal_at'),
  // Minimal lifecycle attempt evidence; old rows legitimately have no evidence.
  // 06-18 owns expiry at original terminal_at + 30 days, including receipt cleanup.
  emailDestinationHash: text('email_destination_hash'),
  emailProviderMessageId: text('email_provider_message_id'),
  emailDeliveryStatus: text('email_delivery_status'),
  emailAttemptedAt: text('email_attempted_at'),
  emailAttemptVersion: integer('email_attempt_version'),
}, table => [
  index('notification_outbox_contact_status_idx').on(table.contactId, table.status),
  check('notification_outbox_status_check', sql`${table.status} IN ('pending', 'queued', 'claimed', 'consumed', 'invalidated')`),
  check('notification_outbox_kind_check', sql`${table.kind} IN ('first-activation', 'reactivation', 'management-recovery', 'event-email', 'event-sms', 'event-web-push')`),
  check('notification_outbox_email_destination_hash_check', sql`${table.emailDestinationHash} IS NULL OR (length(${table.emailDestinationHash}) = 43 AND ${table.emailDestinationHash} NOT GLOB '*[^A-Za-z0-9_-]*')`),
  check('notification_outbox_email_provider_message_id_check', sql`${table.emailProviderMessageId} IS NULL OR (length(CAST(${table.emailProviderMessageId} AS BLOB)) BETWEEN 1 AND 256 AND instr(${table.emailProviderMessageId}, char(0)) = 0 AND ${table.emailProviderMessageId} NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*') AND substr(${table.emailProviderMessageId}, 1, 1) <> '<' AND substr(${table.emailProviderMessageId}, -1) <> '>')`),
  check('notification_outbox_email_delivery_status_check', sql`${table.emailDeliveryStatus} IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed')`),
  check('notification_outbox_email_attempt_version_check', sql`${table.emailAttemptVersion} IS NULL OR (typeof(${table.emailAttemptVersion}) = 'integer' AND ${table.emailAttemptVersion} > 0 AND ${table.emailAttemptVersion} <= ${table.version})`),
  check('notification_outbox_email_attempted_at_check', sql`${table.emailAttemptedAt} IS NULL OR (length(${table.emailAttemptedAt}) = 24 AND ${table.emailAttemptedAt} GLOB '????-??-??T??:??:??.???Z')`),
  check('notification_outbox_lifecycle_email_evidence_check', sql`${table.kind} IN ('first-activation', 'reactivation', 'management-recovery') OR (${table.emailDestinationHash} IS NULL AND ${table.emailProviderMessageId} IS NULL AND ${table.emailDeliveryStatus} IS NULL AND ${table.emailAttemptedAt} IS NULL AND ${table.emailAttemptVersion} IS NULL)`),
])

export const notificationLifecycleEmailCallbacks = sqliteTable('notification_lifecycle_email_callbacks', {
  receiptKey: text('receipt_key').primaryKey().notNull(),
  outboxId: text('outbox_id').notNull().references(() => notificationOutbox.id, { onDelete: 'cascade' }),
  attemptVersion: integer('attempt_version').notNull(),
  event: text('event').notNull(),
  providerMessageId: text('provider_message_id').notNull(),
  receivedAt: text('received_at').notNull(),
}, table => [
  // Lookup and deletion follow the retained outbox owner, never the contact.
  index('notification_lifecycle_email_callbacks_outbox_idx').on(table.outboxId),
  check('notification_lifecycle_email_callbacks_receipt_key_check', sql`length(${table.receiptKey}) = 64 AND ${table.receiptKey} NOT GLOB '*[^0-9a-f]*'`),
  check('notification_lifecycle_email_callbacks_attempt_version_check', sql`typeof(${table.attemptVersion}) = 'integer' AND ${table.attemptVersion} > 0`),
  check('notification_lifecycle_email_callbacks_event_check', sql`${table.event} IN ('delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed')`),
  check('notification_lifecycle_email_callbacks_provider_message_id_check', sql`length(CAST(${table.providerMessageId} AS BLOB)) BETWEEN 1 AND 256 AND instr(${table.providerMessageId}, char(0)) = 0 AND ${table.providerMessageId} NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*') AND substr(${table.providerMessageId}, 1, 1) <> '<' AND substr(${table.providerMessageId}, -1) <> '>'`),
  check('notification_lifecycle_email_callbacks_received_at_check', sql`length(${table.receivedAt}) = 24 AND ${table.receivedAt} GLOB '????-??-??T??:??:??.???Z'`),
])

export const notificationEventDeliveries = sqliteTable('notification_event_deliveries', {
  id: text('id').primaryKey(),
  contactId: integer('contact_id').references(() => notificationContacts.id, { onDelete: 'set null' }),
  channel: text('channel').notNull().default('email'),
  communitySlug: text('community_slug'),
  eligibilityFrequency: text('eligibility_frequency'),
  expectedCapabilityGeneration: integer('expected_capability_generation').notNull(),
  destinationHash: text('destination_hash').notNull(),
  eventUid: text('event_uid').notNull(),
  eventRevision: integer('event_revision').notNull(),
  reason: text('reason').notNull(),
  status: text('status').notNull(),
  providerMessageId: text('provider_message_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  submittedAt: text('submitted_at'),
}, table => [
  uniqueIndex('notification_event_deliveries_dedupe_unique').on(table.contactId, table.eventUid, table.eventRevision, table.reason),
  index('notification_event_deliveries_status_idx').on(table.status),
  index('notification_event_deliveries_authority_idx').on(table.contactId, table.channel, table.communitySlug, table.eligibilityFrequency),
  check('notification_event_deliveries_channel_check', sql`${table.channel} IN ('email', 'sms', 'web-push')`),
  check('notification_event_deliveries_frequency_check', sql`${table.eligibilityFrequency} IN ('created', 'week-before', 'day-before')`),
  check('notification_event_deliveries_reason_check', sql`${table.reason} IN ('created', 'week-before', 'day-before', 'updated', 'cancelled')`),
  check('notification_event_deliveries_status_check', sql`${table.status} IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed')`),
])

export const notificationDeliveryCallbacks = sqliteTable('notification_delivery_callbacks', {
  providerEventId: text('provider_event_id').primaryKey(),
  deliveryId: text('delivery_id').notNull().references(() => notificationEventDeliveries.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  providerMessageId: text('provider_message_id'),
  receivedAt: text('received_at').notNull(),
}, table => [
  index('notification_delivery_callbacks_delivery_idx').on(table.deliveryId),
])

export const notificationEventState = sqliteTable('notification_event_state', {
  eventKey: text('event_key').primaryKey(),
  uid: text('uid').notNull(),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at').notNull(),
  venue: text('venue'),
  cancelled: integer('cancelled', { mode: 'boolean' }).notNull(),
  notificationRevision: integer('notification_revision').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const notificationManagementCapabilities = sqliteTable('notification_management_capabilities', {
  tokenDigest: text('token_digest').primaryKey(),
  contactId: integer('contact_id').notNull().references(() => notificationContacts.id, { onDelete: 'cascade' }),
  expectedCapabilityGeneration: integer('expected_capability_generation').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
}, table => [
  index('notification_management_capabilities_contact_idx').on(table.contactId, table.expectedCapabilityGeneration),
])

export const notificationAbuseAttempts = sqliteTable('notification_abuse_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requesterHash: text('requester_hash').notNull(),
  attemptedAt: text('attempted_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, table => [
  index('notification_abuse_attempts_requester_attempted_idx').on(table.requesterHash, table.attemptedAt),
])
