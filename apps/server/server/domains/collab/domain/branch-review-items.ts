/**
 * The review list (contract §13.1, sync 8 §3.1): a branch's items are its tree state (every
 * document it created, moved or deleted, listed with no text yet, and the documents it
 * edited) merged by document with its `work_draft` drafts. An item is listed when the tree
 * view's one reviewable-pending predicate holds (`TreeStateNode.pending`): a created
 * document, a move or delete live doesn't already agree with, or an active draft with
 * `hasEffect` the branch isn't deleting, so a write and its undo net to no item. That one
 * predicate feeds the list, the Work counts and the D40 confirmation. A draft with no effect is still addressable
 * (`resolve`), unlisted, so its next proposal keeps the same room. Every item is keyed `${branchId}:${documentId}` (F12) and carries the
 * tree-derived address and whether it has a text draft.
 */
import type { BranchId } from "@meridian/contracts";
import { type DraftItemKey, draftItemKey } from "@meridian/contracts";
import type { DraftItemConflict } from "@meridian/contracts/branches";
import type { DocumentId } from "@meridian/contracts/runtime";
import { LIVE_TREE, type TreeReader, type TreeStateNode } from "../../context/tree/tree-view.js";
import type { WorkBranchDraftMetadata } from "./ports/work-branch-pending-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";

export type DraftReviewItem = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The branch's draft on the document; null for an image or a create with no text yet. */
  draftId: string | null;
  /** Whether this item has a text draft. */
  hasDraft: boolean;
  /** created: the branch has a `created` row; edited: draft rows only. */
  origin: "created" | "edited";
  /** Created and still hidden: derived on read, nothing rewrites it. */
  isNew: boolean;
  binary: boolean;
  documentName: string | null;
  /** Canonical URI in the branch's view (the last address for one deleted live). */
  path: string | null;
  /** Eligibility only; existence is `deletedLive`, which a taken path doesn't hide. */
  conflict: DraftItemConflict | null;
  /**
   * Deleted live (an edited document, or a revealed create): live no longer shows it, the
   * branch's view does while it has pending changes (D79). It authorizes through the
   * branch's draft on it and its final location (F9, §13.3), and Apply restores it.
   */
  deletedLive: boolean;
  /** `isNew || binary`: one change, settled by item Apply or Discard only (§3.3). */
  wholeItem: boolean;
  /**
   * The branch's row on the document: the revision a tree cut freezes, and what it says.
   * `movedFrom` is where live has a moving document now (`path` is where the branch puts it).
   */
  tree: { revision: string | null; movedFrom: string | null; deleted: boolean } | null;
  /** Chats with pending writes on the draft, latest first, then the creating chat. */
  actorThreadIds: string[];
  updatedAt: Date;
};

/** One document the branch has a view of: its item, and whether the list shows it. */
export type ResolvedDraftItem = { item: DraftReviewItem; listed: boolean };

export interface BranchReviewItems {
  /** The branch's listed items. */
  list(branchId: BranchId): Promise<DraftReviewItem[]>;
  /**
   * One document's item and whether it is listed, for every document the branch has a view
   * of (an active draft, or a change row); null only when it is not addressable.
   */
  resolve(branchId: BranchId, documentId: DocumentId): Promise<ResolvedDraftItem | null>;
}

export function createBranchReviewItems(deps: {
  tree: Pick<TreeReader, "treeState" | "resolvePath">;
  /**
   * The branch's active `work_draft` drafts (only these documents' when given), each
   * metadata only.
   */
  drafts(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<readonly WorkBranchDraftMetadata[]>;
  /** Expensive receipt membership, read only for listed items. */
  pendingThreadIds(draftId: string): Promise<string[]>;
  /** The chat that created each document the branch created; absent for a writer's create. */
  creators(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, string>>;
}): BranchReviewItems {
  async function items(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ResolvedDraftItem[]> {
    const drafts = await deps.drafts(branchId, documentIds);
    const draftOf = new Map(drafts.map((evidence) => [evidence.documentId, evidence]));
    const nodes = await deps.tree.treeState(
      branchId,
      drafts.map((evidence) => evidence.documentId),
      documentIds,
    );
    const creators = await deps.creators(branchId, documentIds);
    const resolved = await Promise.all(
      nodes.map(async (node) => {
        const evidence = draftOf.get(node.nodeId);
        const item = toItem(branchId, node, evidence, creators.get(node.nodeId));
        item.conflict ??= await waitsFor(branchId, node);
        return { item, listed: node.pending };
      }),
    );
    return resolved.sort((a, b) => (a.item.path ?? "").localeCompare(b.item.path ?? ""));
  }

  /**
   * A moving document whose destination live still gives another document this branch moves
   * or deletes: its Apply waits for that item's (Apply all orders them; a swap stays held).
   */
  async function waitsFor(
    branchId: BranchId,
    node: TreeStateNode,
  ): Promise<DraftReviewItem["conflict"]> {
    if (node.branch?.state !== "moving") return null;
    const found = await deps.tree.resolvePath(LIVE_TREE, {
      contextSourceId: node.target.contextSourceId,
      path: node.target.path,
      as: "document",
    });
    if (found.kind !== "found" || found.node.kind !== "document") return null;
    const occupant = found.node.document.id;
    if (occupant === node.nodeId) return null;
    const [other] = await deps.tree.treeState(branchId, [], [occupant]);
    return other?.nodeId === occupant && (other.branch?.moved || other.branch?.deleted)
      ? {
          code: "pending_item",
          path: node.target.uri ?? node.target.path,
          itemKey: draftItemKey(branchId, occupant),
        }
      : null;
  }

  return {
    async list(branchId) {
      const listed = (await items(branchId)).flatMap(({ item, listed }) => (listed ? [item] : []));
      return Promise.all(
        listed.map(async (item) => {
          const members = item.draftId ? await deps.pendingThreadIds(item.draftId) : [];
          return { ...item, actorThreadIds: [...new Set([...members, ...item.actorThreadIds])] };
        }),
      );
    },
    async resolve(branchId, documentId) {
      const resolved = await items(branchId, [documentId]);
      return resolved.find(({ item }) => item.documentId === documentId) ?? null;
    },
  };
}

function toItem(
  branchId: BranchId,
  node: TreeStateNode,
  evidence: WorkBranchDraftMetadata | undefined,
  creatorThreadId: string | undefined,
): DraftReviewItem {
  const deletedLive = !node.hidden && node.deleted;
  const isNew = node.origin === "created" && node.hidden;
  const path = node.target.uri;
  return {
    branchId,
    itemKey: draftItemKey(branchId, node.nodeId),
    documentId: node.nodeId,
    draftId: evidence?.draftId ?? null,
    origin: node.origin,
    isNew,
    binary: node.binary,
    // A document deleted live takes per-change Apply too: any Apply restores it first.
    wholeItem: isNew || node.binary,
    tree: node.branch
      ? {
          revision: node.branch.revision?.toString() ?? null,
          movedFrom: node.branch.state === "moving" ? (node.from?.uri ?? null) : null,
          deleted: node.branch.state === "deleting",
        }
      : null,
    hasDraft: !!evidence,
    documentName: documentTitleFromUri(path),
    path,
    conflict: conflictOf(node),
    deletedLive,
    actorThreadIds: creatorThreadId ? [creatorThreadId] : [],
    updatedAt: evidence?.updatedAt ?? new Date(),
  };
}

function conflictOf(node: TreeStateNode): DraftReviewItem["conflict"] {
  switch (node.conflict.kind) {
    case "clash":
      return { code: "path_taken", path: node.conflict.uri ?? node.conflict.at };
    case "deleted_live":
    case "none":
      return null;
  }
}
