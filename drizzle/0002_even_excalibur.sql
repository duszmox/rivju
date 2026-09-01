PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_finding_event` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `finding`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_finding_event`("id", "finding_id", "run_id", "type", "payload", "created_at") SELECT "id", "finding_id", "run_id", "type", "payload", "created_at" FROM `finding_event`;--> statement-breakpoint
DROP TABLE `finding_event`;--> statement-breakpoint
ALTER TABLE `__new_finding_event` RENAME TO `finding_event`;--> statement-breakpoint
PRAGMA foreign_keys=ON;