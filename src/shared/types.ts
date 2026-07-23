export type Platform = "darwin" | "win32" | "linux";

export type BookFormat = "epub" | "pdf";

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
  collection: string;
  trashed: number;
}

/**
 * One-way main → renderer notifications. Distinct from `IPCChannel` so the
 * preload bridge can type `on()` separately from the request/response `invoke()`.
 */
export type YumiEvent = "library:changed";

export type IPCChannel =
  | "settings:get"
  | "settings:set"
  | "books:list"
  | "books:insert"
  | "books:update"
  | "books:reveal"
  | "import:book"
  | "dialog:openFile"
  | "dialog:openImage"
  | "db:fts5";

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
    // Absolute path to a new cover image; main copies it into covers/.
    coverSourcePath?: string;
  };
  "books:reveal": { id: number };
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
}

export interface IPCResponses {
  "settings:get": string | null;
  "settings:set": void;
  "books:list": Book[];
  "books:insert": Book;
  "books:update": Book;
  "books:reveal": void;
  "import:book": ImportOutcome;
  "dialog:openFile": string[];
  "dialog:openImage": string | null;
  "db:fts5": boolean;
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
}

declare global {
  interface Window {
    yumi: YumiAPI;
  }
}
