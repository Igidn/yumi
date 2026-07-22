import { useLayoutEffect, useRef, useState } from "react";
import { LibraryView } from "./views/LibraryView";
import { ReaderView } from "./views/ReaderView";
import { SettingsView } from "./views/SettingsView";

type View = "library" | "settings" | "reader";

const NAV_ITEMS: { id: Exclude<View, "reader">; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const [view, setView] = useState<View>("library");
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState({ left: 0, width: 0 });

  // ponytail: skip ResizeObserver — buttons are fixed-size, won't shift on window resize
  useLayoutEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>(
      '[data-nav-active="true"]'
    );
    if (active) setPill({ left: active.offsetLeft, width: active.offsetWidth });
  }, [view]);

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
            <nav className="app-no-drag relative flex items-center gap-1.5" ref={navRef}>
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
                    className={`relative z-10 rounded-[6px] px-4 py-[9px] text-[13px] leading-none transition-colors ${
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

      <main className="h-full overflow-auto pt-[83px]">
        {view === "library" && (
          <LibraryView onOpenBook={() => setView("reader")} />
        )}
        {view === "settings" && <SettingsView />}
        {view === "reader" && <ReaderView />}
      </main>
    </div>
  );
}
