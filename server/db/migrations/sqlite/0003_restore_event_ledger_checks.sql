PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_event_deliveries` (
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
	CONSTRAINT "notification_event_deliveries_channel_check" CHECK("__new_notification_event_deliveries"."channel" IN ('email', 'sms', 'web-push')),
	CONSTRAINT "notification_event_deliveries_frequency_check" CHECK("__new_notification_event_deliveries"."eligibility_frequency" IN ('created', 'week-before', 'day-before')),
	CONSTRAINT "notification_event_deliveries_reason_check" CHECK("__new_notification_event_deliveries"."reason" IN ('created', 'week-before', 'day-before', 'updated', 'cancelled')),
	CONSTRAINT "notification_event_deliveries_status_check" CHECK("__new_notification_event_deliveries"."status" IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_event_deliveries`("id", "contact_id", "channel", "community_slug", "eligibility_frequency", "expected_capability_generation", "destination_hash", "event_uid", "event_revision", "reason", "status", "provider_message_id", "created_at", "updated_at", "submitted_at") SELECT "id", "contact_id", "channel", "community_slug", "eligibility_frequency", "expected_capability_generation", "destination_hash", "event_uid", "event_revision", "reason", "status", "provider_message_id", "created_at", "updated_at", "submitted_at" FROM `notification_event_deliveries`;--> statement-breakpoint
DROP TABLE `notification_event_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notification_event_deliveries` RENAME TO `notification_event_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_event_deliveries_dedupe_unique` ON `notification_event_deliveries` (`contact_id`,`event_uid`,`event_revision`,`reason`);--> statement-breakpoint
CREATE INDEX `notification_event_deliveries_status_idx` ON `notification_event_deliveries` (`status`);--> statement-breakpoint
CREATE INDEX `notification_event_deliveries_authority_idx` ON `notification_event_deliveries` (`contact_id`,`channel`,`community_slug`,`eligibility_frequency`);