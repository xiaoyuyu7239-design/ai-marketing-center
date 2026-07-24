CREATE TABLE `publish_records` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`approved_at` integer,
	`published_at` integer,
	`platform` text,
	`review_status` text DEFAULT 'approved' NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_records_project_id_unique` ON `publish_records` (`project_id`);--> statement-breakpoint
ALTER TABLE `merchants` ADD `category` text;--> statement-breakpoint
ALTER TABLE `merchants` ADD `region` text;--> statement-breakpoint
ALTER TABLE `merchants` ADD `target_audience` text;--> statement-breakpoint
ALTER TABLE `merchants` ADD `price_range` text;--> statement-breakpoint
ALTER TABLE `merchants` ADD `platforms` text;