ALTER TABLE `generation_operation_items` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `generation_operation_items` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `generation_usage` ADD `project_id` text;