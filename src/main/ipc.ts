import { BrowserWindow, dialog, ipcMain } from "electron";
import { eq } from "drizzle-orm";
import { getDb, hasFts5 } from "./database";
import { appSettings, books } from "./db/schema";
import { importBook } from "./import";
import type {
  IPCChannel,
  IPCPayloads,
  IPCResponses,
  YumiEvent,
} from "../shared/types";

type Handler<C extends IPCChannel> = (
  event: Electron.IpcMainInvokeEvent,
  payload: IPCPayloads[C]
) => Promise<IPCResponses[C]> | IPCResponses[C];

function handle<C extends IPCChannel>(
  channel: C,
  handler: Handler<C>
): void {
  ipcMain.handle(channel, handler as any);
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
    return db
      .select()
      .from(books)
      .where(eq(books.trashed, 0))
      .orderBy(books.title);
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
    return rows[0];
  });

  handle("import:book", async (_, payload) => {
    const outcome = await importBook(
      payload.sourcePath,
      payload.duplicateHandling ?? "prompt"
    );
    // Only notify when the library actually changed: a fresh import or a
    // replace (which deletes then inserts). A duplicate prompt or a skip
    // leaves the library untouched.
    if (outcome.status === "imported") broadcastEvent("library:changed");
    return outcome;
  });

  handle("dialog:openFile", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: "Import a book",
          properties: ["openFile", "multiSelections"],
          filters: [
            { name: "Ebooks", extensions: ["epub", "pdf"] },
            { name: "All files", extensions: ["*"] },
          ],
        })
      : await dialog.showOpenDialog({
          title: "Import a book",
          properties: ["openFile", "multiSelections"],
          filters: [
            { name: "Ebooks", extensions: ["epub", "pdf"] },
            { name: "All files", extensions: ["*"] },
          ],
        });
    return result.canceled ? [] : result.filePaths;
  });

  handle("db:fts5", async () => {
    return hasFts5();
  });
}
