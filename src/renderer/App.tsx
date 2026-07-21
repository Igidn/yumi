import { useState } from "react";
import { LibraryView } from "./views/LibraryView";
import { ReaderView } from "./views/ReaderView";

type View = "library" | "reader";

export default function App() {
  const [view, setView] = useState<View>("library");

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      <aside className="flex w-56 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="p-4">
          <h1 className="text-lg font-semibold tracking-tight">Yumi</h1>
        </div>
        <nav className="flex-1 px-2">
          <button
            onClick={() => setView("library")}
            className={`w-full rounded px-3 py-2 text-left text-sm font-medium transition-colors ${
              view === "library"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100"
            }`}
          >
            Library
          </button>
          <button
            onClick={() => setView("reader")}
            className={`w-full rounded px-3 py-2 text-left text-sm font-medium transition-colors ${
              view === "reader"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100"
            }`}
          >
            Reader
          </button>
        </nav>
      </aside>

      <main className="flex-1 overflow-auto">
        {view === "library" ? <LibraryView /> : <ReaderView />}
      </main>
    </div>
  );
}
