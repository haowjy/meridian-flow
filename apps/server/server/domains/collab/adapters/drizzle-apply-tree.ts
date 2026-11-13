/**
 * Tree half of Apply: one document's drafted records become live copies in the list that holds
 * them (`applyDraft`), in the click's transaction. Text Apply and Un-Apply never enter this module.
 *
 * Lock order: the caller holds the Work and the branch. The list's lock comes inside `submit`; the
 * document's mutex only after it, as the order in `collab/.context/CONTEXT.md` says.
 */

import type { BranchId, DocumentId, UserId } from "@meridian/contracts";
import { draftItemKey } from "@meridian/contracts";
import type { AppliedReviewItem } from "@meridian/contracts/branches";
import type { Database } from "@meridian/database";
import { applyDraft, LIVE, pendingRecords } from "@meridian/project-tree";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { LIVE_TREE, type TreeReader } from "../../context/tree/tree-view.js";
import { ApplyClickRefused } from "../domain/apply-click.js";
import type { BranchDocumentTree } from "../domain/ports/branch-tree-state.js";
import { recordsOfItem, treeListOfNode } from "./drizzle-branch-tree-lists.js";
import type { DraftClose } from "./drizzle-draft-close.js";

export type TreeApplyOutcome =
  | { kind: "applied"; applied: AppliedReviewItem[]; restored: boolean }
  | { kind: "changed" }
  | { kind: "needs_restore" };

export function createApplyTreeOperations(input: {
  db: Database;
  treeLists: Pick<TreeListStore, "submit">;
  tree: Pick<TreeReader, "identityStatus">;
  close: Pick<DraftClose, "closeDrafts" | "registerRemoved">;
  arrivals?: Pick<DocumentArrivals, "settle">;
  onCommitted(documentId: DocumentId): Promise<void>;
}) {
  /**
   * Applies what the Work has pending on `documentId`: its own records, the drafted creates they
   * stand on, and the earlier records of the same facts. `item` is the Work's row on it as the
   * click read it. With `cut`, the row must still be the revision the writer saw. Without it, the
   * records land only when the document exists only in the Work (a creation is revealed whole);
   * a document live has in Trash is restored first when the click carries `restore`.
   */
  async function apply(click: {
    branchId: BranchId;
    documentId: DocumentId;
    userId: UserId;
    commandId: string;
    restore: boolean;
    cut: { revision: string | null } | null;
    item: BranchDocumentTree | null;
  }): Promise<TreeApplyOutcome> {
    const { branchId, documentId, item } = click;
    if (click.cut && (!item?.change || item.revision !== click.cut.revision))
      return { kind: "changed" };
    // Only the writer's knowledge brings a deleted document back: a delete their view did not
    // show leaves the click undone and the draft pending.
    const restoring = item?.deletedLive === true && item.change !== "deleting";
    if (restoring && !click.restore) return { kind: "needs_restore" };
    const landing = click.cut !== null || item?.isNew === true;
    if (!landing && !restoring) return { kind: "applied", applied: [], restored: false };

    const list = await treeListOfNode(input.db, documentId);
    if (!list) throw new ApplyClickRefused("not_found");
    const actor = `user:${click.userId}`;
    // Where the document is in live now, to say where the Apply moved it.
    const before = (await input.tree.identityStatus(LIVE_TREE, [documentId])).get(documentId);

    const { result } = await input.treeLists.submit({
      lists: [list],
      make: ([{ writer }]) => {
        const trashed = writer.view(LIVE).nodes.get(documentId)?.trashed === true;
        if (restoring && trashed) writer.restore(LIVE, actor, documentId);
        if (!landing) return "restored" as const;
        const chosen = recordsOfItem(pendingRecords(writer.doc, branchId), documentId);
        if (chosen.length === 0) return "changed" as const;
        const applied = applyDraft(
          writer,
          branchId,
          actor,
          click.commandId,
          chosen.map((record) => record.id),
        );
        // A record that cannot land (a move into itself, a change to what live has in Trash)
        // lands nothing of this item: the click is refused and the draft stays pending.
        if (recordsOfItem(applied.copies, documentId).length === 0)
          throw new ApplyClickRefused("ancestor_taken");
        return "applied" as const;
      },
    });
    if (result === "changed") return { kind: "changed" };

    const after = (await input.tree.identityStatus(LIVE_TREE, [documentId])).get(documentId);
    const to = after?.kind === "visible" ? after.address.uri : null;
    const renamed =
      item?.uri && to && item.uri !== to
        ? { code: "renamed" as const, wanted: item.uri, path: to }
        : undefined;
    const applied: AppliedReviewItem[] = [
      {
        itemKey: draftItemKey(branchId, documentId),
        ...(result === "applied"
          ? { transition: { from: before?.kind === "visible" ? before.address.uri : null, to } }
          : {}),
        ...(renamed ? { renamed } : {}),
      },
    ];

    // The text half takes the document's mutex next; draft rows come after it.
    const tx = currentDrizzleDb(input.db);
    await lockDocumentMutation(tx, documentId);
    if (item?.change === "deleting") {
      // Live rooms of a document the Apply took out of live close once this commits.
      input.close.registerRemoved([documentId], {
        reason: "deleted",
        actor: { kind: "user", userId: click.userId, displayName: null },
        time: new Date().toISOString(),
      });
      await input.close.closeDrafts(
        tx,
        { documentIds: [documentId], branchId },
        "document_discarded",
      );
    }
    await input.arrivals?.settle([documentId]);
    deferUntilDrizzleCommit(() => input.onCommitted(documentId));
    return { kind: "applied", applied, restored: click.restore && restoring };
  }

  return { apply };
}
