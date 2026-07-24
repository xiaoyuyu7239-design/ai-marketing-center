CREATE TABLE `generation_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`success` integer NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `merchant_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `merchants` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`shop_name` text,
	`plan_id` text DEFAULT 'trial' NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchants_email_unique` ON `merchants` (`email`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`monthly_generation_quota` integer NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
ALTER TABLE `brand_settings` ADD `merchant_id` text REFERENCES merchants(id);--> statement-breakpoint
ALTER TABLE `products` ADD `merchant_id` text REFERENCES merchants(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `merchant_id` text REFERENCES merchants(id);