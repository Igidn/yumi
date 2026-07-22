import { useEffect, useMemo, useState } from "react";
import type { Book } from "../../shared/types";
import { useImport } from "../hooks/useImport";

function SearchIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function progressLabel(book: Book): string {
  return book.progress >= 1
    ? "Finished"
    : `${Math.round(book.progress * 100)}%`;
}

function BookCard({ book, onOpen }: { book: Book; onOpen: () => void }) {
  return (
    <div className="w-[170px]">
      <button
        onClick={onOpen}
        className="block h-[261px] w-[170px] overflow-hidden transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-muted"
      >
        <img
          src={book.coverPath ?? ""}
          alt={`${book.title} cover`}
          className="h-full w-full object-cover"
          draggable={false}
        />
      </button>
      <div className="mt-[8px] flex h-[24px] items-center justify-between">
        <span className="text-[12px] text-muted">{progressLabel(book)}</span>
        <button
          className="text-muted transition-colors hover:text-ink"
          aria-label={`More options for ${book.title}`}
        >
          <MoreIcon />
        </button>
      </div>
    </div>
  );
}

export function LibraryView({ onOpenBook }: { onOpenBook: () => void }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [query, setQuery] = useState("");
  const [titleAsc, setTitleAsc] = useState(true);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const { importing, importPaths } = useImport();

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

  const visibleBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? books.filter(
          (book) =>
            book.title.toLowerCase().includes(q) ||
            book.author.toLowerCase().includes(q),
        )
      : books;
    return [...filtered].sort((a, b) =>
      titleAsc
        ? a.title.localeCompare(b.title)
        : b.title.localeCompare(a.title),
    );
  }, [books, query, titleAsc]);

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
      setImportMessage(`Imported ${result.ok} ${result.ok === 1 ? "book" : "books"}`);
    }
  };

  return (
    <div className="pb-16">
      {/* Search + sort + import row */}
      <div className="mx-auto -mt-3 flex w-full max-w-[551px] gap-[6px] px-4">
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-[12px] top-1/2 -translate-y-1/2 text-muted">
            <SearchIcon />
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
          <PlusIcon />
          <span>{importing ? "Importing…" : "Import"}</span>
        </button>
        <button
          onClick={() => setTitleAsc((v) => !v)}
          className="h-[36px] shrink-0 rounded-[8px] border border-edge bg-field px-4 text-[12px] text-muted transition-colors hover:text-ink"
        >
          Sort
        </button>
      </div>

      {importMessage && (
        <p
          className="mx-auto mt-3 w-full max-w-[551px] px-4 text-[12px] text-muted"
          role="status"
        >
          {importMessage}
        </p>
      )}

      {/* Book grid */}
      {visibleBooks.length === 0 ? (
        <p className="mt-[40px] text-center text-[13px] text-muted">
          {books.length === 0 ? "No books yet." : "No books match your search."}
        </p>
      ) : (
        <div className="mt-[31px] grid grid-cols-[repeat(auto-fill,170px)] justify-center gap-x-[55px] gap-y-[48px] px-6">
          {visibleBooks.map((book) => (
            <BookCard key={book.id} book={book} onOpen={onOpenBook} />
          ))}
        </div>
      )}
    </div>
  );
}
