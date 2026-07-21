CREATE TABLE `annotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chapter_id` integer NOT NULL,
	`position` integer NOT NULL,
	`original_span` text NOT NULL,
	`expanded_text` text NOT NULL,
	`collapsed` integer DEFAULT 1 NOT NULL,
	`agent_generated` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`format` text NOT NULL,
	`source_path` text NOT NULL,
	`cover_path` text,
	`imported_at` text NOT NULL,
	`last_opened_at` text,
	`progress` real DEFAULT 0 NOT NULL,
	`collection` text DEFAULT '' NOT NULL,
	`trashed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`title` text NOT NULL,
	`index` integer NOT NULL,
	`raw_text` text NOT NULL,
	`agent_expanded_text` text,
	`agent_expanded_at` text,
	`scroll_position` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `drawings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chapter_id` integer NOT NULL,
	`stroke_data` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chapter_id` integer NOT NULL,
	`position` integer,
	`highlighted_span` text,
	`note_text` text DEFAULT '' NOT NULL,
	`color` text DEFAULT 'default' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
