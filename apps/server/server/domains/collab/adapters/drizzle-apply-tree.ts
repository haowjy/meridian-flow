/** Tree mutation half of Apply. Text Apply and Un-Apply never enter this module. */

import type { DocumentId, UserId } from "@meridian/contracts";
import { draftItemKey } from "@meridian/contracts";
import type { AppliedReviewItem } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import {
  dropDocumentRows,
  settleUndoneCreatesAfterReveal,
} from "../../context/tree/branch-tree-store.js";
import { tombstoneUnused } from "../../context/tree/end-use.js";
import { moveToPlacement } from "../../context/tree/live-tree-state.js";
import { place } from "../../context/tree/placement.js";
import { restoreDocument } from "../../context/tree/removal.js";
import type { TreeStateNode } from "../../context/tree/tree-view.js";
import { loadDocumentIdentityRows } from "../../context/tree/tree-view-sql.js";
import { ApplyClickRefused } from "../domain/apply-click.js";
import type { DraftClose } from "./drizzle-draft-close.js";

export function createApplyTreeOperations(input: {
  db: Database;
  branchId: import("@meridian/contracts").BranchId;
  commandDocumentId: DocumentId;
  userId: UserId;
  removal: DocumentRemoval;
  close: Pick<DraftClose, "closeDrafts">;
  arrivals?: Pick<DocumentArrivals, "settle">;
  catalog: ContextCatalogMutationPort;
  releaseObjects(storageUrls: readonly string[]): Promise<void>;
  onCommitted(documentId: DocumentId): Promise<void>;
  findLive(documentId: DocumentId): Promise<{ kind: string; document?: { path: string } }>;
  resolveLivePath(path: string): Promise<"free" | "folder" | "blocked">;
  renamedNote(node: TreeStateNode): Promise<AppliedReviewItem["renamed"]>;
  displayedPath(node: TreeStateNode, path: string): string;
}) {
  const tx = currentDrizzleDb(input.db);

  const committed = async (
    node: TreeStateNode,
    from: string | null,
  ): Promise<AppliedReviewItem> => {
    const renamed = await input.renamedNote(node);
    const to =
      node.branch?.state === "deleting"
        ? null
        : (renamed?.path ?? input.displayedPath(node, node.target.path));
    return {
      itemKey: draftItemKey(input.branchId, node.nodeId),
      transition: { from, to },
      ...(renamed ? { renamed } : {}),
    };
  };

  const settle = async (node: TreeStateNode, from: string | null): Promise<AppliedReviewItem> => {
    await dropDocumentRows(input.db, {
      branchId: input.branchId,
      documentIds: [node.nodeId],
      settle: { as: "applied", userId: input.userId },
    });
    const item = await committed(node, from);
    deferUntilDrizzleCommit(() => input.onCommitted(node.nodeId));
    return item;
  };

  const reveal = async (
    node: TreeStateNode,
    at: Pick<TreeStateNode["target"], "contextSourceId" | "parentFolderId" | "name" | "extension">,
  ) => {
    const placed = await place(input.db, {
      targets: [{ node: { kind: "document", id: node.nodeId }, at }],
    });
    if (!placed.ok)
      throw new ApplyClickRefused(
        placed.error.code === "ancestor_taken" ? "ancestor_taken" : "not_found",
      );
    await settleUndoneCreatesAfterReveal(input.db, node.nodeId);
    await input.arrivals?.settle([node.nodeId]);
    await input.catalog.refreshSources(
      placed.value.sourceIds,
      placed.value.placed.map((ref) => ref.id),
    );
    if (!placed.value.landed[0]) throw new ApplyClickRefused("not_found");
  };

  const apply = async (
    node: TreeStateNode,
  ): Promise<{ item: AppliedReviewItem; restored: boolean }> => {
    const before = await input.findLive(node.nodeId);
    const from =
      before.kind === "found" && before.document
        ? input.displayedPath(node, before.document.path)
        : null;
    const [identity] = await loadDocumentIdentityRows(tx, [node.nodeId]);
    if (!identity) throw new ApplyClickRefused("not_found");
    if (node.branch?.state === "deleting") {
      if (!identity.deleted && !identity.hidden) {
        await input.removal.remove({
          documentIds: [node.nodeId],
          reason: "deleted",
          userId: input.userId,
        });
        await input.catalog.refreshSources([identity.contextSourceId], [node.nodeId]);
      }
      await input.close.closeDrafts(
        tx,
        { documentIds: [node.nodeId], branchId: input.branchId },
        "document_discarded",
      );
      await dropDocumentRows(input.db, {
        branchId: input.branchId,
        documentIds: [node.nodeId],
        settle: { as: "applied", userId: input.userId },
      });
      if (identity.hidden && !identity.deleted) {
        const ended = await tombstoneUnused(input.db, [node.nodeId], {
          actor: { userId: input.userId },
          removal: input.removal,
        });
        if (ended.tombstoned.length)
          await input.catalog.refreshSources(
            [identity.contextSourceId],
            ended.tombstoned.map((ref) => ref.id),
          );
        if (ended.releasedObjects.length)
          deferUntilDrizzleCommit(() => input.releaseObjects(ended.releasedObjects));
      }
      const item = await committed(node, from);
      deferUntilDrizzleCommit(() => input.onCommitted(node.nodeId));
      return { item, restored: false };
    }
    let restored = false;
    if (identity.deleted) {
      const outcome = await restoreDocument(
        input.db,
        {
          documentId: node.nodeId,
          ...(node.branch?.state === "moving" ? { at: liveLocation(node) } : {}),
        },
        { arrivals: input.arrivals, catalog: input.catalog },
      );
      if (outcome.kind === "ancestor_taken") throw new ApplyClickRefused("ancestor_taken");
      if (outcome.kind === "refused") throw new ApplyClickRefused("not_found");
      restored = node.nodeId === input.commandDocumentId && outcome.kind === "restored";
    } else if (node.branch?.state === "moving" && !identity.hidden) {
      const moved = await moveToPlacement(
        input.db,
        {
          documentId: node.nodeId,
          from: {
            folderId: identity.folderId,
            rootSourceId: identity.folderId ? null : identity.contextSourceId,
            name: identity.name,
            extension: identity.extension,
          },
          to: {
            folderId: node.target.parentFolderId,
            rootSourceId: node.target.parentFolderId ? null : node.target.contextSourceId,
            name: node.target.name,
            extension: node.target.extension,
          },
        },
        { arrivals: input.arrivals, catalog: input.catalog },
      );
      if (moved.kind === "ancestor_taken") throw new ApplyClickRefused("ancestor_taken");
      if (moved.kind === "folder_missing") {
        for (let length = 1; length <= node.target.dir.length; length++) {
          const occupant = await input.resolveLivePath(node.target.dir.slice(0, length).join("/"));
          if (occupant === "free") break;
          if (occupant === "blocked") throw new ApplyClickRefused("ancestor_taken");
        }
      }
      if (moved.kind !== "moved") throw new ApplyClickRefused("not_found");
    }
    if (node.hidden && node.origin === "created") await reveal(node, node.target);
    return { item: await settle(node, from), restored };
  };

  return { apply, settle, reveal };
}

export function liveLocation(node: TreeStateNode) {
  return {
    contextSourceId: node.target.contextSourceId,
    parentFolderId: node.target.parentFolderId,
    name: node.target.name,
    extension: node.target.extension,
  };
}
