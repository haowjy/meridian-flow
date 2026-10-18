/** Collab's live-writer admission into the document journal. */
import type { JournalAuthority, UpdateMeta } from "@meridian/agent-edit/integration";

/**
 * `contained`: the stored document already holds every struct and delete of the update, so
 * nothing was appended. Mirrors the draft path's `{ status: "contained" }`.
 */
export type LiveWriterAppend =
  | { status: "contained" }
  | { status: "appended"; seq: number; joinedSettlement: boolean };

export interface LiveWriterJournal {
  /**
   * Judges a writer's update new against the stored document under the document lock (two
   * sockets carrying one update serialize there), and appends it only if new. Admission
   * joins any unresolved settlement cut in the same transaction.
   */
  appendWriterUpdate(
    documentId: string,
    update: Uint8Array,
    meta: UpdateMeta,
    authority?: JournalAuthority,
  ): Promise<LiveWriterAppend>;
}
