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

export function createLoroAgentEditHost(input: { db: Database; rooms: DocumentRooms<DrizzleDb> }): {
  rooms: AgentEditRooms;
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

const originOf = (room: DocumentRoom): EditOrigin => {
  if (room.kind === "fork") return { kind: "fork", draftId: room.draftId };
  const destination = currentDestination();
  return destination.kind === "draft"
    ? { kind: "live", draftId: destination.draftId as DraftId }
    : { kind: "live" };
};

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
