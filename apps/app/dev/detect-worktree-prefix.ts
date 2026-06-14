import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Branch-prefixed portless host segment when cwd is a linked worktree. */
export function detectWorktreePrefix(repoRoot: string): string | undefined {
  try {
    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const commonDir = execSync("git rev-parse --git-common-dir", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (!gitDir || !commonDir) return undefined;

    const resolvedGitDir = path.resolve(repoRoot, gitDir);
    const resolvedCommonDir = path.resolve(repoRoot, commonDir);
    if (resolvedGitDir === resolvedCommonDir) return undefined;

    return path.basename(fs.realpathSync(repoRoot));
  } catch {
    return undefined;
  }
}
