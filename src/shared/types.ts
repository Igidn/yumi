// Shared IPC channel names and types used by both main and renderer processes.
// Export nothing for now — populate as features are built.

export type Platform = "darwin" | "win32" | "linux";

export interface YumiAPI {
  platform: Platform;
}

declare global {
  interface Window {
    yumi: YumiAPI;
  }
}
