CREATE TABLE `content_diagnosis` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`script_id` text,
	`style` text,
	`platform` text,
	`overall_score` integer NOT NULL,
	`dimensions` text DEFAULT '[]',
	`summary` text,
	`suggestions` text DEFAULT '[]',
	`prediction` text,
	`prediction_confidence` text,
	`prediction_basis` text,
	`source` text DEFAULT 'llm' NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
