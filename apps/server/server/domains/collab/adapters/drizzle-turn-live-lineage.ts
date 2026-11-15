/** Immutable edit/placement discovery for the retained turn change-viewer read model. */
import type { BranchId, DocumentId } from "@meridian/contracts";
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
import { placedNodesSql } from "../../context/tree/tree-addresses.js";
import { LIVE_TREE, type TreeView } from "../../context/tree/tree-relations.js";
import type { TreePlacement, TurnLiveLineageDocumentStore } from "../domain/turn-live-lineage.js";
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
    async placementsOf(nodes) {
      const out = new Map<string, TreePlacement>();
      const byView = new Map<string | null, string[]>();
      for (const { nodeId, branchId } of nodes)
        byView.set(branchId, [...(byView.get(branchId) ?? []), nodeId]);
      for (const [branchId, ids] of byView) {
        const view: TreeView = branchId
          ? { kind: "branch", branchId: branchId as BranchId }
          : LIVE_TREE;
        const rows = await currentDrizzleDb(db).execute<{ start: string; path: string[] }>(sql`
          WITH RECURSIVE placed AS ${placedNodesSql(view)},
          chain AS (
            SELECT p.id AS start, p.id, p.parent_id, p.rank, 0 AS depth FROM placed p
              WHERE p.id IN (${sql.join(
                ids.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})
            UNION ALL
            SELECT chain.start, p.id, p.parent_id, p.rank, chain.depth + 1 FROM placed p
              JOIN chain ON p.id = chain.parent_id
          )
          SELECT start::text AS start, array_agg(rank || ' ' || id::text ORDER BY depth DESC) AS path
          FROM chain GROUP BY start`);
        for (const row of rows) out.set(`${row.start}:${branchId}`, row.path);
      }
      return out;
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
          // The model's own undo has the last word on it: the newest receipt of its chain (an
          // undo, its redo, an undo of that) is an undo no card made. A card's Undo isn't one: the
          // card still says what the reply did, beside its Redo.
          undone: sql<boolean>`coalesce((
            with recursive chain as (
              select r.id, r.kind, r.command_id, 1 as depth from tree_edit_receipts r
                where r.reverses = ${treeEditReceipts.id}
              union all
              select r.id, r.kind, r.command_id, chain.depth + 1 from tree_edit_receipts r
                join chain on r.reverses = chain.id
            )
            select chain.kind = 'undo' and c.kind is distinct from 'reverse_turn'
            from chain left join commands c on c.id = chain.command_id
            order by chain.depth desc limit 1
          ), false)`,
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
