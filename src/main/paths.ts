import path from "path";
import os from "os";

/**
 * Return the directory used for app data.
 * In Electron this delegates to `app.getPath("userData")`; outside Electron
 * (e.g. a `tsx` migration script) it falls back to a platform-appropriate path.
 */
export function getUserDataPath(): string {
  if (process.versions.electron) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require("electron");
    return app.getPath("userData");
  }

  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "yumi");
    case "win32":
      return path.join(process.env.APPDATA || os.homedir(), "yumi");
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        "yumi"
      );
  }
}

export const dbPath = path.join(getUserDataPath(), "yumi.db");
