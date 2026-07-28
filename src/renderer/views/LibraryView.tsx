import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  BookOpen,
  Plus,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Book } from "../../shared/types";
import { BookCard } from "../components/BookCard";
import { BookDetail } from "../components/BookDetail";
import { BookMenu, type MenuState } from "../components/BookMenu";
import { SortMenu } from "../components/SortMenu";
import { compareBooks, SORT_OPTIONS, type SortKey } from "../library/sort";

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

  // The shelf: in-progress books, most recently opened first. Hidden while
  // searching, since the filtered grid below already answers the query.
  const shelf = useMemo(() => {
    if (query.trim()) return [];
    return books
      .filter((b) => b.progress > 0 && b.progress < 1)
      .sort((a, b) => compareBooks(a, b, { field: "recent", dir: "desc" }))
      .slice(0, 10);
  }, [books, query]);

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
          (result.skipped > 0
            ? `, skipped ${result.skipped} duplicate${result.skipped === 1 ? "" : "s"}`
            : ""),
      );
    }
  };

  const sectionLabel =
    "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted";

  return (
    <div className="container-app pb-20">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <Search size={16} strokeWidth={2} />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title or author"
            className="h-9 w-full rounded-[8px] border border-edge bg-field pl-9 pr-3 text-[13px] text-ink outline-none transition-colors placeholder:text-muted focus:border-accent/60"
          />
        </div>
        <div className="relative shrink-0">
          <button
            ref={sortTriggerRef}
            onClick={() => setSortOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={sortOpen}
            className="flex h-9 items-center gap-1.5 rounded-[8px] border border-edge bg-field px-3 text-[12px] text-ink transition-colors hover:border-muted"
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
        <button
          onClick={handleImport}
          disabled={importing}
          className="app-no-drag flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] bg-accent px-4 text-[12px] font-semibold text-on-accent transition-[filter] hover:brightness-110 disabled:opacity-60"
          aria-label="Import a book"
        >
          <Plus size={14} strokeWidth={2.5} />
          <span>{importing ? "Importing…" : "Import"}</span>
        </button>
      </div>

      {importMessage && (
        <p className="mt-3 text-[12px] text-muted" role="status">
          {importMessage}
        </p>
      )}

      {detailBook && (
        <BookDetail
          book={detailBook}
          onClose={() => setDetailBookId(null)}
          onDelete={() => {
            void window.yumi.invoke("books:delete", { id: detailBook.id });
          }}
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
          onDelete={() => {
            if (window.confirm(`Delete "${menu.book.title}"?`)) {
              void window.yumi.invoke("books:delete", { id: menu.book.id });
            }
          }}
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

      {books.length === 0 ? (
        /* Empty library: give the import action somewhere to live. */
        <div className="flex flex-col items-center pt-[72px] text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-shell">
            <BookOpen size={26} strokeWidth={1.5} className="text-muted" />
          </div>
          <p className="mt-5 text-[15px] font-semibold text-ink">
            Your library is empty
          </p>
          <p className="mt-1.5 max-w-[300px] text-[13px] leading-relaxed text-muted">
            Drop an .epub file anywhere in this window, or browse your folders
            for one.
          </p>
          <button
            onClick={handleImport}
            disabled={importing}
            className="mt-6 flex h-9 items-center gap-1.5 rounded-[8px] bg-accent px-4 text-[12px] font-semibold text-on-accent transition-[filter] hover:brightness-110 disabled:opacity-60"
          >
            <Plus size={14} strokeWidth={2.5} />
            {importing ? "Importing…" : "Import a book"}
          </button>
        </div>
      ) : visibleBooks.length === 0 ? (
        <div className="pt-16 text-center">
          <p className="text-[14px] text-ink">
            Nothing matches &ldquo;{query.trim()}&rdquo;
          </p>
          <p className="mt-1 text-[12px] text-muted">
            Try a different title or author.
          </p>
        </div>
      ) : (
        <>
          {shelf.length > 0 && (
            <section className="mt-9">
              <h2 className={sectionLabel}>Continue reading</h2>
              <div className="no-scrollbar -mx-8 mt-4 flex gap-6 overflow-x-auto px-8 pb-1">
                {shelf.map((book) => (
                  <div key={book.id} className="w-[140px] shrink-0">
                    <BookCard
                      book={book}
                      onOpen={() => onOpenBook(book)}
                      onMenu={(pos) => setMenu({ book, ...pos })}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="mt-10">
            {shelf.length > 0 && <h2 className={sectionLabel}>All books</h2>}
            <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-6 gap-y-12">
              {visibleBooks.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  onOpen={() => onOpenBook(book)}
                  onMenu={(pos) => setMenu({ book, ...pos })}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
