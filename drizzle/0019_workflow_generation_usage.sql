CREATE TABLE `generation_operation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`usage_id` text NOT NULL,
	`item_key` text NOT NULL,
	`agent_id` text NOT NULL,
	`request_hash` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`failure_code` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`usage_id`) REFERENCES `generation_usage`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "generation_operation_items_status_check" CHECK("generation_operation_items"."status" IN ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "generation_operation_items_attempts_check" CHECK("generation_operation_items"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generation_operation_items_usage_item_unique` ON `generation_operation_items` (`usage_id`,`item_key`);--> statement-breakpoint
CREATE INDEX `generation_operation_items_usage_status_idx` ON `generation_operation_items` (`usage_id`,`status`);--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `operation_key` text;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `operation_type` text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `request_hash` text;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `manifest_hash` text;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `status` text DEFAULT 'succeeded' NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `expected_items` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `completed_items` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `succeeded_items` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `failed_items` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `updated_at` integer;--> statement-breakpoint
UPDATE `generation_usage`
SET `status` = CASE WHEN `success` = 1 THEN 'succeeded' ELSE 'failed' END,
	`completed_items` = 1,
	`succeeded_items` = CASE WHEN `success` = 1 THEN 1 ELSE 0 END,
	`failed_items` = CASE WHEN `success` = 1 THEN 0 ELSE 1 END,
	`updated_at` = COALESCE(`created_at`, unixepoch())
WHERE `operation_key` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `generation_usage_merchant_type_operation_key_unique` ON `generation_usage` (`merchant_id`,`operation_type`,`operation_key`);--> statement-breakpoint
CREATE INDEX `generation_usage_merchant_status_created_idx` ON `generation_usage` (`merchant_id`,`status`,`created_at`);
