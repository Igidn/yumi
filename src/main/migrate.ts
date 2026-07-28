import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import { dbPath } from "./paths";

const migrationsFolder = path.join(__dirname, "../../drizzle/migrations");

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);
migrate(db, { migrationsFolder });
sqlite.close();

console.log(`Migrations applied. Database at ${dbPath}`);
process.exit(0);
