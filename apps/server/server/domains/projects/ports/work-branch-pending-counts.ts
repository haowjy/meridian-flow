/**
 * The collab-owned pending membership rule, counted per branch: what the Works boundary
 * reconciles each branch's stored count against, and each Work's total (the badge). One SQL
 * aggregate per call.
 */

/** An active branch of a named owner and its pending documents (zero when none). */
export type BranchPendingCount = {
  branchId: string;
  projectId: string;
  /** Exactly one of these two is set. */
  workId: string | null;
  rootThreadId: string | null;
  count: number;
};

export type WorkBranchPendingCounts = {
  countPendingByOwners(input: {
    workIds: readonly string[];
    rootThreadIds: readonly string[];
  }): Promise<readonly BranchPendingCount[]>;
};
