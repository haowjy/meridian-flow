/** Neutral branch journal and auto-push contracts shared across collab domain services. */
import type { ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";

export type BranchJournalRow = {
  id: number;
  branchId: string;
  generation: number;
  wId: number | null;
  source: "agent" | "writer";
  threadId: ThreadId | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  /** Immutable live-journal watermark captured with this draft mutation. */
  draftBaseUpdateSeq: number;
  status: "active" | "pushed" | "discarded" | "rollback_pending";
  updateMeta?: unknown;
};

export function branchJournalRevision(
  rows: readonly Pick<BranchJournalRow, "id" | "status">[],
): string {
  return [...rows]
    .sort((left, right) => left.id - right.id)
    .map((row) => `${row.id}:${row.status}`)
    .join(",");
}

export type AutoBranchPushPort = {
  pushAutoBranchAfterThreadPeerWrite(input: {
    workDraftBranchId: string;
    pushedByUserId?: UserId;
  }): Promise<{ status: string; [key: string]: unknown }>;
};
