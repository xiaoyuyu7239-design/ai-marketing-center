CREATE TABLE `video_retros` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`diagnosis_id` text,
	`style` text,
	`platform` text,
	`predicted` text,
	`actual` text,
	`actual_basis` text,
	`highlights` text DEFAULT '[]',
	`issues` text DEFAULT '[]',
	`next_actions` text DEFAULT '[]',
	`summary` text,
	`source` text DEFAULT 'llm' NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
