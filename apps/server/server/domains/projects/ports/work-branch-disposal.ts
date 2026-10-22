/**
 * Port for Work purge's disposal of the purged Work's branches (contract §2.6, F10),
 * implemented by collab: a privileged locked Discard run inside purge's transaction after
 * purge's own deleted/cutoff proof (never the active-Work Discard command).
 */
import type { WorkId } from "@meridian/contracts/runtime";

export type WorkBranchDisposal = {
  /**
   * `run` with `dispose`, which the purge transaction calls after locking and proving the
   * Work: it locks each of the Work's active branches, their namespaces and hidden documents,
   * and discards every one whole. It throws (aborting the purge transaction) when a branch's
   * scope moved under it; `run` then runs again, up to a bound. `dispose` answers the stored
   * objects to delete after commit.
   */
  withDisposal<T>(
    workId: WorkId,
    run: (dispose: () => Promise<{ releasedObjects: readonly string[] }>) => Promise<T>,
  ): Promise<T>;
};
