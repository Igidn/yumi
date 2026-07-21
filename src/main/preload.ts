import { contextBridge } from "electron";

// Expose a minimal API to the renderer.
// Add IPC methods here as the app grows.
contextBridge.exposeInMainWorld("yumi", {
  platform: process.platform,
});
