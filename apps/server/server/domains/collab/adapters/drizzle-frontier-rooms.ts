/**
 * PostgreSQL `FrontierRooms`: the reads that name an observation frontier's
 * room. Optional to the call that renders: each runs isolated from an ambient
 * transaction, and a failure is reported and answers null, so the call records
 * no frontier and never fails.
 */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentDrafts } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
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
  async function optional<T>(documentId: DocumentId, read: () => Promise<T | null>) {
    try {
      return await runIsolatedFromAmbientTransaction(db, read);
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
  }
  return {
    // Never materializes a head: a document with none has no live room yet.
    liveGeneration: (documentId) =>
      optional(
        documentId,
        async () =>
          (await findDocumentAuthorityHead(currentDrizzleDb(db), documentId))?.generation ?? null,
      ),
    workDraftId: (documentId, branchId) =>
      optional(documentId, async () => {
        const [row] = await currentDrizzleDb(db)
          .select({ id: documentDrafts.id })
          .from(documentDrafts)
          .where(
            and(
              eq(documentDrafts.documentId, documentId),
              eq(documentDrafts.branchId, branchId),
              eq(documentDrafts.kind, "work_draft"),
              eq(documentDrafts.status, "active"),
            ),
          )
          .limit(1);
        return row?.id ?? null;
      }),
  };
}
