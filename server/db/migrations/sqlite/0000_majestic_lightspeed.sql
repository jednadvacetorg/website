CREATE TABLE `notification_abuse_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`requester_hash` text NOT NULL,
	`attempted_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_abuse_attempts_requester_attempted_idx` ON `notification_abuse_attempts` (`requester_hash`,`attempted_at`);--> statement-breakpoint
CREATE TABLE `notification_contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`destination_hash` text NOT NULL,
	`management_token_digest` text NOT NULL,
	`capability_generation` integer NOT NULL,
	`state` text NOT NULL,
	`consent_at` text NOT NULL,
	`consent_version` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "notification_contacts_channel_check" CHECK("notification_contacts"."channel" IN ('email', 'sms', 'web-push')),
	CONSTRAINT "notification_contacts_state_check" CHECK("notification_contacts"."state" IN ('active', 'pending-reactivation'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_contacts_identity_unique` ON `notification_contacts` (`channel`,`destination`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_contacts_token_digest_unique` ON `notification_contacts` (`management_token_digest`);--> statement-breakpoint
CREATE INDEX `notification_contacts_destination_hash_idx` ON `notification_contacts` (`channel`,`destination_hash`);--> statement-breakpoint
CREATE TABLE `notification_delivery_callbacks` (
	`provider_event_id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`event` text NOT NULL,
	`provider_message_id` text,
	`received_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_event_deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_delivery_callbacks_delivery_idx` ON `notification_delivery_callbacks` (`delivery_id`);--> statement-breakpoint
CREATE TABLE `notification_event_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` integer,
	`expected_capability_generation` integer NOT NULL,
	`destination_hash` text NOT NULL,
	`event_uid` text NOT NULL,
	`event_revision` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`submitted_at` text,
	FOREIGN KEY (`contact_id`) REFERENCES `notification_contacts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notification_event_deliveries_status_check" CHECK("notification_event_deliveries"."status" IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_event_deliveries_dedupe_unique` ON `notification_event_deliveries` (`contact_id`,`event_uid`,`event_revision`,`reason`);--> statement-breakpoint
CREATE INDEX `notification_event_deliveries_status_idx` ON `notification_event_deliveries` (`status`);--> statement-breakpoint
CREATE TABLE `notification_event_state` (
	`event_key` text PRIMARY KEY NOT NULL,
	`uid` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`venue` text,
	`cancelled` integer NOT NULL,
	`notification_revision` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_management_capabilities` (
	`token_digest` text PRIMARY KEY NOT NULL,
	`contact_id` integer NOT NULL,
	`expected_capability_generation` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`contact_id`) REFERENCES `notification_contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_management_capabilities_contact_idx` ON `notification_management_capabilities` (`contact_id`,`expected_capability_generation`);--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` integer,
	`version` integer NOT NULL,
	`expected_capability_generation` integer NOT NULL,
	`status` text NOT NULL,
	`claim_token` text,
	`claim_expires_at` text,
	`payload_ciphertext` text,
	`payload_iv` text,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`terminal_at` text,
	CONSTRAINT "notification_outbox_status_check" CHECK("notification_outbox"."status" IN ('pending', 'queued', 'claimed', 'consumed', 'invalidated')),
	CONSTRAINT "notification_outbox_kind_check" CHECK("notification_outbox"."kind" IN ('first-activation', 'reactivation', 'management-recovery', 'event-email'))
);
--> statement-breakpoint
CREATE INDEX `notification_outbox_contact_status_idx` ON `notification_outbox` (`contact_id`,`status`);--> statement-breakpoint
CREATE TABLE `notification_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contact_id` integer NOT NULL,
	`community_slug` text NOT NULL,
	`frequency` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `notification_contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_subscriptions_frequency_check" CHECK("notification_subscriptions"."frequency" IN ('created', 'week-before', 'day-before'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_subscriptions_identity_unique` ON `notification_subscriptions` (`contact_id`,`community_slug`,`frequency`);--> statement-breakpoint
CREATE TABLE `notification_suppressions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`destination_hash` text NOT NULL,
	`reason` text NOT NULL,
	`suppressed_at` text NOT NULL,
	CONSTRAINT "notification_suppressions_channel_check" CHECK("notification_suppressions"."channel" IN ('email', 'sms', 'web-push')),
	CONSTRAINT "notification_suppressions_reason_check" CHECK("notification_suppressions"."reason" IN ('user-stop', 'provider-bounce', 'provider-complaint', 'provider-opt-out'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_suppressions_identity_unique` ON `notification_suppressions` (`channel`,`destination_hash`);
