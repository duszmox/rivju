PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_finding` (
	`id` text PRIMARY KEY NOT NULL,
	`merge_request_id` text,
	`fingerprint` text NOT NULL,
	`scope` text NOT NULL,
	`file_path` text,
	`anchor_snippet` text,
	`ctx_before` text,
	`ctx_after` text,
	`current_line` integer,
	`category` text,
	`severity` text,
	`title` text NOT NULL,
	`body` text,
	`suggested_fix` text,
	`created_run_id` text,
	`first_seen_head_sha` text,
	`triage` text DEFAULT 'untriaged' NOT NULL,
	`triage_note` text,
	`lifecycle` text DEFAULT 'open' NOT NULL,
	`lifecycle_run_id` text,
	FOREIGN KEY (`merge_request_id`) REFERENCES `merge_request`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lifecycle_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_finding`("id", "merge_request_id", "fingerprint", "scope", "file_path", "anchor_snippet", "ctx_before", "ctx_after", "current_line", "category", "severity", "title", "body", "suggested_fix", "created_run_id", "first_seen_head_sha", "triage", "triage_note", "lifecycle", "lifecycle_run_id") SELECT "id", "merge_request_id", "fingerprint", "scope", "file_path", "anchor_snippet", "ctx_before", "ctx_after", "current_line", "category", "severity", "title", "body", "suggested_fix", "created_run_id", "first_seen_head_sha", "triage", "triage_note", "lifecycle", "lifecycle_run_id" FROM `finding`;--> statement-breakpoint
DROP TABLE `finding`;--> statement-breakpoint
ALTER TABLE `__new_finding` RENAME TO `finding`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `finding_mr_fingerprint_uq` ON `finding` (`merge_request_id`,`fingerprint`);