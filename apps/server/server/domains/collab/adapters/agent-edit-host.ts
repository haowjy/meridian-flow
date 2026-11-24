/**
 * agent-edit's Loro core on the server's `DocumentRooms`: the room a call reads (`agentRoomFor`, at
 * the call's destination), its writes committed in the model edit's command transaction with
 * their receipts, each naming the room it merged into, and the chat a turn's commit message names.
 */
import {
  type AgentEditRooms,
  type AgentWriteRecord,
  agentEditRooms,
} from "@meridian/agent-edit/integration";
import type {
  DocumentId,
  DraftId,
  EditOrigin,
  ThreadId,
  TurnId,
  UserId,
} from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import { type Database, threads, turns } from "@meridian/database";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { eq } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDestination } from "../domain/agent-destination.js";
import { agentRoomFor } from "./drizzle-agent-room.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";

export function createAgentEditHost(input: { db: Database; rooms: DocumentRooms<DrizzleDb> }): {
  rooms: AgentEditRooms;
  /** `agent (<chat ref>)` for the chat a turn belongs to; null for a turn the database lacks. */
  authorOfTurn(turnId: string): Promise<string | null>;
} {
  const db = () => currentDrizzleDb(input.db);
  return {
    rooms: agentEditRooms(input.rooms, {
      roomFor: (documentId) => agentRoomFor(db(), documentId),
      transaction: db,
      origin: "server:agent",
      recordWrite,
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

/**
 * The origin of a write into `room` at the call's destination: a Draft chat's write into the Live
 * room of a document only its draft holds names the draft.
 */
const originOf = (room: DocumentRoom): EditOrigin => {
  if (room.kind === "fork") return { kind: "fork", draftId: room.draftId };
  const destination = currentDestination();
  return destination.kind === "draft"
    ? { kind: "live", draftId: destination.draftId as DraftId }
    : { kind: "live" };
};

/** One write's receipt: an edit of kind `write` and its one part, in the room it landed in. */
async function recordWrite(tx: DrizzleDb, record: AgentWriteRecord): Promise<void> {
  const { actor } = record;
  await recordDocumentEdit(tx, {
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
        origin: originOf(record.room),
        delta: record.delta,
        write: { edit: record.edit },
      },
    ],
  });
}
