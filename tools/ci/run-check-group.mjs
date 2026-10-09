#!/usr/bin/env node
// Partition the local check gate for CI without maintaining a second check list.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { scripts } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);
const isolated = ["typecheck", "test"];
const group = process.argv[2];
if (!["static", ...isolated].includes(group)) {
  throw new Error("Usage: node tools/ci/run-check-group.mjs <static|typecheck|test>");
}

const checks = scripts.check.split("&&").map((command) => {
  const match = /^pnpm ([\w:-]+)$/.exec(command.trim());
  if (!match || !Object.hasOwn(scripts, match[1])) {
    throw new Error(`scripts.check must be a chain of named pnpm scripts; got: ${command}`);
  }
  return match[1];
});
for (const required of [...isolated, "check:db"]) {
  if (!checks.includes(required)) {
    throw new Error(`scripts.check no longer includes ${required}; update the CI partition.`);
  }
}

// db-tests owns CI's real-Postgres gate. New checks automatically join static.
const selected = checks.filter((check) =>
  group === "static" ? ![...isolated, "check:db"].includes(check) : check === group,
);
console.log(`Quality ${group}: ${selected.join(", ")}`);
for (const check of selected) {
  const result = spawnSync("pnpm", ["run", check], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
