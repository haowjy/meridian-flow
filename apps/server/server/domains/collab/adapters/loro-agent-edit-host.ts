/**
 * agent-edit's Loro core on the server's `DocumentRooms`: the room a call reads, its writes
 * committed in the model edit's command transaction with their receipts, and the chat a turn's
 * commit message names.
 */
import {
  type AgentEditRooms,
  type AgentWriteRecord,
  agentEditRooms,
  DocumentNotFoundError,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { type Database, documents, threads, turns } from "@meridian/database";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { eq } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";

export function createLoroAgentEditHost(input: { db: Database; rooms: DocumentRooms<DrizzleDb> }): {
  rooms: AgentEditRooms;
  /** `agent (<chat ref>)` for the chat a turn belongs to; null for a turn the database lacks. */
  authorOfTurn(turnId: string): Promise<string | null>;
} {
  const db = () => currentDrizzleDb(input.db);
  return {
    rooms: agentEditRooms(input.rooms, {
      // Drafts are off until phase 2: every chat reads and writes Live.
      async roomFor(documentId): Promise<DocumentRoom> {
        const [row] = await db()
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.id, documentId as DocumentId));
        if (!row) throw new DocumentNotFoundError(documentId);
        return { kind: "live", documentId };
      },
      transaction: db,
      origin: "server:agent",
      recordWrite: async (tx, record, batch) => {
        await recordWrite(tx, record, batch);
      },
    }),
    async authorOfTurn(turnId) {
      const [row] = await db()
        .select({ ref: threads.ref })
        .from(turns)
        .innerJoin(threads, eq(threads.id, turns.threadId))
        .where(eq(turns.id, turnId as TurnId));
      return row?.ref ? `agent (${row.ref})` : null;
    },
  };
}

/** One write's receipt: an edit of kind `write` and its one part, the batch and its delta. */
function recordWrite(tx: DrizzleDb, record: AgentWriteRecord, batch: Uint8Array) {
  const { actor } = record;
  return recordDocumentEdit(tx, {
    documentId: record.documentId as DocumentId,
    threadId: record.threadId as ThreadId,
    turnId: (record.turnId as TurnId | null) ?? null,
    responseId: record.authoringResponseId ?? null,
    toolCallId: record.toolCallId ?? null,
    actor: actor.kind === "agent" ? "agent" : actor.kind === "human" ? "human" : "system",
    wId: record.wId,
    actorUserId: actor.kind === "human" ? (actor.userId as UserId) : null,
    receipts: [
      {
        update: batch,
        origin: { kind: "live" },
        delta: record.delta,
      },
    ],
  });
}
