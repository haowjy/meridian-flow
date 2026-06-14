#!/usr/bin/env node
import { execFileSync } from "node:child_process";

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

execPnpm(["nx", "run-many", `--target=${target}`, `--projects=${filtered.join(",")}`], "inherit");
