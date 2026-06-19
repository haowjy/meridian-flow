import { execSync } from "node:child_process";
import path from "node:path";

const DEFAULT_PORTLESS_BRANCHES = new Set(["main", "master"]);

/**
 * Branch-prefixed portless host segment when cwd is a linked worktree.
 * Mirrors dev-tmux branchToPortlessPrefix — derives prefix from the branch
 * name so the Vite proxy targets the same host portless actually registers.
 */
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

    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (!branch || branch === "HEAD" || DEFAULT_PORTLESS_BRANCHES.has(branch)) return undefined;

    const lastSegment = branch.split("/").at(-1) ?? branch;
    const sanitized = lastSegment
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
    return sanitized || undefined;
  } catch {
    return undefined;
  }
}
