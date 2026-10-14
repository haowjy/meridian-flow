/**
 * Port for Work purge's disposal of the purged Work's drafts (contract §2.6, F10),
 * implemented by collab: every branch of the Work's drafts leased before purge's
 * transaction opens, and a privileged locked Discard run inside it after purge's own
 * deleted/cutoff proof (never the active-Work Discard command).
 */
import type { WorkId } from "@meridian/contracts/runtime";

export type WorkDraftDisposal = {
  /**
   * Discover the Work's drafts and lease their branches, then `run` with `dispose`, which
   * the purge transaction calls after locking and proving the Work: it locks each draft,
   * its namespaces and hidden documents, and discards every active draft whole. It throws
   * (aborting the purge transaction) when the drafts changed since discovery; the whole
   * run is then retried once from discovery. `dispose` answers the stored objects to
   * delete after commit.
   */
  withDisposal<T>(
    workId: WorkId,
    run: (dispose: () => Promise<{ releasedObjects: readonly string[] }>) => Promise<T>,
  ): Promise<T>;
};
