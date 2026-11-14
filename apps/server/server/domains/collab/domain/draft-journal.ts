/**
 * A draft's journal rows and ambient-transaction reads used by attribution.
 */

import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";

export type DraftJournalRow = {
  id: number;
  draftId: string;
  wId: number | null;
  /** The model's tool call that made this write; null for writer rows and legacy rows. */
  toolCallId?: string | null;
  source: "agent" | "writer" | "server";
  threadId: ThreadId | null;
  /** Permanent model-facing handle for agent rows. */
  threadHandle?: string | null;
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  updateMeta?: unknown;
};

export type DraftReplayJournalReads = {
  listConcurrentJournalRows(
    draftId: string,
    options: { documentId: DocumentId; after: number; through: number },
  ): Promise<DraftJournalRow[]>;
};
