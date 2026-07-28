import { useEffect, useRef, useState } from "react";

import type { Book, ReaderChapter } from "../../shared/types";

const FOCUSABLE_SELECTOR =
  'button:not([tabindex="-1"]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Table-of-contents overlay, styled after Apple Books: book identity on top,
 * a scrollable chapter list below, current chapter highlighted.
 */
export function TocPanel({
  book,
  chapters,
  currentPos,
  onSelect,
  onClose,
}: {
  book: Book;
  chapters: ReaderChapter[];
  currentPos: number;
  onSelect: (pos: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [coverBroken, setCoverBroken] = useState(false);

  // Center the current chapter when the panel opens or the chapter changes.
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (list && active) {
      list.scrollTop =
        active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
    }
  }, [currentPos]);

  // Focus-trap Tab cycling within the panel.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusable.length > 0) {
      const active = panel.querySelector<HTMLElement>('[data-active="true"]');
      (active ?? focusable[0]).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const focused = document.activeElement;

      if (e.shiftKey) {
        if (focused === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (focused === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* Click-away catcher */}
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <aside
        ref={panelRef}
        className="fixed bottom-3 left-3 top-[60px] z-30 flex w-[288px] flex-col overflow-hidden rounded-[12px] border border-reader-edge bg-reader-chrome/95 shadow-shell backdrop-blur-md"
        role="dialog"
        aria-label="Table of contents"
      >
        <div className="flex items-center gap-3 border-b border-reader-edge px-4 py-3.5">
          {book.coverPath && !coverBroken ? (
            <img
              src={book.coverPath}
              alt=""
              className="h-[52px] w-[36px] shrink-0 rounded-[2px] object-cover"
              draggable={false}
              onError={() => setCoverBroken(true)}
            />
          ) : (
            <div className="h-[52px] w-[36px] shrink-0 rounded-[2px] bg-reader-edge" />
          )}
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-reader">
              {book.title || "Untitled"}
            </p>
            {book.author && (
              <p className="mt-0.5 truncate text-[12px] text-reader-muted">
                {book.author}
              </p>
            )}
          </div>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {chapters.map((chapter, pos) => {
            const active = pos === currentPos;
            return (
              <button
                key={chapter.id}
                data-active={active}
                onClick={() => onSelect(pos)}
                className={`block w-full rounded-[7px] px-3 py-[8px] text-left text-[13px] leading-snug transition-colors ${
                  active
                    ? "bg-reader-edge/70 font-medium text-reader"
                    : "text-reader-muted hover:bg-reader-edge/40 hover:text-reader"
                }`}
              >
                {chapter.title}
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}
