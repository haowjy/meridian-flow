/** Persistence port for drafts: the `drafts` rows the resolver owns. */
import type { DraftId, DraftOwner, ProjectId, UserId, WorkId } from "@meridian/contracts";
import type { WorkWriteOptions } from "../../../projects/index.js";

/** A draft: everything pending in it. A Work's names the Work; a No Work lineage's root chat names its. */
export type Draft = {
  id: DraftId;
  projectId: ProjectId;
  /** The Work it belongs to; null for a No Work lineage's draft. */
  workId: WorkId | null;
  /** `Delete draft` ran: it is listed nowhere and takes no writes until its Undo. */
  deletedAt: Date | null;
  createdBy: UserId;
  createdAt: Date;
};

/** A draft with who names it, as it reads now. */
export type DraftOwnerView = {
  draft: Draft;
  /** The Work or lineage naming the draft; null when nothing names it any more. */
  owner: DraftOwner | null;
  handle: string | null;
};

export interface DraftStore {
  /** No lock. The draft and who names it; null when there is no such draft. */
  ownerOf(draftId: DraftId): Promise<DraftOwnerView | null>;
  /** No lock. The draft this owner names; null when the owner is gone. */
  ofOwner(owner: DraftOwner): Promise<Draft | null>;
  /** Caller's transaction, after the owner locks: `FOR NO KEY UPDATE`; null when missing. */
  lock(draftId: DraftId): Promise<Draft | null>;
  byIds(draftIds: readonly DraftId[]): Promise<Draft[]>;
  /** Purge only: a Work's drafts, deleted ones included, and those these lineages' roots name. */
  namedBy(input: { workId: WorkId; lineageRootIds: readonly string[] }): Promise<DraftId[]>;
}

/** The write boundary's transaction and owner lock. */
export interface DraftWriteBoundary {
  /**
   * Opens its own transaction, or joins an ambient one only when the command boundary
   * approved it (it has locked nothing but owners); refuses any other ambient caller. Locks
   * the owner (the Work row, or the lineage lock) under the caller's `WorkWriteOptions`; by
   * default it refuses one that isn't active with `WorkLifecycleUnavailableError`.
   */
  withActiveOwnerLocked<T>(
    owner: DraftOwner,
    operation: () => Promise<T>,
    options?: WorkWriteOptions,
  ): Promise<T>;
}
