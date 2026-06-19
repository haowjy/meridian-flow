import { createHash } from "node:crypto";
import path from "node:path";

const SESSION_HASH_LENGTH = 8;
const MAX_SLUG_LENGTH = 48;

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateSegment(input: string, maxLength = MAX_SLUG_LENGTH): string {
  if (input.length <= maxLength) {
    return input;
  }

  const suffix = stableHash(input).slice(0, 6);
  const headLength = Math.max(1, maxLength - suffix.length - 1);
  return `${input.slice(0, headLength)}-${suffix}`;
}

export interface SessionIdentityInput {
  branchName: string;
  detachedHeadRef?: string | null;
  repoRootRealpath: string;
}

export interface SessionIdentity {
  branchLabel: string;
  worktreeLabel: string;
  worktreeHash: string;
  slug: string;
  sessionName: string;
}

function resolveBranchLabel(branchName: string, detachedHeadRef?: string | null): string {
  if (branchName && branchName !== "HEAD") {
    const candidate = branchName.split("/").at(-1) ?? branchName;
    return sanitizeSegment(candidate) || "branch";
  }

  const detachedSuffix = sanitizeSegment(detachedHeadRef ?? "") || "unknown";
  return `detached-${detachedSuffix}`;
}

function resolveSlug(branchLabel: string, worktreeLabel: string): string {
  if (branchLabel === worktreeLabel) {
    return truncateSegment(branchLabel) || worktreeLabel;
  }

  return truncateSegment(sanitizeSegment(`${branchLabel}-${worktreeLabel}`) || worktreeLabel);
}

export function resolveSessionIdentity(input: SessionIdentityInput): SessionIdentity {
  const branchLabel = resolveBranchLabel(input.branchName, input.detachedHeadRef);
  const worktreeLabel = sanitizeSegment(path.basename(input.repoRootRealpath)) || "worktree";
  const slug = resolveSlug(branchLabel, worktreeLabel);
  const worktreeHash = stableHash(input.repoRootRealpath).slice(0, SESSION_HASH_LENGTH);
  const sessionName = `meridian-${slug}-${worktreeHash}`;

  return {
    branchLabel,
    worktreeLabel,
    worktreeHash,
    slug,
    sessionName,
  };
}
