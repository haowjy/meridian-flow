/** Collab's live-writer admission into the document journal. */
import type { JournalAuthority, UpdateMeta } from "@meridian/agent-edit/integration";

export interface LiveWriterJournal {
  /**
   * Stores a frame the room judged new: one counter bump and one insert in one short transaction.
   * Throws `RetiredDocumentHandleError` when the document's head is no longer `authority`'s, and
   * stores nothing.
   */
  appendWriterUpdate(
    documentId: string,
    update: Uint8Array,
    meta: UpdateMeta,
    authority: JournalAuthority,
  ): Promise<{ seq: number }>;
}
