import Database from "better-sqlite3";
import path from "path";
import { getUserDataPath } from "./paths";
import type { DrawingStroke, DrawingTab, SerializedStroke } from "../shared/types";

export const drawingsDbPath = path.join(getUserDataPath(), "drawings.db");

let db: Database.Database | null = null;

export function getDrawingsDb(): Database.Database {
  if (db) return db;

  db = new Database(drawingsDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS strokes (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      stroke_index INTEGER NOT NULL,
      json_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_strokes_tab ON strokes(tab_id, stroke_index);
  `);

  return db;
}

// --- Tabs ---

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
  d.prepare("INSERT INTO tabs (id, label, created_at) VALUES (?, ?, ?)").run(
    id,
    label,
    now
  );
  return { id, label, createdAt: now };
}

export function renameTab(tabId: string, label: string): void {
  getDrawingsDb()
    .prepare("UPDATE tabs SET label = ? WHERE id = ?")
    .run(label, tabId);
}

export function deleteTab(tabId: string): void {
  // CASCADE deletes all strokes for this tab.
  getDrawingsDb().prepare("DELETE FROM tabs WHERE id = ?").run(tabId);
}

// --- Strokes ---

export function loadStrokes(tabId: string): DrawingStroke[] {
  const d = getDrawingsDb();
  return d
    .prepare(
      "SELECT id, tab_id, stroke_index, json_data, created_at, updated_at FROM strokes WHERE tab_id = ? ORDER BY stroke_index"
    )
    .all(tabId) as DrawingStroke[];
}

export function addStroke(
  tabId: string,
  stroke: SerializedStroke
): DrawingStroke {
  const d = getDrawingsDb();
  const id = stroke.uuid;
  const now = new Date().toISOString();

  // stroke_index = max existing index + 1
  const row = d
    .prepare("SELECT COALESCE(MAX(stroke_index), -1) + 1 AS next FROM strokes WHERE tab_id = ?")
    .get(tabId) as { next: number };

  const jsonData = JSON.stringify(stroke);

  d.prepare(
    "INSERT INTO strokes (id, tab_id, stroke_index, json_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, tabId, row.next, jsonData, now, now);

  return {
    id,
    tabId,
    strokeIndex: row.next,
    jsonData,
    createdAt: now,
    updatedAt: now,
  };
}

/** Remove specific strokes by ID. Returns removed stroke IDs (for broadcast). */
export function eraseStrokes(
  tabId: string,
  strokeIds: string[]
): string[] {
  if (strokeIds.length === 0) return [];
  const d = getDrawingsDb();
  const placeholders = strokeIds.map(() => "?").join(",");
  d.prepare(
    `DELETE FROM strokes WHERE tab_id = ? AND id IN (${placeholders})`
  ).run(tabId, ...strokeIds);
  return strokeIds;
}

/** Remove the last stroke in a tab (undo). Returns the removed stroke, or null if empty. */
export function undoLastStroke(tabId: string): { strokeId: string } | null {
  const d = getDrawingsDb();
  const last = d
    .prepare(
      "SELECT id FROM strokes WHERE tab_id = ? ORDER BY stroke_index DESC LIMIT 1"
    )
    .get(tabId) as { id: string } | undefined;

  if (!last) return null;

  d.prepare("DELETE FROM strokes WHERE id = ?").run(last.id);
  return { strokeId: last.id };
}

export function clearTab(tabId: string): void {
  getDrawingsDb().prepare("DELETE FROM strokes WHERE tab_id = ?").run(tabId);
}
