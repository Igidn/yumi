export type Platform = "darwin" | "win32" | "linux";

export type BookFormat = "epub";

export type TtsBackend = "edge" | "kokoro" | "web";

export interface TtsVoice {
  name: string;
  lang: string;
  id: string;
}

export interface TtsSelection {
  blockIndex: number;
  charOffset: number;
}

/** One word spoken in a synthesized segment, timed against that segment's audio. */
export interface WordBoundary {
  /** Seconds from the segment audio start. */
  time: number;
  /** Seconds. */
  duration: number;
  /** Word text; used for debug/alignment only. */
  text: string;
}

/** Result of synthesizing one TTS segment. */
export interface TtsSpeakResult {
  audioBase64: string;
  mimeType: string;
  words: WordBoundary[];
}

export interface Book {
  id: number;
  title: string;
  author: string;
  format: BookFormat;
  sourcePath: string;
  // SHA-256 of the imported file content; the dedup key (SPEC §1).
  sha256: string | null;
  coverPath: string | null;
  importedAt: string;
  lastOpenedAt: string | null;
  progress: number;
  // Progress before a manual "mark finished"; null when not finished that way.
  priorProgress: number | null;
  // First time progress reached 1; null while unfinished.
  finishedAt: string | null;
  collection: string;
  trashed: number;
}

/** Snapshot for the library "Reading goal" panel. */
export interface ReadingStats {
  // Daily goal in minutes (user-configurable, stored in app_settings).
  goalMinutes: number;
  // Active reading time logged for today.
  todaySeconds: number;
  // Consecutive days (ending today/yesterday) the goal was met.
  streakDays: number;
  // Longest goal-completion streak ever.
  bestStreakDays: number;
  // Books finished in the current calendar year, most recent first.
  booksReadThisYear: Book[];
}

/**
 * One-way main → renderer notifications. Distinct from `IPCChannel` so the
 * preload bridge can type `on()` separately from the request/response `invoke()`.
 */
export type YumiEvent =
  | "library:changed"
  | "window:enterFullScreen"
  | "window:leaveFullScreen"
  | "drawing:scene-updated";

export interface DrawingTab {
  id: string;
  label: string;
  createdAt: string;
}

/**
 * Serialized Excalidraw scene, stored as a JSON string in `tabs.scene_data`.
 * Loosely typed here because `shared/` is consumed by the main process too;
 * the renderer restores it into real Excalidraw types.
 */
export interface SceneBlob {
  elements: readonly unknown[];
  appState: Record<string, unknown>;
}

/** A flat, renderer-ready block extracted from a chapter's XHTML. */
export interface ContentBlock {
  type: "heading" | "paragraph" | "image";
  level?: number; // heading level 1–6
  text: string;
  /**
   * Minimal inline markup for this block, built by the EPUB parser from a
   * strict whitelist: only <em>/<strong>/<br>, no attributes, all text
   * escaped. Present only when the block actually contains markup, so it is
   * safe to inject via dangerouslySetInnerHTML.
   */
  html?: string;
  /** Image blocks only: path relative to userData root, served via yumi://asset/ */
  src?: string;
  /** Natural image dimensions (pixels), so the browser can reserve space before load. */
  imgWidth?: number;
  imgHeight?: number;
  /** Fragment anchor ID from the source XHTML — used for hyperlink scroll targets. */
  fragment?: string;
}

/** A chapter as shipped to the reader window (blocks parsed from rawText). */
export interface ReaderChapter {
  id: number;
  title: string;
  /** Order within the book, matching the OPF spine. */
  index: number;
  /** Saved reading position inside this chapter, 0–1. */
  scrollPosition: number;
  blocks: ContentBlock[];
}

/** Everything the reader window needs to render a book, in one round-trip. */
export interface ReaderPayload {
  book: Book;
  chapters: ReaderChapter[];
  /** Position in `chapters` to resume at (derived from books.progress). */
  resumeChapterPos: number;
}

export type IPCChannel =
  | "settings:get"
  | "settings:set"
  | "books:list"
  | "books:insert"
  | "books:update"
  | "books:delete"
  | "books:reveal"
  | "reader:open"
  | "reader:load"
  | "reader:progress"
  | "reading:log"
  | "reading:stats"
  | "import:book"
  | "dialog:openFile"
  | "dialog:openImage"
  | "db:fts5"
  | "window:isFullScreen"
  | "drawing:load-tabs"
  | "drawing:load-scene"
  | "drawing:save-scene"
  | "drawing:create-tab"
  | "drawing:rename-tab"
  | "drawing:delete-tab"
  | "drawing:clear-tab"
  | "tts:speak"
  | "tts:stop"
  | "tts:voices";

/** Result of an `import:book` call (SPEC §1 duplicate handling). */
export type ImportOutcome =
  | { status: "imported"; book: Book }
  | { status: "duplicate"; existingBook: Book }
  | { status: "skipped"; existingBook: Book };

export interface IPCPayloads {
  "settings:get": { key: string };
  "settings:set": { key: string; value: string };
  "books:list": void;
  "books:insert": { title: string; author: string; format: BookFormat };
  "books:update": {
    id: number;
    title?: string;
    author?: string;
    // 0–1 reading progress; 1 = finished.
    progress?: number;
    // Restore progress stashed when the book was marked finished.
    restoreProgress?: boolean;
    // Absolute path to a new cover image; main copies it into covers/.
    coverSourcePath?: string;
  };
  "books:delete": { id: number };
  "books:reveal": { id: number };
  // Library → main: open (or focus) the reader window for a book.
  "reader:open": { id: number };
  // Reader window → main: request book + chapters for rendering.
  "reader:load": { id: number };
  "reader:progress": {
    bookId: number;
    chapterId: number;
    // 0–1 position inside the chapter.
    chapterPosition: number;
    // 0–1 position across the whole book.
    bookProgress: number;
  };
  // Reader window heartbeat: active reading time to log for today.
  "reading:log": { seconds: number };
  "reading:stats": void;
  "import:book": {
    sourcePath: string;
    // Resolution for a detected duplicate. Omit ("prompt") to detect and
    // return `{ status: "duplicate" }` without writing; "skip" keeps the
    // existing book; "replace" deletes the existing book then imports.
    duplicateHandling?: "skip" | "replace";
  };
  "dialog:openFile": void;
  "dialog:openImage": void;
  "db:fts5": void;
  "window:isFullScreen": void;
  "drawing:load-tabs": void;
  "drawing:load-scene": { tabId: string };
  "drawing:save-scene": { tabId: string; sceneData: string };
  "drawing:create-tab": { label: string };
  "drawing:rename-tab": { tabId: string; label: string };
  "drawing:delete-tab": { tabId: string };
  "drawing:clear-tab": { tabId: string };
  "tts:speak": { text: string; voice: string | null; rate: number };
  "tts:stop": void;
  "tts:voices": void;
}

export interface IPCResponses {
  "settings:get": string | null;
  "settings:set": void;
  "books:list": Book[];
  "books:insert": Book;
  "books:update": Book;
  "books:delete": void;
  "books:reveal": void;
  "reader:open": void;
  "reader:load": ReaderPayload;
  "reader:progress": void;
  "reading:log": void;
  "reading:stats": ReadingStats;
  "import:book": ImportOutcome;
  "dialog:openFile": string[];
  "dialog:openImage": string | null;
  "db:fts5": boolean;
  "window:isFullScreen": boolean;
  "drawing:load-tabs": DrawingTab[];
  "drawing:load-scene": string | null;
  "drawing:save-scene": void;
  "drawing:create-tab": DrawingTab;
  "drawing:rename-tab": void;
  "drawing:delete-tab": void;
  "drawing:clear-tab": void;
  "tts:speak": TtsSpeakResult;
  "tts:stop": void;
  "tts:voices": TtsVoice[];
}

export interface YumiAPI {
  platform: Platform;
  invoke: <C extends IPCChannel>(
    channel: C,
    ...args: IPCPayloads[C] extends void ? [] : [payload: IPCPayloads[C]]
  ) => Promise<IPCResponses[C]>;
  /**
   * Resolve an OS path for a `File` from a drop event. In Electron ≥ 32,
   * `File.path` is gone; `webUtils.getPathForFile` is the supported way.
   */
  getPathForFile: (file: File) => string;
  /**
   * Subscribe to a main-process event. Returns an unsubscribe function.
   */
  on(event: string, listener: (...args: unknown[]) => void): () => void;
  /** Check whether the window is in macOS native fullscreen. */
  isFullScreen: () => Promise<boolean>;
}

declare global {
  interface Window {
    yumi: YumiAPI;
  }
}
