/**
 * The review list (contract §13.1): a draft's items are its tree state (every document it
 * created, listed with no text yet, and the documents it edited) merged by document with
 * its `work_draft` branches with reviewable rows. A branch with no rows and no change row
 * is not an item. Every item is keyed `${draftId}:${documentId}` (F12) and carries the
 * tokens Apply checks (§11.3): its location version from the same tree read that spells
 * its path, the live document's full-state fingerprint, and the branch generation.
 */
import type { DraftId, TurnId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { TreeReader, TreeStateNode } from "../../context/tree/tree-view.js";
import { type DraftItemKey, draftItemKey } from "./draft-publication.js";
import type { WorkDraftPendingEvidence } from "./ports/work-draft-pending-store.js";
import { documentTitleFromUri } from "./reversal-notices.js";

export type DraftReviewItem = {
  draftId: DraftId;
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The draft's branch on the document; null for a created image (no Yjs, 12b-Q2). */
  draftBranchId: string | null;
  /** created: the draft has a `created` row; edited: branch rows only. */
  origin: "created" | "edited";
  /** Created and still hidden: derived on read, nothing rewrites it. */
  isNew: boolean;
  binary: boolean;
  documentName: string | null;
  /** Canonical URI in the draft's view (the last address for one deleted live). */
  path: string | null;
  /** The live URI when it differs from `path` (revealed, then moved live). */
  livePath: string | null;
  conflict:
    | { code: "path_taken"; path: string }
    | { code: "rename_replaced"; livePath: string }
    | { code: "deleted_live" }
    | null;
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
  /** Reviewable journal rows on its branch: the legacy list shows only items with some. */
  pendingRows: number;
  lastActorTurnId: TurnId | null;
  updatedAt: Date;
};

export interface DraftReviewItems {
  /** The draft's items, live text tokens unread (null). */
  list(draftId: DraftId): Promise<DraftReviewItem[]>;
  /** One document's item in the draft, or null when it isn't one. */
  item(draftId: DraftId, documentId: DocumentId): Promise<DraftReviewItem | null>;
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
  /** The live document's full-state fingerprint, read under its coordinator lease. */
  liveFingerprint(documentId: DocumentId): Promise<string>;
}): DraftReviewItems {
  async function items(draftId: DraftId, documentIds?: readonly DocumentId[]) {
    const branches = await deps.branches(draftId, documentIds);
    const branchOf = new Map(branches.map((evidence) => [evidence.branch.documentId, evidence]));
    const edited = branches
      .filter((evidence) => evidence.rows.length > 0)
      .map((evidence) => evidence.branch.documentId);
    const nodes = await deps.tree.treeState(draftId, edited);
    return nodes
      .filter((node) => !documentIds || documentIds.includes(node.nodeId))
      .map((node) => toItem(draftId, node, branchOf.get(node.nodeId)))
      .sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));
  }

  return {
    list: (draftId) => items(draftId),
    async item(draftId, documentId) {
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

function toItem(
  draftId: DraftId,
  node: TreeStateNode,
  evidence: WorkDraftPendingEvidence | undefined,
): DraftReviewItem {
  const path = node.target.uri;
  const livePath = node.live.uri !== path && !node.hidden ? node.live.uri : null;
  return {
    draftId,
    itemKey: draftItemKey(draftId, node.nodeId),
    documentId: node.nodeId,
    draftBranchId: evidence?.branch.branchId ?? null,
    origin: node.origin,
    isNew: node.origin === "created" && node.hidden,
    binary: node.binary,
    documentName: documentTitleFromUri(path),
    path,
    livePath,
    conflict: conflictOf(node),
    deletedLive: !node.hidden && node.live.deleted,
    tokens: {
      locationToken: node.locationVersion.toString(),
      liveTextToken: null,
      branchGenerationToken: evidence ? String(evidence.branch.generation) : null,
    },
    pendingRows: evidence?.rows.length ?? 0,
    lastActorTurnId: (evidence?.rows.find((row) => row.turnId)?.turnId ?? null) as TurnId | null,
    updatedAt: new Date(),
  };
}

function conflictOf(node: TreeStateNode): DraftReviewItem["conflict"] {
  switch (node.conflict.kind) {
    case "clash":
      return { code: "path_taken", path: node.conflict.uri ?? node.conflict.at };
    case "relocated":
      return { code: "rename_replaced", livePath: node.live.uri ?? node.live.path };
    case "deleted_live":
      return { code: "deleted_live" };
    case "none":
      return null;
  }
}
