import fs from "fs";
import os from "os";
import path from "path";

/**
 * Return the platform-appropriate directory for app data.
 */
export function getUserDataPath(): string {
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

export function getBooksDir(): string {
  const dir = path.join(getUserDataPath(), "books");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getCoversDir(): string {
  const dir = path.join(getUserDataPath(), "covers");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
