import { app, BrowserWindow, net, protocol } from "electron";
import path from "path";
import { pathToFileURL } from "url";
import { registerIpcHandlers, broadcastEvent } from "./ipc";
import { getStore } from "./store";
import { importBook } from "./import";
import { getUserDataPath } from "./paths";

const isDev = process.env.NODE_ENV !== "production";

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
    void createWindow();
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

async function createWindow() {
  const store = await getStore();
  const bounds = store.get("windowBounds");

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 800,
    minHeight: 600,
    title: "Yumi",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  // Don't let an accidental file drop navigate the window to a `file://`
  // URL; the renderer handles imports via IPC.
  win.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  const saveBounds = () => {
    const b = win.getNormalBounds();
    store.set("windowBounds", b);
  };

  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("moved", saveBounds);

  win.webContents.once("did-finish-load", () => {
    while (pendingOpenFiles.length > 0) {
      const file = pendingOpenFiles.shift()!;
      void handleOpenFile(file);
    }
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) {
    await win.loadURL("http://localhost:5173");
  } else {
    await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
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
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
