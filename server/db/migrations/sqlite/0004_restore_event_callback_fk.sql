PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_delivery_callbacks` (
	`provider_event_id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`event` text NOT NULL,
	`provider_message_id` text,
	`received_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_event_deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_notification_delivery_callbacks`("provider_event_id", "delivery_id", "event", "provider_message_id", "received_at") SELECT "provider_event_id", "delivery_id", "event", "provider_message_id", "received_at" FROM `notification_delivery_callbacks`;--> statement-breakpoint
DROP TABLE `notification_delivery_callbacks`;--> statement-breakpoint
ALTER TABLE `__new_notification_delivery_callbacks` RENAME TO `notification_delivery_callbacks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notification_delivery_callbacks_delivery_idx` ON `notification_delivery_callbacks` (`delivery_id`);