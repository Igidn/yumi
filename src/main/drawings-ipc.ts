import { ipcMain, BrowserWindow } from "electron";
import {
  loadTabs,
  loadScene,
  saveScene,
  createTab,
  renameTab,
  deleteTab,
  clearTab,
} from "./drawings-db";

/**
 * Broadcast a drawing event to all windows except the sender. The scene blob
 * is authoritative, so a single `drawing:scene-updated` event covers every
 * mutation — receiving windows apply it with Excalidraw's updateScene.
 */
function broadcastToOthers(
  channel: string,
  data: unknown,
  sender?: Electron.WebContents
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (win.webContents === sender) continue;
    win.webContents.send(channel, data);
  }
}

export function registerDrawingIpcHandlers(): void {
  ipcMain.handle("drawing:load-tabs", async () => {
    return loadTabs();
  });

  ipcMain.handle(
    "drawing:load-scene",
    async (_, payload: { tabId: string }) => {
      return loadScene(payload.tabId);
    }
  );

  ipcMain.handle(
    "drawing:save-scene",
    async (event, payload: { tabId: string; sceneData: string }) => {
      saveScene(payload.tabId, payload.sceneData);
      broadcastToOthers(
        "drawing:scene-updated",
        { tabId: payload.tabId, sceneData: payload.sceneData },
        event.sender
      );
    }
  );

  ipcMain.handle("drawing:create-tab", async (_, payload: { label: string }) => {
    return createTab(payload.label);
  });

  ipcMain.handle(
    "drawing:rename-tab",
    async (_, payload: { tabId: string; label: string }) => {
      renameTab(payload.tabId, payload.label);
    }
  );

  ipcMain.handle(
    "drawing:delete-tab",
    async (_, payload: { tabId: string }) => {
      deleteTab(payload.tabId);
    }
  );

  ipcMain.handle(
    "drawing:clear-tab",
    async (event, payload: { tabId: string }) => {
      clearTab(payload.tabId);
      broadcastToOthers(
        "drawing:scene-updated",
        { tabId: payload.tabId, sceneData: null },
        event.sender
      );
    }
  );
}
