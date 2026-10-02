/**
 * File policy: where an agent's write to a file lands (D20).
 *
 * PR 1 decides destination only, from the source scheme and whether the
 * thread's Work is in draft mode. PR 2 adds access levels to this module.
 * Callers compute the destination and pass it on; collab never calls this.
 */

import type { ContextUriScheme } from "@meridian/contracts/context-uri";

/** Where an agent write lands: the live document or the thread's Work draft. */
export type WriteDestination = "live" | "draft";

interface SourceRule {
  /** Whether a draft-mode Work holds agent writes to this source for review. */
  readonly drafted: boolean;
}

/**
 * Per-source rules. Scratch is the Work's own working area and uploads are
 * read-only for agents, so neither is ever drafted (D9).
 */
const SOURCE_RULES: Readonly<Record<ContextUriScheme, SourceRule>> = {
  manuscript: { drafted: true },
  kb: { drafted: true },
  user: { drafted: true },
  unfiled: { drafted: true },
  scratch: { drafted: false },
  uploads: { drafted: false },
};

/** Whether agent writes to this source go to the Work draft in draft mode. */
export function isDrafted(scheme: ContextUriScheme): boolean {
  return SOURCE_RULES[scheme].drafted;
}

/** The destination of an agent write to a file of this source. People always write live. */
export function destination(scheme: ContextUriScheme, draftMode: boolean): WriteDestination {
  return draftMode && isDrafted(scheme) ? "draft" : "live";
}
