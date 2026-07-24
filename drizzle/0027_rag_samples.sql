CREATE TABLE `rag_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`industry` text,
	`category` text,
	`scene` text,
	`platform` text,
	`style_type` text,
	`video_mode` text,
	`store_type` text,
	`structure` text,
	`expression` text,
	`search_text` text NOT NULL,
	`embedding` text,
	`embedding_model` text,
	`source` text NOT NULL,
	`seed_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `rag_samples_source_seed_idx` ON `rag_samples` (`source`,`seed_version`);--> statement-breakpoint
CREATE INDEX `rag_samples_category_store_idx` ON `rag_samples` (`category`,`store_type`);