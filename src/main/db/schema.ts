import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const books = sqliteTable("books", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  author: text("author").notNull().default(""),
  format: text("format").$type<"epub">().notNull(),
  sourcePath: text("source_path").notNull(),
  // SHA-256 of the imported file content; the dedup key (SPEC §1).
  sha256: text("sha256"),
  coverPath: text("cover_path"),
  importedAt: text("imported_at").notNull(),
  lastOpenedAt: text("last_opened_at"),
  progress: real("progress").notNull().default(0), // 0–1 fraction
  // Progress before a manual "mark finished"; restored by "still reading".
  priorProgress: real("prior_progress"),
  collection: text("collection").notNull().default(""),
  trashed: integer("trashed").notNull().default(0), // boolean
});

export const chapters = sqliteTable("chapters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookId: integer("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  index: integer("index").notNull(), // order within the book
  rawText: text("raw_text").notNull(), // OCR output
  agentExpandedText: text("agent_expanded_text"), // after agent pre-expansion
  agentExpandedAt: text("agent_expanded_at"),
  scrollPosition: real("scroll_position").notNull().default(0),
});

export const annotations = sqliteTable("annotations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chapterId: integer("chapter_id")
    .notNull()
    .references(() => chapters.id, { onDelete: "cascade" }),
  position: integer("position").notNull(), // char offset in rawText
  originalSpan: text("original_span").notNull(),
  expandedText: text("expanded_text").notNull(),
  collapsed: integer("collapsed").notNull().default(1), // boolean
  agentGenerated: integer("agent_generated").notNull().default(1),
  createdAt: text("created_at").notNull(),
});

export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chapterId: integer("chapter_id")
    .notNull()
    .references(() => chapters.id, { onDelete: "cascade" }),
  position: integer("position"), // char offset, null for chapter-level notes
  highlightedSpan: text("highlighted_span"),
  noteText: text("note_text").notNull().default(""),
  color: text("color").notNull().default("default"),
  createdAt: text("created_at").notNull(),
});

export const drawings = sqliteTable("drawings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chapterId: integer("chapter_id")
    .notNull()
    .references(() => chapters.id, { onDelete: "cascade" }),
  strokeData: text("stroke_data").notNull(), // JSON-serialized rough.js strokes
  updatedAt: text("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
