ALTER TABLE `jobs` ADD `request_hash` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `generation_usage_id` text REFERENCES generation_usage(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `paid_tts_used` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_generation_usage_unique` ON `jobs` (`generation_usage_id`);
--> statement-breakpoint
UPDATE `assets`
SET `type` = 'user_upload'
WHERE `provider` = 'local'
	AND `type` = 'stock_footage'
	AND (`source_url` IS NULL OR trim(`source_url`) = '');
