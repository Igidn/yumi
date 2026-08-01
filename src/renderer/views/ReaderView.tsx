import { List, Pen, Search, Undo2, Volume2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { ReaderPayload, TtsSelection } from "../../shared/types";
import { AppearanceMenu } from "../reader/AppearanceMenu";
import { ContextMenu, getTtsSelection } from "../reader/ContextMenu";
import { FloatingPanel } from "../reader/FloatingPanel";
import {
  countChapterCols,
  PagedChapter,
  type PageJump,
  type Reposition,
  type SpreadInfo,
} from "../reader/PagedChapter";
import { SearchPanel } from "../reader/SearchPanel";
import {
  DEFAULT_READER_SETTINGS,
  loadReaderSettings,
  type ReaderSettings,
  saveReaderSettings,
} from "../reader/settings";
import { TocPanel } from "../reader/TocPanel";
import { TtsBar } from "../reader/TtsBar";
import { useTts } from "../reader/useTts";

/** px from top of viewport considered "hovering the header zone" */
const HEADER_HOVER_ZONE = 80;

type Panel = "toc" | "search" | null;

interface HistoryEntry {
  chapterPos: number;
  fraction: number;
}

const PROGRESS_SAVE_MS = 400;

/** Book-wide column counts, keyed by layout signature. Module scope is fine:
 *  each reader window is its own renderer process with one open book. */
const colsCache: {
  key: string;
  payload: ReaderPayload | null;
  cols: number[];
} = { key: "", payload: null, cols: [] };

/**
 * The standalone reader window root (Apple Books flow: library → cover click
 * → book opens here, in its own window). Owns chapter navigation, appearance
 * settings, panels (TOC / search / AA), and reading-progress persistence.
 */
export function ReaderView({ bookId }: { bookId: number }) {
  const [payload, setPayload] = useState<ReaderPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(
    DEFAULT_READER_SETTINGS,
  );
  const [chapterPos, setChapterPos] = useState(0);
  /** Fraction to land at when the chapter changes (0 start, 1 end, resume). */
  const [landingFraction, setLandingFraction] = useState(0);
  const [pageInfo, setPageInfo] = useState<SpreadInfo | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [drawingOpen, setDrawingOpen] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [contextMenuSelection, setContextMenuSelection] =
    useState<TtsSelection | null>(null);
  const [jump, setJump] = useState<PageJump | null>(null);
  const [reposition, setReposition] = useState<Reposition | null>(null);
  /** Slide direction for chapter-switch animation: -1 prev, 1 next, 0 none. */
  const [slideDir, setSlideDir] = useState<-1 | 0 | 1>(0);
  // Hyperlink history: stack of positions visited before clicking a link.
  const [linkHistory, setLinkHistory] = useState<HistoryEntry[]>([]);
  const [backButton, setBackButton] = useState<{
    side: "left" | "right";
  } | null>(null);
  // Titlebar hover: shows chrome when the cursor is near the top.
  const [headerVisible, setHeaderVisible] = useState(true);
  const headerHoverRef = useRef(false);
  const hideTimer = useRef<number | null>(null);
  // macOS native fullscreen: traffic lights vanish, move content left.
  const [isFullScreen, setIsFullScreen] = useState(false);
  /** Spread the TTS highlight sits on; reported by PagedChapter's auto-turn. */
  const [ttsSpread, setTtsSpread] = useState<number | null>(null);
  /** User manually hid the bar while listening (toggles via the header button). */
  const [barHidden, setBarHidden] = useState(false);
  const isMac = window.yumi.platform === "darwin";

  const nonceRef = useRef(1);
  const readerChapterPosRef = useRef(chapterPos);
  useEffect(() => {
    readerChapterPosRef.current = chapterPos;
  }, [chapterPos]);
  const payloadRef = useRef<ReaderPayload | null>(null);
  // Latest position for progress writes; chapterId 0 = nothing to save yet.
  const progressRef = useRef({ chapterPos: 0, chapterId: 0, fraction: 0 });
  const saveTimer = useRef<number | null>(null);

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
          Math.max(0, data.chapters.length - 1),
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

  const flushProgress = useCallback(() => {
    const data = payloadRef.current;
    const p = progressRef.current;
    if (!data || p.chapterId === 0 || data.chapters.length === 0) return;
    const bookProgress = (p.chapterPos + p.fraction) / data.chapters.length;
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

  // Context menu: right-click on reader content → show "Speak" if text selected.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sel = getTtsSelection();
    if (sel) {
      setContextMenuPos({ x: e.clientX, y: e.clientY });
      setContextMenuSelection(sel);
    }
  }, []);

  const dismissContextMenu = useCallback(() => {
    setContextMenuPos(null);
    setContextMenuSelection(null);
  }, []);

  // Reading-time heartbeat for the library goal/streak panel. Ticks only
  // while this window is visible and focused, so an idle-open book never
  // inflates the daily count.
  useEffect(() => {
    const TICK_MS = 15_000;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible" || !document.hasFocus())
        return;
      void window.yumi.invoke("reading:log", { seconds: TICK_MS / 1000 });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

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
      setSlideDir(pos > chapterPos ? 1 : pos < chapterPos ? -1 : 0);
      setLandingFraction(fraction);
      setChapterPos(pos);
    },
    [chapterPos, flushProgress],
  );

  const handleOverflow = useCallback(
    (dir: -1 | 1) => {
      // Forward overflows land on the next chapter's first page; backward
      // overflows land on the previous chapter's last page (Apple Books).
      goToChapter(chapterPos + dir, dir === 1 ? 0 : 1);
    },
    [chapterPos, goToChapter],
  );

  // TTS: independent playback position, decoupled from reader chapter.
  const tts = useTts(payload?.chapters ?? [], readerChapterPosRef);

  // Auto-advance reader chapter when TTS advances (only if reader was on the same chapter).
  const prevTtsChapterPosRef = useRef(tts.ttsChapterPos);
  useEffect(() => {
    const prev = prevTtsChapterPosRef.current;
    if (tts.ttsChapterPos !== prev) {
      prevTtsChapterPosRef.current = tts.ttsChapterPos;
      if (chapterPos === prev) {
        goToChapter(tts.ttsChapterPos, 0);
      }
    }
  }, [tts.ttsChapterPos, chapterPos, goToChapter]);

  // TTS bar appears only while TTS is reading and the user is on the spread
  // it reads from — not on other spreads, chapters, or when TTS is idle.
  // The user can hide it manually (barHidden) and toggle it back.
  const ttsBarVisible =
    tts.active &&
    chapterPos === tts.ttsChapterPos &&
    pageInfo?.spread === ttsSpread &&
    !barHidden;

  // Fragment target + nonce for scrolling after chapter mount (nonce forces re-fire).
  const [fragmentTarget, setFragmentTarget] = useState<{
    fragment: string | null;
    nonce: number;
  }>({ fragment: null, nonce: 0 });

  // Hyperlink navigation: push current position, jump to target chapter.
  const handleLinkNavigate = useCallback(
    (targetChapter: number, fragment: string | null) => {
      const fraction = pageInfo?.fraction ?? 0;
      setLinkHistory((prev) => [...prev, { chapterPos, fraction }]);
      setBackButton({ side: targetChapter < chapterPos ? "right" : "left" });
      if (targetChapter === chapterPos) {
        // Same-chapter link: stay in chapter, just scroll to fragment.
        setFragmentTarget((prev) => ({ fragment, nonce: prev.nonce + 1 }));
        return;
      }
      goToChapter(targetChapter, 0);
      setFragmentTarget((prev) => ({ fragment, nonce: prev.nonce + 1 }));
    },
    [chapterPos, pageInfo?.fraction, goToChapter],
  );

  // Back button: pop last history entry and return to it.
  const handleBack = useCallback(() => {
    const entry = linkHistory[linkHistory.length - 1];
    if (!entry) return;
    setLinkHistory((prev) => {
      const next = prev.slice(0, -1);
      if (next.length > 0) {
        const prevEntry = next[next.length - 1];
        setBackButton({
          side: prevEntry.chapterPos < entry.chapterPos ? "right" : "left",
        });
      } else {
        setBackButton(null);
      }
      return next;
    });
    setFragmentTarget({ fragment: null, nonce: 0 });
    if (entry.chapterPos === chapterPos) {
      // Same-chapter back: reposition without remounting PagedChapter.
      setReposition({ fraction: entry.fraction, nonce: nonceRef.current++ });
    } else {
      goToChapter(entry.chapterPos, entry.fraction);
    }
  }, [linkHistory, chapterPos, goToChapter]);

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
    [chapterPos, goToChapter],
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
    [chapterPos, goToChapter],
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
    [chapterPos, scheduleProgressSave],
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

  useEffect(() => {
    if (!isMac) return;
    window.yumi.isFullScreen().then(setIsFullScreen);
    const unlistenEnter = window.yumi.on("window:enterFullScreen", () =>
      setIsFullScreen(true),
    );
    const unlistenLeave = window.yumi.on("window:leaveFullScreen", () =>
      setIsFullScreen(false),
    );
    return () => {
      unlistenEnter();
      unlistenLeave();
    };
  }, [isMac]);

  const showHeader = useCallback(() => {
    headerHoverRef.current = true;
    setHeaderVisible(true);
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const hideHeader = useCallback(() => {
    headerHoverRef.current = false;
    hideTimer.current = window.setTimeout(() => {
      if (!headerHoverRef.current) setHeaderVisible(false);
      hideTimer.current = null;
    }, 400);
  }, []);

  const handleHeaderMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (e.clientY <= HEADER_HOVER_ZONE) {
        showHeader();
      } else if (headerHoverRef.current && e.clientY > HEADER_HOVER_ZONE + 20) {
        hideHeader();
      }
    },
    [showHeader, hideHeader],
  );

  // Book-wide page offsets: remeasure every chapter when layout/typography
  // changes. Chapter switches flap pageInfo through null with identical dims,
  // so cache by layout signature — a switch hits the cache instead of
  // re-laying-out every chapter (that synchronous remeasure was the
  // chapter-switch stall). Measured in an effect: React compiler lint forbids
  // writing the cache during render.
  // ponytail: DOM measure of all chapters in one effect; chunk if 200+
  // chapter books jank on resize/font change.
  const [colsByChapter, setColsByChapter] = useState<number[] | null>(null);
  const layoutKey = pageInfo
    ? [
        pageInfo.contentWidth,
        pageInfo.contentHeight,
        pageInfo.colWidth,
        pageInfo.colGap,
        settings.fontSize,
        settings.lineHeight,
      ].join("|")
    : null;
  useLayoutEffect(() => {
    if (!payload || !pageInfo || !layoutKey) return;
    let cols = colsCache.cols;
    if (colsCache.key !== layoutKey || colsCache.payload !== payload) {
      const layout = {
        contentWidth: pageInfo.contentWidth,
        contentHeight: pageInfo.contentHeight,
        colWidth: pageInfo.colWidth,
        colGap: pageInfo.colGap,
      };
      cols = payload.chapters.map((ch) =>
        countChapterCols(ch, layout, settings.fontSize, settings.lineHeight),
      );
      colsCache.key = layoutKey;
      colsCache.payload = payload;
      colsCache.cols = cols;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing state from an offscreen DOM measure, an external system React can't model.
    setColsByChapter(cols);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutKey encodes pageInfo dims + typography.
  }, [payload, layoutKey]);

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
      pageInfo.totalCols,
    );
    if (!colsByChapter) return chapterPos === 0 ? local : null;
    let prefix = 0;
    for (let i = 0; i < chapterPos; i++) prefix += colsByChapter[i] ?? 0;
    return prefix + local;
  })();

  return (
    <div
      className={`reader-${theme} relative flex h-screen flex-col overflow-hidden bg-reader font-ui text-reader`}
      onMouseMove={handleHeaderMouseMove}
    >
      {/* Chrome header — drag region for the frameless window.
           Shows on hover; left padding adjusts to fullscreen state so the
           content index slides to where the traffic lights used to be. */}
      <header
        className={`app-drag relative z-10 flex h-[52px] shrink-0 items-center justify-between pr-3 transition-all duration-300 ${
          isMac && !isFullScreen ? "pl-[78px]" : "pl-4"
        } ${
          headerVisible
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-full opacity-0"
        }`}
      >
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
            onClick={() => setDrawingOpen((v) => !v)}
            className={`rounded-[6px] p-1.5 transition-colors ${
              drawingOpen
                ? "text-reader"
                : "text-reader-muted hover:text-reader"
            }`}
            aria-label="Drawing panel"
            aria-pressed={drawingOpen}
          >
            <Pen size={17} strokeWidth={1.75} />
          </button>
          <button
            onClick={() => {
              setPanel(null);
              setAppearanceOpen((v) => !v);
            }}
            className={`rounded-[6px] px-1.5 py-1 text-[13px] font-medium leading-none transition-colors select-none ${
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
              if (tts.active) {
                if (
                  chapterPos === tts.ttsChapterPos &&
                  pageInfo?.spread === ttsSpread
                ) {
                  // On the reading position: toggle the bar.
                  setBarHidden((v) => !v);
                } else {
                  // Jump to the read-aloud position; the bar appears on arrival.
                  setBarHidden(false);
                  goToChapter(tts.ttsChapterPos, 0);
                  setJump({
                    blockIndex: tts.highlightBlockIndex ?? 0,
                    nonce: nonceRef.current++,
                  });
                }
              } else {
                // Idle: start reading from the current spread.
                setBarHidden(false);
                tts.start({
                  blockIndex: pageInfo?.firstVisibleBlockIndex ?? 0,
                  charOffset: 0,
                });
              }
            }}
            className={`rounded-[6px] p-1.5 transition-colors ${
              ttsBarVisible ||
              (tts.active &&
                !(
                  chapterPos === tts.ttsChapterPos &&
                  pageInfo?.spread === ttsSpread
                ))
                ? "text-reader"
                : "text-reader-muted hover:text-reader"
            }`}
            aria-label={
              tts.active &&
              !(
                chapterPos === tts.ttsChapterPos &&
                pageInfo?.spread === ttsSpread
              )
                ? "Jump to read-aloud position"
                : ttsBarVisible
                  ? "Hide read-aloud controls"
                  : "Show read-aloud controls"
            }
            aria-pressed={ttsBarVisible}
          >
            <Volume2 size={17} strokeWidth={1.75} />
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
        <div
          className={`relative flex min-h-0 flex-1 flex-col chapter-switch ${
            slideDir === 1 ? "slide-next" : slideDir === -1 ? "slide-prev" : ""
          }`}
          onAnimationEnd={() => setSlideDir(0)}
        >
          {tts.buffering && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 text-[11px] text-reader-muted">
              Generating audio…
            </div>
          )}
          <PagedChapter
            key={chapter.id}
            chapter={chapter}
            fontSize={settings.fontSize}
            lineHeight={settings.lineHeight}
            initialFraction={landingFraction}
            jump={jump}
            reposition={reposition}
            fragmentTarget={fragmentTarget}
            highlightBlockIndex={
              chapterPos === tts.ttsChapterPos ? tts.highlightBlockIndex : null
            }
            onTtsSpreadChange={setTtsSpread}
            onSpreadChange={handleSpreadChange}
            onOverflow={handleOverflow}
            onLinkNavigate={handleLinkNavigate}
            onContextMenu={handleContextMenu}
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

      {/* TTS control bar */}
      <TtsBar
        backend={tts.backend}
        onBackendChange={tts.setBackend}
        rate={tts.rate}
        onRateChange={tts.setRate}
        speaking={tts.speaking}
        paused={tts.paused}
        buffering={tts.buffering}
        onPlayPause={() => {
          if (tts.paused) {
            tts.resume();
          } else if (tts.speaking) {
            tts.pause();
          }
        }}
        onSkipBack={tts.skipBack}
        onSkipFwd={tts.skipFwd}
        onStop={tts.stop}
        voices={tts.voices}
        voice={tts.voice}
        onVoiceChange={tts.setVoice}
        visible={ttsBarVisible}
      />

      {/* Context menu */}
      <ContextMenu
        visible={contextMenuPos !== null}
        x={contextMenuPos?.x ?? 0}
        y={contextMenuPos?.y ?? 0}
        selection={contextMenuSelection}
        onSpeak={tts.start}
        onDismiss={dismissContextMenu}
      />

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

      {/* Drawing panel */}
      <FloatingPanel
        isOpen={drawingOpen}
        onClose={() => setDrawingOpen(false)}
      />
    </div>
  );
}
