/**
 * The one drafts resolver: which draft an owner's chats draft into (the draft a Work or a root
 * chat names), the view a read by that owner sees, and the locks every later lane takes on a
 * draft. A draft is minted with the Work or chat naming it, never at a write. Callers reach
 * drafts only through this object.
 */
import type { DraftId, DraftOwner, WorkId } from "@meridian/contracts";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { WorkWriteOptions } from "../../projects/index.js";
import type { Draft, DraftOwnerView, DraftStore, DraftWriteBoundary } from "./ports/draft-store.js";

export interface Drafts {
  /** Reads: the owner's draft as a view, else live. */
  viewForOwner(owner: DraftOwner | null): Promise<TreeView>;
  /**
   * The write boundary only: locks the owner (the Work row, or the lineage lock) under the
   * caller's `WorkWriteOptions`, by default refusing an archived, deleted or frozen one (archive
   * and Trash stop new AI writes), then the draft the write names, row-locked: `draftId` while
   * it is still the owner's and not deleted, else the owner's default. With no ambient
   * transaction it runs in its own. Inside one it joins only a transaction the ContextFS command
   * boundary approved (`approveDraftWriteJoin`: it has locked nothing but owners); any other
   * ambient caller gets `DraftWriteJoinRefusedError`, so it never takes the owner lock after
   * namespace or document locks.
   */
  lockForWrite(owner: DraftOwner, draftId: DraftId, options?: WorkWriteOptions): Promise<Draft>;
  /** No lock. The draft and who names it, as it reads now. */
  ownerOf(draftId: DraftId): Promise<DraftOwnerView | null>;
  /** No lock. The draft this owner names; null when the owner is gone. */
  ofOwner(owner: DraftOwner): Promise<Draft | null>;
  /**
   * Caller's transaction, after its Work row locks: `FOR NO KEY UPDATE` on the draft; null when
   * missing. The press and purge take this.
   */
  lock(draftId: DraftId): Promise<Draft | null>;
  /** No lock. These drafts. */
  byIds(draftIds: readonly DraftId[]): Promise<Draft[]>;
  /** Purge only: the drafts a Work and these lineages' roots name. */
  namedBy(input: { workId: WorkId; lineageRootIds: readonly string[] }): Promise<DraftId[]>;
}

/** An owner the write boundary locked names no draft: its row went between the read and the lock. */
export class OwnerWithoutDraftError extends Error {
  constructor(readonly owner: DraftOwner) {
    super(`No draft is named by ${JSON.stringify(owner)}`);
    this.name = "OwnerWithoutDraftError";
  }
}

export function createDrafts(deps: { store: DraftStore; boundary: DraftWriteBoundary }): Drafts {
  const { store } = deps;
  return {
    async viewForOwner(owner) {
      if (owner === null) return { kind: "live" };
      const draft = await store.ofOwner(owner);
      return draft ? { kind: "draft", draftId: draft.id } : { kind: "live" };
    },
    lockForWrite(owner, draftId, options) {
      return deps.boundary.withActiveOwnerLocked(
        owner,
        async () => {
          const named = await store.lock(draftId);
          if (named && !named.deletedAt && ownedBy(named, owner)) return named;
          const fallback = await store.ofOwner(owner);
          const locked = fallback ? await store.lock(fallback.id) : null;
          if (!locked) throw new OwnerWithoutDraftError(owner);
          return locked;
        },
        options,
      );
    },
    ownerOf: (draftId) => store.ownerOf(draftId),
    ofOwner: (owner) => store.ofOwner(owner),
    lock: (draftId) => store.lock(draftId),
    byIds: (draftIds) => store.byIds(draftIds),
    namedBy: (input) => store.namedBy(input),
  };
}

const ownedBy = (draft: Draft, owner: DraftOwner) =>
  owner.kind === "work" ? draft.workId === owner.workId : draft.workId === null;
