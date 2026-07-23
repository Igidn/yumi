import { asc, eq } from "drizzle-orm";
import { getDb } from "./database";
import { books, chapters } from "./db/schema";
import { parseEpub } from "./epub";
import { bookForRenderer } from "./import";
import type {
  ContentBlock,
  ReaderChapter,
  ReaderPayload,
} from "../shared/types";

function blocksFromRaw(rawText: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? (parsed as ContentBlock[]) : [];
  } catch {
    // ponytail: a corrupt raw_text row reads as an empty chapter rather than
    // failing the whole book; re-import restores it.
    return [];
  }
}

/**
 * Return the chapter rows for a book, parsing the EPUB into the chapters
 * table on first open. Chapters are cached in SQLite from then on, so the
 * zip walk happens exactly once per book (M1 stores blocks in rawText).
 *
 * Self-heal: if a cached book has the same title appearing 2+ times, the
 * chapter list is suspect — re-parse once and re-attach each chapter's
 * scrollPosition by title (taking the max across the duplicates) so the
 * reader's in-chapter position survives the migration. Per-chapter ids
 * change — annotations/notes/drawings on those old chapter rows are
 * dropped by the cascade; their data was already on the wrong chapter.
 * Threshold is 2, not 3: a buggy parse can produce exact 2x duplication
 * (one row per logical chapter, twice) and a higher floor would miss it.
 */
async function ensureChapters(
  bookId: number,
  format: string,
  sourcePath: string
) {
  const db = await getDb();
  const existing = await db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.index));

  if (existing.length > 0) {
    const titleCounts = new Map<string, number>();
    for (const c of existing) titleCounts.set(c.title, (titleCounts.get(c.title) ?? 0) + 1);
    const looksBuggy = [...titleCounts.values()].some((n) => n >= 2);
    if (!looksBuggy || format !== "epub") return existing;

    // Parse first; only mutate the table once we know the new chapter list
    // is ready — a failure mid-parse must not leave the book empty.
    const parsed = await parseEpub(sourcePath);
    const scrollByTitle = new Map<string, number>();
    for (const c of existing) {
      if (c.scrollPosition > (scrollByTitle.get(c.title) ?? 0)) {
        scrollByTitle.set(c.title, c.scrollPosition);
      }
    }
    await db.delete(chapters).where(eq(chapters.bookId, bookId));
    for (const chapter of parsed.chapters) {
      await db.insert(chapters).values({
        bookId,
        title: chapter.title,
        index: chapter.index,
        rawText: chapter.rawText,
        scrollPosition: scrollByTitle.get(chapter.title) ?? 0,
      });
    }
    return db
      .select()
      .from(chapters)
      .where(eq(chapters.bookId, bookId))
      .orderBy(asc(chapters.index));
  }

  if (format !== "epub") return existing;

  const parsed = await parseEpub(sourcePath);
  for (const chapter of parsed.chapters) {
    await db.insert(chapters).values({
      bookId,
      title: chapter.title,
      index: chapter.index,
      rawText: chapter.rawText,
    });
  }
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.index));
}

/**
 * Load everything the reader window needs in one shot: the book (with a
 * renderer-usable cover URL), its chapters with parsed blocks, and the
 * chapter position to resume at.
 *
 * Throws when the book is missing or trashed. PDF books load with zero
 * chapters — the renderer shows the "PDF arrives in M2" placeholder.
 */
export async function loadReaderBook(bookId: number): Promise<ReaderPayload> {
  const db = await getDb();
  const book = (
    await db.select().from(books).where(eq(books.id, bookId)).limit(1)
  )[0];
  if (!book || book.trashed) throw new Error(`Book not found: ${bookId}`);

  const rows = await ensureChapters(book.id, book.format, book.sourcePath);
  const readerChapters: ReaderChapter[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    index: row.index,
    scrollPosition: row.scrollPosition,
    blocks: blocksFromRaw(row.rawText),
  }));

  // books.progress is the whole-book fraction written by saveReaderProgress:
  // (chapterPos + chapterFraction) / chapterCount, so floor(progress * count)
  // recovers the chapter the reader was on.
  const resumeChapterPos =
    readerChapters.length === 0
      ? 0
      : Math.min(
          Math.floor(book.progress * readerChapters.length),
          readerChapters.length - 1
        );

  return {
    book: bookForRenderer(book),
    chapters: readerChapters,
    resumeChapterPos,
  };
}

/** Persist reading position: per-chapter fraction plus whole-book fraction. */
export async function saveReaderProgress(payload: {
  bookId: number;
  chapterId: number;
  chapterPosition: number;
  bookProgress: number;
}): Promise<void> {
  const db = await getDb();
  const chapterPosition = Math.min(1, Math.max(0, payload.chapterPosition));
  const bookProgress = Math.min(1, Math.max(0, payload.bookProgress));
  await db
    .update(chapters)
    .set({ scrollPosition: chapterPosition })
    .where(eq(chapters.id, payload.chapterId));
  await db
    .update(books)
    .set({ progress: bookProgress })
    .where(eq(books.id, payload.bookId));
}
