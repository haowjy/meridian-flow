/**
 * The review list (contract §13.1, sync 8 §3.1): a branch's items are its tree state (every
 * document it created, listed with no text yet, and the documents it edited) merged by
 * document with its `work_draft` drafts. A created document is always an item; an edited
 * one is when its active draft has `hasEffect`, so a write and its
 * undo net to no item. That one predicate feeds the list, the
 * Work counts and the D40 confirmation. A draft with no effect is still addressable
 * (`resolve`), unlisted, so its next proposal keeps the same room. Every item is keyed `${branchId}:${documentId}` (F12) and carries the
 * tokens Apply checks (§11.3): its location version from the same tree read that spells
 * its path, the live document's full-state fingerprint, and the draft generation.
 */
import type { BranchId } from "@meridian/contracts";
import { type DraftItemKey, draftItemKey } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { TreeReader, TreeStateNode } from "../../context/tree/tree-view.js";
import type { WorkBranchPendingEvidence } from "./ports/work-branch-pending-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";

export type DraftReviewItem = {
  branchId: BranchId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The branch's draft on the document; null for an image or a create with no text yet. */
  draftId: string | null;
  /** The draft's generation; null without a draft. */
  hasDraft: boolean;
  /** created: the branch has a `created` row; edited: draft rows only. */
  origin: "created" | "edited";
  /** Created and still hidden: derived on read, nothing rewrites it. */
  isNew: boolean;
  binary: boolean;
  documentName: string | null;
  /** Canonical URI in the branch's view (the last address for one deleted live). */
  path: string | null;
  conflict: { code: "path_taken"; path: string } | { code: "deleted_live" } | null;
  tokens: {
    locationToken: string;
    liveTextToken: string | null;
  };
  /**
   * Deleted live (an edited document, or a revealed create): no view shows it, so it
   * authorizes through the branch's draft on it and its final location (F9, §13.3).
   */
  deletedLive: boolean;
  /** `isNew || binary || deletedLive`: one change, settled by item Apply or Discard only (§3.3). */
  wholeItem: boolean;
  /** Chats with pending writes on the draft, latest first, then the creating chat. */
  actorThreadIds: string[];
  updatedAt: Date;
};

/** One document the branch has a view of: its item, and whether the list shows it. */
export type ResolvedDraftItem = { item: DraftReviewItem; listed: boolean };

export interface BranchReviewItems {
  /** The branch's listed items, live text tokens unread (null). */
  list(branchId: BranchId): Promise<DraftReviewItem[]>;
  /**
   * One document's item and whether it is listed, for every document the branch has a view
   * of (an active draft, or a change row); null only when it is not addressable.
   */
  resolve(branchId: BranchId, documentId: DocumentId): Promise<ResolvedDraftItem | null>;
  /**
   * The review list's enrichment: each live document's full-state fingerprint read under
   * its lease, for an item with text that live readers see. Apply compares the tokens a
   * request carries; it never needs these.
   */
  withLiveTextTokens(items: readonly DraftReviewItem[]): Promise<DraftReviewItem[]>;
}

export function createBranchReviewItems(deps: {
  tree: Pick<TreeReader, "treeState">;
  /**
   * The branch's active `work_draft` drafts (only these documents' when given), each
   * with its pending text membership.
   */
  drafts(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<readonly WorkBranchPendingEvidence[]>;
  /** The chat that created each document the branch created; absent for a writer's create. */
  creators(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, string>>;
  /** The live document's full-state fingerprint, read under its coordinator lease. */
  liveFingerprint(documentId: DocumentId): Promise<string>;
}): BranchReviewItems {
  async function items(
    branchId: BranchId,
    documentIds?: readonly DocumentId[],
  ): Promise<ResolvedDraftItem[]> {
    const drafts = await deps.drafts(branchId, documentIds);
    const draftOf = new Map(
      drafts.map((evidence) => [evidence.documentDraft.documentId, evidence]),
    );
    const nodes = await deps.tree.treeState(
      branchId,
      drafts.map((evidence) => evidence.documentDraft.documentId),
      documentIds,
    );
    const creators = await deps.creators(branchId, documentIds);
    return nodes
      .map((node) => {
        const evidence = draftOf.get(node.nodeId);
        const item = toItem(branchId, node, evidence, creators.get(node.nodeId));
        return { item, listed: node.origin === "created" || isEdited(evidence) };
      })
      .sort((a, b) => (a.item.path ?? "").localeCompare(b.item.path ?? ""));
  }

  return {
    async list(branchId) {
      return (await items(branchId)).flatMap(({ item, listed }) => (listed ? [item] : []));
    },
    async resolve(branchId, documentId) {
      return (await items(branchId, [documentId]))[0] ?? null;
    },
    withLiveTextTokens: (listed) =>
      Promise.all(
        listed.map(async (item) =>
          // Live text exists only for a document live readers see.
          item.draftId && !item.isNew && !item.deletedLive && !item.binary
            ? {
                ...item,
                tokens: {
                  ...item.tokens,
                  liveTextToken: await deps.liveFingerprint(item.documentId),
                },
              }
            : item,
        ),
      ),
  };
}

/** The §3.1 predicate for a document the branch only edited. */
function isEdited(evidence: WorkBranchPendingEvidence | undefined): boolean {
  return evidence?.documentDraft.hasEffect ?? false;
}

function toItem(
  branchId: BranchId,
  node: TreeStateNode,
  evidence: WorkBranchPendingEvidence | undefined,
  creatorThreadId: string | undefined,
): DraftReviewItem {
  const deletedLive = !node.hidden && node.deleted;
  const isNew = node.origin === "created" && node.hidden;
  const writers = evidence?.agentThreadIds ?? [];
  const path = node.target.uri;
  return {
    branchId,
    itemKey: draftItemKey(branchId, node.nodeId),
    documentId: node.nodeId,
    draftId: evidence?.documentDraft.draftId ?? null,
    origin: node.origin,
    isNew,
    binary: node.binary,
    wholeItem: isNew || node.binary || deletedLive,
    hasDraft: !!evidence,
    documentName: documentTitleFromUri(path),
    path,
    conflict: conflictOf(node),
    deletedLive,
    tokens: {
      locationToken: node.locationVersion.toString(),
      liveTextToken: null,
    },
    actorThreadIds:
      creatorThreadId && !writers.includes(creatorThreadId)
        ? [...writers, creatorThreadId]
        : writers,
    updatedAt: evidence?.documentDraft.updatedAt ?? new Date(),
  };
}

function conflictOf(node: TreeStateNode): DraftReviewItem["conflict"] {
  switch (node.conflict.kind) {
    case "clash":
      return { code: "path_taken", path: node.conflict.uri ?? node.conflict.at };
    case "deleted_live":
      return { code: "deleted_live" };
    case "none":
      return null;
  }
}
