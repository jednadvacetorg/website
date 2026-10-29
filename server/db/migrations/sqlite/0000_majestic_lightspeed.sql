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
	`channel` text DEFAULT 'email' NOT NULL,
	`community_slug` text,
	`eligibility_frequency` text,
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
	CONSTRAINT "notification_event_deliveries_channel_check" CHECK("notification_event_deliveries"."channel" IN ('email', 'sms', 'web-push')),
	CONSTRAINT "notification_event_deliveries_frequency_check" CHECK("notification_event_deliveries"."eligibility_frequency" IN ('created', 'week-before', 'day-before')),
	CONSTRAINT "notification_event_deliveries_reason_check" CHECK("notification_event_deliveries"."reason" IN ('created', 'week-before', 'day-before', 'updated', 'cancelled')),
	CONSTRAINT "notification_event_deliveries_status_check" CHECK("notification_event_deliveries"."status" IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_event_deliveries_dedupe_unique` ON `notification_event_deliveries` (`contact_id`,`event_uid`,`event_revision`,`reason`);--> statement-breakpoint
CREATE INDEX `notification_event_deliveries_status_idx` ON `notification_event_deliveries` (`status`);--> statement-breakpoint
CREATE INDEX `notification_event_deliveries_authority_idx` ON `notification_event_deliveries` (`contact_id`,`channel`,`community_slug`,`eligibility_frequency`);--> statement-breakpoint
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
CREATE TABLE `notification_lifecycle_email_callbacks` (
	`receipt_key` text PRIMARY KEY NOT NULL,
	`outbox_id` text NOT NULL,
	`attempt_version` integer NOT NULL,
	`event` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`outbox_id`) REFERENCES `notification_outbox`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_lifecycle_email_callbacks_receipt_key_check" CHECK(length("notification_lifecycle_email_callbacks"."receipt_key") = 64 AND "notification_lifecycle_email_callbacks"."receipt_key" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "notification_lifecycle_email_callbacks_attempt_version_check" CHECK(typeof("notification_lifecycle_email_callbacks"."attempt_version") = 'integer' AND "notification_lifecycle_email_callbacks"."attempt_version" > 0),
	CONSTRAINT "notification_lifecycle_email_callbacks_event_check" CHECK("notification_lifecycle_email_callbacks"."event" IN ('delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed')),
	CONSTRAINT "notification_lifecycle_email_callbacks_provider_message_id_check" CHECK(length(CAST("notification_lifecycle_email_callbacks"."provider_message_id" AS BLOB)) BETWEEN 1 AND 256 AND instr("notification_lifecycle_email_callbacks"."provider_message_id", char(0)) = 0 AND "notification_lifecycle_email_callbacks"."provider_message_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*') AND substr("notification_lifecycle_email_callbacks"."provider_message_id", 1, 1) <> '<' AND substr("notification_lifecycle_email_callbacks"."provider_message_id", -1) <> '>'),
	CONSTRAINT "notification_lifecycle_email_callbacks_received_at_check" CHECK(length("notification_lifecycle_email_callbacks"."received_at") = 24 AND "notification_lifecycle_email_callbacks"."received_at" GLOB '????-??-??T??:??:??.???Z')
);
--> statement-breakpoint
CREATE INDEX `notification_lifecycle_email_callbacks_outbox_idx` ON `notification_lifecycle_email_callbacks` (`outbox_id`);--> statement-breakpoint
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
	`email_destination_hash` text,
	`email_provider_message_id` text,
	`email_delivery_status` text,
	`email_attempted_at` text,
	`email_attempt_version` integer,
	CONSTRAINT "notification_outbox_status_check" CHECK("notification_outbox"."status" IN ('pending', 'queued', 'claimed', 'consumed', 'invalidated')),
	CONSTRAINT "notification_outbox_kind_check" CHECK("notification_outbox"."kind" IN ('first-activation', 'reactivation', 'management-recovery', 'event-email', 'event-sms', 'event-web-push')),
	CONSTRAINT "notification_outbox_email_destination_hash_check" CHECK("notification_outbox"."email_destination_hash" IS NULL OR (length("notification_outbox"."email_destination_hash") = 43 AND "notification_outbox"."email_destination_hash" NOT GLOB '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "notification_outbox_email_provider_message_id_check" CHECK("notification_outbox"."email_provider_message_id" IS NULL OR (length(CAST("notification_outbox"."email_provider_message_id" AS BLOB)) BETWEEN 1 AND 256 AND instr("notification_outbox"."email_provider_message_id", char(0)) = 0 AND "notification_outbox"."email_provider_message_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*') AND substr("notification_outbox"."email_provider_message_id", 1, 1) <> '<' AND substr("notification_outbox"."email_provider_message_id", -1) <> '>')),
	CONSTRAINT "notification_outbox_email_delivery_status_check" CHECK("notification_outbox"."email_delivery_status" IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed')),
	CONSTRAINT "notification_outbox_email_attempt_version_check" CHECK("notification_outbox"."email_attempt_version" IS NULL OR (typeof("notification_outbox"."email_attempt_version") = 'integer' AND "notification_outbox"."email_attempt_version" > 0 AND "notification_outbox"."email_attempt_version" <= "notification_outbox"."version")),
	CONSTRAINT "notification_outbox_email_attempted_at_check" CHECK("notification_outbox"."email_attempted_at" IS NULL OR (length("notification_outbox"."email_attempted_at") = 24 AND "notification_outbox"."email_attempted_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "notification_outbox_lifecycle_email_evidence_check" CHECK("notification_outbox"."kind" IN ('first-activation', 'reactivation', 'management-recovery') OR ("notification_outbox"."email_destination_hash" IS NULL AND "notification_outbox"."email_provider_message_id" IS NULL AND "notification_outbox"."email_delivery_status" IS NULL AND "notification_outbox"."email_attempted_at" IS NULL AND "notification_outbox"."email_attempt_version" IS NULL))
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