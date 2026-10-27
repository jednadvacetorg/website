ALTER TABLE `notification_outbox` ADD `email_destination_hash` text;--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `email_provider_message_id` text;--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `email_delivery_status` text;--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `email_attempted_at` text;--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `email_attempt_version` integer;