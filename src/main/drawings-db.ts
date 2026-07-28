import Database from "better-sqlite3";
import path from "path";
import { getUserDataPath } from "./paths";
import type { DrawingTab } from "../shared/types";

export const drawingsDbPath = path.join(getUserDataPath(), "drawings.db");

let db: Database.Database | null = null;

export function getDrawingsDb(): Database.Database {
  if (db) return db;

  db = new Database(drawingsDbPath);
  db.pragma("journal_mode = WAL");

  // One row per tab; the whole Excalidraw scene lives in scene_data as a
  // JSON blob ({ elements, appState }). Vector data is small, so the blob
  // is authoritative — no per-stroke tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      scene_data TEXT
    );
  `);

  // Migrate the old stroke-based schema: drop the strokes table and add the
  // scene_data column to pre-existing tabs rows.
  const cols = db.prepare("PRAGMA table_info(tabs)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "scene_data")) {
    db.exec("ALTER TABLE tabs ADD COLUMN scene_data TEXT");
  }
  db.exec("DROP TABLE IF EXISTS strokes");

  return db;
}

// --- Tabs ---

/** Tab list for the strip; scene blobs are loaded separately, per tab. */
export function loadTabs(): DrawingTab[] {
  const d = getDrawingsDb();
  return d
    .prepare("SELECT id, label, created_at FROM tabs ORDER BY created_at")
    .all() as DrawingTab[];
}

export function createTab(label: string): DrawingTab {
  const d = getDrawingsDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  d.prepare(
    "INSERT INTO tabs (id, label, created_at, scene_data) VALUES (?, ?, ?, NULL)"
  ).run(id, label, now);
  return { id, label, createdAt: now };
}

export function renameTab(tabId: string, label: string): void {
  getDrawingsDb()
    .prepare("UPDATE tabs SET label = ? WHERE id = ?")
    .run(label, tabId);
}

export function deleteTab(tabId: string): void {
  getDrawingsDb().prepare("DELETE FROM tabs WHERE id = ?").run(tabId);
}

// --- Scenes ---

/** Raw scene JSON for one tab, or null when the canvas was never drawn on. */
export function loadScene(tabId: string): string | null {
  const row = getDrawingsDb()
    .prepare("SELECT scene_data FROM tabs WHERE id = ?")
    .get(tabId) as { scene_data: string | null } | undefined;
  return row?.scene_data ?? null;
}

export function saveScene(tabId: string, sceneData: string): void {
  getDrawingsDb()
    .prepare("UPDATE tabs SET scene_data = ? WHERE id = ?")
    .run(sceneData, tabId);
}

export function clearTab(tabId: string): void {
  getDrawingsDb()
    .prepare("UPDATE tabs SET scene_data = NULL WHERE id = ?")
    .run(tabId);
}
