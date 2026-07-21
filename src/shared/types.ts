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

export type IPCChannel =
  | "settings:get"
  | "settings:set"
  | "books:list"
  | "books:insert"
  | "db:fts5";

export interface IPCPayloads {
  "settings:get": { key: string };
  "settings:set": { key: string; value: string };
  "books:list": void;
  "books:insert": { title: string; author: string; format: BookFormat };
  "db:fts5": void;
}

export interface IPCResponses {
  "settings:get": string | null;
  "settings:set": void;
  "books:list": Book[];
  "books:insert": Book;
  "db:fts5": boolean;
}

export interface YumiAPI {
  platform: Platform;
  invoke: <C extends IPCChannel>(
    channel: C,
    ...args: IPCPayloads[C] extends void ? [] : [payload: IPCPayloads[C]]
  ) => Promise<IPCResponses[C]>;
}

declare global {
  interface Window {
    yumi: YumiAPI;
  }
}
