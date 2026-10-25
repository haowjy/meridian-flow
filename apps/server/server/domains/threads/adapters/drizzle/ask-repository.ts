/** Drizzle adapter for durable ask storage and deadline discovery. */
import type { ThreadId } from "@meridian/contracts/runtime";
import { asks } from "@meridian/database/schema";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { AskRepository, StoredAsk } from "../../ports/ask-repository.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

function storedAsk(row: typeof asks.$inferSelect): StoredAsk {
  return {
    id: row.id,
    threadId: row.threadId,
    askingTurnId: row.askingTurnId,
    executionId: row.executionId,
    toolCallId: row.toolCallId,
    kind: row.kind,
    payload: row.payload,
    deadlineAt: row.deadlineAt,
    status: row.status,
    resolution: row.resolution,
    submissionId: row.submissionId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

export function createDrizzleAskRepository(db: DrizzleDb): AskRepository {
  return {
    async create(input) {
      const [row] = await currentDrizzleDb(db).insert(asks).values(input).returning();
      if (!row) throw new Error("Ask insert returned no row");
      return storedAsk(row);
    },
    async findById(id) {
      const [row] = await currentDrizzleDb(db).select().from(asks).where(eq(asks.id, id)).limit(1);
      return row ? storedAsk(row) : null;
    },
    async findLiveByTurnForUpdate(turnId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(asks)
        .where(and(eq(asks.askingTurnId, turnId), inArray(asks.status, ["pending", "open"])))
        .limit(1)
        .for("update");
      return row ? storedAsk(row) : null;
    },
    async findOpenByThread(threadId: ThreadId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(asks)
        .where(and(eq(asks.threadId, threadId), eq(asks.status, "open")))
        .orderBy(asc(asks.createdAt))
        .limit(1);
      return row ? storedAsk(row) : null;
    },
    async findLiveByThread(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(asks)
        .where(and(eq(asks.threadId, threadId), inArray(asks.status, ["pending", "open"])))
        .limit(1);
      return row ? storedAsk(row) : null;
    },
    async listByThread(threadId) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(asks)
        .where(eq(asks.threadId, threadId))
        .orderBy(asc(asks.createdAt), asc(asks.id));
      return rows.map(storedAsk);
    },
    async listOpenDueBy(deadline, limit) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(asks)
        .where(and(eq(asks.status, "open"), lte(asks.deadlineAt, deadline)))
        .orderBy(asc(asks.deadlineAt), asc(asks.id))
        .limit(limit);
      return rows.map(storedAsk);
    },
    async listByTurnIds(turnIds) {
      if (turnIds.length === 0) return [];
      return (
        await currentDrizzleDb(db)
          .select()
          .from(asks)
          .where(inArray(asks.askingTurnId, [...turnIds]))
          .orderBy(asc(asks.createdAt), asc(asks.id))
      ).map(storedAsk);
    },
    async openPending(id, turnId, deadline) {
      const [row] = await currentDrizzleDb(db)
        .update(asks)
        .set({ status: "open", deadlineAt: deadline })
        .where(and(eq(asks.id, id), eq(asks.askingTurnId, turnId), eq(asks.status, "pending")))
        .returning();
      return row ? storedAsk(row) : null;
    },
    async cancelPendingByTurn(turnId) {
      const now = new Date();
      return (
        await currentDrizzleDb(db)
          .update(asks)
          .set({ status: "cancelled", resolution: { kind: "cancelled" }, resolvedAt: now })
          .where(and(eq(asks.askingTurnId, turnId), eq(asks.status, "pending")))
          .returning()
      ).map(storedAsk);
    },
    async resolveOpen(input) {
      const [row] = await currentDrizzleDb(db)
        .update(asks)
        .set({
          status: input.status,
          resolution: input.resolution,
          submissionId: input.submissionId ?? null,
          resolvedAt: input.resolvedAt,
        })
        .where(and(eq(asks.id, input.id), eq(asks.status, "open")))
        .returning();
      return row ? storedAsk(row) : null;
    },
    async resolveLive(input) {
      const [row] = await currentDrizzleDb(db)
        .update(asks)
        .set({
          status: input.status,
          resolution: input.resolution,
          resolvedAt: input.resolvedAt,
        })
        .where(and(eq(asks.id, input.id), inArray(asks.status, ["pending", "open"])))
        .returning();
      return row ? storedAsk(row) : null;
    },
  };
}
