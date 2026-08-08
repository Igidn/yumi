import { createHash } from "crypto";
import { eq, inArray } from "drizzle-orm";
import fs from "fs";
import path from "path";

import type { Book, BookFormat, ImportOutcome } from "../shared/types";
import { getDb } from "./database";
import { books, chapters } from "./db/schema";
import { readEpubMeta } from "./epub";
import { getBooksDir, getCoversDir, getUserDataPath } from "./paths";

const SUPPORTED_EXTENSIONS: Record<string, BookFormat> = {
  ".epub": "epub",
};

/**
 * Rewrite a stored absolute cover path into a `yumi://asset/...` URL the
 * renderer can load via the custom protocol registered in `index.ts`.
 */
export function coverUrlForRenderer(coverPath: string | null): string | null {
  if (!coverPath) return null;
  const root = getUserDataPath();
  const rel = path.relative(root, coverPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return `yumi://asset/${rel.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export function bookForRenderer(book: Book): Book {
  return { ...book, coverPath: coverUrlForRenderer(book.coverPath) };
}

type BookRow = typeof books.$inferSelect;

/**
 * Attach webnovel reading position — the 1-based index and title of the
 * last-read chapter — to book rows headed for the renderer, resolved from
 * `books.lastChapterId`. Epub books (and webnovels never opened) pass
 * through untouched; the library UI falls back to "Chapter 1" for those.
 */
export async function withChapterInfo(rows: BookRow[]): Promise<BookRow[]> {
  const toLookup = rows.filter(
    (b) => b.format === "webnovel" && b.lastChapterId != null,
  );
  if (toLookup.length === 0) return rows;
  const db = await getDb();
  const ids = [...new Set(toLookup.map((b) => b.lastChapterId!))];
  const chapterRows = await db
    .select()
    .from(chapters)
    .where(inArray(chapters.id, ids));
  const chapterById = new Map(chapterRows.map((c) => [c.id, c]));
  return rows.map((b) => {
    if (b.format !== "webnovel" || b.lastChapterId == null) return b;
    const chapter = chapterById.get(b.lastChapterId);
    if (!chapter) return b;
    return {
      ...b,
      currentChapterIndex: chapter.index + 1,
      currentChapterTitle: chapter.title,
    };
  });
}

export function getFormatForFile(filePath: string): BookFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] ?? null;
}

/**
 * SHA-256 of a file's contents, streamed so large files don't load whole
 * into memory. The dedup key (SPEC §1).
 */
function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Pick a destination path inside `destDir` that does not collide with an
 * existing file. The basename is preserved; collisions get `-1`, `-2`, ...
 *
 * A name collision with a *different* hash is a different book that happens
 * to share a filename — keep both via the suffix. A same-hash collision is a
 * true duplicate and is handled by `importBook` before we get here.
 */
function uniqueDestination(destDir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(destDir, filename);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(destDir, `${base}-${n}${ext}`);
    n++;
  }
  return candidate;
}

/**
 * Copy `sourcePath` into `<userData>/books/` and insert a row in the books
 * table pointing at the copy. The original is never modified or moved.
 *
 * Duplicate detection (SPEC §1): the SHA-256 of the source is compared against
 * the `sha256` column of non-trashed books. On a match:
 *   - `duplicateHandling` omitted → return `{ status: "duplicate" }` so the
 *     renderer can prompt the user.
 *   - `"skip"`   → keep the existing book, import nothing.
 *   - `"replace"` → delete the existing book (cascade drops chapters, notes,
 *     drawings) and its copied file, then import fresh.
 *
 * Throws on: missing source, source is a directory, unsupported extension.
 */
export async function importBook(
  sourcePath: string,
  duplicateHandling: "skip" | "replace" | "prompt" = "prompt",
): Promise<ImportOutcome> {
  const abs = path.resolve(sourcePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Source file does not exist: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`Source path is not a file: ${abs}`);
  }

  const format = getFormatForFile(abs);
  if (!format) {
    throw new Error(
      `Unsupported file format: ${path.extname(abs) || "(no extension)"}`,
    );
  }

  const hash = await sha256OfFile(abs);
  const db = await getDb();

  // select().limit(1)[0] returns undefined when no row matches. Using this
  // pattern instead of findFirst for consistency with the rest of the codebase.
  const existing = (
    await db.select().from(books).where(eq(books.sha256, hash)).limit(1)
  )[0];
  // ponytail: trashed dups aren't consulted. A trashed book with the same
  // hash would let this import proceed and create a second copy; revisit if
  // trash ever holds large duplicates, otherwise the empty-trash purge cleans up.
  if (existing && !existing.trashed) {
    if (duplicateHandling === "prompt") {
      return { status: "duplicate", existingBook: bookForRenderer(existing) };
    }
    if (duplicateHandling === "skip") {
      return { status: "skipped", existingBook: bookForRenderer(existing) };
    }
    // "replace": drop the existing book row (cascade) and its copied file,
    // then fall through to a fresh import below.
    await deleteBook(existing.id);
  }

  const destDir = getBooksDir();
  const dest = uniqueDestination(destDir, path.basename(abs));
  await fs.promises.copyFile(abs, dest);

  // Filename fallback; EPUB meta overwrites title/author/cover below.
  let title = path.basename(abs, path.extname(abs));
  let author = "";
  let coverPath: string | null = null;

  if (format === "epub") {
    try {
      const meta = await readEpubMeta(dest);
      if (meta.title) title = meta.title;
      author = meta.author || "";
      if (meta.cover) {
        coverPath = path.join(getCoversDir(), `${hash}.${meta.cover.ext}`);
        await fs.promises.writeFile(coverPath, meta.cover.data);
      }
    } catch (err) {
      // Book file is already copied; keep the filename title rather than
      // failing the whole import over a bad OPF/cover.
      console.error("[import] epub meta failed:", dest, err);
    }
  }

  const rows = await db
    .insert(books)
    .values({
      title,
      author,
      format,
      sourcePath: dest,
      sha256: hash,
      coverPath,
      importedAt: new Date().toISOString(),
    })
    .returning();
  return { status: "imported", book: bookForRenderer(rows[0]) };
}

/** Delete a book row (cascade clears chapters/notes/drawings) and its files. */
export async function deleteBook(bookId: number): Promise<void> {
  const db = await getDb();
  const row = await db.query.books.findFirst({ where: eq(books.id, bookId) });
  if (!row) return;
  await db.delete(books).where(eq(books.id, bookId));
  if (row.sourcePath) fs.rmSync(row.sourcePath, { force: true });
  if (row.coverPath) fs.rmSync(row.coverPath, { force: true });
  // ponytail: best-effort cleanup of extracted images.
  const imageDir = path.join(getCoversDir(), String(bookId), "images");
  fs.rmSync(imageDir, { recursive: true, force: true });
}
