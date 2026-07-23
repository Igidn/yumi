import { BrowserWindow } from "electron";
import path from "path";
import { getStore } from "./store";

const isDev = process.env.NODE_ENV !== "production";

/** One reader window per book, Apple Books style: re-opening focuses it. */
const readerWindows = new Map<number, BrowserWindow>();

interface WindowOptions {
  /** Runs once after the renderer finishes its first load. */
  onDidFinishLoad?: (win: BrowserWindow) => void;
  /** Runs when the window is closed. */
  onClosed?: () => void;
}

function rendererUrl(query?: string): { kind: "url" | "file"; target: string } {
  if (isDev) {
    return {
      kind: "url",
      target: `http://localhost:5173/${query ? `?${query}` : ""}`,
    };
  }
  return {
    kind: "file",
    target: path.join(__dirname, "..", "renderer", "index.html"),
  };
}

async function loadRenderer(win: BrowserWindow, query?: string): Promise<void> {
  const { kind, target } = rendererUrl(query);
  if (kind === "url") {
    await win.loadURL(target);
  } else {
    await win.loadFile(target, query ? { search: `?${query}` } : undefined);
  }
}

function trackBounds(win: BrowserWindow, key: "windowBounds" | "readerWindowBounds"): void {
  const save = async () => {
    if (win.isDestroyed()) return;
    const store = await getStore();
    store.set(key, win.getNormalBounds());
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("moved", save);
}

function baseWindowOptions(bounds: {
  width: number;
  height: number;
  x?: number;
  y?: number;
}): Electron.BrowserWindowConstructorOptions {
  return {
    ...bounds,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    // macOS: lets the reader join a native tab group with the library window,
    // matching the Books.app "open in a new tab" feel.
    tabbingIdentifier: "yumi",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

export async function createMainWindow(
  opts: WindowOptions = {}
): Promise<BrowserWindow> {
  const store = await getStore();
  const win = new BrowserWindow({
    ...baseWindowOptions(store.get("windowBounds")),
    title: "Yumi",
  });

  // Don't let an accidental file drop navigate the window to a `file://`
  // URL; the renderer handles imports via IPC.
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  trackBounds(win, "windowBounds");
  if (opts.onDidFinishLoad) {
    win.webContents.once("did-finish-load", () => opts.onDidFinishLoad!(win));
  }
  if (opts.onClosed) win.on("closed", opts.onClosed);

  await loadRenderer(win);
  return win;
}

/**
 * Open the reader for a book in its own window (Apple Books flow:
 * library → click cover → book opens in a new window/tab). If the book is
 * already open, its window is focused instead of spawning a duplicate.
 */
export async function openReaderWindow(
  bookId: number,
  title: string
): Promise<void> {
  const existing = readerWindows.get(bookId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const store = await getStore();
  const win = new BrowserWindow({
    ...baseWindowOptions(store.get("readerWindowBounds")),
    title,
  });
  readerWindows.set(bookId, win);

  win.webContents.on("will-navigate", (event) => event.preventDefault());
  trackBounds(win, "readerWindowBounds");
  win.on("closed", () => {
    if (readerWindows.get(bookId) === win) readerWindows.delete(bookId);
  });

  await loadRenderer(win, `reader=${bookId}`);
}
