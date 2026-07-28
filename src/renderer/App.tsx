import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Book } from "../shared/types";
import { DuplicatePrompt } from "./components/DuplicatePrompt";
import { useImport } from "./hooks/useImport";
import { LibraryView } from "./views/LibraryView";
import { SettingsView } from "./views/SettingsView";

type View = "library" | "settings";

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const [view, setView] = useState<View>("library");
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });

  const { importing, importPaths, pendingDuplicate, resolveDuplicate } =
    useImport();

  // Apple Books flow: clicking a cover opens the book in its own window.
  const openBook = (book: Book) => {
    void window.yumi.invoke("reader:open", { id: book.id });
  };

  // Track nested dragenter/dragleave with a counter so the overlay doesn't
  // flicker when the cursor crosses child elements.
  const dragCounter = useRef(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  useLayoutEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>(
      '[data-nav-active="true"]',
    );
    if (active) setPill({ left: active.offsetLeft, width: active.offsetWidth });
  }, [view]);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounter.current += 1;
      setIsDraggingFiles(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Required to allow the subsequent drop.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setIsDraggingFiles(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setIsDraggingFiles(false);

      const files = Array.from(e.dataTransfer?.files ?? []);
      const paths = files
        .map((f) => window.yumi.getPathForFile(f))
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      if (paths.length > 0) void importPaths(paths);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [importPaths]);

  return (
    <div className="h-screen overflow-hidden bg-page font-ui text-ink">
      {/* Top strip + floating capsule navbar — the whole strip is the window drag region */}
      <header className="app-drag fixed inset-x-0 top-0 z-10 flex justify-center pt-[13px]">
        {/* Same max-width + padding as the search row below, so edges align */}
        <div className="w-full max-w-[551px] px-4">
          <div className="flex h-[44px] items-center justify-between rounded-[10px] bg-shell/80 px-4 shadow-shell backdrop-blur-sm">
            <span className="select-none font-logo text-[15px] leading-none text-ink">
              yumi
            </span>
            <nav
              className="app-no-drag relative flex items-center gap-1.5"
              ref={navRef}
            >
              <span
                aria-hidden
                className="pointer-events-none absolute top-0 h-full rounded-[6px] bg-pill shadow-shell transition-all duration-200 ease-out"
                style={{ left: pill.left, width: pill.width }}
              />
              {NAV_ITEMS.map((item) => {
                const active = view === item.id;
                return (
                  <button
                    key={item.id}
                    data-nav-active={active}
                    onClick={() => setView(item.id)}
                    className={`relative z-10 rounded-[6px] px-4 py-[9px] text-[12px] leading-none transition-colors ${
                      active ? "text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      </header>

      <main className="h-full overflow-auto pt-[83px] no-scrollbar">
        {view === "library" && (
          <LibraryView
            onOpenBook={openBook}
            importing={importing}
            importPaths={importPaths}
          />
        )}
        {view === "settings" && <SettingsView />}
      </main>

      {isDraggingFiles && <DropOverlay />}
      {pendingDuplicate && (
        <DuplicatePrompt
          pending={pendingDuplicate}
          onResolve={resolveDuplicate}
        />
      )}
    </div>
  );
}

function DropOverlay() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-page/70 backdrop-blur-sm"
    >
      <div className="flex h-[200px] w-[420px] flex-col items-center justify-center gap-3 rounded-[14px] border-2 border-dashed border-muted bg-shell/80 shadow-shell">
        <UploadIcon />
        <p className="text-[14px] text-ink">Drop to import</p>
        <p className="text-[12px] text-muted">.epub</p>
      </div>
    </div>
  );
}

function UploadIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
