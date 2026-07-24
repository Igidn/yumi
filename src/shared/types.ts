export type Platform = "darwin" | "win32" | "linux";

export type BookFormat = "epub";

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
  collection: string;
  trashed: number;
}

/**
 * One-way main → renderer notifications. Distinct from `IPCChannel` so the
 * preload bridge can type `on()` separately from the request/response `invoke()`.
 */
export type YumiEvent = "library:changed" | "window:enterFullScreen" | "window:leaveFullScreen";

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
  | "import:book"
  | "dialog:openFile"
  | "dialog:openImage"
  | "db:fts5"
  | "window:isFullScreen";

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
  "import:book": ImportOutcome;
  "dialog:openFile": string[];
  "dialog:openImage": string | null;
  "db:fts5": boolean;
  "window:isFullScreen": boolean;
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
  on<E extends YumiEvent>(
    event: E,
    listener: () => void
  ): () => void;
  /** Check whether the window is in macOS native fullscreen. */
  isFullScreen: () => Promise<boolean>;
}

declare global {
  interface Window {
    yumi: YumiAPI;
  }
}
