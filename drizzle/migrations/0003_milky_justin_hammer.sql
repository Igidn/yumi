CREATE TABLE `reading_activity` (
	`date` text PRIMARY KEY NOT NULL,
	`seconds` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `books` ADD `finished_at` text;