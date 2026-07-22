import { app, BrowserWindow } from "electron";
import path from "path";
import { registerIpcHandlers } from "./ipc";
import { getStore } from "./store";

const isDev = process.env.NODE_ENV !== "production";

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

  const saveBounds = () => {
    const b = win.getNormalBounds();
    store.set("windowBounds", b);
  };

  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("moved", saveBounds);

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
