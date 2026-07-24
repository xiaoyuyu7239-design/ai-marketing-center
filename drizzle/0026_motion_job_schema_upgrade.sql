-- 0024 曾在开发库落过 output_asset_id 草案；迁移不改写旧历史，在此显式升级为独立 video_clips。
-- 对旧版已成功任务，先建立可追溯 clip，保留文件与 source asset 绑定。
INSERT OR IGNORE INTO `video_clips` (
	`id`, `project_id`, `shot_id`, `asset_id`, `file_path`, `duration`, `provider`, `model`, `transition_type`, `status`, `created_at`
)
SELECT
	'motion-migrated-' || `id`, `project_id`, `shot_id`, `source_asset_id`, `output_file_path`, NULL,
	'legacy-motion-migration', NULL, 'ai_reference', 'done', `created_at`
FROM `motion_video_jobs`
WHERE `status` = 'succeeded' AND `output_asset_id` IS NOT NULL AND `output_file_path` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_motion_video_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`project_id` text NOT NULL,
	`generation_usage_id` text,
	`generation_item_id` text,
	`operation_key` text NOT NULL,
	`item_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`shot_id` integer NOT NULL,
	`source_asset_id` text,
	`payload_version` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`remote_task_id` text,
	`result` text,
	`output_clip_id` text,
	`output_file_path` text,
	`progress` integer,
	`poll_attempts` integer DEFAULT 0 NOT NULL,
	`max_poll_attempts` integer DEFAULT 240 NOT NULL,
	`paid_capability_used` integer DEFAULT false NOT NULL,
	`available_at` integer DEFAULT (unixepoch()) NOT NULL,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`error_code` text,
	`error_category` text,
	`error_request_id` text,
	`error_message` text,
	`error_retryable` integer,
	`retry_after_seconds` integer,
	`suggested_action` text,
	`started_at` integer,
	`submitted_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`generation_usage_id`) REFERENCES `generation_usage`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`generation_item_id`) REFERENCES `generation_operation_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`output_clip_id`) REFERENCES `video_clips`(`id`) ON UPDATE no action ON DELETE restrict,
	-- 列名保持不带临时表限定，兼容旧版 SQLite 在 ALTER TABLE RENAME 时重写 CHECK 约束。
	CONSTRAINT "motion_video_jobs_status_check" CHECK("status" IN ('pending', 'submitting', 'submitted', 'polling', 'downloading', 'saving', 'succeeded', 'failed', 'submission_uncertain')),
	CONSTRAINT "motion_video_jobs_shot_id_check" CHECK("shot_id" >= 0),
	CONSTRAINT "motion_video_jobs_poll_attempts_check" CHECK("poll_attempts" >= 0),
	CONSTRAINT "motion_video_jobs_max_poll_attempts_check" CHECK("max_poll_attempts" > 0),
	CONSTRAINT "motion_video_jobs_progress_check" CHECK("progress" IS NULL OR ("progress" >= 0 AND "progress" <= 100)),
	CONSTRAINT "motion_video_jobs_active_lease_check" CHECK("status" NOT IN ('submitting', 'polling', 'downloading', 'saving') OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)),
	CONSTRAINT "motion_video_jobs_remote_task_check" CHECK("status" NOT IN ('submitted', 'polling', 'downloading', 'saving', 'succeeded') OR "remote_task_id" IS NOT NULL),
	CONSTRAINT "motion_video_jobs_succeeded_output_check" CHECK("status" <> 'succeeded' OR ("output_clip_id" IS NOT NULL AND "output_file_path" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_motion_video_jobs`("id", "merchant_id", "project_id", "generation_usage_id", "generation_item_id", "operation_key", "item_key", "request_hash", "shot_id", "source_asset_id", "payload_version", "payload", "status", "remote_task_id", "result", "output_clip_id", "output_file_path", "progress", "poll_attempts", "max_poll_attempts", "paid_capability_used", "available_at", "lease_owner", "lease_token", "lease_expires_at", "heartbeat_at", "error_code", "error_category", "error_request_id", "error_message", "error_retryable", "retry_after_seconds", "suggested_action", "started_at", "submitted_at", "finished_at", "created_at", "updated_at") SELECT "id", "merchant_id", "project_id", "generation_usage_id", "generation_item_id", "operation_key", "item_key", "request_hash", "shot_id", "source_asset_id", "payload_version", "payload", "status", "remote_task_id", "result", CASE WHEN "status" = 'succeeded' THEN 'motion-migrated-' || "id" ELSE NULL END, "output_file_path", "progress", "poll_attempts", "max_poll_attempts", "paid_capability_used", "available_at", "lease_owner", "lease_token", "lease_expires_at", "heartbeat_at", "error_code", "error_category", NULL, "error_message", "error_retryable", "retry_after_seconds", "suggested_action", "started_at", "submitted_at", "finished_at", "created_at", "updated_at" FROM `motion_video_jobs`;--> statement-breakpoint
DROP TABLE `motion_video_jobs`;--> statement-breakpoint
ALTER TABLE `__new_motion_video_jobs` RENAME TO `motion_video_jobs`;--> statement-breakpoint
CREATE UNIQUE INDEX `motion_video_jobs_merchant_operation_item_unique` ON `motion_video_jobs` (`merchant_id`,`operation_key`,`item_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `motion_video_jobs_generation_item_unique` ON `motion_video_jobs` (`generation_item_id`);--> statement-breakpoint
CREATE INDEX `motion_video_jobs_status_available_idx` ON `motion_video_jobs` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `motion_video_jobs_status_lease_idx` ON `motion_video_jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `motion_video_jobs_merchant_project_created_idx` ON `motion_video_jobs` (`merchant_id`,`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `motion_video_jobs_project_shot_created_idx` ON `motion_video_jobs` (`project_id`,`shot_id`,`created_at`);
