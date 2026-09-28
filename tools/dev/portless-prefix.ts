/** Branch-name → portless worktree-prefix derivation. Single source of truth. */
import { createHash } from "node:crypto";
import path from "node:path";
import { runGit } from "./lib/dev-env";

const DEFAULT_PORTLESS_BRANCHES = new Set(["main", "master"]);
const MAX_DNS_LABEL_LENGTH = 63;

function truncateDnsLabel(label: string): string {
  if (label.length <= MAX_DNS_LABEL_LENGTH) return label;
  const hash = createHash("sha256").update(label).digest("hex").slice(0, 6);
  const head = label.slice(0, MAX_DNS_LABEL_LENGTH - 7).replace(/-+$/, "");
  return `${head}-${hash}`;
}

export function sanitizeForHostname(value: string): string {
  return truncateDnsLabel(
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, ""),
  );
}

export function branchToPortlessPrefix(branchName: string): string | undefined {
  if (!branchName || branchName === "HEAD" || DEFAULT_PORTLESS_BRANCHES.has(branchName)) {
    return undefined;
  }

  const lastSegment = branchName.split("/").at(-1) ?? branchName;
  return sanitizeForHostname(lastSegment) || undefined;
}

function isLinkedWorktree(repoRoot: string): boolean {
  const gitDir = runGit(repoRoot, ["rev-parse", "--git-dir"]);
  const commonDir = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!gitDir || !commonDir) return false;
  return path.resolve(repoRoot, gitDir) !== path.resolve(repoRoot, commonDir);
}

/**
 * The route prefix `pnpm dev` registers for this checkout: only linked worktrees
 * get one, so the primary checkout keeps plain routes on any branch.
 */
export function worktreePortlessPrefix(repoRoot: string, branchName: string): string | undefined {
  return isLinkedWorktree(repoRoot) ? branchToPortlessPrefix(branchName) : undefined;
}
