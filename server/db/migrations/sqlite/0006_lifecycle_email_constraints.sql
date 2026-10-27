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
	`email_destination_hash` text,
	`email_provider_message_id` text,
	`email_delivery_status` text,
	`email_attempted_at` text,
	`email_attempt_version` integer,
	CONSTRAINT "notification_outbox_status_check" CHECK("__new_notification_outbox"."status" IN ('pending', 'queued', 'claimed', 'consumed', 'invalidated')),
	CONSTRAINT "notification_outbox_kind_check" CHECK("__new_notification_outbox"."kind" IN ('first-activation', 'reactivation', 'management-recovery', 'event-email', 'event-sms', 'event-web-push')),
	CONSTRAINT "notification_outbox_email_destination_hash_check" CHECK("__new_notification_outbox"."email_destination_hash" IS NULL OR (length("__new_notification_outbox"."email_destination_hash") = 43 AND "__new_notification_outbox"."email_destination_hash" NOT GLOB '*[^A-Za-z0-9_-]*')),
	CONSTRAINT "notification_outbox_email_provider_message_id_check" CHECK("__new_notification_outbox"."email_provider_message_id" IS NULL OR (length(CAST("__new_notification_outbox"."email_provider_message_id" AS BLOB)) BETWEEN 1 AND 256 AND instr("__new_notification_outbox"."email_provider_message_id", char(0)) = 0 AND "__new_notification_outbox"."email_provider_message_id" NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*') AND substr("__new_notification_outbox"."email_provider_message_id", 1, 1) <> '<' AND substr("__new_notification_outbox"."email_provider_message_id", -1) <> '>')),
	CONSTRAINT "notification_outbox_email_delivery_status_check" CHECK("__new_notification_outbox"."email_delivery_status" IN ('pending', 'submitted', 'delivered', 'soft-bounce', 'blocked', 'hard-bounce', 'complaint', 'unsubscribed', 'failed')),
	CONSTRAINT "notification_outbox_email_attempt_version_check" CHECK("__new_notification_outbox"."email_attempt_version" IS NULL OR (typeof("__new_notification_outbox"."email_attempt_version") = 'integer' AND "__new_notification_outbox"."email_attempt_version" > 0 AND "__new_notification_outbox"."email_attempt_version" <= "__new_notification_outbox"."version")),
	CONSTRAINT "notification_outbox_email_attempted_at_check" CHECK("__new_notification_outbox"."email_attempted_at" IS NULL OR (length("__new_notification_outbox"."email_attempted_at") = 24 AND "__new_notification_outbox"."email_attempted_at" GLOB '????-??-??T??:??:??.???Z')),
	CONSTRAINT "notification_outbox_lifecycle_email_evidence_check" CHECK("__new_notification_outbox"."kind" IN ('first-activation', 'reactivation', 'management-recovery') OR ("__new_notification_outbox"."email_destination_hash" IS NULL AND "__new_notification_outbox"."email_provider_message_id" IS NULL AND "__new_notification_outbox"."email_delivery_status" IS NULL AND "__new_notification_outbox"."email_attempted_at" IS NULL AND "__new_notification_outbox"."email_attempt_version" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_notification_outbox`("id", "contact_id", "version", "expected_capability_generation", "status", "claim_token", "claim_expires_at", "payload_ciphertext", "payload_iv", "kind", "created_at", "updated_at", "terminal_at", "email_destination_hash", "email_provider_message_id", "email_delivery_status", "email_attempted_at", "email_attempt_version") SELECT "id", "contact_id", "version", "expected_capability_generation", "status", "claim_token", "claim_expires_at", "payload_ciphertext", "payload_iv", "kind", "created_at", "updated_at", "terminal_at", "email_destination_hash", "email_provider_message_id", "email_delivery_status", "email_attempted_at", "email_attempt_version" FROM `notification_outbox`;--> statement-breakpoint
DROP TABLE `notification_outbox`;--> statement-breakpoint
ALTER TABLE `__new_notification_outbox` RENAME TO `notification_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notification_outbox_contact_status_idx` ON `notification_outbox` (`contact_id`,`status`);