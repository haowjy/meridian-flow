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
import { documentTitleFromUri } from "./reversal-notices.js";
import type { DraftBranchEvidence } from "./work-draft-pending.js";

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
  list(draftId: DraftId): Promise<DraftReviewItem[]>;
}

export function createDraftReviewItems(deps: {
  tree: Pick<TreeReader, "treeState">;
  /** Every active `work_draft` branch of the draft with its reviewable rows (maybe none). */
  branches(draftId: DraftId): Promise<readonly DraftBranchEvidence[]>;
  /** The live document's full-state fingerprint, read under its coordinator lease. */
  liveFingerprint(documentId: DocumentId): Promise<string>;
}): DraftReviewItems {
  return {
    async list(draftId) {
      const branches = await deps.branches(draftId);
      const branchOf = new Map(branches.map((evidence) => [evidence.branch.documentId, evidence]));
      const edited = branches
        .filter((evidence) => evidence.rows.length > 0)
        .map((evidence) => evidence.branch.documentId);
      const nodes = await deps.tree.treeState(draftId, edited);
      const items = await Promise.all(
        nodes.map(async (node) => {
          const evidence = branchOf.get(node.nodeId);
          // Live text exists only for a document live readers see.
          const liveText = evidence && !node.hidden && !node.live.deleted && !node.binary;
          return toItem(draftId, node, evidence, {
            liveTextToken: liveText ? await deps.liveFingerprint(node.nodeId) : null,
          });
        }),
      );
      return items.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));
    },
  };
}

function toItem(
  draftId: DraftId,
  node: TreeStateNode,
  evidence: DraftBranchEvidence | undefined,
  live: { liveTextToken: string | null },
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
      liveTextToken: live.liveTextToken,
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
