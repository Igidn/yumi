import fs from "fs";
import path from "path";
import { getUserDataPath } from "./paths";
import { getDb } from "./database";
import { books } from "./db/schema";
import type { Book, BookFormat } from "../shared/types";

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
 * Pick a destination path inside `destDir` that does not collide with an
 * existing file. The basename is preserved; collisions get `-1`, `-2`, ...
 *
 * Filename-based dedup proper (filename + SHA-256, with a skip/replace prompt)
 * is a separate M1 sub-item; for now we just don't clobber.
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
 * Throws on: missing source, source is a directory, unsupported extension.
 */
export async function importBook(sourcePath: string): Promise<Book> {
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

  const destDir = getBooksDir();
  const dest = uniqueDestination(destDir, path.basename(abs));
  await fs.promises.copyFile(abs, dest);

  const db = await getDb();
  const title = path.basename(abs, path.extname(abs));
  const rows = await db
    .insert(books)
    .values({
      title,
      author: "",
      format,
      sourcePath: dest,
      importedAt: new Date().toISOString(),
    })
    .returning();
  return rows[0];
}
