import initSqlJs from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import { migrate } from "drizzle-orm/sql-js/migrator";
import path from "path";
import fs from "fs";
import { dbPath } from "./paths";

const migrationsFolder = path.join(__dirname, "../../drizzle/migrations");

async function main() {
  const SQL = await initSqlJs();

  let sqlDb: any;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }

  const db = drizzle(sqlDb);
  await migrate(db, { migrationsFolder });

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(sqlDb.export()));
  console.log(`Migrations applied. Database saved to ${dbPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
