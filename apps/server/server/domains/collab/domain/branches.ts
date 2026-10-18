/**
 * The one branches resolver: which branch a Work's drafted writes share, the view a read in
 * that Work sees, and the lock and lifecycle calls every later lane makes on branches. A
 * branch is made only at the write boundary, never by a read (F7): a draft-mode chat's Work with
 * no active branch reads live. Callers reach branches only through this object.
 */
import type { BranchId, ProjectId, ThreadId, UserId, WorkId } from "@meridian/contracts";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { Branch, BranchStore, BranchWriteBoundary } from "./ports/branch-store.js";

export interface Branches {
  /** Reads: the Work's active branch as a view, else live. Never creates a branch. */
  viewForWork(workId: WorkId | null): Promise<TreeView>;
  /**
   * The write boundary only, and the only path that makes a branch: locks the Work row
   * (refusing an archived or deleted Work), then the Work's active branch, made if absent,
   * row-locked. With no ambient transaction it runs in its own. Inside one it joins only
   * a transaction the ContextFS command boundary approved (`approveBranchWriteJoin`: it has
   * locked nothing but Works); any other ambient caller gets `BranchWriteJoinRefusedError`,
   * so it never takes the Work lock after namespace or document locks.
   */
  ensureActiveForWrite(input: {
    workId: WorkId;
    projectId: ProjectId;
    threadId: ThreadId | null;
    userId: UserId;
  }): Promise<Branch>;
  /** No lock. The oldest active branch whose origin is this Work, else null. */
  activeForWork(workId: WorkId): Promise<Branch | null>;
  /**
   * Caller's transaction, after its Work row locks: `FOR NO KEY UPDATE` on the branch;
   * null when closed or missing. Apply, Discard and closing take this.
   */
  lockActive(branchId: BranchId): Promise<Branch | null>;
  /**
   * Caller's transaction, before any namespace lock: `FOR SHARE`, for a writer that needs
   * the branch to stay active without changing it (ahead registration, peer ensure); null
   * when closed or missing.
   */
  shareActive(branchId: BranchId): Promise<Branch | null>;
  /**
   * Caller's transaction, the branch locked by `lockActive`, every draft closed by the
   * Discard kernel (which returns the exact peers to retire): closes the `branches` row only.
   */
  close(branchId: BranchId, at: Date): Promise<void>;
  /** No lock. These branches, any status. */
  byIds(branchIds: readonly BranchId[]): Promise<Branch[]>;
  /** Purge only: every branch whose origin is this Work, any status, oldest first. */
  byOriginWork(workId: WorkId): Promise<Branch[]>;
}

export class BranchClosedUnderWorkLockError extends Error {
  constructor(readonly branchId: BranchId) {
    super(`Branch ${branchId} closed while its Work was locked`);
    this.name = "BranchClosedUnderWorkLockError";
  }
}

export function createBranches(deps: {
  store: BranchStore;
  boundary: BranchWriteBoundary;
}): Branches {
  const { store } = deps;
  return {
    async viewForWork(workId) {
      if (workId === null) return { kind: "live" };
      const branch = await store.activeForWork(workId);
      return branch ? { kind: "branch", branchId: branch.id } : { kind: "live" };
    },
    ensureActiveForWrite(input) {
      return deps.boundary.withActiveWorkLocked(input.workId, async () => {
        const ensured = await store.ensureActiveLocked({
          workId: input.workId,
          projectId: input.projectId,
          originThreadId: input.threadId,
          createdBy: input.userId,
        });
        // Every close locks the Work first, so the draft can't close between these.
        const locked = await store.lockActive(ensured.id);
        if (!locked) throw new BranchClosedUnderWorkLockError(ensured.id);
        return locked;
      });
    },
    activeForWork: (workId) => store.activeForWork(workId),
    lockActive: (branchId) => store.lockActive(branchId),
    shareActive: (branchId) => store.shareActive(branchId),
    close: (branchId, at) => store.close(branchId, at),
    byIds: (branchIds) => store.byIds(branchIds),
    byOriginWork: (workId) => store.byOriginWork(workId),
  };
}
