import type { Book } from "../../shared/types";

export type SortField = "title" | "author" | "recent" | "progress" | "importedAt";
export type SortDir = "asc" | "desc";
export type SortKey = { field: SortField; dir: SortDir };

// Date-based fields read better newest-first; string-based read better
// A→Z. Clicking the same field again flips the direction.
export const SORT_OPTIONS: { field: SortField; label: string; defaultDir: SortDir }[] =
  [
    { field: "title", label: "Title", defaultDir: "asc" },
    { field: "author", label: "Author", defaultDir: "asc" },
    { field: "recent", label: "Recent", defaultDir: "desc" },
    { field: "progress", label: "Read Progress", defaultDir: "desc" },
    { field: "importedAt", label: "Date added", defaultDir: "desc" },
  ];

// Sort comparator. Date-based fields push missing values to the end regardless
// of direction so "never opened" never crowds the top of Recent.
export function compareBooks(a: Book, b: Book, key: SortKey): number {
  const sign = key.dir === "asc" ? 1 : -1;
  const byTitle = a.title.localeCompare(b.title);
  switch (key.field) {
    case "title":
      return sign * a.title.localeCompare(b.title);
    case "author": {
      // Missing authors sink so they don't bunch up at "A" / "Z".
      const aEmpty = a.author.trim() === "";
      const bEmpty = b.author.trim() === "";
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      const byAuthor = a.author.localeCompare(b.author);
      return byAuthor !== 0 ? sign * byAuthor : byTitle;
    }
    case "recent": {
      const aTs = a.lastOpenedAt;
      const bTs = b.lastOpenedAt;
      if (!aTs && !bTs) return byTitle;
      if (!aTs) return 1;
      if (!bTs) return -1;
      return aTs < bTs ? sign : aTs > bTs ? -sign : 0;
    }
    case "progress": {
      // Tie-break by title so equal-progress books don't shuffle every render.
      if (a.progress !== b.progress) return sign * (a.progress - b.progress);
      return byTitle;
    }
    case "importedAt": {
      if (a.importedAt < b.importedAt) return sign;
      if (a.importedAt > b.importedAt) return -sign;
      return 0;
    }
  }
}

// ponytail: tiny self-check, run with `npx tsx src/renderer/library/sort.ts`.
// Guard `process` access behind a `file://` URL check so the renderer
// (where import.meta.url is http(s):// and `process` is undefined) never
// evaluates it — otherwise importing this module throws ReferenceError
// and the whole view white-screens.
declare const process: { argv: string[] };
const isMain =
  typeof import.meta.url === "string" &&
  import.meta.url.startsWith("file://") &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const mk = (over: Partial<Book>): Book => ({
    id: 0, title: "", author: "", format: "epub", sourcePath: "", sha256: null,
    coverPath: null, importedAt: "2024-01-01T00:00:00Z", lastOpenedAt: null,
    progress: 0, priorProgress: null, collection: "", trashed: 0, ...over,
  });
  const books = [
    mk({ id: 1, title: "B", author: "Adams" }),
    mk({ id: 2, title: "A", author: "" }),
    mk({ id: 3, title: "C", author: "Brown", lastOpenedAt: "2024-06-01" }),
  ];
  const byAuthor = [...books].sort((a, b) =>
    compareBooks(a, b, { field: "author", dir: "asc" }),
  );
  // Empty author sinks to the end regardless of dir.
  if (byAuthor[2].id !== 2) throw new Error("empty author should sink");
  // Equal-importedAt returns 0; progress ties fall back to title.
  const tied = [
    mk({ id: 1, title: "B", progress: 0.5 }),
    mk({ id: 2, title: "A", progress: 0.5 }),
  ];
  const r = tied.sort((a, b) => compareBooks(a, b, { field: "progress", dir: "asc" }));
  if (r[0].title !== "A") throw new Error("progress tie should fall back to title");
  // Recent with no timestamps falls back to title.
  const fresh = [
    mk({ id: 1, title: "Z", lastOpenedAt: null }),
    mk({ id: 2, title: "A", lastOpenedAt: null }),
  ];
  const r2 = fresh.sort((a, b) => compareBooks(a, b, { field: "recent", dir: "asc" }));
  if (r2[0].title !== "A") throw new Error("null recent should fall back to title");
  console.log("sort.ts: ok");
}
