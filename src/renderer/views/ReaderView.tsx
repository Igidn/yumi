import { useCallback, useEffect, useRef, useState } from "react";
import { List, Search, Undo2 } from "lucide-react";
import type { ReaderPayload } from "../../shared/types";
import {
  PagedChapter,
  countChapterCols,
  type PageJump,
  type Reposition,
  type SpreadInfo,
} from "../reader/PagedChapter";
import { TocPanel } from "../reader/TocPanel";
import { AppearanceMenu } from "../reader/AppearanceMenu";
import { SearchPanel } from "../reader/SearchPanel";
import {
  DEFAULT_READER_SETTINGS,
  loadReaderSettings,
  saveReaderSettings,
  type ReaderSettings,
} from "../reader/settings";

type Panel = "toc" | "search" | null;

interface HistoryEntry {
  chapterPos: number;
  fraction: number;
}

const PROGRESS_SAVE_MS = 400;

/**
 * The standalone reader window root (Apple Books flow: library → cover click
 * → book opens here, in its own window). Owns chapter navigation, appearance
 * settings, panels (TOC / search / AA), and reading-progress persistence.
 */
export function ReaderView({ bookId }: { bookId: number }) {
  const [payload, setPayload] = useState<ReaderPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(
    DEFAULT_READER_SETTINGS
  );
  const [chapterPos, setChapterPos] = useState(0);
  /** Fraction to land at when the chapter changes (0 start, 1 end, resume). */
  const [landingFraction, setLandingFraction] = useState(0);
  const [pageInfo, setPageInfo] = useState<SpreadInfo | null>(null);
  /** Column counts per chapter under the current layout; null until measured. */
  const [colsByChapter, setColsByChapter] = useState<number[] | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [jump, setJump] = useState<PageJump | null>(null);
  const [reposition, setReposition] = useState<Reposition | null>(null);
  // Hyperlink history: stack of positions visited before clicking a link.
  const [linkHistory, setLinkHistory] = useState<HistoryEntry[]>([]);
  const [backButton, setBackButton] = useState<{
    side: "left" | "right";
  } | null>(null);

  // Auto-hide chrome: fades header when mouse isn't near the top edge,
  // Apple Books style. Always visible when a panel is open.
  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeTimer = useRef<number | null>(null);
  const chromePinned = panel !== null || appearanceOpen;
  const showChrome = chromeVisible || chromePinned;

  const scheduleChromeHide = useCallback(() => {
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => {
      if (!chromePinned) setChromeVisible(false);
    }, 2000);
  }, [chromePinned]);

  const handleChromeMove = useCallback(
    (e: React.MouseEvent) => {
      if (chromePinned) return;
      if (e.clientY < 60) {
        setChromeVisible(true);
        if (chromeTimer.current) {
          clearTimeout(chromeTimer.current);
          chromeTimer.current = null;
        }
      } else if (chromeVisible) {
        scheduleChromeHide();
      }
    },
    [chromePinned, chromeVisible, scheduleChromeHide]
  );

  // Show chrome when a panel opens, start hide timer when all close.
  useEffect(() => {
    if (chromePinned) {
      setChromeVisible(true);
      if (chromeTimer.current) {
        clearTimeout(chromeTimer.current);
        chromeTimer.current = null;
      }
    } else {
      scheduleChromeHide();
    }
  }, [chromePinned, scheduleChromeHide]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
    };
  }, []);

  const nonceRef = useRef(1);
  const payloadRef = useRef<ReaderPayload | null>(null);
  // Latest position for progress writes; chapterId 0 = nothing to save yet.
  const progressRef = useRef({ chapterPos: 0, chapterId: 0, fraction: 0 });
  const saveTimer = useRef<number | null>(null);

  // ---- loading ----------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void loadReaderSettings().then((s) => {
      if (!cancelled) setSettings(s);
    });
    window.yumi
      .invoke("reader:load", { id: bookId })
      .then((data) => {
        if (cancelled) return;
        payloadRef.current = data;
        setPayload(data);
        document.title = data.book.title || "Yumi";
        const pos = Math.min(
          data.resumeChapterPos,
          Math.max(0, data.chapters.length - 1)
        );
        setChapterPos(pos);
        setLandingFraction(data.chapters[pos]?.scrollPosition ?? 0);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // ---- progress persistence --------------------------------------------

  const flushProgress = useCallback(() => {
    const data = payloadRef.current;
    const p = progressRef.current;
    if (!data || p.chapterId === 0 || data.chapters.length === 0) return;
    const bookProgress =
      (p.chapterPos + p.fraction) / data.chapters.length;
    void window.yumi.invoke("reader:progress", {
      bookId: data.book.id,
      chapterId: p.chapterId,
      chapterPosition: p.fraction,
      bookProgress: Math.min(1, bookProgress),
    });
  }, []);

  const scheduleProgressSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      flushProgress();
    }, PROGRESS_SAVE_MS);
  }, [flushProgress]);

  // Flush pending writes on unload and when the window loses focus.
  useEffect(() => {
    window.addEventListener("beforeunload", flushProgress);
    window.addEventListener("blur", flushProgress);
    return () => {
      window.removeEventListener("beforeunload", flushProgress);
      window.removeEventListener("blur", flushProgress);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      flushProgress();
    };
  }, [flushProgress]);

  // ---- navigation --------------------------------------------------------

  const goToChapter = useCallback(
    (pos: number, fraction: number, keepJump?: boolean) => {
      const data = payloadRef.current;
      if (!data || pos < 0 || pos >= data.chapters.length) return;
      // Persist the old location before moving.
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      flushProgress();
      if (!keepJump) setJump(null);
      setReposition(null);
      setPageInfo(null);
      setLandingFraction(fraction);
      setChapterPos(pos);
    },
    [flushProgress]
  );

  const handleOverflow = useCallback(
    (dir: -1 | 1) => {
      // Forward overflows land on the next chapter's first page; backward
      // overflows land on the previous chapter's last page (Apple Books).
      goToChapter(chapterPos + dir, dir === 1 ? 0 : 1);
    },
    [chapterPos, goToChapter]
  );

  // Fragment target + nonce for scrolling after chapter mount (nonce forces re-fire).
  const [fragmentTarget, setFragmentTarget] = useState<{
    fragment: string | null;
    nonce: number;
  }>({ fragment: null, nonce: 0 });

  // Hyperlink navigation: push current position, jump to target chapter.
  const handleLinkNavigate = useCallback(
    (targetChapter: number, fragment: string | null) => {
      if (targetChapter === chapterPos) {
        // Same-chapter link: increment nonce so re-clicks on the same fragment re-fire.
        setFragmentTarget((prev) => ({ fragment, nonce: prev.nonce + 1 }));
        return;
      }
      const fraction = pageInfo?.fraction ?? 0;
      setLinkHistory((prev) => [...prev, { chapterPos, fraction }]);
      setBackButton({ side: targetChapter < chapterPos ? "right" : "left" });
      goToChapter(targetChapter, 0);
      setFragmentTarget((prev) => ({ fragment, nonce: prev.nonce + 1 }));
    },
    [chapterPos, pageInfo?.fraction, goToChapter]
  );

  // Back button: pop last history entry and return to it.
  const handleBack = useCallback(() => {
    const entry = linkHistory[linkHistory.length - 1];
    if (!entry) return;
    setLinkHistory((prev) => prev.slice(0, -1));
    setBackButton(null);
    setFragmentTarget({ fragment: null, nonce: 0 });
    goToChapter(entry.chapterPos, entry.fraction);
  }, [linkHistory, goToChapter]);

  const handleTocSelect = useCallback(
    (pos: number) => {
      setPanel(null);
      setLinkHistory([]);
      setBackButton(null);
      setFragmentTarget({ fragment: null, nonce: 0 });
      if (pos === chapterPos) {
        setReposition({ fraction: 0, nonce: nonceRef.current++ });
      } else {
        goToChapter(pos, 0);
      }
    },
    [chapterPos, goToChapter]
  );

  const handleSearchJump = useCallback(
    (pos: number, blockIndex: number) => {
      setPanel(null);
      setLinkHistory([]);
      setBackButton(null);
      setFragmentTarget({ fragment: null, nonce: 0 });
      setJump({ blockIndex, nonce: nonceRef.current++ });
      if (pos !== chapterPos) goToChapter(pos, 0, true);
    },
    [chapterPos, goToChapter]
  );

  const handleSpreadChange = useCallback(
    (info: SpreadInfo) => {
      setPageInfo(info);
      const chapter = payloadRef.current?.chapters[chapterPos];
      if (!chapter) return;
      progressRef.current = {
        chapterPos,
        chapterId: chapter.id,
        fraction: info.fraction,
      };
      scheduleProgressSave();
    },
    [chapterPos, scheduleProgressSave]
  );

  // Chapter-level shortcuts; page-turn keys live in PagedChapter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPanel(null);
        setAppearanceOpen(false);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "[") {
        e.preventDefault();
        setLinkHistory([]);
        setBackButton(null);
        setFragmentTarget({ fragment: null, nonce: 0 });
        goToChapter(chapterPos - 1, 0);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        setLinkHistory([]);
        setBackButton(null);
        setFragmentTarget({ fragment: null, nonce: 0 });
        goToChapter(chapterPos + 1, 0);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setAppearanceOpen(false);
        setPanel((p) => (p === "search" ? null : "search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chapterPos, goToChapter]);

  // Book-wide page offsets: remeasure every chapter when layout/typography changes.
  // ponytail: sync full-book measure; chunk if 200+ chapter books jank on resize.
  useEffect(() => {
    if (!payload || !pageInfo) return;
    const layout = {
      contentWidth: pageInfo.contentWidth,
      contentHeight: pageInfo.contentHeight,
      colWidth: pageInfo.colWidth,
      colGap: pageInfo.colGap,
    };
    setColsByChapter(
      payload.chapters.map((ch) =>
        countChapterCols(ch, layout, settings.fontSize, settings.lineHeight)
      )
    );
  }, [
    payload,
    pageInfo?.contentWidth,
    pageInfo?.contentHeight,
    pageInfo?.colWidth,
    pageInfo?.colGap,
    settings.fontSize,
    settings.lineHeight,
  ]);

  // ---- render ------------------------------------------------------------

  const theme = settings.theme;

  if (error) {
    return (
      <div className="reader-dark flex h-screen flex-col items-center justify-center bg-reader text-reader">
        <p className="text-[14px]">Couldn't open this book.</p>
        <p className="mt-2 max-w-[400px] text-center text-[12px] text-reader-muted">
          {error}
        </p>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="reader-dark flex h-screen items-center justify-center bg-reader">
        <p className="text-[13px] text-reader-muted">Opening…</p>
      </div>
    );
  }

  const { book, chapters } = payload;
  const chapter = chapters[chapterPos] ?? null;

  // Apple Books shows the rightmost visible page of the current spread,
  // numbered across the whole book (not restarting per chapter).
  const pageLabel = (() => {
    if (!pageInfo) return null;
    const local = Math.min(
      (pageInfo.spread + 1) * pageInfo.perSpread,
      pageInfo.totalCols
    );
    if (!colsByChapter) return chapterPos === 0 ? local : null;
    let prefix = 0;
    for (let i = 0; i < chapterPos; i++) prefix += colsByChapter[i] ?? 0;
    return prefix + local;
  })();

  return (
    <div
      className={`reader-${theme} flex h-screen flex-col overflow-hidden bg-reader font-ui text-reader`}
      onMouseMove={handleChromeMove}
      onMouseLeave={() => { if (!chromePinned) scheduleChromeHide(); }}
    >
      {/* Chrome header — auto-hides when mouse leaves the top zone */}
      <header
        className={`app-drag relative z-10 flex h-[52px] shrink-0 items-center justify-between pl-[78px] pr-3 transition-opacity duration-300 ${
          showChrome ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        <div className="app-no-drag flex items-center gap-1">
          <button
            onClick={() => {
              setAppearanceOpen(false);
              setPanel((p) => (p === "toc" ? null : "toc"));
            }}
            className={`rounded-[6px] p-1.5 transition-colors ${
              panel === "toc"
                ? "text-reader"
                : "text-reader-muted hover:text-reader"
            }`}
            aria-label="Table of contents"
            aria-pressed={panel === "toc"}
          >
            <List size={18} strokeWidth={1.75} />
          </button>
        </div>

        <h1 className="pointer-events-none absolute left-1/2 max-w-[55%] -translate-x-1/2 select-none truncate text-[13px] font-medium">
          {book.title || "Untitled"}
        </h1>

        <div className="app-no-drag flex items-center gap-1">
          <button
            onClick={() => {
              setPanel(null);
              setAppearanceOpen((v) => !v);
            }}
            className={`rounded-[6px] px-1.5 py-1 text-[13px] font-medium leading-none transition-colors ${
              appearanceOpen
                ? "text-reader"
                : "text-reader-muted hover:text-reader"
            }`}
            aria-label="Appearance"
            aria-pressed={appearanceOpen}
          >
            AA
          </button>
          <button
            onClick={() => {
              setAppearanceOpen(false);
              setPanel((p) => (p === "search" ? null : "search"));
            }}
            className={`rounded-[6px] p-1.5 transition-colors ${
              panel === "search"
                ? "text-reader"
                : "text-reader-muted hover:text-reader"
            }`}
            aria-label="Search in book"
            aria-pressed={panel === "search"}
          >
            <Search size={17} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      {/* Reading surface */}
      {chapter ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
        <PagedChapter
          key={chapter.id}
          chapter={chapter}
          fontSize={settings.fontSize}
          lineHeight={settings.lineHeight}
          initialFraction={landingFraction}
          jump={jump}
          reposition={reposition}
          fragmentTarget={fragmentTarget}
          onSpreadChange={handleSpreadChange}
          onOverflow={handleOverflow}
          onLinkNavigate={handleLinkNavigate}
        />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-8">
          <p className="max-w-[420px] text-center text-[13px] leading-relaxed text-reader-muted">
            This book has no readable chapters.
          </p>
        </div>
      )}

      {/* Footer: back button + page indicator, Apple Books style */}
      <footer className="flex h-[36px] shrink-0 select-none items-center justify-between px-4">
        <div className="flex-1">
          {backButton && backButton.side === "left" && (
            <button
              onClick={handleBack}
              className="app-no-drag flex items-center gap-1 text-[12px] text-reader-muted transition-colors hover:text-reader"
              aria-label="Back to previous page"
            >
              <Undo2 size={14} strokeWidth={1.75} />
              Back
            </button>
          )}
        </div>

        <div className="flex-1 text-center">
          {chapter && pageLabel !== null && (
            <span className="text-[12px] tabular-nums text-reader-muted">
              {pageLabel}
            </span>
          )}
        </div>

        <div className="flex-1 flex justify-end">
          {backButton && backButton.side === "right" && (
            <button
              onClick={handleBack}
              className="app-no-drag flex items-center gap-1 text-[12px] text-reader-muted transition-colors hover:text-reader"
              aria-label="Back to previous page"
            >
              Back
              <Undo2 size={14} strokeWidth={1.75} className="scale-x-[-1]" />
            </button>
          )}
        </div>
      </footer>

      {/* Panels */}
      {panel === "toc" && (
        <TocPanel
          book={book}
          chapters={chapters}
          currentPos={chapterPos}
          onSelect={handleTocSelect}
          onClose={() => setPanel(null)}
        />
      )}
      {panel === "search" && (
        <SearchPanel
          chapters={chapters}
          onJump={handleSearchJump}
          onClose={() => setPanel(null)}
        />
      )}
      {appearanceOpen && (
        <AppearanceMenu
          settings={settings}
          onChange={(next) => {
            setSettings(next);
            saveReaderSettings(next);
          }}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
    </div>
  );
}
