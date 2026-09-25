import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFunctions } from "../src/release-runner.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const functionsDir = join(root, "src/functions");

await applyFunctions({ databaseUrl, functionsDirectory: functionsDir });
console.log("apply-functions: all functions applied atomically");
