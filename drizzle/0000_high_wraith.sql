CREATE TABLE `finding` (
	`id` text PRIMARY KEY NOT NULL,
	`merge_request_id` text NOT NULL,
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
	FOREIGN KEY (`merge_request_id`) REFERENCES `merge_request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lifecycle_run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_mr_fingerprint_uq` ON `finding` (`merge_request_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `finding_event` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `finding`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gitlab_instance` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`base_url` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_scopes` text DEFAULT '[]' NOT NULL,
	`gitlab_version` text,
	`user_id` text,
	`username` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `merge_request` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`iid` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`author` text,
	`source_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	`state` text NOT NULL,
	`web_url` text NOT NULL,
	`updated_at` integer,
	`last_seen_head_sha` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merge_request_project_iid_uq` ON `merge_request` (`project_id`,`iid`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`gitlab_project_id` text NOT NULL,
	`path_with_namespace` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text,
	`mirror_path` text,
	`reference_clone_path` text,
	`model_override` text,
	`effort_override` text,
	FOREIGN KEY (`instance_id`) REFERENCES `gitlab_instance`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_gitlab_uq` ON `project` (`instance_id`,`gitlab_project_id`);--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`merge_request_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`base_sha` text,
	`head_sha` text,
	`model` text,
	`effort` text,
	`enabled_skills` text,
	`worktree_path` text,
	`log_path` text,
	`usage` text,
	`error` text,
	`started_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`merge_request_id`) REFERENCES `merge_request`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`dir_path` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_scope_name_uq` ON `skill` (`scope`,`project_id`,`name`);