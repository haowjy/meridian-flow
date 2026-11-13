#!/usr/bin/env tsx
/**
 * Runs every self-contained database probe, `tools/qa/probes/<name>/run.mts`, one after another and
 * exits nonzero if any fails or hangs. Each creates, migrates and drops what it needs, so a file
 * named `run.mts` must need no browser, model or running stack. CI runs this after the DB suite;
 * locally it needs `pnpm dev:infra`.
 *
 *   pnpm test:probes [probe-dir ...]
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Slowest probe is about 35 s; a probe past this is hung on a lock or an open handle. */
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 300_000);

const probesDir = join(dirname(fileURLToPath(import.meta.url)), "probes");
const requested = process.argv.slice(2).filter((arg) => arg !== "--");
const available = readdirSync(probesDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && readdirSync(join(probesDir, entry.name)).includes("run.mts"),
  )
  .map((entry) => entry.name)
  .sort();
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length)
  throw new Error(`Unknown probe ${unknown.join(", ")}; one of ${available.join(", ")}`);
const probes = requested.length ? available.filter((name) => requested.includes(name)) : available;

/**
 * Exit status, or "timeout" after killing the probe. The probe is one node process (no pnpm or
 * tsx wrapper to leave behind), so killing the child kills everything it started.
 */
function runProbe(name: string): Promise<number | "timeout"> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(probesDir, name, "run.mts")], {
      stdio: "inherit",
    });
    // An interrupt of the runner alone (a CI cancel, a command timeout) would orphan the probe.
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
      child.once("exit", () => process.exit(1));
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, forward);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, PROBE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
        process.removeListener(signal, forward);
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const failed: string[] = [];
  for (const name of probes) {
    const started = Date.now();
    console.log(`\n=== probe ${name}`);
    const status = await runProbe(name);
    const seconds = Math.round((Date.now() - started) / 1000);
    const verdict =
      status === 0
        ? "PASS"
        : status === "timeout"
          ? `FAIL: no exit in ${PROBE_TIMEOUT_MS / 1000}s, killed`
          : "FAIL";
    console.log(`=== ${verdict} ${name} (${seconds}s)`);
    if (status !== 0) failed.push(name);
  }
  console.log(failed.length ? `\nFailed probes: ${failed.join(", ")}` : "\nAll probes passed.");
  process.exitCode = failed.length ? 1 : 0;
}

void main();
