import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const functionsDir = join(root, "src/functions");

const files = [
  "update_updated_at.sql",
  "validate_turn_thread_integrity.sql",
  "consume_credit_lots_fifo.sql",
];

const sql = postgres(databaseUrl, { max: 1 });

try {
  for (const file of files) {
    const path = join(functionsDir, file);
    const body = readFileSync(path, "utf8");
    console.log(`apply-functions: ${file}`);
    await sql.unsafe(body);
  }
  console.log("apply-functions: done");
} finally {
  await sql.end();
}
