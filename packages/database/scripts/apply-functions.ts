/** Apply canonical database functions through the guarded development target seam. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOW_MAIN_DATABASE,
  MANAGED_TEST_DATABASE,
  resolveDatabaseAdminTarget,
} from "../../../tools/dev/lib/dev-db-target";
import { resolveCurrentRepoRoot } from "../../../tools/dev/lib/dev-env";
import { applyFunctions } from "../src/release-runner.js";

const args = process.argv.slice(2);
const repoRoot = resolveCurrentRepoRoot();
const { databaseUrl } = resolveDatabaseAdminTarget({ repoRoot, args });

if (args.includes(ALLOW_MAIN_DATABASE)) {
  console.log("apply-functions: explicitly allowed the registered main database");
}
if (args.includes(MANAGED_TEST_DATABASE)) {
  console.log("apply-functions: using an active managed test database");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const functionsDir = join(root, "src/functions");

await applyFunctions({ databaseUrl, functionsDirectory: functionsDir });
console.log("apply-functions: all functions applied atomically");
