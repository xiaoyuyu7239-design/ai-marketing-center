CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`merchant_id` text NOT NULL,
	`project_id` text,
	`composition_id` text,
	`idempotency_key` text NOT NULL,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`available_at` integer DEFAULT (unixepoch()) NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`locked_at` integer,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`composition_id`) REFERENCES `compositions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_attempts_check" CHECK("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_check" CHECK("jobs"."max_attempts" > 0),
	CONSTRAINT "jobs_running_lease_check" CHECK("jobs"."status" <> 'running' OR ("jobs"."lease_owner" IS NOT NULL AND "jobs"."lease_token" IS NOT NULL AND "jobs"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_merchant_type_idempotency_unique` ON `jobs` (`merchant_id`,`type`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_composition_unique` ON `jobs` (`composition_id`);--> statement-breakpoint
CREATE INDEX `jobs_status_available_created_idx` ON `jobs` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_status_lease_idx` ON `jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_merchant_status_idx` ON `jobs` (`merchant_id`,`status`);--> statement-breakpoint
CREATE INDEX `jobs_project_status_idx` ON `jobs` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `compositions_project_created_idx` ON `compositions` (`project_id`,`created_at`);