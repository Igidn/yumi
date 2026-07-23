import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { ReaderChapter } from "../../shared/types";

export interface SearchHit {
  chapterPos: number;
  blockIndex: number;
  chapterTitle: string;
  snippet: string;
}

const MAX_RESULTS = 100;

function searchChapters(chapters: ReaderChapter[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  outer: for (let pos = 0; pos < chapters.length; pos++) {
    const chapter = chapters[pos];
    for (let i = 0; i < chapter.blocks.length; i++) {
      const text = chapter.blocks[i].text;
      const at = text.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const from = Math.max(0, at - 36);
      const to = Math.min(text.length, at + q.length + 60);
      hits.push({
        chapterPos: pos,
        blockIndex: i,
        chapterTitle: chapter.title,
        snippet:
          (from > 0 ? "…" : "") +
          text.slice(from, to).trim() +
          (to < text.length ? "…" : ""),
      });
      if (hits.length >= MAX_RESULTS) break outer;
    }
  }
  return hits;
}

/**
 * In-book search overlay: live results with context snippets; clicking a hit
 * jumps the reading surface to the matched paragraph. Full-text indexing
 * (FTS5) lands in M7 — this is a plain substring scan over loaded blocks.
 */
export function SearchPanel({
  chapters,
  onJump,
  onClose,
}: {
  chapters: ReaderChapter[];
  onJump: (chapterPos: number, blockIndex: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const hits = useMemo(() => searchChapters(chapters, query), [chapters, query]);

  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <aside
        className="fixed bottom-3 right-3 top-[60px] z-30 flex w-[320px] flex-col overflow-hidden rounded-[12px] border border-reader-edge bg-reader-chrome/95 shadow-shell backdrop-blur-md"
        role="dialog"
        aria-label="Search in book"
      >
        <div className="border-b border-reader-edge p-3">
          <div className="relative">
            <span className="pointer-events-none absolute left-[10px] top-1/2 -translate-y-1/2 text-reader-muted">
              <Search size={15} strokeWidth={2} />
            </span>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search in book"
              className="h-[32px] w-full rounded-[8px] border border-reader-edge bg-reader-bg pl-[31px] pr-3 text-[13px] text-reader outline-none placeholder:text-reader-muted"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {query.trim().length >= 2 && hits.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-reader-muted">
              No results
            </p>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.chapterPos}:${hit.blockIndex}:${i}`}
              onClick={() => onJump(hit.chapterPos, hit.blockIndex)}
              className="block w-full rounded-[7px] px-3 py-[8px] text-left transition-colors hover:bg-reader-edge/40"
            >
              <p className="truncate text-[11px] font-medium text-reader-accent">
                {hit.chapterTitle}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-reader">
                {hit.snippet}
              </p>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
