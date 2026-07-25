/** Last-write attribution projection from the collab journal. */
import type { PersistedUpdate as JournalUpdate } from "@meridian/agent-edit/integration";
import type { DocumentAttribution } from "../contracts.js";
import { attributionFromMeta } from "./agent-edit-runtime.js";

export function createDocumentAttribution(input: {
  latestUpdate(documentId: string): Promise<JournalUpdate | null>;
}): DocumentAttribution {
  return {
    async getLastUpdateAttribution(documentId) {
      const latest = await input.latestUpdate(documentId);
      if (!latest) {
        return { originType: null, actorTurnId: null, actorUserId: null, updateSeq: null };
      }
      return { ...attributionFromMeta(latest.meta), updateSeq: latest.seq };
    },
  };
}
