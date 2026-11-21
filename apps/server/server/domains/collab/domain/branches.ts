/**
 * The one drafts resolver: which draft an owner's chats draft into (the draft a Work or a root
 * chat names), the view a read by that owner sees, and the locks every later lane takes on a
 * draft. A draft is minted with the Work or chat naming it, never at a write. Callers reach
 * drafts only through this object.
 */
import type { DraftId, DraftOwner, WorkId } from "@meridian/contracts";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { WorkWriteOptions } from "../../projects/index.js";
import type {
  Branch,
  BranchOwnerView,
  BranchStore,
  BranchWriteBoundary,
} from "./ports/branch-store.js";

export interface Branches {
  /** Reads: the owner's draft as a view, else live. */
  viewForOwner(owner: DraftOwner | null): Promise<TreeView>;
  /**
   * The write boundary only: locks the owner (the Work row, or the lineage lock) under the
   * caller's `WorkWriteOptions`, by default refusing an archived, deleted or frozen one (archive
   * and Trash stop new AI writes), then the draft it names, row-locked. With no ambient
   * transaction it runs in its own. Inside one it joins only a transaction the ContextFS command
   * boundary approved (`approveBranchWriteJoin`: it has locked nothing but owners); any other
   * ambient caller gets `BranchWriteJoinRefusedError`, so it never takes the owner lock after
   * namespace or document locks.
   */
  lockForWrite(owner: DraftOwner, options?: WorkWriteOptions): Promise<Branch>;
  /** No lock. The draft and who names it, as it reads now. */
  ownerOf(draftId: DraftId): Promise<BranchOwnerView | null>;
  /** No lock. The draft this owner names; null when the owner is gone. */
  ofOwner(owner: DraftOwner): Promise<Branch | null>;
  /**
   * Caller's transaction, after its Work row locks: `FOR NO KEY UPDATE` on the draft; null when
   * missing. The press and purge take this.
   */
  lock(draftId: DraftId): Promise<Branch | null>;
  /**
   * Caller's transaction, before any namespace lock: `FOR SHARE`, for a writer that needs the
   * draft to stay without changing it (ahead registration); null when missing.
   */
  share(draftId: DraftId): Promise<Branch | null>;
  /** No lock. These drafts. */
  byIds(draftIds: readonly DraftId[]): Promise<Branch[]>;
  /** Purge only: the drafts a Work and these lineages' roots name. */
  namedBy(input: { workId: WorkId; lineageRootIds: readonly string[] }): Promise<DraftId[]>;
  /** Purge only, caller's transaction, each draft locked and emptied: deletes the rows. */
  delete(draftIds: readonly DraftId[]): Promise<void>;
}

/** An owner the write boundary locked names no draft: its row went between the read and the lock. */
export class OwnerWithoutDraftError extends Error {
  constructor(readonly owner: DraftOwner) {
    super(`No draft is named by ${JSON.stringify(owner)}`);
    this.name = "OwnerWithoutDraftError";
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
      const draft = await store.ofOwner(owner);
      return draft ? { kind: "branch", branchId: draft.id } : { kind: "live" };
    },
    lockForWrite(owner, options) {
      return deps.boundary.withActiveOwnerLocked(
        owner,
        async () => {
          const named = await store.ofOwner(owner);
          const locked = named ? await store.lock(named.id) : null;
          if (!locked) throw new OwnerWithoutDraftError(owner);
          return locked;
        },
        options,
      );
    },
    ownerOf: (draftId) => store.ownerOf(draftId),
    ofOwner: (owner) => store.ofOwner(owner),
    lock: (draftId) => store.lock(draftId),
    share: (draftId) => store.share(draftId),
    byIds: (draftIds) => store.byIds(draftIds),
    namedBy: (input) => store.namedBy(input),
    delete: (draftIds) => store.delete(draftIds),
  };
}
