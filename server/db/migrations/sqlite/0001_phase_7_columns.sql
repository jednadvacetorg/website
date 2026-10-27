PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_outbox` (
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
	CONSTRAINT "notification_outbox_status_check" CHECK("__new_notification_outbox"."status" IN ('pending', 'queued', 'claimed', 'consumed', 'invalidated')),
	CONSTRAINT "notification_outbox_kind_check" CHECK("__new_notification_outbox"."kind" IN ('first-activation', 'reactivation', 'management-recovery', 'event-email', 'event-sms', 'event-web-push'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_outbox`("id", "contact_id", "version", "expected_capability_generation", "status", "claim_token", "claim_expires_at", "payload_ciphertext", "payload_iv", "kind", "created_at", "updated_at", "terminal_at") SELECT "id", "contact_id", "version", "expected_capability_generation", "status", "claim_token", "claim_expires_at", "payload_ciphertext", "payload_iv", "kind", "created_at", "updated_at", "terminal_at" FROM `notification_outbox`;--> statement-breakpoint
DROP TABLE `notification_outbox`;--> statement-breakpoint
ALTER TABLE `__new_notification_outbox` RENAME TO `notification_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notification_outbox_contact_status_idx` ON `notification_outbox` (`contact_id`,`status`);--> statement-breakpoint
ALTER TABLE `notification_event_deliveries` ADD `channel` text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_event_deliveries` ADD `community_slug` text;--> statement-breakpoint
ALTER TABLE `notification_event_deliveries` ADD `eligibility_frequency` text;--> statement-breakpoint
CREATE INDEX `notification_event_deliveries_authority_idx` ON `notification_event_deliveries` (`contact_id`,`channel`,`community_slug`,`eligibility_frequency`);