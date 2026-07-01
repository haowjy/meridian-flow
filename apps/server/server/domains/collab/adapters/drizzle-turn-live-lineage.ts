/** Drizzle adapter for turn live-lineage document discovery. */
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { agentEditMutations } from "@meridian/database";
import { and, asc, eq } from "drizzle-orm";
import type { TurnLiveLineageDocumentStore } from "../domain/turn-live-lineage.js";
import { LIVE_SCOPE } from "./drizzle-agent-edit-scope.js";

type TurnLiveLineageDb = Pick<Database, "selectDistinct">;

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
  };
}
