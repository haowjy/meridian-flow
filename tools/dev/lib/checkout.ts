import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

export function runGit(cwd: string, args: string[], timeout?: number): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
    ...(timeout === undefined ? {} : { timeout }),
  }).trim();
}

// keep: the one test for the main checkout. A linked worktree's `.git` is a file; only the main checkout has the directory. It throws for a directory that is not a checkout's root
export function isMainCheckout(checkout: string): boolean {
  return fs.statSync(path.join(checkout, ".git")).isDirectory();
}

export function listCheckoutPaths(repoRoot: string): string[] {
  return runGit(repoRoot, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}
