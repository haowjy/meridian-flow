/** Drizzle adapter for per-turn edited document discovery. */
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditMutations, branchWriteJournal, documentBranches } from "@meridian/database";
import { and, asc, eq, sql } from "drizzle-orm";
import type {
  TurnEditedDocumentId,
  TurnLiveLineageDocumentStore,
} from "../domain/turn-live-lineage.js";
import { LIVE_SCOPE } from "./drizzle-agent-edit-scope.js";

type TurnLiveLineageDb = Pick<Database, "select" | "selectDistinct">;

export function createDrizzleTurnLiveLineageStore(
  db: TurnLiveLineageDb,
): TurnLiveLineageDocumentStore {
  return {
    async listLiveDocumentIdsForTurn(threadId, turnId) {
      const rows = await db
        .selectDistinct({ documentId: agentEditMutations.documentId })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.threadId, threadId as ThreadId),
            eq(agentEditMutations.turnId, turnId as TurnId),
            eq(agentEditMutations.scopeId, LIVE_SCOPE),
          ),
        )
        .orderBy(asc(agentEditMutations.documentId));
      return rows.map((row) => row.documentId as DocumentId);
    },

    async listEditedDocumentIdsForTurn(threadId, turnId) {
      const liveRows = await db
        .selectDistinct({
          documentId: agentEditMutations.documentId,
          scope: sql<
            "live" | "draft"
          >`case when ${agentEditMutations.scopeId} = ${LIVE_SCOPE} then 'live' else 'draft' end`,
        })
        .from(agentEditMutations)
        .where(
          and(
            eq(agentEditMutations.threadId, threadId as ThreadId),
            eq(agentEditMutations.turnId, turnId as TurnId),
          ),
        );
      const branchRows = await db
        .selectDistinct({
          documentId: documentBranches.documentId,
          scope: sql<"live" | "draft">`'draft'`,
        })
        .from(branchWriteJournal)
        .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
        .where(
          and(
            eq(branchWriteJournal.threadId, threadId as ThreadId),
            eq(branchWriteJournal.turnId, turnId as TurnId),
          ),
        );
      const rows = [...liveRows, ...branchRows];
      return rows.sort(compareTurnEditedDocumentRows).map(
        (row): TurnEditedDocumentId => ({
          documentId: row.documentId as DocumentId,
          scope: row.scope,
        }),
      );
    },
  };
}

function compareTurnEditedDocumentRows(
  left: { documentId: string; scope: "live" | "draft" },
  right: { documentId: string; scope: "live" | "draft" },
): number {
  const documentOrder = left.documentId.localeCompare(right.documentId);
  if (documentOrder !== 0) return documentOrder;
  return scopeSortOrder(left.scope) - scopeSortOrder(right.scope);
}

function scopeSortOrder(scope: "live" | "draft"): number {
  return scope === "draft" ? 0 : 1;
}
