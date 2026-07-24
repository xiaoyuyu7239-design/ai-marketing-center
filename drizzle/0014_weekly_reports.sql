CREATE TABLE `weekly_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`period_start` integer,
	`period_end` integer,
	`stats` text,
	`highlights` text DEFAULT '[]',
	`watchouts` text DEFAULT '[]',
	`next_actions` text DEFAULT '[]',
	`summary` text,
	`source` text DEFAULT 'llm' NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade
);
