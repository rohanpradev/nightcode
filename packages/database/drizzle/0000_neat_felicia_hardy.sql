CREATE TABLE `code_symbols` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`file` text NOT NULL,
	`startLine` integer NOT NULL,
	`endLine` integer NOT NULL,
	`parent` text,
	`signature` text,
	`fileIndexId` text,
	FOREIGN KEY (`fileIndexId`) REFERENCES `file_index`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `code_symbols_name_idx` ON `code_symbols` (`name`);--> statement-breakpoint
CREATE INDEX `code_symbols_kind_idx` ON `code_symbols` (`kind`);--> statement-breakpoint
CREATE INDEX `code_symbols_file_idx` ON `code_symbols` (`file`);--> statement-breakpoint
CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`filePath` text NOT NULL,
	`chunk` text NOT NULL,
	`vector` blob NOT NULL,
	`startLine` integer NOT NULL,
	`endLine` integer NOT NULL,
	`model` text DEFAULT 'text-embedding-3-small' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embeddings_filePath_idx` ON `embeddings` (`filePath`);--> statement-breakpoint
CREATE TABLE `file_index` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`hash` text NOT NULL,
	`language` text DEFAULT 'unknown' NOT NULL,
	`symbolCount` integer DEFAULT 0 NOT NULL,
	`lastIndexed` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_index_path_unique` ON `file_index` (`path`);--> statement-breakpoint
CREATE INDEX `file_index_path_idx` ON `file_index` (`path`);--> statement-breakpoint
CREATE INDEX `file_index_language_idx` ON `file_index` (`language`);--> statement-breakpoint
CREATE TABLE `git_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`sessionId` text NOT NULL,
	`message` text NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `git_commits_sessionId_idx` ON `git_commits` (`sessionId`);--> statement-breakpoint
CREATE INDEX `git_commits_hash_idx` ON `git_commits` (`hash`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text DEFAULT 'local' NOT NULL,
	`createdAt` integer NOT NULL,
	`title` text NOT NULL,
	`updatedAt` integer NOT NULL,
	`messages` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_userId_idx` ON `sessions` (`userId`);--> statement-breakpoint
CREATE INDEX `sessions_createdAt_idx` ON `sessions` (`createdAt`);--> statement-breakpoint
CREATE TABLE `tool_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`toolName` text NOT NULL,
	`result` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_cache_key_unique` ON `tool_cache` (`key`);--> statement-breakpoint
CREATE INDEX `tool_cache_key_idx` ON `tool_cache` (`key`);--> statement-breakpoint
CREATE INDEX `tool_cache_toolName_idx` ON `tool_cache` (`toolName`);--> statement-breakpoint
CREATE INDEX `tool_cache_expiresAt_idx` ON `tool_cache` (`expiresAt`);