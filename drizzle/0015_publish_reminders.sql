CREATE TABLE `reminder_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`plan_date` text NOT NULL,
	`window_key` text NOT NULL,
	`channel` text DEFAULT 'wechat' NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`created_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wechat_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`open_id` text NOT NULL,
	`remark` text,
	`created_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wechat_bindings_open_id_unique` ON `wechat_bindings` (`open_id`);--> statement-breakpoint
ALTER TABLE `merchants` ADD `daily_publish_target` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `merchants` ADD `publish_reminder_enabled` integer DEFAULT true NOT NULL;