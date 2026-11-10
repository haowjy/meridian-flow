/** Persistence port for Work branches: the `branches` rows the resolver owns. */
import type {
  BranchId,
  DraftOwner,
  ProjectId,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import type { BranchOwnerLifecycle } from "../../../../shared/draft-owner.js";

export type BranchStatus = "active" | "closed";

export type Branch = {
  id: BranchId;
  projectId: ProjectId;
  status: BranchStatus;
  /** The owner is one of these: a Work, or a lineage. Both null: a purged Work's closed branch. */
  originWorkId: WorkId | null;
  originRootThreadId: ThreadId | null;
  /** Provenance, not ownership (decision 3): the chat that created the branch. */
  originThreadId: ThreadId | null;
  createdBy: UserId;
  createdAt: Date;
};

/** A branch with its owner's lifecycle as the row reads now; any status. */
export type BranchOwnerView = {
  branch: Branch;
  owner: DraftOwner | null;
  handle: string | null;
  lifecycle: BranchOwnerLifecycle;
};

export interface BranchStore {
  /** No lock. The branch and its owner's lifecycle; null when there is no such branch. */
  ownerOf(branchId: BranchId): Promise<BranchOwnerView | null>;
  /** No lock. Oldest active branch this owner has, else null. */
  activeForOwner(owner: DraftOwner): Promise<Branch | null>;
  /** Caller's transaction, owner already locked: the active branch, inserted if absent. */
  ensureActiveLocked(input: {
    owner: DraftOwner;
    projectId: ProjectId;
    originThreadId: ThreadId | null;
    createdBy: UserId;
  }): Promise<Branch>;
  /** Caller's transaction, after Work locks: `FOR NO KEY UPDATE`; null when closed or missing. */
  lockActive(branchId: BranchId): Promise<Branch | null>;
  /** `FOR SHARE`: a writer that needs the branch to stay active without changing it. */
  shareActive(branchId: BranchId): Promise<Branch | null>;
  /**
   * Caller's transaction, branch locked: closes the `branches` row only. The Discard kernel closes
   * the drafts first (`closeBranchDrafts`), because it owns peer retirement and disposition.
   */
  close(branchId: BranchId, at: Date): Promise<void>;
  byIds(branchIds: readonly BranchId[]): Promise<Branch[]>;
  /** Purge only: every branch whose origin is this Work, any status. */
  byOriginWork(workId: WorkId): Promise<Branch[]>;
  /** Purge only: every active branch owned by these lineages. */
  activeByOriginLineages(rootThreadIds: readonly ThreadId[]): Promise<Branch[]>;
}

/** The write boundary's transaction and owner lock. */
export interface BranchWriteBoundary {
  /**
   * Opens its own transaction, or joins an ambient one only when the command boundary
   * approved it (it has locked nothing but owners); refuses any other ambient caller. Locks
   * the owner (the Work row, or the lineage lock) and refuses one that isn't active with
   * `WorkLifecycleUnavailableError`.
   */
  withActiveOwnerLocked<T>(owner: DraftOwner, operation: () => Promise<T>): Promise<T>;
}
