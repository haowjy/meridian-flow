/**
 * The collab-owned pending membership rule, counted per draft: what the Works boundary
 * reconciles each draft's stored count against, and each Work's total (the badge). One SQL
 * aggregate per call.
 */

/** An active draft of a named owner and its pending documents and folders (zero when none). */
export type DraftPendingCount = {
  draftId: string;
  projectId: string;
  /** Exactly one of these two is set. */
  workId: string | null;
  rootThreadId: string | null;
  documents: number;
  folders: number;
};

export type WorkDraftPendingCounts = {
  countPendingByOwners(input: {
    workIds: readonly string[];
    rootThreadIds: readonly string[];
  }): Promise<readonly DraftPendingCount[]>;
};
