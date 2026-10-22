/** Immutable edit/placement discovery for the retained turn change-viewer read model. */
import type { DocumentId } from "@meridian/contracts";
import { type Database, documentEdits } from "@meridian/database";
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
          op: sql<"move" | "delete" | "restore">`${documentEdits.treeChange}->>'op'`,
          shownAt: sql<string | null>`${documentEdits.treeChange}->>'shownAt'`,
          landedAt: sql<string | null>`${documentEdits.treeChange}->>'landedAt'`,
        })
        .from(documentEdits)
        .where(
          and(
            eq(documentEdits.threadId, threadId),
            eq(documentEdits.turnId, turnId),
            inArray(documentEdits.kind, ["write", "revert"]),
            isNotNull(documentEdits.treeChange),
            sql`${documentEdits.treeChange}->'destination'->>'kind' = 'live'`,
            sql`${documentEdits.treeChange}->>'op' <> 'settle'`,
          ),
        )
        .orderBy(sql`(${documentEdits.treeChange}->>'seq')::bigint`);
      return rows.map((row) => ({ ...row, documentId: row.documentId as DocumentId }));
    },
  };
}
