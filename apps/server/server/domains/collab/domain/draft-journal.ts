/**
 * A draft's journal rows and ambient-transaction reads used by reply replay and attribution.
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
  turnId: TurnId | null;
  actorUserId: UserId | null;
  updateData: Uint8Array;
  status: "active" | "rollback_pending";
  updateMeta?: unknown;
  /** Immutable edit evidence, never inferred from actor or missing text. */
  editKind?: "write" | "undo" | "redo" | "revert" | "rollback";
};

export type DraftReplayJournalReads = {
  listConcurrentJournalRows(
    draftId: string,
    options: { documentId: DocumentId },
  ): Promise<DraftJournalRow[]>;
  listJournalRowsForDraft(input: {
    draftId: string;
    throughJournalId?: number;
  }): Promise<DraftJournalRow[]>;
};
