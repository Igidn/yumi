import { asc, eq } from "drizzle-orm";
import { getDb } from "./database";
import { books, chapters } from "./db/schema";
import { parseEpub } from "./epub";
import { bookForRenderer, coverUrlForRenderer } from "./import";
import type {
  ContentBlock,
  ReaderChapter,
  ReaderPayload,
} from "../shared/types";

/** Per-book parse lock so two concurrent reader:load calls don't both insert. */
const parseLocks = new Map<number, ReturnType<typeof doParseEpub>>();

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

/** Parse EPUB into chapter rows and insert them. Factored out so the lock can reuse it. */
async function doParseEpub(
  bookId: number,
  sourcePath: string,
  scrollByTitle?: Map<string, number>
) {
  const db = await getDb();
  const parsed = await parseEpub(sourcePath, bookId);
  for (const chapter of parsed.chapters) {
    await db.insert(chapters).values({
      bookId,
      title: chapter.title,
      index: chapter.index,
      rawText: chapter.rawText,
      scrollPosition: scrollByTitle?.get(chapter.title) ?? 0,
    });
  }
  return db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.index));
}

/**
 * Return the chapter rows for a book, parsing the EPUB into the chapters
 * table on first open. Chapters are cached in SQLite from then on, so the
 * zip walk happens exactly once per book (M1 stores blocks in rawText).
 *
 * Self-heal: if a cached book has consecutive chapters with identical
 * titles, the chapter list is suspect — re-parse once and re-attach each
 * chapter's scrollPosition by title (taking the max across the duplicates)
 * so the reader's in-chapter position survives the migration. Per-chapter
 * ids change — annotations/notes/drawings on those old chapter rows are
 * dropped by the cascade; their data was already on the wrong chapter.
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
    const looksBuggy = existing.some(
      (c, i) => i > 0 && c.title === existing[i - 1].title
    );
    if (!looksBuggy || format !== "epub") return existing;

    // Self-heal: delete duplicates and re-parse once.
    const scrollByTitle = new Map<string, number>();
    for (const c of existing) {
      if (c.scrollPosition > (scrollByTitle.get(c.title) ?? 0)) {
        scrollByTitle.set(c.title, c.scrollPosition);
      }
    }
    try {
      await db.delete(chapters).where(eq(chapters.bookId, bookId));
      return doParseEpub(bookId, sourcePath, scrollByTitle);
    } catch (err) {
      console.error("[reader] self-heal parse failed:", err);
      return existing;
    }
  }

  if (format !== "epub") return existing;

  // ponytail: per-book lock prevents duplicate inserts when two reader
  // windows open the same uncached book before the first parse finishes.
  const inflight = parseLocks.get(bookId);
  if (inflight) return inflight;
  const promise = doParseEpub(bookId, sourcePath);
  parseLocks.set(bookId, promise);
  try {
    return await promise;
  } finally {
    parseLocks.delete(bookId);
  }
}

/**
 * Load everything the reader window needs in one shot: the book (with a
 * renderer-usable cover URL), its chapters with parsed blocks, and the
 * chapter position to resume at.
 *
 * Throws when the book is missing or trashed.
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

  // Prepend the book cover as the first image in chapter zero.
  const coverUrl = coverUrlForRenderer(book.coverPath);
  if (coverUrl && readerChapters.length > 0) {
    // Strip yumi://asset/ to get the relative path the renderer expects.
    const rel = coverUrl.replace(/^yumi:\/\/asset\//, "");
    readerChapters[0].blocks.unshift({
      type: "image",
      text: "Cover",
      src: rel,
    });
  }

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
  try {
    await db
      .update(chapters)
      .set({ scrollPosition: chapterPosition })
      .where(eq(chapters.id, payload.chapterId));
    await db
      .update(books)
      .set({ progress: bookProgress })
      .where(eq(books.id, payload.bookId));
  } catch (err) {
    // ponytail: single-statement writes, no transaction needed; a crash
    // between the two writes leaves progress partially saved, but the
    // re-save on the next page turn will overwrite the stale value.
    console.error("[reader] progress save failed:", err);
  }
}
