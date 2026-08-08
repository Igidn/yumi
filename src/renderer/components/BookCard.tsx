import { Check, Ellipsis, Globe } from "lucide-react";
import { useState } from "react";

import type { Book } from "../../shared/types";
import { chapterLabel } from "../shared/chapter-label";

function CoverPlaceholder({
  title,
  author,
}: {
  title: string;
  author: string;
}) {
  return (
    <div className="relative flex h-full w-full flex-col justify-between bg-shell p-3 pt-4 text-left">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgb(0_0_0/0.35),transparent_10%,transparent_92%,rgb(255_255_255/0.05))]"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-[9px] w-px bg-ink/10"
      />
      <span className="line-clamp-6 text-[13px] font-medium leading-snug text-ink">
        {title || "Untitled"}
      </span>
      {author ? (
        <span className="mt-2 line-clamp-2 text-[11px] text-muted">
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
  const percent = Math.round(book.progress * 100);
  const finished = book.progress >= 1;
  const isWebnovel = book.format === "webnovel";

  return (
    <div
      className="group w-full"
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="relative">
        <button
          onClick={onOpen}
          className="block aspect-[2/3] w-full overflow-hidden rounded-[6px] bg-shell shadow-[0_2px_10px_rgb(0_0_0/0.35)] ring-1 ring-ink/10 transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:shadow-[0_12px_28px_rgb(0_0_0/0.5)] focus-visible:-translate-y-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
        <button
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMenu({ x: r.right, y: r.bottom + 4 });
          }}
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-page/80 text-ink opacity-0 shadow-shell transition-opacity hover:bg-page focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={`More options for ${book.title}`}
        >
          <Ellipsis size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="mt-2.5">
        <p
          className="line-clamp-2 text-[13px] leading-snug text-ink"
          title={book.title}
        >
          {book.title || "Untitled"}
        </p>
        {book.author ? (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted">
            {book.author}
          </p>
        ) : null}
        {isWebnovel ? (
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[11px] font-medium text-muted">
              <Globe size={12} strokeWidth={2} />
              Webnovel
            </span>
            <span className="text-[11px] tabular-nums text-muted">
              {chapterLabel(book.currentChapterIndex ?? 1)}
            </span>
          </div>
        ) : finished ? (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-accent">
            <Check size={12} strokeWidth={2.5} />
            Finished
          </p>
        ) : percent > 0 ? (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-edge">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-muted">
              {percent}%
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
