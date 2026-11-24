/**
 * Port for Work purge's disposal of the purged Work's drafts (contract §2.6, F10),
 * implemented by collab: a privileged locked Discard run inside purge's transaction after
 * purge's own deleted/cutoff proof (never the active-Work Discard command).
 */
import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";

export type WorkDraftDisposal = {
  /**
   * `run` with `dispose`, which the purge transaction calls after locking and proving the
   * Work: it locks the draft the Work names and those of the lineages in `lineageRootIds` (the
   * purged threads that root one), their lists and the documents they have forks of, and
   * discards every one whole. `dispose` answers the stored objects to delete after commit and
   * the drafts, whose rows the purge deletes once the Work and chats naming them are gone.
   */
  withDisposal<T>(
    workId: WorkId,
    run: (
      dispose: (
        lineageRootIds: readonly string[],
      ) => Promise<{ releasedObjects: readonly string[]; draftIds: readonly DraftId[] }>,
    ) => Promise<T>,
  ): Promise<T>;
};
