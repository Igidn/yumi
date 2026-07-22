import { app, BrowserWindow } from "electron";
import path from "path";
import { registerIpcHandlers, broadcastEvent } from "./ipc";
import { getStore } from "./store";
import { importBook } from "./import";

const isDev = process.env.NODE_ENV !== "production";

/**
 * macOS delivers `open-file` events for Finder/dock drops. They can fire
 * before the app is ready (and before any window exists), so buffer them
 * and drain once the window finishes loading.
 */
const pendingOpenFiles: string[] = [];
let mainWindow: BrowserWindow | null = null;

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    void handleOpenFile(filePath);
  } else {
    pendingOpenFiles.push(filePath);
  }
});

async function handleOpenFile(filePath: string): Promise<void> {
  try {
    await importBook(filePath);
    broadcastEvent("library:changed");
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

  if (isDev) {
    await win.loadURL("http://localhost:5173");
  } else {
    await win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
