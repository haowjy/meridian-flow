import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  ALLOW_MAIN_DATABASE,
  MANAGED_TEST_DATABASE,
  resolveDatabaseAdminTarget,
} from "../../../tools/dev/lib/dev-db-target";
import { resolveCurrentRepoRoot } from "../../../tools/dev/lib/dev-env";

const args = process.argv.slice(2);
const repoRoot = resolveCurrentRepoRoot();
const { databaseUrl } = resolveDatabaseAdminTarget({
  repoRoot,
  args,
});

if (args.includes(ALLOW_MAIN_DATABASE)) {
  console.log("apply-functions: explicitly allowed the registered main database");
}
if (args.includes(MANAGED_TEST_DATABASE)) {
  console.log("apply-functions: using an active managed test database");
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
