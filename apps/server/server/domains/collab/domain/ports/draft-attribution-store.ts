/** Reads the AI edit parts pending in a text branch, for who wrote each change. */
import type { DraftAttributionEdit } from "@meridian/contracts/drafts";

export type DraftAttributionStore = {
  /** AI actor edit parts whose placement is pending in `branchId`, latest first, each with its owner. */
  pendingAgentEdits(branchId: string): Promise<DraftAttributionEdit[]>;
  /** The user whose browser clients write the branch's draft (`projects.user_id`), or null if gone. */
  projectUserId(branchId: string): Promise<string | null>;
};
