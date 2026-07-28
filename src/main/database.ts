import Database from "better-sqlite3";
import { BetterSQLite3Database,drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "./db/schema";
import { dbPath } from "./paths";

const migrationsFolder = path.join(__dirname, "../../drizzle/migrations");

let db: BetterSQLite3Database<typeof schema> | null = null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (db) return db;

  const sqlite = new Database(dbPath);

  // WAL mode gives concurrent reads (multiple reader windows) without locks.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const drizzleDb = drizzle(sqlite, { schema });

  // Apply any pending migrations on startup.
  migrate(drizzleDb, { migrationsFolder });

  db = drizzleDb;

  console.log(`[database] FTS5 available: ${hasFts5()}`);

  return db;
}

export function hasFts5(): boolean {
  // better-sqlite3 bundles its own SQLite compilation with FTS5 always enabled.
  try {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      "CREATE VIRTUAL TABLE __fts5_probe__ USING fts5 (probe); DROP TABLE __fts5_probe__;"
    );
    sqlite.close();
    return true;
  } catch {
    return false;
  }
}

export { schema };
