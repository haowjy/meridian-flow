/** Drizzle adapter for per-turn edited document discovery. */
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditMutations } from "@meridian/database";
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
      const rows = await db
        .select({
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
        )
        .groupBy(
          agentEditMutations.documentId,
          sql`case when ${agentEditMutations.scopeId} = ${LIVE_SCOPE} then 'live' else 'draft' end`,
        )
        .orderBy(asc(agentEditMutations.documentId));
      return rows.map(
        (row): TurnEditedDocumentId => ({
          documentId: row.documentId as DocumentId,
          scope: row.scope,
        }),
      );
    },
  };
}
