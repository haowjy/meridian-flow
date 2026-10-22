/** Persistence port for Work branches: the `branches` rows the resolver owns. */
import type { BranchId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts";

export type BranchStatus = "active" | "closed";

export type Branch = {
  id: BranchId;
  projectId: ProjectId;
  status: BranchStatus;
  /** Provenance, not ownership (decision 3). */
  originWorkId: WorkId | null;
  originThreadId: ThreadId | null;
  createdBy: UserId;
  createdAt: Date;
};

export interface BranchStore {
  /** No lock. Oldest active branch whose origin is this Work, else null. */
  activeForWork(workId: WorkId): Promise<Branch | null>;
  /** Caller's transaction, Work row already locked: the active branch, inserted if absent. */
  ensureActiveLocked(input: {
    workId: WorkId;
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
}

/** The write boundary's transaction and Work row lock. */
export interface BranchWriteBoundary {
  /**
   * Opens its own transaction, or joins an ambient one only when the command boundary
   * approved it (it has locked nothing but Works); refuses any other ambient caller. Locks
   * the Work row and refuses a Work that isn't active with `WorkLifecycleUnavailableError`.
   */
  withActiveWorkLocked<T>(workId: WorkId, operation: () => Promise<T>): Promise<T>;
}
