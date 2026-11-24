#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";

const [target, ...options] = process.argv.slice(2);
if (!target || options.some((option) => option !== "--staged")) {
  throw new Error("Usage: node tools/ci/run-nx-target.mjs <target> [--staged]");
}

const query = ["nx", "show", "projects", `--withTarget=${target}`, "--json"];
let input;
if (options.includes("--staged")) {
  const files = execFileSync("git", ["diff", "--cached", "--name-only", "--no-renames", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((file) => file && !/(\.(md|mdc|markdown|txt|rst)$|(^|\/)\.context\/)/i.test(file));
  if (files.length === 0) {
    console.log(`No staged non-documentation paths. Skipping Nx target "${target}".`);
    process.exit(0);
  }
  // keep: Nx's stdin protocol is newline-delimited, so a filename with a newline cannot be sent losslessly: check all projects rather than select the wrong ones
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

// keep: Nx 23 exits non-zero after green targets when its task-history SQLite commit fails with code 787; forgive only that exact failure, matched on the output tail, and never when a failed-task summary is there
const TAIL_LIMIT = 64 * 1024;

function isIgnorableDbFailure(tailText) {
  return (
    /Successfully ran target .+ for \d+ projects?/.test(tailText) &&
    tailText.includes(
      'DB transaction error: SqliteFailure(Error { code: ConstraintViolation, extended_code: 787 }, Some("FOREIGN KEY constraint failed"))',
    ) &&
    !/Failed tasks|failed for \d+ projects?/.test(tailText)
  );
}

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
