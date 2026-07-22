export type Platform = "darwin" | "win32" | "linux";

export type BookFormat = "epub" | "pdf";

export interface Book {
  id: number;
  title: string;
  author: string;
  format: BookFormat;
  sourcePath: string;
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
  | "import:book"
  | "dialog:openFile"
  | "db:fts5";

export interface IPCPayloads {
  "settings:get": { key: string };
  "settings:set": { key: string; value: string };
  "books:list": void;
  "books:insert": { title: string; author: string; format: BookFormat };
  "import:book": { sourcePath: string };
  "dialog:openFile": void;
  "db:fts5": void;
}

export interface IPCResponses {
  "settings:get": string | null;
  "settings:set": void;
  "books:list": Book[];
  "books:insert": Book;
  "import:book": Book;
  "dialog:openFile": string[];
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
