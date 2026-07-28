import type Store from "electron-store";

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface StoreSchema {
  windowBounds: WindowBounds;
  // Reader windows (one per book) share a single saved size/position.
  readerWindowBounds: WindowBounds;
  lastOpenedBookId: number | null;
}

export interface TypedStore {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K];
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void;
}

let store: TypedStore | null = null;

export async function getStore(): Promise<TypedStore> {
  if (store) return store;

  // electron-store v10 is ESM. TypeScript's CommonJS emit turns `import()`
  // into `require()`, which fails for ESM-only packages, so force a real
  // dynamic import through `Function`.
  const modulePromise = new Function(
    'return import("electron-store")',
  )() as Promise<{ default: typeof Store }>;
  const { default: StoreConstructor } = await modulePromise;
  const instance = new StoreConstructor<StoreSchema>({
    defaults: {
      windowBounds: { width: 1200, height: 800 },
      readerWindowBounds: { width: 1160, height: 840 },
      lastOpenedBookId: null,
    },
  }) as unknown as Store<StoreSchema>;

  store = instance as unknown as TypedStore;
  return store;
}
