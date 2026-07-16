#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node tools/ci/run-nx-target.mjs <target>");
  process.exit(1);
}

function execPnpm(args, stdio = ["ignore", "pipe", "pipe"]) {
  return execFileSync("pnpm", args, { stdio, encoding: "utf8" });
}

let projectsOutput;
try {
  projectsOutput = execPnpm(["nx", "show", "projects", `--withTarget=${target}`]);
} catch (error) {
  console.error(`Failed to query Nx target "${target}".`);
  console.error("Run `pnpm install` first, then retry.");
  if (error?.stdout) {
    console.error(String(error.stdout).trim());
  }
  process.exit(1);
}

const raw = projectsOutput.trim();
let projects;
try {
  // Nx 22+ returns JSON array format
  projects = JSON.parse(raw);
} catch {
  // Fallback: one project per line (older Nx)
  projects = raw
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
}

if (projects.length === 0) {
  console.log(`No Nx projects expose target "${target}" yet. Skipping.`);
  process.exit(0);
}

const TEMPORARY_EXCLUDES = [];

const envExcludes = (process.env.NX_EXCLUDE_PROJECTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allExcludes = [...new Set([...TEMPORARY_EXCLUDES, ...envExcludes])];
const filtered = projects.filter((p) => !allExcludes.includes(p));

if (filtered.length === 0) {
  console.log(`All projects excluded for target "${target}". Skipping.`);
  process.exit(0);
}

// Nx 23 can exit non-zero after green targets when its task-history SQLite
// commit fails with SqliteFailure code 787. Forgive only that exact
// post-success metadata failure. Match on the output TAIL, not the whole run:
// the terminal summary and the DB error land last, so a nested Nx invocation
// or task logging earlier in a huge run can't fake the signature — and the
// bounded buffer means arbitrarily large runs can't exhaust memory.
const TAIL_LIMIT = 64 * 1024;

function isIgnorableDbFailure(tailText) {
  return (
    /Successfully ran target .+ for \d+ projects?/.test(tailText) &&
    tailText.includes(
      'DB transaction error: SqliteFailure(Error { code: ConstraintViolation, extended_code: 787 }, Some("FOREIGN KEY constraint failed"))',
    ) &&
    // Any failed-task summary in the tail means a REAL failure — never forgive.
    !/Failed tasks|failed for \d+ projects?/.test(tailText)
  );
}

// Async spawn + tee: output streams live to the terminal (hooks stay honest
// about progress) while only a bounded tail is retained for the check above.
let tail = "";
const child = spawn(
  "pnpm",
  ["nx", "run-many", `--target=${target}`, `--projects=${filtered.join(",")}`],
  { stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  tail = (tail + chunk).slice(-TAIL_LIMIT);
});
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  tail = (tail + chunk).slice(-TAIL_LIMIT);
});

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("close", (code, signal) => {
  // Interruption is never a success — a killed run has no trustworthy output.
  if (signal !== null) {
    console.error(`Nx run terminated by ${signal}.`);
    process.exit(1);
  }
  if (code !== 0 && isIgnorableDbFailure(tail)) {
    console.warn("Nx targets succeeded; ignoring its post-run task-history SQLite failure.");
    process.exit(0);
  }
  process.exit(code ?? 1);
});
