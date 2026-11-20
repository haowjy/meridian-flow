/**
 * The review list (contract §13.1, sync 8 §3.1): a branch's items are its tree state (every
 * document it created, moved or deleted, and the documents it edited) merged by document with its
 * owner's suggestions in Live. An item is listed when the tree view's one reviewable-pending
 * predicate holds (`TreeStateNode.pending`): a created document, a move or delete live doesn't
 * already agree with, or suggestions in a document the branch isn't deleting, so a write and its
 * undo net to no item. That one predicate feeds the list, the Work counts and the confirmation.
 * Every item is keyed `${branchId}:${documentId}` (F12) and carries the tree-derived address and
 * whether it has text changes.
 */
import type { BranchId } from "@meridian/contracts";
import { type DraftItemKey, draftItemKey } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { BranchDocumentTree, BranchTreeStateReader } from "./ports/branch-tree-state.js";
import type { WorkBranchTextChanges } from "./ports/work-branch-pending-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";

export type DraftReviewItem = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** Whether this item has text changes: the owner's suggestions in the Live document. */
  hasDraft: boolean;
  /** The text changes the document's derivation last counted; 0 without any. */
  textChanges: number;
  /** created: the branch has a `created` row; edited: text changes only. */
  origin: "created" | "edited";
  /** A creation only the Work shows: derived on read, nothing rewrites it. */
  isNew: boolean;
  binary: boolean;
  documentName: string | null;
  /** Canonical URI in the branch's view (the last address for one deleted live). */
  path: string | null;
  /**
   * Deleted live (an edited document, or a revealed create): live no longer shows it, the
   * branch's view does while it has pending changes. It authorizes through its final location
   * (F9, §13.3), and Apply restores it.
   */
  deletedLive: boolean;
  /** For `deletedLive`: where live last had it (`path` is where the branch puts it). */
  deletedFrom: string | null;
  /** `isNew || binary`: one change, settled by item Apply or Discard only (§3.3). */
  wholeItem: boolean;
  /**
   * The branch's row on the document: the revision a tree cut freezes, and what it says.
   * `movedFrom` is where live has a moving document now (`path` is where the branch puts it).
   */
  tree: { movedFrom: string | null; deleted: boolean } | null;
  /** Chats with pending text changes, then the chats behind its tree row. */
  actorThreadIds: string[];
  /** A text change no chat wrote (the writer's typing). */
  unattributed: boolean;
  updatedAt: Date;
};

/** One document the branch has a view of: its item, and whether the list shows it. */
export type ResolvedDraftItem = { item: DraftReviewItem; listed: boolean };

export interface BranchReviewItems {
  /** The branch's listed items. */
  list(branchId: BranchId): Promise<DraftReviewItem[]>;
  /**
   * One document's item and whether it is listed, for every document the branch has a view
   * of (text changes, or a change row); null only when it is not addressable.
   */
  resolve(branchId: BranchId, documentId: DocumentId): Promise<ResolvedDraftItem | null>;
}

export function createBranchReviewItems(deps: {
  tree: BranchTreeStateReader;
  /** The documents the branch's owner has suggestions in (only these documents' when given). */
  text(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<readonly WorkBranchTextChanges[]>;
  /** The chats behind each document's branch row (moved or deleted it, created it). */
  treeActors(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, readonly string[]>>;
}): BranchReviewItems {
  async function items(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ResolvedDraftItem[]> {
    const text = await deps.text(branchId, documentIds);
    const textOf = new Map(text.map((changes) => [changes.documentId, changes]));
    const nodes = await deps.tree.read(
      branchId,
      text.map((changes) => changes.documentId),
      documentIds,
    );
    const treeActors = await deps.treeActors(branchId, documentIds);
    const resolved = nodes.map((node) => ({
      item: toItem(
        branchId,
        node,
        textOf.get(node.documentId),
        treeActors.get(node.documentId) ?? [],
      ),
      listed: node.pending,
    }));
    return resolved.sort((a, b) => (a.item.path ?? "").localeCompare(b.item.path ?? ""));
  }

  return {
    async list(branchId) {
      return (await items(branchId)).filter(({ listed }) => listed).map(({ item }) => item);
    },
    async resolve(branchId, documentId) {
      const resolved = await items(branchId, [documentId]);
      return resolved.find(({ item }) => item.documentId === documentId) ?? null;
    },
  };
}

function toItem(
  branchId: BranchId,
  node: BranchDocumentTree,
  text: WorkBranchTextChanges | undefined,
  treeActorThreadIds: readonly string[],
): DraftReviewItem {
  const path = node.uri;
  return {
    branchId,
    itemKey: draftItemKey(branchId, node.documentId),
    documentId: node.documentId,
    origin: node.origin,
    isNew: node.isNew,
    binary: node.binary,
    // A document deleted live takes per-change Apply too: any Apply restores it first.
    wholeItem: node.isNew || node.binary,
    tree: node.change
      ? {
          movedFrom: node.change === "moving" ? node.movedFromUri : null,
          deleted: node.change === "deleting",
        }
      : null,
    hasDraft: !!text,
    textChanges: text?.textChanges ?? 0,
    documentName: documentTitleFromUri(path),
    path,
    deletedLive: node.deletedLive,
    deletedFrom: node.deletedLive ? node.deletedFromUri : null,
    actorThreadIds: [...new Set([...(text?.writers.threadIds ?? []), ...treeActorThreadIds])],
    unattributed: text?.writers.unattributed ?? false,
    updatedAt: text?.updatedAt ?? new Date(),
  };
}
