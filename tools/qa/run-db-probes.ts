#!/usr/bin/env tsx
/**
 * Runs every self-contained database probe, `tools/qa/probes/<name>/run.mts`, one after another and
 * exits nonzero if any fails. Each creates, migrates and drops its own `lfd_probe_*` database, so
 * a file named `run.mts` must need no browser, model or running stack. CI runs this after the DB
 * suite; locally it needs `pnpm dev:infra`.
 *
 *   pnpm test:probes [probe-dir ...]
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const probesDir = join(dirname(fileURLToPath(import.meta.url)), "probes");
const requested = process.argv.slice(2).filter((arg) => arg !== "--");
const probes = readdirSync(probesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => readdirSync(join(probesDir, name)).includes("run.mts"))
  .filter((name) => !requested.length || requested.includes(name))
  .sort();
if (!probes.length) throw new Error("No probe selected.");

const failed: string[] = [];
for (const name of probes) {
  const started = Date.now();
  console.log(`\n=== probe ${name}`);
  const result = spawnSync("pnpm", ["exec", "tsx", join(probesDir, name, "run.mts")], {
    stdio: "inherit",
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const ok = result.status === 0;
  console.log(`=== ${ok ? "PASS" : "FAIL"} ${name} (${seconds}s)`);
  if (!ok) failed.push(name);
}
console.log(failed.length ? `\nFailed probes: ${failed.join(", ")}` : "\nAll probes passed.");
process.exitCode = failed.length ? 1 : 0;
