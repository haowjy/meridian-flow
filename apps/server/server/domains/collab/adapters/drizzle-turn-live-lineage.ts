/** Immutable edit/placement discovery for the retained turn change-viewer read model. */
import type { DocumentId, WorkId } from "@meridian/contracts";
import { type Database, documentEdits } from "@meridian/database";
import { branches } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TurnLiveLineageDocumentStore } from "../domain/turn-live-lineage.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";

export function createDrizzleTurnLiveLineageStore(db: Database): TurnLiveLineageDocumentStore {
  return {
    async listLiveDocumentIdsForTurn(threadId, turnId) {
      const targets = await readTurnEditTargets(currentDrizzleDb(db), { threadId, turnId });
      return targets.filter((target) => target.scope === "live").map((target) => target.documentId);
    },
    listEditedDocumentIdsForTurn(threadId, turnId) {
      return readTurnEditTargets(currentDrizzleDb(db), { threadId, turnId });
    },
    async listTreeEntriesForTurn(threadId, turnId) {
      const rows = await currentDrizzleDb(db)
        .select({
          documentId: documentEdits.documentId,
          workId: branches.originWorkId,
          op: sql<"create" | "move" | "delete" | "restore">`${documentEdits.treeChange}->>'op'`,
          shownAt: sql<string | null>`${documentEdits.treeChange}->>'shownAt'`,
          landedAt: sql<string | null>`${documentEdits.treeChange}->>'landedAt'`,
        })
        .from(documentEdits)
        // A drafted entry's Work: the branch its destination names.
        .leftJoin(
          branches,
          sql`${branches.id} = (${documentEdits.treeChange}->'destination'->>'branchId')::uuid`,
        )
        .where(
          and(
            eq(documentEdits.threadId, threadId),
            eq(documentEdits.turnId, turnId),
            inArray(documentEdits.kind, ["write", "revert"]),
            isNotNull(documentEdits.treeChange),
            sql`${documentEdits.treeChange}->>'op' <> 'settle'`,
            // A stopped reply's rollback reversed it: the turn didn't leave it moved or deleted.
            sql`NOT EXISTS (
              SELECT 1 FROM ${documentEdits} AS undone
              WHERE undone.document_id = ${documentEdits.documentId}
                AND undone.kind = 'rollback'
                AND undone.tree_change->'targets' @> jsonb_build_array(
                  jsonb_build_object('editId', ${documentEdits.id}::text)
                )
            )`,
          ),
        )
        .orderBy(sql`(${documentEdits.treeChange}->>'seq')::bigint`);
      return rows.map((row) => ({
        ...row,
        documentId: row.documentId as DocumentId,
        workId: row.workId as WorkId | null,
      }));
    },
  };
}
