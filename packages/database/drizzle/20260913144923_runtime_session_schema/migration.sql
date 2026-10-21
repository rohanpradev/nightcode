CREATE TABLE `metadata` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`sessionId` text NOT NULL,
	`runId` text,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` integer NOT NULL,
	CONSTRAINT `run_events_runId_sequence_unique` UNIQUE(`runId`,`sequence`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `workspace` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `fileContext` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `run_events_session_idx` ON `run_events` (`sessionId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `sessions_workspace_idx` ON `sessions` (`workspace`);--> statement-breakpoint
CREATE INDEX `sessions_updatedAt_idx` ON `sessions` (`updatedAt`);