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
  withActiveOwnerLocked<T>(
    owner: DraftOwner,
    operation: () => Promise<T>,
    options?: WorkWriteOptions,
  ): Promise<T>;
}
