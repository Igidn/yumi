import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { getUserDataPath } from "./paths";
import { getDb } from "./database";
import { books } from "./db/schema";
import type { Book, BookFormat, ImportOutcome } from "../shared/types";

const SUPPORTED_EXTENSIONS: Record<string, BookFormat> = {
  ".epub": "epub",
  ".pdf": "pdf",
};

/** Return `<userData>/books`, creating the directory if it does not exist. */
export function getBooksDir(): string {
  const dir = path.join(getUserDataPath(), "books");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getFormatForFile(filePath: string): BookFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS[ext] ?? null;
}

/**
 * SHA-256 of a file's contents, streamed so large PDFs don't load whole
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
  duplicateHandling: "skip" | "replace" | "prompt" = "prompt"
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
      `Unsupported file format: ${path.extname(abs) || "(no extension)"}`
    );
  }

  const hash = await sha256OfFile(abs);
  const db = await getDb();

  // Use select().limit(1) rather than the relational `findFirst`: drizzle's
  // sql.js driver returns an all-undefined object (not `undefined`) when no
  // row matches, which would make a truthiness guard false-positive every import.
  const existing = (
    await db.select().from(books).where(eq(books.sha256, hash)).limit(1)
  )[0];
  // ponytail: trashed dups aren't consulted. A trashed book with the same
  // hash would let this import proceed and create a second copy; revisit if
  // trash ever holds large duplicates, otherwise the empty-trash purge cleans up.
  if (existing && !existing.trashed) {
    if (duplicateHandling === "prompt") {
      return { status: "duplicate", existingBook: existing };
    }
    if (duplicateHandling === "skip") {
      return { status: "skipped", existingBook: existing };
    }
    // "replace": drop the existing book row (cascade) and its copied file,
    // then fall through to a fresh import below.
    await deleteBook(existing.id);
  }

  const destDir = getBooksDir();
  const dest = uniqueDestination(destDir, path.basename(abs));
  await fs.promises.copyFile(abs, dest);

  const title = path.basename(abs, path.extname(abs));
  const rows = await db
    .insert(books)
    .values({
      title,
      author: "",
      format,
      sourcePath: dest,
      sha256: hash,
      importedAt: new Date().toISOString(),
    })
    .returning();
  return { status: "imported", book: rows[0] };
}

/** Delete a book row (cascade clears chapters/notes/drawings) and its copied file. */
async function deleteBook(bookId: number): Promise<void> {
  const db = await getDb();
  const row = await db.query.books.findFirst({ where: eq(books.id, bookId) });
  if (!row) return;
  await db.delete(books).where(eq(books.id, bookId));
  if (row.sourcePath) {
    fs.rmSync(row.sourcePath, { force: true });
  }
}
