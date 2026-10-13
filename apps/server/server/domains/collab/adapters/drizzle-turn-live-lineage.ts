/** Immutable edit/placement discovery for the retained turn change-viewer read model. */
import type { Database } from "@meridian/database";
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
  };
}
