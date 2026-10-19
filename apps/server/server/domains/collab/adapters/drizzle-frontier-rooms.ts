/**
 * PostgreSQL `FrontierRooms`: the read that names a live observation frontier's
 * room. Optional to the call that renders: it runs isolated from an ambient
 * transaction, and a failure is reported and answers null, so the call records
 * no frontier and never fails.
 */
import type { Database } from "@meridian/database";
import {
  currentDrizzleDb,
  runIsolatedFromAmbientTransaction,
} from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { FrontierRooms } from "../domain/agent-edit-cores.js";
import { findDocumentAuthorityHead } from "./drizzle-document-authority-head.js";

export function createDrizzleFrontierRooms(
  db: Database,
  eventSink: EventSink | undefined,
): FrontierRooms {
  return {
    // Never materializes a head: a document with none has no live room yet.
    async liveGeneration(documentId) {
      try {
        return await runIsolatedFromAmbientTransaction(
          db,
          async () =>
            (await findDocumentAuthorityHead(currentDrizzleDb(db), documentId))?.generation ?? null,
        );
      } catch (cause) {
        if (eventSink)
          emitEvent(eventSink, {
            level: "warn",
            source: "collab.agent_edit",
            name: "observation_frontier.room_key_failed",
            correlation: { documentId },
            payload: unknownToEventPayload(cause),
          });
        return null;
      }
    },
  };
}
