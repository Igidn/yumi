import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { drizzle, SQLJsDatabase as DrizzleDb } from "drizzle-orm/sql-js";
import { migrate } from "drizzle-orm/sql-js/migrator";
import * as schema from "./db/schema";
import path from "path";
import fs from "fs";
import { app } from "electron";
import { dbPath } from "./paths";

const migrationsFolder = path.join(__dirname, "../../drizzle/migrations");

let sqlInstance: SqlJsDatabase | null = null;
let db: DrizzleDb<typeof schema> | null = null;

const SAVE_DEBOUNCE_MS = 500;
let saveTimeout: NodeJS.Timeout | null = null;
let isDirty = false;

export async function getDb(): Promise<DrizzleDb<typeof schema>> {
  if (db) return db;

  const SQL = await initSqlJs();

  // Load existing database or create a new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    sqlInstance = new SQL.Database(buffer);
  } else {
    sqlInstance = new SQL.Database();
  }

  // WAL mode is a no-op for the in-memory sql.js database; persistence is
  // handled explicitly by exporting the database to disk.
  // sqlInstance.run("PRAGMA journal_mode = WAL");
  sqlInstance.run("PRAGMA foreign_keys = ON");

  // Track every mutating sql.js call so Drizzle writes are persisted.
  patchDatabase(sqlInstance);

  const drizzleDb = drizzle(sqlInstance, { schema });

  // Apply any pending migrations on startup.
  await migrate(drizzleDb, { migrationsFolder });

  db = drizzleDb;

  // Probe the bundled sql.js build for FTS5 support; M7 depends on it.
  console.log(`[database] FTS5 available: ${hasFts5()}`);

  // Flush any pending writes before the app exits.
  app.on("before-quit", flushDatabase);

  return db;
}

function patchDatabase(instance: SqlJsDatabase) {
  // run(sql, params)
  const originalRun = instance.run.bind(instance);
  instance.run = function (sql: string, params?: any) {
    const result = originalRun(sql, params);
    markDirty();
    return result;
  };

  // exec(sql)
  const originalExec = instance.exec.bind(instance);
  instance.exec = function (sql: string) {
    const result = originalExec(sql);
    markDirty();
    return result;
  };

  // prepare(sql) returns a Statement whose run() must also mark dirty,
  // because Drizzle may use prepared statements instead of db.run().
  const originalPrepare = instance.prepare.bind(instance);
  instance.prepare = function (sql: string) {
    const stmt = originalPrepare(sql);
    const originalStmtRun = stmt.run.bind(stmt);
    stmt.run = function (params?: any) {
      const result = originalStmtRun(params);
      markDirty();
      return result;
    };
    return stmt;
  };
}

function markDirty() {
  isDirty = true;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveToDisk();
  }, SAVE_DEBOUNCE_MS);
}

function saveToDisk() {
  if (!sqlInstance || !isDirty) return;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const data = sqlInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
  isDirty = false;
}

export function flushDatabase() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveToDisk();
}

export function hasFts5(): boolean {
  if (!sqlInstance) return false;
  try {
    sqlInstance.run(
      "CREATE VIRTUAL TABLE __fts5_probe__ USING fts5 (probe); DROP TABLE __fts5_probe__;"
    );
    return true;
  } catch {
    return false;
  }
}

export { schema };
