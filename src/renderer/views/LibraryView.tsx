import { useEffect, useMemo, useState } from "react";
import type { Book } from "@shared/types";
import coverPlaceholder from "../assets/cover-placeholder.jpg";

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
          src={book.coverPath ?? coverPlaceholder}
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

  useEffect(() => {
    window.yumi.invoke("books:list").then(setBooks);
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

  return (
    <div className="pb-16">
      {/* Search + sort row */}
      <div className="mx-auto flex w-full max-w-[551px] gap-[6px] px-4">
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
          onClick={() => setTitleAsc((v) => !v)}
          className="h-[36px] shrink-0 rounded-[8px] border border-edge bg-field px-4 text-[12px] text-muted transition-colors hover:text-ink"
        >
          Sort
        </button>
      </div>

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
