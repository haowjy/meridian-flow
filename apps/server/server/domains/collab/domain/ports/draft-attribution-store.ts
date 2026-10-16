/** Reads the AI edit parts pending in a text branch, for who wrote each change. */
import type { DraftAttributionEdit } from "@meridian/contracts/drafts";

export type DraftAttributionStore = {
  /** AI actor edit parts whose placement is pending in `branchId`, latest first, each with its owner. */
  pendingAgentEdits(branchId: string): Promise<DraftAttributionEdit[]>;
  /** State and AI parts from one durable database snapshot, never independently advancing reads. */
  read(branchId: string): Promise<{
    state: Uint8Array;
    edits: DraftAttributionEdit[];
    userId: string | null;
  } | null>;
};
