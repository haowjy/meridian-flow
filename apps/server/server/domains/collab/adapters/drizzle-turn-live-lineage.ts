/** Immutable edit/placement discovery for the retained turn change-viewer read model. */
import type { DocumentId, DraftId } from "@meridian/contracts";
import {
  type Database,
  documents,
  treeEditReceiptNodes,
  treeEditReceipts,
} from "@meridian/database";
import { drafts } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadFolderAddresses, placedNodesSql } from "../../context/tree/tree-addresses.js";
import { LIVE_TREE, type TreeView } from "../../context/tree/tree-relations.js";
import type { TreePlace, TurnLiveLineageDocumentStore } from "../domain/turn-live-lineage.js";
import {
  readTurnEditTargets,
  readTurnFolderTargets,
  readTurnTreeTargets,
  receiptBranchExists,
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
    async placesOf(nodes) {
      const out = new Map<string, TreePlace>();
      const byView = new Map<string | null, string[]>();
      for (const { nodeId, branchId } of nodes)
        byView.set(branchId, [...(byView.get(branchId) ?? []), nodeId]);
      for (const [branchId, ids] of byView) {
        const view: TreeView = branchId
          ? { kind: "branch", branchId: branchId as DraftId }
          : LIVE_TREE;
        const [rows, folders] = await Promise.all([
          currentDrizzleDb(db).execute<{ start: string; source: string; path: string[] }>(sql`
            WITH RECURSIVE placed AS ${placedNodesSql(view)},
            chain AS (
              SELECT p.id AS start, p.id, p.parent_id, p.rank, p.context_source_id, 0 AS depth
                FROM placed p
                WHERE p.id IN (${sql.join(
                  ids.map((id) => sql`${id}::uuid`),
                  sql`, `,
                )})
              UNION ALL
              SELECT chain.start, p.id, p.parent_id, p.rank, p.context_source_id, chain.depth + 1
                FROM placed p JOIN chain ON p.id = chain.parent_id
            )
            SELECT start::text AS start, min(context_source_id::text) AS source,
              array_agg(rank || ' ' || id::text ORDER BY depth DESC) AS path
            FROM chain GROUP BY start`),
          loadFolderAddresses(db, ids, view),
        ]);
        const uris = new Map(folders.map((folder) => [folder.folderId as string, folder.uri]));
        for (const row of rows) {
          const uri = uris.get(row.start);
          out.set(`${row.start}:${branchId}`, {
            placement: [row.source, ...row.path],
            ...(uri ? { uri } : {}),
          });
        }
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
          draft: drafts.id,
          op: treeEditReceipts.op,
          // The node's own address before the change (a create's: where it was made), so a
          // folder's delete or a several-move reads as each node's own line.
          shownAt: sql<
            string | null
          >`coalesce(${treeEditReceiptNodes.beforeAt}, ${treeEditReceiptNodes.afterAt})`,
          landedAt: treeEditReceiptNodes.afterAt,
          // A copy's create names the document it read, so the turn can say it copied.
          copiedFrom: sql<
            string | null
          >`coalesce(${treeEditReceiptNodes.copiedFrom}, ${documents.metadata}->'copiedFrom'->>'uri')`,
          // The model's own undo has the last word on it: the newest receipt of its chain (an
          // undo, an undo of that) is an undo no card made. A card's Undo isn't one: the card's
          // rows still say what the reply did.
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
        // Folders have no document metadata, but their receipt still carries a tree line.
        .leftJoin(documents, eq(documents.id, treeEditReceiptNodes.nodeId))
        // A drafted entry's draft, while it stands.
        .leftJoin(drafts, eq(drafts.id, treeEditReceipts.draftBranchId))
        .where(
          and(
            eq(treeEditReceipts.threadId, threadId),
            eq(treeEditReceipts.turnId, turnId),
            // What the reply wrote: a Redo repeats it, and an Undo is the card's, not the reply's.
            eq(treeEditReceipts.kind, "write"),
            receiptBranchExists,
          ),
        )
        .orderBy(treeEditReceipts.seq, treeEditReceiptNodes.wId);
      return rows.map((row) => ({ ...row, documentId: row.documentId as DocumentId }));
    },
  };
}
