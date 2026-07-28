import { EllipsisVertical } from "lucide-react";
import { useState } from "react";

import type { Book } from "../../shared/types";

function progressLabel(book: Book): string {
  return book.progress >= 1
    ? "Finished"
    : `${Math.round(book.progress * 100)}%`;
}

function CoverPlaceholder({
  title,
  author,
}: {
  title: string;
  author: string;
}) {
  return (
    <div className="flex h-full w-full flex-col justify-end bg-shell p-3 text-left">
      <span className="line-clamp-4 text-[13px] font-medium leading-snug text-ink">
        {title || "Untitled"}
      </span>
      {author ? (
        <span className="mt-1 line-clamp-2 text-[11px] text-muted">
          {author}
        </span>
      ) : null}
    </div>
  );
}

export function BookCard({
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
