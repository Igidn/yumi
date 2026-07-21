# Ebook Reader — Full Feature Specification

## 1. Library

**Import**
- Drag-and-drop one or multiple files onto the app window or dock icon.
- Supported formats: PDF, EPUB. More added as conversion pipelines mature.
- On import: file is copied to internal storage (`~/Library/Application Support/[app]/books/`). Original is untouched. This is the backup.
- Duplicate detection by filename + file hash. Offers to skip or replace.

**Organize**
- User-created collections (folders/tags). One book can belong to multiple collections.
- Sort by: title, author, last opened, import date, reading progress.
- Filter by: format, collection, read/unread, has notes.
- Search across library metadata (title, author) with live results.

**Trash**
- Deleting a book moves it to an internal trash folder. Remains recoverable until explicitly emptied.
- Empty trash requires confirmation with count of items.

**Export**
- Export a book's annotated text as standalone HTML or Markdown (with inline agent expansions, notes, drawings).
- Export notes only as plain text or JSON.

---

## 2. Reading Surface

**Text Rendering**
- Formatted text preserving spatial layout from OCR (indentation, paragraph spacing, line breaks).
- Inline LaTeX equations rendered with KaTeX.
- Inline figures extracted from the original PDF and placed at their original positions.
- Tables rendered as proper tables, not text art.

**Agent Annotations**
- Pre-generated annotations appear as subtle `[▶]` markers next to sentences the agent flagged during import.
- Click or hotkey toggles between collapsed (original text only) and expanded (agent clarification inserted inline, pushing surrounding text down).
- On-demand annotations: highlight any text span → hit hotkey → agent generates explanation inserted as a new annotation at that position.
- Annotation state (collapsed/expanded) is per-user, persisted per chapter.
- User can delete any annotation (both pre-generated and on-demand).

**Figures & Media**
- Extracted figures displayed inline with captions from original PDF.
- Click figure to open full-resolution view in a lightbox.
- Zoom and pan in lightbox.

**Reading Modes**
- Normal: annotated text with optional drawing overlay.
- Focus: hides all UI chrome, annotation markers, and notes sidebar. Full-screen text only.
- Dark mode: light text on dark background. Toggle via system setting or app shortcut.

**Typography**
- Font family, size, line height, paragraph spacing — all configurable.
- Per-book defaults with global override.
- OpenDyslexic and Atkinson Hyperlegible as built-in accessibility font options.

---

## 3. Navigation (For vim-based nav specifically This will be a toggle)

**Within a Chapter**
- Scroll: standard trackpad/mouse scrolling, `j/k` line-by-line, `Ctrl+d/u` half-page.
- Jump: `gg` top, `G` bottom, `[number]G` to line, `[number]%` to percentage position.
- Section jump: `[[` / `]]` previous/next section heading.
- Annotation jump: `[` / `]` previous/next annotation marker.
- Back/forward: `Ctrl+o` / `Ctrl+i` through scroll position history.

**Between Chapters**
- `Cmd+[` / `Cmd+]`: previous/next chapter.
- `Cmd+K` command palette: type chapter name or number to jump.
- Table of contents sidebar: click to jump.

**Between Books**
- `Cmd+Shift+K`: global command palette. Search across all books, chapters, and notes. Select to open.

**Reading Progress**
- Scroll position saved per chapter on every navigation event. Resume reading at the exact scroll position.
- Visual progress indicator (progress bar at bottom or scrollbar marker).

---

## 4. Drawing & Annotation Overlay

**Modes**
- Read mode (`esc`): standard reading, clicks select text, scrolling navigates.
- Draw mode (`i`): the drawing canvas renders as a transparent overlay on top of the text. Clicks and drags draw on the overlay; the text underneath remains fully visible and unchanged. Scrolling is passed through to the text layer — the drawing canvas scrolls in sync with the text.
- In draw mode, text selection is disabled. All pointer events go to the drawing canvas.
- Visual indicator in the status bar shows current mode.

**Drawing Tools**
- Pen tool with configurable color, opacity, and stroke width.
- Highlighter tool (semi-transparent broad stroke).
- Eraser tool.
- Undo/redo per stroke.
- Canvas is per-chapter, saved automatically.

**Drawing Persistence**
- Drawings stored as vector stroke data (rough.js format) in the chapter file.
- Export drawings as PNG alongside book export.

---

## 5. Notes

**Highlight Notes**
- In read mode, select text → tag as note via hotkey or context menu.
- Optional: attach a text note to the highlight.
- Highlights appear in a collapsible sidebar panel, ordered by position in the chapter.
- Click a highlight in the sidebar to jump to its position in the text.

**Margin Notes**
- In draw mode, write or draw in margins. These are regular drawings but visually positioned to the side of the text column.

**Chapter Notes**
- Free-form note attached to the entire chapter (not anchored to specific text). Accessible from the chapter header.

**Note Management**
- Notes scoped to book + chapter.
- Search across all notes in a book or across the entire library.
- Export notes as Markdown, plain text, or JSON.
- Color-code notes for categorization.

---

## 6. Agent (LLM Integration)

**Import-Time Pre-Expansion (automatic)**
- On book import, the agent processes each chapter:
  1. Detects "gaps" — sentences where understanding breaks (e.g., "clearly we get...", "it follows that...").
  2. Generates expanded explanations for each gap.
  3. Marks these as pre-generated annotations in the chapter data.
  4. Also produces a "chapter summary" and "prerequisites" metadata.
- Pre-expansion runs as a background job. The book is readable immediately (without annotations) while the agent works.
- Annotations appear progressively as the agent finishes each chapter.

**On-Demand Explanation (manual)**
- Student highlights any text span → right click -> help (add details prompt, if user wanted) → agent generates explanation.
- Context: the agent receives the surrounding paragraph, the highlighted span, and the chapter's topic.
- Explanation rendered as a new annotation at the highlight position.

**Text Simplification**
- "Simplify this section" command: agent rewrites a selected section in simpler language.
- Rendered as an expandable alternative — original text always visible underneath.
- Useful before TTS (see below) and for difficult passages.

**Ask Agent (conversational)**
- `Cmd+Shift+A`: open agent chat panel.
- Student asks free-form questions about the current book/chapter/topic.
- Agent has full context of the current chapter + student's notes.
- Responses can reference specific positions in the text.

**Agent Configuration**
- Choose model/provider per book (some subjects benefit from stronger models).
- Adjust pre-expansion depth (none / gaps only / full rewrite).
- Per-book agent settings saved.

---

## 7. Text-to-Speech

**Playback**
- Read-aloud of the current chapter from any scroll position.
- Voice selection (system voices + custom Kokoro/Edge TTS voices).
- Speed control (0.5x – 3x).
- Play/pause, skip forward/back by sentence or paragraph.

**Agent-Prepared Audio Text**
- Before TTS playback, the agent optionally simplifies the text for listening:
  - Expands inline math to spoken form ("x squared" instead of "x²"). (For inline math specifically we can just write an algorithm to do this task; Faster & Cheaper.)
  - Converts tables to descriptive prose.
  - Adds verbal cues for section transitions ("Moving on to...").
- The simplified text is not shown to the student — it's only fed to the TTS engine. The visual text remains unchanged.
- Toggle on/off per book.

**Visual Tracking**
- Current spoken sentence is highlighted in the text.
- Auto-scroll follows playback.

---

## 8. Search

**Within Current Book**
- `Cmd+F`: search within the current chapter or entire book.
- Results displayed in a sidebar panel with surrounding context.
- Click result to jump to position.
- Regex support toggle.

**Library-Wide Search**
- `Cmd+Shift+F`: full-text search across all imported books.
- Results grouped by book + chapter.
- Supports searching within notes and highlights too.

**Semantic Search (v2+)**
- Natural language queries: "find where the book discusses the chain rule."
- Requires embeddings index per book. Optional, can be enabled per book to save disk space.

---

## 9. Learning Tools

**Flashcards (v2+)**
- From any highlight, generate a flashcard (question on front, answer/context on back).
- Spaced repetition scheduling (SM-2 algorithm).
- Deck scoped per book or global.
- Export flashcards to Anki-compatible format.

**Reading Goals**
- Daily page/section target.
- Streak tracking.
- Weekly/monthly reading stats (pages read, time spent, notes taken).

**Dictionary**
- Double-click any word → inline definition popup.
- Supports multiple dictionary sources (system dictionary, Wiktionary, custom).
- For Japanese: furigana ＆ romaji rendering, word decomposition, JLPT level tagging.

---

## 10. Customization

**Appearance**
- Themes: light, dark, sepia, custom (user-defined colors).
- Font selection for body text, headings, code, and math.
- Line spacing, margin width, text alignment.
- Full-screen and minimal-chrome modes.

**Keyboard**
- All shortcuts rebindable. Defaults follow vim conventions where applicable.
- Shortcut cheat sheet accessible via `?` key.

---

## 11. Data & Privacy

**Storage**
- All data stored locally in `~/Library/Application Support/[app]/`.
- SQLite database for all structured data (books, chapters, annotations, notes, drawings, reading progress).
- Figures and extracted images stored as files on disk, referenced by path in the database.
- Single SQLite file per library. Easy to back up, query, and inspect.
- Why SQLite over JSON files: relational queries (all notes across a book, annotations by chapter, search by tag), foreign key integrity (no orphaned annotations when a chapter is deleted), concurrent read/write safety via WAL mode, and no hand-rolled parsing or merge conflicts.

**Backup & Sync**
- Manual backup: export entire library as a zip archive.
- Optional: watch a folder for automatic backup on file change.

**Privacy**
- Agent API calls send only the text needed for the current query. No telemetry, no analytics, no account required.
- API keys stored in system keychain.
- Option to use a fully local agent (local LLM via Ollama/llama.cpp).

---

## 12. Accessibility

- Full keyboard navigation (no mouse required for any feature).
- Screen reader support (ARIA labels on all interactive elements in the web-based UI).
- High contrast mode with configurable contrast ratio.
- Reduced motion option (disables scroll animations).
- Font size scale up to 3x with reflow.

---

## 13. Tech Stack

- **App shell**: Electron (mature, no IPC translation layer, browser-native features work as documented)
- **Frontend**: TypeScript + React (or Svelte, your call)
- **Database**: SQLite via `better-sqlite3` (synchronous, zero-config, main-thread-safe native bindings)
- **OCR**: Unlimited-OCR 4-bit GGUF via llama.cpp (runs once on import, out-of-process)
- **Agent**: Any LLM (OpenRouter API or local) — called during import for pre-expansion, called on-demand for highlight queries
- **Text rendering**: KaTeX for math + custom React renderer for formatted text
- **Drawing**: Excalidraw or rough.js Canvas2D overlay
- **Storage**: `~/Library/Application Support/[app]/` for images + SQLite database

---

## 14. Platform Support

- **v1**: macOS (Electron). Primary target.
- **v2**: Windows and Linux (Electron cross-platform).

## Appendix A: Term Equivalents

This spec uses terms consistently. No two terms mean the same thing:

- **Annotation**: Text generated by the agent, inserted inline, toggleable. Always agent-authored.
- **Note**: User-authored. A highlighted text span plus optional user-written comment. Never agent-authored.
- **Drawing**: Freehand strokes on the overlay canvas. Not attached to specific text.
- **Highlight**: The act of selecting text to create a note or trigger an agent annotation.
- **Bookmark**: (Not implemented in v1). A saved position in a book with an optional label.
