import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const notificationContacts = sqliteTable('notification_contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  channel: text('channel').notNull(),
  destination: text('destination').notNull(),
  destinationHash: text('destination_hash').notNull(),
  destinationHashKeyVersion: text('destination_hash_key_version').notNull(),
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
  destinationHashKeyVersion: text('destination_hash_key_version').notNull(),
  reason: text('reason').notNull(),
  suppressedAt: text('suppressed_at').notNull(),
}, table => [
  uniqueIndex('notification_suppressions_identity_unique').on(table.channel, table.destinationHash),
  check('notification_suppressions_channel_check', sql`${table.channel} IN ('email', 'sms', 'web-push')`),
  check('notification_suppressions_reason_check', sql`${table.reason} IN ('user-stop', 'provider-bounce', 'provider-complaint', 'provider-opt-out')`),
])

export const notificationOutbox = sqliteTable('notification_outbox', {
  id: text('id').primaryKey(),
  contactId: integer('contact_id').notNull(),
  version: integer('version').notNull(),
  expectedCapabilityGeneration: integer('expected_capability_generation').notNull(),
  status: text('status').notNull(),
  claimToken: text('claim_token'),
  claimExpiresAt: text('claim_expires_at'),
  payloadCiphertext: text('payload_ciphertext'),
  payloadIv: text('payload_iv'),
  transportKeyVersion: text('transport_key_version'),
  kind: text('kind').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  terminalAt: text('terminal_at'),
}, table => [
  index('notification_outbox_contact_status_idx').on(table.contactId, table.status),
  check('notification_outbox_status_check', sql`${table.status} IN ('pending', 'queued', 'claimed', 'consumed', 'invalidated')`),
  check('notification_outbox_kind_check', sql`${table.kind} IN ('first-activation', 'reactivation', 'management-recovery')`),
])

export const notificationAbuseAttempts = sqliteTable('notification_abuse_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requesterHash: text('requester_hash').notNull(),
  requesterHashKeyVersion: text('requester_hash_key_version').notNull(),
  attemptedAt: text('attempted_at').notNull(),
  expiresAt: text('expires_at').notNull(),
}, table => [
  index('notification_abuse_attempts_requester_attempted_idx').on(table.requesterHash, table.attemptedAt),
])
