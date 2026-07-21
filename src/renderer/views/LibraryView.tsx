import { useEffect, useState } from "react";
import type { Book } from "@shared/types";

export function LibraryView() {
  const [books, setBooks] = useState<Book[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [fts5, setFts5] = useState<boolean | null>(null);
  const [roundTrip, setRoundTrip] = useState<string | null>(null);

  const loadBooks = async () => {
    const list = await window.yumi.invoke("books:list");
    setBooks(list);
  };

  const addBook = async () => {
    if (!newTitle.trim()) return;
    await window.yumi.invoke("books:insert", {
      title: newTitle,
      author: "M0 Test",
      format: "epub",
    });
    setNewTitle("");
    await loadBooks();
  };

  useEffect(() => {
    loadBooks();
    window.yumi.invoke("db:fts5").then(setFts5);

    // Round-trip test: write a value to SQLite via main and read it back.
    (async () => {
      const testKey = "m0_round_trip";
      await window.yumi.invoke("settings:set", {
        key: testKey,
        value: "survived",
      });
      const value = await window.yumi.invoke("settings:get", { key: testKey });
      setRoundTrip(value);
    })();
  }, []);

  return (
    <div className="flex h-full flex-col p-8">
      <h1 className="mb-4 text-2xl font-semibold">Library</h1>

      <div className="mb-6 space-y-2 text-sm text-zinc-400">
        <p>Platform: {window.yumi.platform}</p>
        <p>FTS5 available: {fts5 === null ? "checking…" : fts5 ? "yes" : "no"}</p>
        <p>Round-trip value: {roundTrip ?? "…"}</p>
      </div>

      <div className="mb-6 flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Book title"
          className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
        />
        <button
          onClick={addBook}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          Add test book
        </button>
      </div>

      {books.length === 0 ? (
        <p className="text-zinc-500">No books yet.</p>
      ) : (
        <ul className="space-y-2">
          {books.map((book) => (
            <li
              key={book.id}
              className="rounded border border-zinc-800 bg-zinc-900 p-4"
            >
              <p className="font-medium text-zinc-100">{book.title}</p>
              <p className="text-sm text-zinc-400">{book.author}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
