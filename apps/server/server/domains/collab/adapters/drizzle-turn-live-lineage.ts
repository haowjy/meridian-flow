/** Immutable edit/placement discovery for the retained turn change-viewer read model. */
import type { DocumentId } from "@meridian/contracts";
import {
  type Database,
  documents,
  treeEditReceiptNodes,
  treeEditReceipts,
} from "@meridian/database";
import { branches } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { ownerKeyOfColumns } from "../../../shared/draft-owner.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TurnLiveLineageDocumentStore } from "../domain/turn-live-lineage.js";
import {
  readTurnEditTargets,
  readTurnFolderTargets,
  readTurnTreeTargets,
} from "./drizzle-turn-edit-targets.js";

export function createDrizzleTurnLiveLineageStore(db: Database): TurnLiveLineageDocumentStore {
  return {
    async listLiveDocumentIdsForTurn(threadId, turnId) {
      const targets = await readTurnEditTargets(currentDrizzleDb(db), { threadId, turnId });
      return targets.filter((target) => target.scope === "live").map((target) => target.documentId);
    },
    async listEditedDocumentIdsForTurn(threadId, turnId) {
      const tx = currentDrizzleDb(db);
      return readTurnTreeTargets(
        tx,
        { threadId, turnId },
        await readTurnEditTargets(tx, { threadId, turnId }),
      );
    },
    listFolderTargetsForTurn: (threadId, turnId) =>
      readTurnFolderTargets(currentDrizzleDb(db), { threadId, turnId }),
    async listTreeEntriesForTurn(threadId, turnId) {
      const rows = await currentDrizzleDb(db)
        .select({
          documentId: treeEditReceiptNodes.nodeId,
          // A folder has no `documents` row.
          folder: sql<boolean>`${documents.id} is null`,
          workId: branches.originWorkId,
          rootThreadId: branches.originRootThreadId,
          op: treeEditReceipts.op,
          // The node's own address before the change (a create's: where it was made), so a
          // folder's delete or a several-move reads as each node's own line.
          shownAt: sql<
            string | null
          >`coalesce(${treeEditReceiptNodes.beforeAt}, ${treeEditReceiptNodes.afterAt})`,
          landedAt: treeEditReceiptNodes.afterAt,
          // A copy's create names the document it read, so the turn can say it copied.
          copiedFrom: sql<string | null>`${documents.metadata}->'copiedFrom'->>'uri'`,
          // The model's own undo of it, in this reply or a later one; a card's Undo isn't one:
          // the card still says what the reply did, beside its Redo.
          undone: sql<boolean>`exists (select 1 from tree_edit_receipts r
            left join commands c on c.id = r.command_id
            where r.reverses = ${treeEditReceipts.id} and c.kind is distinct from 'reverse_turn')`,
        })
        .from(treeEditReceipts)
        .innerJoin(treeEditReceiptNodes, eq(treeEditReceiptNodes.receiptId, treeEditReceipts.id))
        .leftJoin(documents, eq(documents.id, treeEditReceiptNodes.nodeId))
        // A drafted entry's owner: the branch it was drafted in.
        .leftJoin(branches, eq(branches.id, treeEditReceipts.draftBranchId))
        .where(
          and(
            eq(treeEditReceipts.threadId, threadId),
            eq(treeEditReceipts.turnId, turnId),
            // What the reply wrote: a Redo repeats it, and an Undo is the card's, not the reply's.
            eq(treeEditReceipts.kind, "write"),
          ),
        )
        .orderBy(treeEditReceipts.seq, treeEditReceiptNodes.wId);
      return rows.map(({ workId, rootThreadId, ...row }) => ({
        ...row,
        documentId: row.documentId as DocumentId,
        ownerKey: ownerKeyOfColumns({ workId, rootThreadId }),
      }));
    },
  };
}
