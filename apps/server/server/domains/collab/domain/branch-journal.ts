/**
 * A branch's write journal as its readers see it: the row record, its revision token, and the
 * neutral reads that replay, attribution and review make. Apply's push-lineage reads
 * extend this in `branch-push-contracts.ts`.
 */

import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";

export type BranchJournalRow = {
  id: number;
  branchId: string;
  generation: number;
  wId: number | null;
  /** The model's tool call that made this write; null for writer rows and legacy rows. */
  toolCallId?: string | null;
  source: "agent" | "writer";
  threadId: ThreadId | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  /** Immutable live-journal watermark captured with this draft mutation. */
  draftBaseUpdateSeq: number;
  status: "active" | "pushed" | "discarded" | "rollback_pending";
  updateMeta?: unknown;
  /** Immutable edit evidence, never inferred from actor or missing text. */
  editKind?: "write" | "undo" | "redo" | "revert" | "rollback";
};

export function branchJournalRevision(
  rows: readonly Pick<BranchJournalRow, "id" | "status">[],
): string {
  return [...rows]
    .sort((left, right) => left.id - right.id)
    .map((row) => `${row.id}:${row.status}`)
    .join(",");
}

export type BranchJournalReadStore = {
  listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listReviewableJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
  listConcurrentJournalRows(
    branchId: string,
    generation: number,
    options: { afterJournalId?: number; documentId: DocumentId },
  ): Promise<BranchJournalRow[]>;
  listJournalRowsForTurn(input: {
    branchId?: string;
    generation?: number;
    threadId: ThreadId;
    turnId: TurnId;
    statuses?: readonly BranchJournalRow["status"][];
  }): Promise<BranchJournalRow[]>;
  listJournalRowsForBranch(input: {
    branchId: string;
    generation: number;
    throughJournalId?: number;
  }): Promise<BranchJournalRow[]>;
};

/**
 * The reads a reply's save makes: the generation history its replay reconciles against, and
 * the upstream rows that landed since its baseline, for attribution.
 */
export type BranchReplayJournalReads = Pick<
  BranchJournalReadStore,
  "listJournalRowsForBranch" | "listConcurrentJournalRows"
>;
