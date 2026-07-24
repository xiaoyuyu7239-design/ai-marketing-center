ALTER TABLE `assets` ADD `license_url` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `attribution_text` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `requires_attribution` integer;--> statement-breakpoint
ALTER TABLE `compositions` ADD `aigc_disclosure` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `compositions` ADD `credits` text DEFAULT '[]';