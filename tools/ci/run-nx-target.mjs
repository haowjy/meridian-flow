#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";

// Run configured Nx targets, optionally selecting projects from staged Git paths.
const [target, ...options] = process.argv.slice(2);
if (!target || options.some((option) => option !== "--staged")) {
  throw new Error("Usage: node tools/ci/run-nx-target.mjs <target> [--staged]");
}

const query = ["nx", "show", "projects", `--withTarget=${target}`, "--json"];
let input;
if (options.includes("--staged")) {
  // No rename detection: both old and new paths must participate in selection.
  const files = execFileSync("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && !/\.(md|mdc|markdown|txt|rst)$/i.test(file));
  if (files.length === 0) {
    console.log(`No staged non-documentation paths. Skipping Nx target "${target}".`);
    process.exit(0);
  }
  // Nx's stdin protocol is newline-delimited. Such filenames cannot be sent
  // losslessly, so check all projects rather than silently selecting the wrong ones.
  if (files.some((file) => file.includes("\n"))) {
    console.log("Staged path contains a newline; selecting all projects.");
  } else {
    query.push("--affected", "--stdin");
    input = files.join("\n");
  }
  console.log("Selecting from the Git index; project checks read the working tree.");
}

const projects = JSON.parse(
  execFileSync("pnpm", query, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] }),
);
if (projects.length === 0) {
  console.log(`No selected Nx projects expose target "${target}". Skipping.`);
  process.exit(0);
}

const envExcludes = (process.env.NX_EXCLUDE_PROJECTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const filtered = projects.filter((p) => !envExcludes.includes(p));

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
