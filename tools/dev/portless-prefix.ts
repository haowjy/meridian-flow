/** Checkout-owned Portless prefixes shared by startup, CLI discovery and browser tests. */
import { createHash } from "node:crypto";
import { isMainCheckout, resolveCheckoutSessionIdentity, runGit } from "./lib/dev-env";

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

function branchToPortlessPrefix(branchName: string): string | undefined {
  if (!branchName || branchName === "HEAD" || DEFAULT_PORTLESS_BRANCHES.has(branchName)) {
    return undefined;
  }

  const lastSegment = branchName.split("/").at(-1) ?? branchName;
  return sanitizeForHostname(lastSegment) || undefined;
}

/** Only the primary checkout owns bare routes, including when HEAD is detached. */
export function resolveCheckoutPortlessPrefix(repoRoot: string): string | undefined {
  if (isMainCheckout(repoRoot)) return undefined;
  const identity = resolveCheckoutSessionIdentity(repoRoot);
  return (
    branchToPortlessPrefix(runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])) ??
    sanitizeForHostname(`${identity.slug}-${identity.worktreeHash}`)
  );
}
