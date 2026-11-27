import type { DraftId, DraftOwner, WorkId } from "@meridian/contracts";
import type { TreeView } from "../../context/tree/tree-view.js";
import type { WorkWriteOptions } from "../../projects/index.js";
import type { Draft, DraftOwnerView, DraftStore, DraftWriteBoundary } from "./ports/draft-store.js";

export interface Drafts {
  viewForOwner(owner: DraftOwner | null): Promise<TreeView>;
  lockForWrite(owner: DraftOwner, draftId: DraftId, options?: WorkWriteOptions): Promise<Draft>;
  ownerOf(draftId: DraftId): Promise<DraftOwnerView | null>;
  ofOwner(owner: DraftOwner): Promise<Draft | null>;
  /**
   * Caller's transaction, after its Work row locks: `FOR NO KEY UPDATE` on the draft; null when
   * missing. The press and purge take this.
   */
  lock(draftId: DraftId): Promise<Draft | null>;
  byIds(draftIds: readonly DraftId[]): Promise<Draft[]>;
  namedBy(input: { workId: WorkId; lineageRootIds: readonly string[] }): Promise<DraftId[]>;
}

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
