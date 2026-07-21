import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { drizzle, SQLJsDatabase as DrizzleDb } from "drizzle-orm/sql-js";
import * as schema from "./db/schema";
import path from "path";
import fs from "fs";
import { app } from "electron";

const dbPath = path.join(app.getPath("userData"), "yumi.db");

let sqlInstance: SqlJsDatabase | null = null;
let db: DrizzleDb<typeof schema> | null = null;

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

  // Enable WAL mode and foreign keys
  sqlInstance.run("PRAGMA journal_mode = WAL");
  sqlInstance.run("PRAGMA foreign_keys = ON");

  db = drizzle(sqlInstance, { schema });

  // Persist to disk on every write
  const originalRun = sqlInstance.run.bind(sqlInstance);
  sqlInstance.run = (sql: string, params?: any) => {
    const result = originalRun(sql, params);
    saveToDisk();
    return result;
  };

  return db;
}

function saveToDisk() {
  if (!sqlInstance) return;
  const data = sqlInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

export { schema };
