/**
 * The review list (contract §13.1, sync 8 §3.1): a draft's items are its tree state (every
 * document it created, listed with no text yet, and the documents it edited) merged by
 * document with its `work_draft` branches. A created document is always an item; an edited
 * one is when its branch has reviewable rows and `hasEffect OR blocking`, so a write and its
 * undo net to no item and a held restoration stays. That one predicate feeds the list, the
 * Work counts and the D40 confirmation. A branch with no effect is still addressable
 * (`resolve`), unlisted, so its next proposal keeps the same room. Every item is keyed `${draftId}:${documentId}` (F12) and carries the
 * tokens Apply checks (§11.3): its location version from the same tree read that spells
 * its path, the live document's full-state fingerprint, and the branch generation.
 */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { TreeReader, TreeStateNode } from "../../context/tree/tree-view.js";
import { type DraftItemKey, draftItemKey } from "./draft-publication.js";
import type { WorkDraftPendingEvidence } from "./ports/work-draft-pending-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";

export type DraftReviewItem = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The draft's branch on the document; null for an image or a create with no text yet. */
  draftBranchId: string | null;
  /** The branch's generation; null without a branch. */
  branchGeneration: number | null;
  /** created: the draft has a `created` row; edited: branch rows only. */
  origin: "created" | "edited";
  /** Created and still hidden: derived on read, nothing rewrites it. */
  isNew: boolean;
  binary: boolean;
  documentName: string | null;
  /** Canonical URI in the draft's view (the last address for one deleted live). */
  path: string | null;
  conflict: { code: "path_taken"; path: string } | { code: "deleted_live" } | null;
  tokens: {
    locationToken: string;
    liveTextToken: string | null;
    branchGenerationToken: string | null;
  };
  /**
   * Deleted live (an edited document, or a revealed create): no view shows it, so it
   * authorizes through the draft's branch on it and its final location (F9, §13.3).
   */
  deletedLive: boolean;
  /** `isNew || binary || deletedLive`: one change, settled by item Apply or Discard only (§3.3). */
  wholeItem: boolean;
  /** A staged batch holds the item: progress only, never a settlement signal (§4.5). */
  settling: boolean;
  /** Chats with pending writes on the branch, latest first, then the creating chat. */
  actorThreadIds: string[];
  updatedAt: Date;
};

/** One document the draft has a view of: its item, and whether the list shows it. */
export type ResolvedDraftItem = { item: DraftReviewItem; listed: boolean };

export interface DraftReviewItems {
  /** The draft's listed items, live text tokens unread (null). */
  list(draftId: DraftId): Promise<DraftReviewItem[]>;
  /**
   * One document's item and whether it is listed, for every document the draft has a view
   * of (an active branch, or a change row); null only when it is not addressable.
   */
  resolve(draftId: DraftId, documentId: DocumentId): Promise<ResolvedDraftItem | null>;
  /**
   * The review list's enrichment: each live document's full-state fingerprint read under
   * its lease, for an item with text that live readers see. Apply compares the tokens a
   * request carries; it never needs these.
   */
  withLiveTextTokens(items: readonly DraftReviewItem[]): Promise<DraftReviewItem[]>;
}

export function createDraftReviewItems(deps: {
  tree: Pick<TreeReader, "treeState">;
  /**
   * The draft's active `work_draft` branches (only these documents' when given), each
   * with its reviewable rows (maybe none).
   */
  branches(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<readonly WorkDraftPendingEvidence[]>;
  /** The chat that created each document the draft created; absent for a writer's create. */
  creators(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<ReadonlyMap<DocumentId, string>>;
  /** The item keys a staged, unfinished batch of the draft holds. */
  settling(draftId: DraftId): Promise<ReadonlySet<string>>;
  /** The live document's full-state fingerprint, read under its coordinator lease. */
  liveFingerprint(documentId: DocumentId): Promise<string>;
}): DraftReviewItems {
  async function items(
    draftId: DraftId,
    documentIds?: readonly DocumentId[],
  ): Promise<ResolvedDraftItem[]> {
    const branches = await deps.branches(draftId, documentIds);
    const branchOf = new Map(branches.map((evidence) => [evidence.branch.documentId, evidence]));
    const nodes = await deps.tree.treeState(
      draftId,
      branches.map((evidence) => evidence.branch.documentId),
      documentIds,
    );
    const creators = await deps.creators(draftId, documentIds);
    const settling = await deps.settling(draftId);
    return nodes
      .map((node) => {
        const evidence = branchOf.get(node.nodeId);
        const item = toItem(draftId, node, evidence, creators.get(node.nodeId), settling);
        return { item, listed: node.origin === "created" || isEdited(evidence) };
      })
      .sort((a, b) => (a.item.path ?? "").localeCompare(b.item.path ?? ""));
  }

  return {
    async list(draftId) {
      return (await items(draftId)).flatMap(({ item, listed }) => (listed ? [item] : []));
    },
    async resolve(draftId, documentId) {
      return (await items(draftId, [documentId]))[0] ?? null;
    },
    withLiveTextTokens: (listed) =>
      Promise.all(
        listed.map(async (item) =>
          // Live text exists only for a document live readers see.
          item.draftBranchId && !item.isNew && !item.deletedLive && !item.binary
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

/** The §3.1 predicate for a document the draft only edited. */
function isEdited(evidence: WorkDraftPendingEvidence | undefined): boolean {
  return Boolean(evidence?.hasRows && (evidence.branch.hasEffect || evidence.branch.blocking));
}

function toItem(
  draftId: DraftId,
  node: TreeStateNode,
  evidence: WorkDraftPendingEvidence | undefined,
  creatorThreadId: string | undefined,
  settling: ReadonlySet<string>,
): DraftReviewItem {
  const deletedLive = !node.hidden && node.deleted;
  const isNew = node.origin === "created" && node.hidden;
  const writers = evidence?.agentThreadIds ?? [];
  const path = node.target.uri;
  return {
    draftId,
    itemKey: draftItemKey(draftId, node.nodeId),
    documentId: node.nodeId,
    draftBranchId: evidence?.branch.branchId ?? null,
    origin: node.origin,
    isNew,
    binary: node.binary,
    wholeItem: isNew || node.binary || deletedLive,
    settling: settling.has(draftItemKey(draftId, node.nodeId)),
    branchGeneration: evidence?.branch.generation ?? null,
    documentName: documentTitleFromUri(path),
    path,
    conflict: conflictOf(node),
    deletedLive,
    tokens: {
      locationToken: node.locationVersion.toString(),
      liveTextToken: null,
      branchGenerationToken: evidence ? String(evidence.branch.generation) : null,
    },
    actorThreadIds:
      creatorThreadId && !writers.includes(creatorThreadId)
        ? [...writers, creatorThreadId]
        : writers,
    updatedAt: evidence?.branch.updatedAt ?? new Date(),
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
