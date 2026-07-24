CREATE TABLE `golden_media_eval_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`agent_id` text NOT NULL,
	`case_id` text NOT NULL,
	`candidate_role` text NOT NULL,
	`candidate_key` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`strategy_revision` integer NOT NULL,
	`request_kind` text NOT NULL,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`remote_task_id` text,
	`result` text,
	`artifact_urls` text DEFAULT '[]',
	`poll_attempts` integer DEFAULT 0 NOT NULL,
	`max_poll_attempts` integer DEFAULT 240 NOT NULL,
	`available_at` integer DEFAULT (unixepoch()) NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`submitted_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "golden_media_eval_jobs_status_check" CHECK("golden_media_eval_jobs"."status" IN ('pending', 'submitting', 'submitted', 'polling', 'succeeded', 'failed', 'submission_uncertain')),
	CONSTRAINT "golden_media_eval_jobs_poll_attempts_check" CHECK("golden_media_eval_jobs"."poll_attempts" >= 0),
	CONSTRAINT "golden_media_eval_jobs_max_poll_attempts_check" CHECK("golden_media_eval_jobs"."max_poll_attempts" > 0),
	CONSTRAINT "golden_media_eval_jobs_active_lease_check" CHECK("golden_media_eval_jobs"."status" NOT IN ('submitting', 'polling') OR ("golden_media_eval_jobs"."lease_owner" IS NOT NULL AND "golden_media_eval_jobs"."lease_token" IS NOT NULL AND "golden_media_eval_jobs"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "golden_media_eval_jobs_remote_task_check" CHECK("golden_media_eval_jobs"."status" NOT IN ('submitted', 'polling', 'succeeded') OR "golden_media_eval_jobs"."remote_task_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `golden_media_eval_jobs_idempotency_unique` ON `golden_media_eval_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `golden_media_eval_jobs_status_available_idx` ON `golden_media_eval_jobs` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `golden_media_eval_jobs_status_lease_idx` ON `golden_media_eval_jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `golden_media_eval_jobs_case_candidate_idx` ON `golden_media_eval_jobs` (`case_id`,`candidate_key`,`created_at`);