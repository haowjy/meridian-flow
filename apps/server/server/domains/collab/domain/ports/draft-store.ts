import type { DraftId, DraftOwner, ProjectId, UserId, WorkId } from "@meridian/contracts";
import type { WorkWriteOptions } from "../../../projects/index.js";

export type Draft = {
  id: DraftId;
  projectId: ProjectId;
  workId: WorkId | null;
  deletedAt: Date | null;
  createdBy: UserId;
  createdAt: Date;
};

export type DraftOwnerView = {
  draft: Draft;
  owner: DraftOwner | null;
  handle: string | null;
};

export interface DraftStore {
  ownerOf(draftId: DraftId): Promise<DraftOwnerView | null>;
  ofOwner(owner: DraftOwner): Promise<Draft | null>;
  /** Caller's transaction, after the owner locks: `FOR NO KEY UPDATE`; null when missing. */
  lock(draftId: DraftId): Promise<Draft | null>;
  byIds(draftIds: readonly DraftId[]): Promise<Draft[]>;
  namedBy(input: { workId: WorkId; lineageRootIds: readonly string[] }): Promise<DraftId[]>;
}

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
