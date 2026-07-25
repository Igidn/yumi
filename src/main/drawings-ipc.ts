import { ipcMain, BrowserWindow } from "electron";
import {
  loadTabs,
  loadStrokes,
  addStroke,
  eraseStrokes,
  undoLastStroke,
  createTab,
  renameTab,
  deleteTab,
  clearTab,
} from "./drawings-db";

/**
 * Broadcast a drawing event to all windows except the sender.
 * Each renderer filters by tabId and deduplicates by stroke UUID.
 */
function broadcastToAll(
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

  ipcMain.handle("drawing:load-strokes", async (_, payload: { tabId: string }) => {
    return loadStrokes(payload.tabId);
  });

  ipcMain.handle(
    "drawing:stroke-added",
    async (event, payload: { tabId: string; stroke: import("../shared/types").SerializedStroke }) => {
      const stroke = addStroke(payload.tabId, payload.stroke);

      broadcastToAll("drawing:external-stroke", {
        tabId: payload.tabId,
        stroke,
      }, event.sender);
    }
  );

  ipcMain.handle(
    "drawing:stroke-erased",
    async (event, payload: { tabId: string; strokeIds: string[] }) => {
      const removed = eraseStrokes(payload.tabId, payload.strokeIds);
      broadcastToAll("drawing:external-strokes-removed", {
        tabId: payload.tabId,
        strokeIds: removed,
      }, event.sender);
    }
  );

  ipcMain.handle(
    "drawing:undo",
    async (event, payload: { tabId: string }) => {
      const result = undoLastStroke(payload.tabId);
      if (result) {
        broadcastToAll("drawing:external-strokes-removed", {
          tabId: payload.tabId,
          strokeIds: [result.strokeId],
        }, event.sender);
      }
      return result;
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
      broadcastToAll("drawing:external-tab-cleared", {
        tabId: payload.tabId,
      }, event.sender);
    }
  );
}
