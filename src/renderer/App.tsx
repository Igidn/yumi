import { useState } from "react";
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

  return (
    <div className="h-screen overflow-hidden bg-page font-ui text-ink">
      {/* Floating capsule navbar — doubles as the window drag region */}
      <header className="pointer-events-none fixed inset-x-0 top-[19px] z-10 flex justify-center px-4">
        <div className="app-drag pointer-events-auto flex h-[63px] w-full max-w-[551px] items-center justify-between rounded-[10px] bg-shell/80 px-6 shadow-shell backdrop-blur-sm">
          <span className="select-none font-logo text-[17px] leading-none text-ink">
            yumi
          </span>
          <nav className="app-no-drag flex items-center gap-2">
            {NAV_ITEMS.map((item) => {
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setView(item.id)}
                  className={`rounded-[10px] px-4 py-[13px] text-[13px] leading-none transition-colors ${
                    active
                      ? "bg-pill text-ink"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Content starts below the capsule (19 + 63 + 30 = 112, per design) */}
      <main className="h-full overflow-auto pt-[112px]">
        {view === "library" && (
          <LibraryView onOpenBook={() => setView("reader")} />
        )}
        {view === "settings" && <SettingsView />}
        {view === "reader" && <ReaderView />}
      </main>
    </div>
  );
}
