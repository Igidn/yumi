import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownNarrowWide, ArrowUpNarrowWide, Plus, Search } from "lucide-react";
import type { Book } from "../../shared/types";
import { BookDetail } from "../components/BookDetail";
import { BookCard } from "../components/BookCard";
import { BookMenu, type MenuState } from "../components/BookMenu";
import { SortMenu } from "../components/SortMenu";
import { SORT_OPTIONS, compareBooks, type SortKey } from "../library/sort";

export function LibraryView({
  onOpenBook,
  importing,
  importPaths,
}: {
  onOpenBook: (book: Book) => void;
  importing: boolean;
  importPaths: (paths: string[]) => Promise<{
    ok: number;
    skipped: number;
    failed: { path: string; error: string }[];
  }>;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>({
    field: "title",
    dir: "asc",
  });
  const [sortOpen, setSortOpen] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [detailBookId, setDetailBookId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const sortTriggerRef = useRef<HTMLButtonElement | null>(null);

  const fetchBooks = () => window.yumi.invoke("books:list").then(setBooks);

  useEffect(() => {
    void fetchBooks();
  }, []);

  // Main emits `library:changed` after every successful import — window
  // drop, dialog, or dock drop — so re-fetch to pick up new rows without
  // waiting for a tab switch.
  useEffect(() => {
    return window.yumi.on("library:changed", () => {
      void fetchBooks();
    });
  }, []);

  // Auto-dismiss the import toast after 15s so it stops nagging.
  useEffect(() => {
    if (!importMessage) return;
    const t = setTimeout(() => setImportMessage(null), 15_000);
    return () => clearTimeout(t);
  }, [importMessage]);

  const visibleBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? books.filter(
          (book) =>
            book.title.toLowerCase().includes(q) ||
            book.author.toLowerCase().includes(q),
        )
      : books;
    return [...filtered].sort((a, b) => compareBooks(a, b, sortKey));
  }, [books, query, sortKey]);

  const detailBook =
    detailBookId === null
      ? null
      : (books.find((b) => b.id === detailBookId) ?? null);

  const handleImport = async () => {
    setImportMessage(null);
    const paths = await window.yumi.invoke("dialog:openFile");
    if (paths.length === 0) return;
    const result = await importPaths(paths);
    if (result.failed.length > 0) {
      setImportMessage(
        `Imported ${result.ok}, ${result.failed.length} failed: ${result.failed[0].error}`,
      );
    } else {
      setImportMessage(
        `Imported ${result.ok} ${result.ok === 1 ? "book" : "books"}` +
          (result.skipped > 0 ? `, skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}` : ""),
      );
    }
  };

  return (
    <div className="pb-16">
      {/* Search + sort + import row */}
      <div className="mx-auto -mt-3 flex w-full max-w-[551px] gap-[6px] px-4">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-[12px] top-1/2 -translate-y-1/2 text-muted">
            <Search size={18} strokeWidth={2} />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="h-[36px] w-full rounded-[8px] border border-edge bg-field pl-[38px] pr-3 text-[13px] text-ink outline-none placeholder:text-muted focus:border-muted"
          />
        </div>
        <button
          onClick={handleImport}
          disabled={importing}
          className="app-no-drag flex h-[36px] shrink-0 items-center gap-1.5 rounded-[8px] border border-edge bg-field px-4 text-[12px] text-ink transition-colors hover:text-ink disabled:opacity-60"
          aria-label="Import a book"
        >
          <Plus size={14} strokeWidth={2} />
          <span>{importing ? "Importing…" : "Import"}</span>
        </button>
        <div className="relative shrink-0">
          <button
            ref={sortTriggerRef}
            onClick={() => setSortOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            className="flex h-[36px] items-center gap-1.5 rounded-[8px] border border-edge bg-field px-3 text-[12px] text-ink transition-colors hover:text-ink"
          >
            <span className="text-muted">Sort:</span>
            <span>
              {SORT_OPTIONS.find((o) => o.field === sortKey.field)?.label}
            </span>
            {sortKey.dir === "asc" ? (
              <ArrowUpNarrowWide
                size={13}
                strokeWidth={1.75}
                className="text-muted"
              />
            ) : (
              <ArrowDownNarrowWide
                size={13}
                strokeWidth={1.75}
                className="text-muted"
              />
            )}
          </button>
          {sortOpen && (
            <SortMenu
              sortKey={sortKey}
              onSelect={setSortKey}
              onClose={() => setSortOpen(false)}
              anchorRef={sortTriggerRef}
            />
          )}
        </div>
      </div>

      {importMessage && (
        <p
          className="mx-auto mt-3 w-full max-w-[551px] px-4 text-[12px] text-muted"
          role="status"
        >
          {importMessage}
        </p>
      )}

      {detailBook && (
        <BookDetail
          book={detailBook}
          onClose={() => setDetailBookId(null)}
          onUpdated={(updated) =>
            setBooks((prev) =>
              prev.map((b) => (b.id === updated.id ? updated : b)),
            )
          }
        />
      )}

      {menu && (
        <BookMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onDetails={() => setDetailBookId(menu.book.id)}
          onToggleFinished={() => {
            const finished = menu.book.progress >= 1;
            void window.yumi
              .invoke(
                "books:update",
                finished
                  ? { id: menu.book.id, restoreProgress: true }
                  : { id: menu.book.id, progress: 1 },
              )
              .then((updated) =>
                setBooks((prev) =>
                  prev.map((b) => (b.id === updated.id ? updated : b)),
                ),
              );
          }}
        />
      )}

      {/* Book grid */}
      {visibleBooks.length === 0 ? (
        <p className="mt-[40px] text-center text-[13px] text-muted">
          {books.length === 0 ? "No books yet." : "No books match your search."}
        </p>
      ) : (
        <div className="mt-[31px] grid grid-cols-[repeat(auto-fill,170px)] justify-center gap-x-[55px] gap-y-[48px] px-6">
          {visibleBooks.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              onOpen={() => onOpenBook(book)}
              onMenu={(pos) => setMenu({ book, ...pos })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
