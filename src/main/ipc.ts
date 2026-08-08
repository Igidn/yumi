import { eq } from "drizzle-orm";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "fs";
import path from "path";

import type {
  IPCChannel,
  IPCPayloads,
  IPCResponses,
  YumiEvent,
} from "../shared/types";
import { getDb, hasFts5 } from "./database";
import { appSettings, books } from "./db/schema";
import { registerDrawingIpcHandlers } from "./drawings-ipc";
import { bookForRenderer, deleteBook, importBook, withChapterInfo } from "./import";
import { getCoversDir } from "./paths";
import {
  loadReaderBook,
  loadReaderChapter,
  saveReaderProgress,
} from "./reader";
import { getReadingStats, logReadingSeconds } from "./reading";
import { getStore } from "./store";
import { registerTtsHandlers } from "./tts";
import { importWebnovel } from "./webnovel";
import { closeReaderWindow, openReaderWindow } from "./windows";

type Handler<C extends IPCChannel> = (
  event: Electron.IpcMainInvokeEvent,
  payload: IPCPayloads[C],
) => Promise<IPCResponses[C]> | IPCResponses[C];

function handle<C extends IPCChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(
    channel,
    handler as (
      event: Electron.IpcMainInvokeEvent,
      ...args: unknown[]
    ) => unknown,
  );
}

/**
 * Broadcast a one-way event to every open window. The renderer subscribes
 * via the preload bridge's `on()`; see `src/shared/types.ts`.
 */
export function broadcastEvent(event: YumiEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event);
  }
}

export function registerIpcHandlers(): void {
  registerDrawingIpcHandlers();
  registerTtsHandlers();

  handle("settings:get", async (_, payload) => {
    const db = await getDb();
    const row = await db.query.appSettings.findFirst({
      where: eq(appSettings.key, payload.key),
    });
    return row?.value ?? null;
  });

  handle("settings:set", async (_, payload) => {
    const db = await getDb();
    await db
      .insert(appSettings)
      .values({ key: payload.key, value: payload.value })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: payload.value },
      });
  });

  handle("books:list", async () => {
    const db = await getDb();
    const rows = await db
      .select()
      .from(books)
      .where(eq(books.trashed, 0))
      .orderBy(books.title);
    const enriched = await withChapterInfo(rows);
    return enriched.map(bookForRenderer);
  });

  handle("books:insert", async (_, payload) => {
    const db = await getDb();
    const now = new Date().toISOString();
    const rows = await db
      .insert(books)
      .values({
        title: payload.title,
        author: payload.author,
        format: payload.format,
        sourcePath: "/dev/null",
        importedAt: now,
      })
      .returning();
    return bookForRenderer(rows[0]);
  });

  handle("books:update", async (_, payload) => {
    const db = await getDb();
    const existing = (
      await db.select().from(books).where(eq(books.id, payload.id)).limit(1)
    )[0];
    if (!existing) throw new Error(`Book not found: ${payload.id}`);

    const patch: {
      title?: string;
      author?: string;
      progress?: number;
      priorProgress?: number | null;
      finishedAt?: string | null;
      coverPath?: string;
    } = {};
    if (payload.title !== undefined)
      patch.title = payload.title.trim() || "Untitled";
    if (payload.author !== undefined) patch.author = payload.author;

    if (payload.restoreProgress) {
      const prior = existing.priorProgress;
      patch.progress =
        prior != null && prior < 1 ? Math.min(1, Math.max(0, prior)) : 0;
      patch.priorProgress = null;
      patch.finishedAt = null;
    } else if (payload.progress !== undefined) {
      const next = Math.min(1, Math.max(0, payload.progress));
      if (next >= 1 && existing.progress < 1) {
        patch.priorProgress = existing.progress;
        patch.finishedAt = new Date().toISOString();
      } else if (next < 1 && existing.progress >= 1) {
        patch.finishedAt = null;
      }
      patch.progress = next;
    }

    if (payload.coverSourcePath) {
      const src = path.resolve(payload.coverSourcePath);
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        throw new Error(`Cover file not found: ${src}`);
      }
      const ext = path.extname(src).toLowerCase().replace(".", "") || "jpg";
      const dest = path.join(
        getCoversDir(),
        `${existing.sha256 ?? existing.id}.${ext}`,
      );
      await fs.promises.copyFile(src, dest);
      // Drop previous cover if it lived somewhere else under covers/.
      if (existing.coverPath && existing.coverPath !== dest) {
        fs.rmSync(existing.coverPath, { force: true });
      }
      patch.coverPath = dest;
    }

    const rows = await db
      .update(books)
      .set(patch)
      .where(eq(books.id, payload.id))
      .returning();
    const [enriched] = await withChapterInfo(rows);
    broadcastEvent("library:changed");
    return bookForRenderer(enriched);
  });

  // Progress saves fire every few hundred ms while paging; re-rendering the
  // library grid on each one is wasted work, so cap the broadcast rate.
  let lastLibraryBroadcast = 0;
  const broadcastLibraryChangedThrottled = () => {
    const now = Date.now();
    if (now - lastLibraryBroadcast < 1500) return;
    lastLibraryBroadcast = now;
    broadcastEvent("library:changed");
  };

  handle("reader:open", async (_, payload) => {
    const db = await getDb();
    const row = (
      await db.select().from(books).where(eq(books.id, payload.id)).limit(1)
    )[0];
    if (!row || row.trashed) throw new Error(`Book not found: ${payload.id}`);

    const now = new Date().toISOString();
    await db
      .update(books)
      .set({ lastOpenedAt: now })
      .where(eq(books.id, row.id));
    const store = await getStore();
    store.set("lastOpenedBookId", row.id);

    await openReaderWindow(row.id, row.title || "Untitled");
    broadcastLibraryChangedThrottled();
  });

  handle("reader:load", async (_, payload) => {
    return loadReaderBook(payload.id);
  });

  handle("reader:chapter", async (_, payload) => {
    return loadReaderChapter(payload.bookId, payload.chapterId);
  });

  handle("reader:progress", async (_, payload) => {
    await saveReaderProgress(payload);
    broadcastLibraryChangedThrottled();
  });

  handle("reading:log", async (_, payload) => {
    await logReadingSeconds(payload.seconds);
    // Let the library goal panel tick up while a reader window is open.
    broadcastLibraryChangedThrottled();
  });

  handle("reading:stats", async () => {
    return getReadingStats();
  });

  handle("books:delete", async (_, payload) => {
    closeReaderWindow(payload.id);
    await deleteBook(payload.id);
    broadcastEvent("library:changed");
  });

  handle("books:reveal", async (_, payload) => {
    const db = await getDb();
    const row = (
      await db.select().from(books).where(eq(books.id, payload.id)).limit(1)
    )[0];
    if (!row) throw new Error(`Book not found: ${payload.id}`);
    // Webnovels have no file to reveal; open the source page in the browser.
    if (row.format === "webnovel") {
      if (row.sourcePath && /^https?:\/\//i.test(row.sourcePath)) {
        await shell.openExternal(row.sourcePath);
        return;
      }
      throw new Error(`Novel URL missing: ${row.sourcePath}`);
    }
    if (!row.sourcePath || !fs.existsSync(row.sourcePath)) {
      throw new Error(`Book file missing: ${row.sourcePath}`);
    }
    shell.showItemInFolder(row.sourcePath);
  });

  handle("import:book", async (_, payload) => {
    const outcome = await importBook(
      payload.sourcePath,
      payload.duplicateHandling ?? "prompt",
    );
    // Only notify when the library actually changed: a fresh import or a
    // replace (which deletes then inserts). A duplicate prompt or a skip
    // leaves the library untouched.
    if (outcome.status === "imported") broadcastEvent("library:changed");
    return outcome;
  });

  handle("import:webnovel", async (_, payload) => {
    const outcome = await importWebnovel(
      payload.url,
      payload.duplicateHandling ?? "prompt",
    );
    if (outcome.status === "imported") broadcastEvent("library:changed");
    return outcome;
  });

  handle("dialog:openFile", async () => {
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      title: "Import a book",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Ebooks", extensions: ["epub"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return result.canceled ? [] : result.filePaths;
  });

  handle("dialog:openImage", async () => {
    const win =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      title: "Choose a cover image",
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle("db:fts5", async () => {
    return hasFts5();
  });

  handle("window:isFullScreen", async (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false;
  });

  // Forward native fullscreen transitions to the renderer so the reader
  // header can adjust padding (traffic lights disappear in fullscreen).
  app.on("browser-window-created", (_, win) => {
    win.on("enter-full-screen", () => {
      broadcastEvent("window:enterFullScreen");
    });
    win.on("leave-full-screen", () => {
      broadcastEvent("window:leaveFullScreen");
    });
  });
}
