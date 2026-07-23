import { app, BrowserWindow, net, protocol } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { registerIpcHandlers, broadcastEvent } from "./ipc";
import { importBook } from "./import";
import { getUserDataPath } from "./paths";
import { createMainWindow } from "./windows";

// Must run before app is ready. Lets <img src="yumi://asset/..."> load covers
// from the userData directory (renderer can't use bare file:// paths).
protocol.registerSchemesAsPrivileged([
  {
    scheme: "yumi",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

/**
 * macOS delivers `open-file` events for Finder/dock drops. They can fire
 * before the app is ready (and before any window exists), so buffer them
 * and drain once the window finishes loading.
 *
 * On macOS, closing all windows doesn't quit the app, so `mainWindow` can
 * point at a destroyed window; check `isDestroyed()` before touching its
 * `webContents`, and (re)create a window if one is needed to drain buffered
 * files into.
 */
const pendingOpenFiles: string[] = [];
let mainWindow: BrowserWindow | null = null;

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    void handleOpenFile(filePath);
    return;
  }
  pendingOpenFiles.push(filePath);
  // No live window to receive the drop: spin one up so buffered files get
  // drained on did-finish-load rather than left orphaned until activation.
  if (!mainWindow || mainWindow.isDestroyed()) {
    void openMainWindow();
  }
});

async function handleOpenFile(filePath: string): Promise<void> {
  try {
    // open-file has no renderer to prompt, so silently skip duplicates
    // rather than clobber an existing book without confirmation.
    const outcome = await importBook(filePath, "skip");
    if (outcome.status === "imported") broadcastEvent("library:changed");
  } catch (err) {
    // ponytail: real toast UI lands in a later milestone; console is enough
    // for M1's import bullet. The file is rejected, the app keeps running.
    console.error("[import] open-file failed:", filePath, err);
  }
}

async function openMainWindow(): Promise<void> {
  const win = await createMainWindow({
    onDidFinishLoad: () => {
      while (pendingOpenFiles.length > 0) {
        const file = pendingOpenFiles.shift()!;
        void handleOpenFile(file);
      }
    },
    onClosed: () => {
      if (mainWindow === win) mainWindow = null;
    },
  });
  mainWindow = win;
}

function registerAssetProtocol(): void {
  protocol.handle("yumi", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "asset") {
      return new Response("Not found", { status: 404 });
    }
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const root = getUserDataPath();
    const full = path.normalize(path.join(root, rel));
    // Stay inside userData — no path traversal out to the rest of the disk.
    if (full !== root && !full.startsWith(root + path.sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(full).href);
  });
}

app.whenReady().then(async () => {
  registerAssetProtocol();
  registerIpcHandlers();
  await openMainWindow();

  // TEMP smoke-test hook (removed before commit): YUMI_OPEN_READER=<bookId>
  // opens that book's reader window at boot.
  if (process.env.YUMI_OPEN_READER) {
    const { getDb } = await import("./database");
    const { books } = await import("./db/schema");
    const { eq } = await import("drizzle-orm");
    const { openReaderWindow } = await import("./windows");
    const db = await getDb();
    const id = Number(process.env.YUMI_OPEN_READER);
    const row = (
      await db.select().from(books).where(eq(books.id, id)).limit(1)
    )[0];
    if (row) await openReaderWindow(row.id, row.title);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void openMainWindow();
});
