# Yumi Roadmap

Derived from SPEC.md. Milestones are ordered by dependency, not by spec section number. Each milestone lists the spec sections it covers and ends with a testable exit condition.

Current state: Electron + React + Vite scaffold boots, sql.js + Drizzle connect in the main process, a partial schema exists (books, chapters, annotations, notes, drawings, appSettings). No features are implemented.

## Why this order

- **EPUB before PDF.** EPUB is zipped XHTML, so the first reader needs no OCR. PDF import depends on the Unlimited-OCR pipeline, the biggest technical unknown in the spec.
- **Notes and drawing before the agent.** They have no external dependencies and they build the text-selection and position-anchoring machinery the agent features reuse.
- **On-demand agent before import-time pre-expansion.** The manual path (highlight, right-click, explain) validates context assembly and prompt design before the same code runs unattended on every chapter.
- **TTS after the agent.** Agent-prepared audio text (SPEC §7) depends on the agent context builder from M4.
- **Search late.** It needs a library worth searching, and its FTS index rides on tables that already exist by then.

## M0: Foundation

Spec: §11, §13. The scaffold runs but has gaps that will bite later.

- [x] Remove `better-sqlite3` from package.json dependencies. It is a leftover; sql.js replaced it (see TECH_STACK.md) and its native build is the known failure.
- [x] Add the missing `src/main/migrate.ts` or fix the `db:migrate` script, which points at a file that does not exist.
- [x] Fix write persistence in `src/main/database.ts`: it currently exports the whole database to disk on every `run()` call. Debounce writes (for example 500 ms after the last mutation), save on `before-quit`, and confirm Drizzle's writes actually pass through the wrapped `run()` rather than bypassing it via prepared statements.
- [x] Remove or comment the `PRAGMA journal_mode = WAL` line. It is a no-op for an in-memory sql.js database and misleads readers.
- [x] Confirm FTS5 is available in the bundled sql.js build (`CREATE VIRTUAL TABLE ... USING fts5`). M7 depends on it; better to know now.
- [x] Typed IPC layer: channel names and payload types in `src/shared/types.ts`, `ipcMain.handle` wrappers in main, matching `invoke` methods on the preload bridge.
- [x] App shell layout: floating top navigation bar (Library / Settings) plus content area, with a library view and a reader view. Matches the Penpot "Library page" design.
- [x] electron-store wiring for window bounds and last-opened book.

**Done when:** `npm run dev` boots, a value round-trips renderer → main → SQLite → disk, and it survives an app restart.

## M1: Reader MVP (EPUB)

Spec: §1 (import, trash), §2 (typography basics, dark mode), §3 (baseline navigation and progress). First end-to-end value: import a book, read it, resume where you stopped.

- [ ] EPUB parser in the main process: unzip, read OPF spine, split into chapters, convert XHTML to structured blocks (headings, paragraphs) stored in `chapters.rawText`.
- [ ] Import: drag-and-drop onto the window and dock icon, plus a file dialog. Copy the file into `books/` in the app support directory; the original is untouched.
- [x] Duplicate detection by filename plus SHA-256 hash, with a skip/replace prompt.
- [ ] Library view: cover, title, author; sort by title, author, last opened, import date; live search over title and author.
- [ ] Reader view: render chapter blocks; font size and line-height controls; dark mode toggle.
- [ ] Navigation: scrolling, previous/next chapter (`Cmd+[` / `Cmd+]`), TOC sidebar with click-to-jump, minimal `Cmd+K` palette for chapter jump.
- [ ] Vim toggle (first slice): `j/k`, `gg`, `G`, `Ctrl+d/u`. The rest of the keymap lands in M8.
- [ ] Reading progress: save scroll position per chapter on every navigation event, resume on open, progress bar at the bottom.
- [ ] Trash: soft delete via the existing `trashed` column, trash view, restore, empty-with-confirmation showing the item count.

**Done when:** import an EPUB, read, quit, reopen: same book, same scroll position. A deleted book sits in trash, restores, and the empty-trash dialog shows the count.

## M2: PDF and OCR pipeline

Spec: §1 (PDF import), §2 (layout-preserving text, KaTeX, figures, tables, lightbox). Highest-risk milestone, so it starts with a spike.

- [ ] **Spike first, timeboxed:** run Unlimited-OCR 4-bit GGUF through llama.cpp on three real textbook pages (prose, math-heavy, figure-plus-table). Judge whether the output is good enough to drive §2 rendering. If not, evaluate alternatives before building anything else.
- [ ] Born-digital shortcut: for PDFs with an embedded text layer, extract text and positions with pdf.js and skip OCR entirely. Reserve OCR for scanned books. Most real textbooks take the cheap path.
- [ ] OCR sidecar: spawn llama.cpp as a child process from main, stream results, kill on quit. Model file lives in the app support directory, downloaded on first PDF import.
- [ ] Chapter detection: PDF bookmarks/outline first, page-range fallback.
- [ ] Figure extraction: images and captions stored as files on disk, paths in the database, placed inline at their original positions.
- [ ] Tables rendered as table elements, not text art.
- [ ] Math spans rendered with KaTeX.
- [ ] Figure lightbox with zoom and pan.

**Done when:** a real textbook PDF imports and its chapters show formatted text, working equations, and figures in place; the lightbox zooms.

## M3: Notes and drawing

Spec: §4, §5. All user-authored features; no network calls.

- [ ] Mode state machine: read mode (`esc`) and draw mode (`i`), with a status-bar indicator.
- [ ] Draw mode: Excalidraw as a transparent overlay. Pointer events go to the canvas, scrolling passes through to the text, the canvas scrolls in sync, text selection is disabled.
- [ ] **Prototype checkpoint:** scroll-synced overlay is the hard part. If Excalidraw fights this, fall back to a custom Canvas2D layer storing rough.js stroke data, which the spec explicitly allows.
- [ ] Tools: pen (color, opacity, stroke width), highlighter, eraser, per-stroke undo/redo.
- [ ] Drawing persistence: stroke JSON in the `drawings` table, per chapter, autosaved.
- [ ] Highlight notes: select text in read mode, tag via hotkey or context menu, optional attached comment, color coding.
- [ ] Notes sidebar: collapsible, ordered by position, click to jump to the highlight.
- [ ] Chapter notes: free-form, attached to the chapter, opened from the chapter header.
- [ ] Margin notes: drawings placed beside the text column (a convention on top of the overlay, not a separate feature).

**Done when:** highlight → note → sidebar → jump back works, and strokes survive switching chapters and restarting the app.

## M4: Agent

Spec: §6. Adds the first network dependency.

- [ ] Agent settings: provider and model per book, pre-expansion depth (none / gaps only / full rewrite), API keys in the system keychain via Electron `safeStorage`. New table or columns for per-book agent config.
- [ ] On-demand explanation first: highlight a span → right-click → help (with an optional details prompt) → explanation inserted as a new annotation. This validates the context builder (surrounding paragraph + highlighted span + chapter topic) before it runs unattended.
- [ ] Annotation UI: subtle `[▶]` markers, click or hotkey toggles collapse, expanded text pushes surrounding text down, collapsed state persisted per chapter, delete for any annotation.
- [ ] Import-time pre-expansion: background job queue, one chapter at a time. The book is readable immediately; annotations appear progressively. Also writes chapter summary and prerequisites (new columns on `chapters`).
- [ ] Simplify section: selected span → simpler rewrite rendered as an expandable alternative, original always visible.
- [ ] Ask agent: `Cmd+Shift+A` chat panel with the current chapter and the user's notes as context.
- [ ] Local model option: Ollama endpoint alongside OpenRouter.

**Done when:** importing a book with depth "gaps only" produces progressive per-chapter annotations, and on-demand explanation and chat share the same context builder.

## M5: Library management and export

Spec: §1 (organize, export). Export comes after M4 because annotated export includes agent expansions.

- [ ] Collections: new `collections` table plus a `book_collections` join table (one book, many collections); UI to create, rename, assign.
- [ ] Filters: format, collection, read/unread, has notes.
- [ ] Export annotated book as standalone HTML or Markdown with inline expansions, notes, and drawings.
- [ ] Export notes only, as Markdown, plain text, or JSON.
- [ ] Export drawings as PNG alongside a book export.

**Done when:** a chapter with annotations, notes, and drawings exports to a single HTML file that reads like the in-app view.

## M6: Text-to-speech

Spec: §7.

- [ ] Playback from any scroll position: play/pause, skip by sentence or paragraph, 0.5x–3x speed.
- [ ] Voices: system voices via the Web Speech API first; Kokoro/Edge TTS behind the same interface after.
- [ ] Visual tracking: highlight the spoken sentence, auto-scroll to follow.
- [ ] Math-to-speech: deterministic converter for inline math ("x²" → "x squared"). Algorithm, no LLM, per the spec.
- [ ] Agent-prepared audio text (optional, per book): tables to prose, section-transition cues. Fed only to the TTS engine; the visible text never changes.

**Done when:** starting playback mid-chapter reads to the end with correct highlighting, scrolling, and spoken math.

## M7: Search

Spec: §8 (minus semantic search).

- [ ] In-book search: `Cmd+F`, scope toggle (chapter / whole book), sidebar results with surrounding context, click to jump, regex toggle.
- [ ] Library-wide search: `Cmd+Shift+F`, results grouped by book and chapter, includes notes and highlights.
- [ ] Index: FTS5 virtual tables over chapter text and notes (pending the M0 confirmation that sql.js ships FTS5); fall back to `LIKE` queries if not.

**Done when:** a phrase from chapter 9 of one book is findable from the library screen in a single query.

## M8: Full vim navigation and customization

Spec: §3 (remaining keymap), §10.

- [ ] Remaining keymap: `[number]G`, `[number]%`, `[[` / `]]` section jumps, `[` / `]` annotation jumps, `Ctrl+o` / `Ctrl+i` scroll history.
- [ ] Global command palette: `Cmd+Shift+K` across all books, chapters, and notes.
- [ ] Every shortcut rebindable; cheat sheet on `?`.
- [ ] Themes: light, dark, sepia, custom colors. Separate font slots for body, headings, code, math.
- [ ] Bundle OpenDyslexic and Atkinson Hyperlegible.
- [ ] Per-book typography defaults with a global override.
- [ ] Focus mode (no chrome, no markers, full-screen text) and minimal-chrome mode.

**Done when:** every §3 shortcut works with vim mode on, every shortcut is rebindable, and theme changes persist across restarts.

## M9: Accessibility, backup, release

Spec: §11 (backup), §12, §14. The v1 gate.

- [ ] ARIA labels on all interactive elements; screen reader pass over the core loop.
- [ ] Full keyboard reachability audit: no feature requires a mouse.
- [ ] High contrast mode with configurable ratio; reduced motion option; font scale to 3x with reflow.
- [ ] Manual backup: export the whole library (database file plus books/ plus figures) as a zip. Optional watched folder for automatic backup.
- [ ] electron-builder DMG with signing and notarization.

**Done when:** VoiceOver completes import → read → note → ask agent, and a fresh Mac installs and runs from the DMG.

## v2+ backlog

Not scheduled. Each is independent of the others.

- Flashcards from highlights, SM-2 scheduling, per-book or global decks, Anki export (§9)
- Semantic search with a per-book embeddings index, opt-in per book (§8)
- Reading goals, streaks, weekly/monthly stats (§9)
- Dictionary popup, multiple sources, Japanese furigana/romaji/decomposition/JLPT (§9)
- Windows and Linux builds (§14)
- Auto-update via electron-builder
- Bookmarks (SPEC appendix: explicitly not v1)

## Risks

1. **OCR quality gates all of §2.** The M2 spike settles it before rendering work begins, and the born-digital shortcut keeps most PDFs off the OCR path entirely.
2. **Excalidraw scroll sync.** The M3 checkpoint exists because a transparent third-party canvas tracking text scroll is unproven. The fallback (custom rough.js Canvas2D) is spec-sanctioned.
3. **sql.js write amplification.** Every mutation exports the whole database. Fine while the library is small; figures live on disk so the database stays small. The M0 debounce covers it; if libraries grow past a few hundred MB of text, revisit persistence.
4. **Agent cost and latency.** Pre-expansion on a 40-chapter textbook is a lot of tokens. Per-book depth settings and the Ollama option are the controls; both land in M4, not after.
5. **Scope.** M1 alone is a usable reader. If momentum drops, the cut line for a smaller v1 is M0–M4 plus M6 and M9; M5, M7, and M8 can slip to v1.1 without blocking anything.
