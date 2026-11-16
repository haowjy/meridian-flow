import type { ThreadId } from "@meridian/contracts";
import type { McpConnectionId, McpPinId } from "@meridian/contracts/mcp";
import type { Database } from "@meridian/database";
import { mcpCalls } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { CallStore } from "../../ports/call-store.js";

/** Plain `db`, never the ambient transaction: a call's record must commit before the call leaves. */
export function createDrizzleCallStore({ db }: { db: Database }): CallStore {
  return {
    async open(call) {
      const [row] = await db
        .insert(mcpCalls)
        .values({
          ...call,
          threadId: call.threadId as ThreadId,
          connectionId: call.connectionId as McpConnectionId,
          pinId: call.pinId as McpPinId,
        })
        .returning({ id: mcpCalls.id });
      if (!row) throw new Error("The call record was not written");
      return row.id;
    },

    async complete(id, done) {
      await db
        .update(mcpCalls)
        .set({
          outcomeKind: done.outcomeKind,
          replyRef: done.replyRef,
          finishedAt: done.finishedAt,
        })
        .where(eq(mcpCalls.id, id));
    },

    async listForTurns(threadId, turnIds) {
      if (turnIds.length === 0) return [];
      const rows = await db
        .select()
        .from(mcpCalls)
        .where(
          and(eq(mcpCalls.threadId, threadId as ThreadId), inArray(mcpCalls.turnId, [...turnIds])),
        )
        .orderBy(mcpCalls.sentAt);
      return rows.map((row) => ({
        id: row.id,
        threadId: row.threadId,
        turnId: row.turnId,
        modelResponseId: row.modelResponseId,
        toolCallId: row.toolCallId,
        sequence: row.sequence,
        connectionId: row.connectionId,
        pinId: row.pinId,
        toolName: row.toolName,
        arguments: row.arguments as never,
        outcomeKind: row.outcomeKind,
        replyKept: typeof (row.replyRef as { key?: unknown } | null)?.key === "string",
        sentAt: row.sentAt,
      }));
    },
  };
}
