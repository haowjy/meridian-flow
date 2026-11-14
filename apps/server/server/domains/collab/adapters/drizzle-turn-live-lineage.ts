/** Immutable edit/placement discovery for the retained turn change-viewer read model. */
import type { DocumentId } from "@meridian/contracts";
import { type Database, documentEdits, documents } from "@meridian/database";
import { branches } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ownerKeyOfColumns } from "../../../shared/draft-owner.js";
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
          rootThreadId: branches.originRootThreadId,
          op: sql<"create" | "move" | "delete" | "restore">`${documentEdits.treeChange}->>'op'`,
          shownAt: sql<string | null>`${documentEdits.treeChange}->>'shownAt'`,
          landedAt: sql<string | null>`${documentEdits.treeChange}->>'landedAt'`,
          // A copy's create names the document it read, so the turn can say it copied.
          copiedFrom: sql<string | null>`${documents.metadata}->'copiedFrom'->>'uri'`,
        })
        .from(documentEdits)
        .leftJoin(documents, eq(documents.id, documentEdits.documentId))
        // A drafted entry's owner: the branch its destination names.
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
            sql`NOT EXISTS (
              SELECT 1 FROM document_edits AS materialized
              WHERE materialized.document_id = ${documentEdits.documentId}
                AND materialized.tree_change->>'materializes' = ${documentEdits.id}::text
            )`,
          ),
        )
        .orderBy(sql`(${documentEdits.treeChange}->>'seq')::bigint`);
      return rows.map(({ workId, rootThreadId, ...row }) => ({
        ...row,
        documentId: row.documentId as DocumentId,
        ownerKey: ownerKeyOfColumns({ workId, rootThreadId }),
      }));
    },
  };
}
