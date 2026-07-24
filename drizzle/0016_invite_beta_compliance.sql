CREATE TABLE `legal_consent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_id` text NOT NULL,
	`terms_version` text NOT NULL,
	`privacy_version` text NOT NULL,
	`ai_notice_version` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
UPDATE `publish_metrics`
SET `published_at` = (
	SELECT `publish_records`.`published_at`
	FROM `publish_records`
	WHERE `publish_records`.`project_id` = `publish_metrics`.`project_id`
)
WHERE `published_at` IS NULL
	AND `views` > 0
	AND EXISTS (
		SELECT 1 FROM `publish_records`
		WHERE `publish_records`.`project_id` = `publish_metrics`.`project_id`
			AND `publish_records`.`published_at` IS NOT NULL
	);
--> statement-breakpoint
DELETE FROM `publish_metrics` WHERE `note` = 'manual_published_marker';
--> statement-breakpoint
UPDATE `publish_metrics`
SET `platform` = COALESCE(
	NULLIF(TRIM(`platform`), ''),
	(SELECT NULLIF(TRIM(`publish_records`.`platform`), '') FROM `publish_records` WHERE `publish_records`.`project_id` = `publish_metrics`.`project_id`),
	'douyin'
);
--> statement-breakpoint
-- 邀请内测把回流定义为“每项目 × 平台一条当前快照”；历史重复行保留最后写入的一条。
DELETE FROM `publish_metrics`
WHERE rowid NOT IN (
	SELECT MAX(rowid) FROM `publish_metrics` GROUP BY `project_id`, `platform`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_metrics_project_platform_unique` ON `publish_metrics` (`project_id`,`platform`);
