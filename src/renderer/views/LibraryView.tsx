import { useEffect, useMemo, useState } from "react";
import { EllipsisVertical, Plus, Search } from "lucide-react";
import type { Book } from "../../shared/types";
import { useImport } from "../hooks/useImport";
import { DuplicatePrompt } from "../components/DuplicatePrompt";
import { BookDetail } from "../components/BookDetail";

function progressLabel(book: Book): string {
  return book.progress >= 1
    ? "Finished"
    : `${Math.round(book.progress * 100)}%`;
}

function CoverPlaceholder({ title, author }: { title: string; author: string }) {
  return (
    <div className="flex h-full w-full flex-col justify-end bg-shell p-3 text-left">
      <span className="line-clamp-4 text-[13px] font-medium leading-snug text-ink">
        {title || "Untitled"}
      </span>
      {author ? (
        <span className="mt-1 line-clamp-2 text-[11px] text-muted">{author}</span>
      ) : null}
    </div>
  );
}

type MenuState = { book: Book; x: number; y: number };

function BookCard({
  book,
  onOpen,
  onMenu,
}: {
  book: Book;
  onOpen: () => void;
  onMenu: (pos: { x: number; y: number }) => void;
}) {
  const [broken, setBroken] = useState(false);
  const showCover = !!book.coverPath && !broken;

  return (
    <div
      className="w-[170px]"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button
        onClick={onOpen}
        className="block h-[261px] w-[170px] overflow-hidden rounded-[2px] bg-shell transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-muted"
      >
        {showCover ? (
          <img
            src={book.coverPath!}
            alt={`${book.title} cover`}
            className="h-full w-full object-cover"
            draggable={false}
            onError={() => setBroken(true)}
          />
        ) : (
          <CoverPlaceholder title={book.title} author={book.author} />
        )}
      </button>
      <div className="mt-[8px] flex h-[24px] items-center justify-between">
        <span className="text-[12px] text-muted">{progressLabel(book)}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu({ x: r.right, y: r.bottom + 4 });
          }}
          className="text-muted transition-colors hover:text-ink"
          aria-label={`More options for ${book.title}`}
        >
          <EllipsisVertical size={18} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

function BookMenu({
  menu,
  onClose,
  onDetails,
  onToggleFinished,
}: {
  menu: MenuState;
  onClose: () => void;
  onDetails: () => void;
  onToggleFinished: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // next tick so the opening click doesn't instantly dismiss
    const t = setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", onKey);
      window.addEventListener("scroll", close, true);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  const finished = menu.book.progress >= 1;
  const item =
    "flex w-full px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-field disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent";

  return (
    <div
      role="menu"
      className="fixed z-50 min-w-[160px] overflow-hidden rounded-[8px] border border-edge bg-shell py-1 shadow-shell"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onToggleFinished();
          onClose();
        }}
      >
        {finished ? "Mark as still reading" : "Mark as finished"}
      </button>
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          onDetails();
          onClose();
        }}
      >
        Details
      </button>
      <button
        role="menuitem"
        className={item}
        onClick={() => {
          void window.yumi.invoke("books:reveal", { id: menu.book.id });
          onClose();
        }}
      >
        Reveal in folder
      </button>
      {/* ponytail: delete is UI-only until trash/soft-delete lands */}
      <button
        role="menuitem"
        disabled
        title="Coming soon"
        className={item}
      >
        Delete
      </button>
    </div>
  );
}

export function LibraryView({ onOpenBook }: { onOpenBook: () => void }) {
  const [books, setBooks] = useState<Book[]>([]);
  const [query, setQuery] = useState("");
  const [titleAsc, setTitleAsc] = useState(true);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [detailBookId, setDetailBookId] = useState<number | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const { importing, importPaths, pendingDuplicate, resolveDuplicate } =
    useImport();

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
    return [...filtered].sort((a, b) =>
      titleAsc
        ? a.title.localeCompare(b.title)
        : b.title.localeCompare(a.title),
    );
  }, [books, query, titleAsc]);

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

      {pendingDuplicate && (
        <DuplicatePrompt
          pending={pendingDuplicate}
          onResolve={resolveDuplicate}
        />
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
              onOpen={onOpenBook}
              onMenu={(pos) => setMenu({ book, ...pos })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
