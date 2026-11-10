/**
 * The one branches resolver: which branch an owner's drafted writes share (a Work, or a
 * conversation lineage), the view a read by that owner sees, and the lock and lifecycle calls
 * every later lane makes on branches. A branch is made only at the write boundary, never by a
 * read (F7): a draft-mode chat whose owner has no active branch reads live. Callers reach
 * branches only through this object.
 */
import type {
  BranchId,
  DraftOwner,
  ProjectId,
  ThreadId,
  UserId,
  WorkId,
} from "@meridian/contracts";
import type { TreeView } from "../../context/tree/tree-view.js";
import type {
  Branch,
  BranchOwnerView,
  BranchStore,
  BranchWriteBoundary,
} from "./ports/branch-store.js";

export interface Branches {
  /** Reads: the owner's active branch as a view, else live. Never creates a branch. */
  viewForOwner(owner: DraftOwner | null): Promise<TreeView>;
  /**
   * The write boundary only, and the only path that makes a branch: locks the owner (the Work
   * row, or the lineage lock; refusing an archived, deleted or frozen one), then the owner's
   * active branch, made if absent, row-locked. With no ambient transaction it runs in its own.
   * Inside one it joins only a transaction the ContextFS command boundary approved
   * (`approveBranchWriteJoin`: it has locked nothing but owners); any other ambient caller gets
   * `BranchWriteJoinRefusedError`, so it never takes the owner lock after namespace or document
   * locks.
   */
  ensureActiveForWrite(input: {
    owner: DraftOwner;
    projectId: ProjectId;
    threadId: ThreadId | null;
    userId: UserId;
  }): Promise<Branch>;
  /** No lock. The branch and its owner's lifecycle as it reads now; any status. */
  ownerOf(branchId: BranchId): Promise<BranchOwnerView | null>;
  /** No lock. The oldest active branch this owner has, else null. */
  activeForOwner(owner: DraftOwner): Promise<Branch | null>;
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
  /** Purge only: the active branches these lineages own. */
  activeByOriginLineages(rootThreadIds: readonly ThreadId[]): Promise<Branch[]>;
}

export class BranchClosedUnderOwnerLockError extends Error {
  constructor(readonly branchId: BranchId) {
    super(`Branch ${branchId} closed while its owner was locked`);
    this.name = "BranchClosedUnderOwnerLockError";
  }
}

export function createBranches(deps: {
  store: BranchStore;
  boundary: BranchWriteBoundary;
}): Branches {
  const { store } = deps;
  return {
    async viewForOwner(owner) {
      if (owner === null) return { kind: "live" };
      const branch = await store.activeForOwner(owner);
      return branch ? { kind: "branch", branchId: branch.id } : { kind: "live" };
    },
    ensureActiveForWrite(input) {
      return deps.boundary.withActiveOwnerLocked(input.owner, async () => {
        const ensured = await store.ensureActiveLocked({
          owner: input.owner,
          projectId: input.projectId,
          originThreadId: input.threadId,
          createdBy: input.userId,
        });
        // Every close locks the owner first, so the branch can't close between these.
        const locked = await store.lockActive(ensured.id);
        if (!locked) throw new BranchClosedUnderOwnerLockError(ensured.id);
        return locked;
      });
    },
    ownerOf: (branchId) => store.ownerOf(branchId),
    activeForOwner: (owner) => store.activeForOwner(owner),
    lockActive: (branchId) => store.lockActive(branchId),
    shareActive: (branchId) => store.shareActive(branchId),
    close: (branchId, at) => store.close(branchId, at),
    byIds: (branchIds) => store.byIds(branchIds),
    byOriginWork: (workId) => store.byOriginWork(workId),
    activeByOriginLineages: (rootThreadIds) => store.activeByOriginLineages(rootThreadIds),
  };
}
