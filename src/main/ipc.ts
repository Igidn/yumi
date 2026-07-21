import { ipcMain } from "electron";
import { eq } from "drizzle-orm";
import { getDb, hasFts5 } from "./database";
import { appSettings, books } from "./db/schema";
import type {
  IPCChannel,
  IPCPayloads,
  IPCResponses,
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

  handle("db:fts5", async () => {
    return hasFts5();
  });
}
