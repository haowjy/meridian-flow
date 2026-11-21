/**
 * The review list (contract §13.1, sync 8 §3.1): a draft's items are its tree state (every
 * document it created, moved or deleted, and the documents it edited) merged by document with its
 * owner's suggestions in Live. An item is listed when the tree view's one reviewable-pending
 * predicate holds (`TreeStateNode.pending`): a created document, a move or delete live doesn't
 * already agree with, or suggestions in a document the draft isn't deleting, so a write and its
 * undo net to no item. That one predicate feeds the list, the Work counts and the confirmation.
 * Every item is keyed `${draftId}:${documentId}` (F12) and carries the tree-derived address and
 * whether it has text changes.
 */
import type { DraftId } from "@meridian/contracts";
import { type DraftItemKey, draftItemKey } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { DraftDocumentTree, DraftTreeStateReader } from "./ports/draft-tree-state.js";
import type { WorkDraftTextChanges } from "./ports/work-draft-pending-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";

export type DraftReviewItem = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The text changes the document's derivation last counted; 0 without any. */
  textChanges: number;
  /** created: the draft has a `created` row; edited: text changes only. */
  origin: "created" | "edited";
  /** A creation only the Work shows: derived on read, nothing rewrites it. */
  isNew: boolean;
  binary: boolean;
  documentName: string | null;
  /** Canonical URI in the draft's view (the last address for one the draft deletes). */
  path: string | null;
  /** `isNew || binary`: one change, settled by item Apply or Discard only (§3.3). */
  wholeItem: boolean;
  /**
   * The draft's row on the document: the revision a tree cut freezes, and what it says.
   * `movedFrom` is where live has a moving document now (`path` is where the draft puts it).
   */
  tree: { movedFrom: string | null; deleted: boolean } | null;
  /** Chats with pending text changes, then the chats behind its tree row. */
  actorThreadIds: string[];
  /** A text change no chat wrote (the writer's typing). */
  unattributed: boolean;
  updatedAt: Date;
};

/** One document the draft has a view of: its item, and whether the list shows it. */
export type ResolvedDraftItem = { item: DraftReviewItem; listed: boolean };

export interface DraftReviewItems {
  /** The draft's listed items. */
  list(draftId: DraftId): Promise<DraftReviewItem[]>;
  /**
   * One document's item and whether it is listed, for every document the draft has a view
   * of (text changes, or a change row); null only when it is not addressable.
   */
  resolve(draftId: DraftId, documentId: DocumentId): Promise<ResolvedDraftItem | null>;
}

export function createDraftReviewItems(deps: {
  tree: DraftTreeStateReader;
  /** The documents the draft's owner has suggestions in (only these documents' when given). */
  text(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<readonly WorkDraftTextChanges[]>;
  /** The chats behind each document's draft row (moved or deleted it, created it). */
  treeActors(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, readonly string[]>>;
}): DraftReviewItems {
  async function items(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<ResolvedDraftItem[]> {
    const text = await deps.text(draftId, documentIds);
    const textOf = new Map(text.map((changes) => [changes.documentId, changes]));
    const nodes = await deps.tree.read(
      draftId,
      text.map((changes) => changes.documentId),
      documentIds,
    );
    const treeActors = await deps.treeActors(draftId, documentIds);
    const resolved = nodes.map((node) => ({
      item: toItem(
        draftId,
        node,
        textOf.get(node.documentId),
        treeActors.get(node.documentId) ?? [],
      ),
      listed: node.pending,
    }));
    return resolved.sort((a, b) => (a.item.path ?? "").localeCompare(b.item.path ?? ""));
  }

  return {
    async list(draftId) {
      return (await items(draftId)).filter(({ listed }) => listed).map(({ item }) => item);
    },
    async resolve(draftId, documentId) {
      const resolved = await items(draftId, [documentId]);
      return resolved.find(({ item }) => item.documentId === documentId) ?? null;
    },
  };
}

function toItem(
  draftId: DraftId,
  node: DraftDocumentTree,
  text: WorkDraftTextChanges | undefined,
  treeActorThreadIds: readonly string[],
): DraftReviewItem {
  const path = node.uri;
  return {
    draftId,
    itemKey: draftItemKey(draftId, node.documentId),
    documentId: node.documentId,
    origin: node.origin,
    isNew: node.isNew,
    binary: node.binary,
    wholeItem: node.isNew || node.binary,
    tree: node.change
      ? {
          movedFrom: node.change === "moving" ? node.movedFromUri : null,
          deleted: node.change === "deleting",
        }
      : null,
    textChanges: text?.textChanges ?? 0,
    documentName: documentTitleFromUri(path),
    path,
    actorThreadIds: [...new Set([...(text?.writers.threadIds ?? []), ...treeActorThreadIds])],
    unattributed: text?.writers.unattributed ?? false,
    updatedAt: text?.updatedAt ?? new Date(),
  };
}
