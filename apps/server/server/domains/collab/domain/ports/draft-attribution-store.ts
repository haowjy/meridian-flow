/** Reads the AI edit parts pending in a text branch, for the chat-name hint on changes. */
import type { DraftAttributionEdit } from "@meridian/contracts/drafts";

export type DraftAttributionStore = {
  /** AI actor edit parts whose placement is pending in `branchId`, latest first. */
  pendingAgentEdits(branchId: string): Promise<DraftAttributionEdit[]>;
};
