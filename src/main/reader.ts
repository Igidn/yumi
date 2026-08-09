import { and, asc, eq, isNull } from "drizzle-orm";
import fs from "fs";
import path from "path";

import type {
  ContentBlock,
  ReaderChapter,
  ReaderPayload,
} from "../shared/types";
import { getDb } from "./database";
import { books, chapters } from "./db/schema";
import { parseEpub } from "./epub";
import { bookForRenderer, coverUrlForRenderer } from "./import";
import { getCoversDir } from "./paths";
import { fetchWebnovelChapterBlocks } from "./webnovel";

/** Per-book parse lock so two concurrent reader:load calls don't both insert. */
const parseLocks = new Map<number, ReturnType<typeof doParseEpub>>();

/** doParseEpub under the per-book lock, shared by first-parse and self-heal. */
function parseWithLock(
  bookId: number,
  sourcePath: string,
  scrollByTitle?: Map<string, number>,
) {
  const inflight = parseLocks.get(bookId);
  if (inflight) return inflight;
  const promise = doParseEpub(bookId, sourcePath, scrollByTitle);
  parseLocks.set(bookId, promise);
  return promise.finally(() => parseLocks.delete(bookId));
}

function blocksFromRaw(rawText: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(rawText);
    // v2 (current): { v: 2, blocks: [...] }. v1 (pre-styling): bare array.
    if (Array.isArray(parsed)) return parsed as ContentBlock[];
    if (parsed && Array.isArray(parsed.blocks))
      return parsed.blocks as ContentBlock[];
    return [];
  } catch {
    // ponytail: a corrupt raw_text row reads as an empty chapter rather than
    // failing the whole book; re-import restores it.
    return [];
  }
}

/** True when rawText was written by the current parser (v2 wrapper). */
function rawIsCurrentFormat(rawText: string): boolean {
  try {
    const parsed = JSON.parse(rawText);
    return (
      !!parsed && typeof parsed === "object" && Array.isArray(parsed.blocks)
    );
  } catch {
    return false;
  }
}

/** Read the stylesheet manifest written by parseEpub, if present. */
function stylesheetsForBook(bookId: number): string[] {
  try {
    const raw = fs.readFileSync(
      path.join(getCoversDir(), String(bookId), "stylesheets.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Parse EPUB into chapter rows and insert them. Factored out so the lock can reuse it. */
async function doParseEpub(
  bookId: number,
  sourcePath: string,
  scrollByTitle?: Map<string, number>,
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
 * Self-heal: if a cached book has every chapter twice (the old
 * spine-based parser inserted two identical batches), re-parse once and
 * re-attach each chapter's scrollPosition by title (taking the max across
 * the duplicates) so the reader's in-chapter position survives the
 * migration. Per-chapter ids change — annotations/notes/drawings on those
 * old chapter rows are dropped by the cascade; their data was already on
 * the wrong chapter. The check is the full 2x signature, not any
 * consecutive duplicate title: GEB's own TOC lists "CHAPTER VIII" twice,
 * and re-parsing on that would churn chapter ids on every open, making
 * lastChapterId stale and resume always fall back to scalar progress.
 *
 * v1→v2 migration: chapters parsed before the styling parser stored a bare
 * block array. Such books are re-parsed once (same scroll-position
 * preservation) so inline styling and book stylesheets are extracted.
 */
async function ensureChapters(
  bookId: number,
  format: string,
  sourcePath: string,
) {
  const db = await getDb();
  const existing = await db
    .select()
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.index));

  if (existing.length > 0) {
    // True duplication signature: even count, every adjacent pair equal
    // (rows come interleaved: batch1[0], batch2[0], batch1[1], batch2[1]…).
    const looksBuggy =
      existing.length % 2 === 0 &&
      existing.every(
        (c, i) => i % 2 === 0 || c.title === existing[i - 1].title,
      );
    if (format !== "epub") return existing;
    // Books parsed before the styling parser stored a bare block array with
    // no class/style markup and no extracted stylesheets; re-parse them once
    // so styling + book CSS land on next open.
    const oldFormat = !rawIsCurrentFormat(existing[0].rawText);
    if (!looksBuggy && !oldFormat) return existing;

    // Re-parse (self-heal or v1→v2 migration): delete and re-insert, then
    // re-attach each chapter's scrollPosition by title (taking the max
    // across the duplicates) so the reader's in-chapter position survives
    // the migration. Per-chapter ids change — annotations/notes/drawings on
    // those old chapter rows are dropped by the cascade; their data was
    // already on the wrong chapter.
    const scrollByTitle = new Map<string, number>();
    for (const c of existing) {
      if (c.scrollPosition > (scrollByTitle.get(c.title) ?? 0)) {
        scrollByTitle.set(c.title, c.scrollPosition);
      }
    }
    try {
      await db.delete(chapters).where(eq(chapters.bookId, bookId));
      return parseWithLock(bookId, sourcePath, scrollByTitle);
    } catch (err) {
      console.error("[reader] self-heal parse failed:", err);
      return existing;
    }
  }

  if (format !== "epub") return existing;
  return parseWithLock(bookId, sourcePath);
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

  // Prepend the book cover as the first image in chapter zero. Skipped for
  // uncached webnovel chapters: their text is fetched lazily on first read
  // (loadReaderChapter prepends the cover then), and a cover-only block
  // list would mask the "not fetched yet" state the renderer keys its fetch
  // on — leaving chapter 0's text unreachable.
  const coverUrl = coverUrlForRenderer(book.coverPath);
  if (coverUrl && readerChapters.length > 0) {
    const first = readerChapters[0];
    const lazilyFetched =
      book.format === "webnovel" && first.blocks.length === 0;
    if (!lazilyFetched) {
      // Strip yumi://asset/ to get the relative path the renderer expects.
      const rel = coverUrl.replace(/^yumi:\/\/asset\//, "");
      first.blocks.unshift({
        type: "image",
        text: "Cover",
        src: rel,
      });
    }
  }

  // Resume: find the chapter matching the stored lastChapterId.
  // Fall back to scalar progress when lastChapterId is missing (legacy data).
  const resumeChapterPos = (() => {
    if (readerChapters.length === 0) return 0;
    if (book.lastChapterId != null) {
      const idx = readerChapters.findIndex(
        (ch) => ch.id === book.lastChapterId,
      );
      if (idx >= 0) return idx;
    }
    // Legacy: scalar progress fallback.
    return Math.min(
      Math.floor(book.progress * readerChapters.length),
      readerChapters.length - 1,
    );
  })();

  return {
    book: bookForRenderer(book),
    chapters: readerChapters,
    resumeChapterPos,
    stylesheets: stylesheetsForBook(book.id),
  };
}

/**
 * Load a single chapter for rendering, fetching + caching webnovel chapter
 * text on first read. EPUBs and already-cached webnovel chapters return
 * instantly; an uncached webnovel chapter triggers a network round-trip and
 * the result is stored in `chapters.rawText` so the next visit is instant.
 */
export async function loadReaderChapter(
  bookId: number,
  chapterId: number,
): Promise<ReaderChapter> {
  const db = await getDb();
  const book = (
    await db.select().from(books).where(eq(books.id, bookId)).limit(1)
  )[0];
  if (!book || book.trashed) throw new Error(`Book not found: ${bookId}`);
  const row = (
    await db
      .select()
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.bookId, bookId)))
      .limit(1)
  )[0];
  if (!row) throw new Error(`Chapter not found: ${chapterId}`);

  let blocks = blocksFromRaw(row.rawText);
  if (book.format === "webnovel" && blocks.length === 0 && row.sourceUrl) {
    blocks = await fetchWebnovelChapterBlocks(row.sourceUrl);
    // Cache the fetched text; a failed fetch leaves rawText empty so the
    // next open retries rather than showing a permanently blank chapter.
    await db
      .update(chapters)
      .set({ rawText: JSON.stringify(blocks) })
      .where(eq(chapters.id, chapterId));
  }

  const readerChapter: ReaderChapter = {
    id: row.id,
    title: row.title,
    index: row.index,
    scrollPosition: row.scrollPosition,
    blocks,
  };

  // Chapter 0 leads with the cover image, mirroring loadReaderBook.
  // The cover is prepended at read time, never persisted into rawText.
  if (readerChapter.index === 0) {
    const coverUrl = coverUrlForRenderer(book.coverPath);
    if (coverUrl) {
      const rel = coverUrl.replace(/^yumi:\/\/asset\//, "");
      readerChapter.blocks = [
        { type: "image", text: "Cover", src: rel },
        ...readerChapter.blocks,
      ];
    }
  }
  return readerChapter;
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
      .set({ progress: bookProgress, lastChapterId: payload.chapterId })
      .where(eq(books.id, payload.bookId));
    if (bookProgress >= 1) {
      // Stamp the finish date once per finish cycle; "still reading" clears
      // it (via books:update), so re-finishing after that counts again.
      await db
        .update(books)
        .set({ finishedAt: new Date().toISOString() })
        .where(and(eq(books.id, payload.bookId), isNull(books.finishedAt)));
    }
  } catch (err) {
    // ponytail: single-statement writes, no transaction needed; a crash
    // between the two writes leaves progress partially saved, but the
    // re-save on the next page turn will overwrite the stale value.
    console.error("[reader] progress save failed:", err);
  }
}
