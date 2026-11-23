/**
 * agent-edit's Loro core on the server's `DocumentRooms`: the room a call reads (`agentRoomFor`, at
 * the call's destination), its writes committed in the model edit's command transaction with
 * their receipts, each naming the room it merged into, and the chat a turn's commit message names.
 */
import type { AgentEditRooms, AgentWriteRecord } from "@meridian/agent-edit/integration";
import type { DocumentId, EditOrigin, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { type Database, threads, turns } from "@meridian/database";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { eq } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { agentRoomFor } from "./drizzle-agent-room.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";

export function createLoroAgentEditHost(input: { db: Database; rooms: DocumentRooms<DrizzleDb> }): {
  rooms: AgentEditRooms;
  /** `agent (<chat ref>)` for the chat a turn belongs to; null for a turn the database lacks. */
  authorOfTurn(turnId: string): Promise<string | null>;
} {
  const db = () => currentDrizzleDb(input.db);
  return {
    rooms: {
      async readRoom(documentId) {
        const room = await agentRoomFor(db(), documentId);
        return { room, docs: await input.rooms.read(room) };
      },
      async save(room, batch, record) {
        const tx = db();
        await input.rooms.commit(tx, room, batch, "server:agent");
        if (record) await recordWrite(tx, record, originOf(room));
      },
    },
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

export const originOf = (room: DocumentRoom): EditOrigin =>
  room.kind === "fork" ? { kind: "fork", draftId: room.draftId } : { kind: "live" };

/** One write's receipt: an edit of kind `write` and its one part, its delta, in its room. */
function recordWrite(tx: DrizzleDb, record: AgentWriteRecord, origin: EditOrigin) {
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
        origin,
        delta: record.delta,
      },
    ],
  });
}
