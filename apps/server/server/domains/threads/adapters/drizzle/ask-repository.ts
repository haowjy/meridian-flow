/** Drizzle adapter for durable ask storage and deadline discovery. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { asks } from "@meridian/database/schema";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { continuationOwedSql } from "../../../../shared/ask-continuation-owed.js";
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
    continuation: row.continuation,
    continuationTurnId: row.continuationTurnId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  };
}

/** A row from raw SQL, which returns column names, not field names. */
function storedAskFromColumns(row: Record<string, unknown>): StoredAsk {
  return {
    id: row.id as string,
    threadId: row.thread_id as ThreadId,
    askingTurnId: row.asking_turn_id as TurnId,
    executionId: row.execution_id as string,
    toolCallId: row.tool_call_id as string,
    kind: row.kind as StoredAsk["kind"],
    payload: row.payload as StoredAsk["payload"],
    deadlineAt: dateOrNull(row.deadline_at),
    status: row.status as StoredAsk["status"],
    resolution: row.resolution as StoredAsk["resolution"],
    submissionId: row.submission_id as string | null,
    continuation: row.continuation as StoredAsk["continuation"],
    continuationTurnId: row.continuation_turn_id as TurnId | null,
    createdAt: dateOrNull(row.created_at) as Date,
    resolvedAt: dateOrNull(row.resolved_at),
  };
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value as string);
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
    async claimLineage(input) {
      const owedSql = continuationOwedSql(sql`a`);
      const held = sql`(a.status IN ('pending', 'open') OR ${owedSql})`;
      const targets =
        input.threadIds.length > 0
          ? sql`(a.thread_id IN (${sql.join(
              input.threadIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}) AND ${held})`
          : sql`false`;
      const { owner } = input;
      const owned = owner
        ? sql`(a.thread_id = ${owner.threadId}::uuid AND (
            ((a.status = 'open' OR (a.status = 'pending' AND ${
              owner.execution ? sql`a.execution_id = ${owner.execution}::uuid` : sql`false`
            })) AND ${owner.turnId ? sql`a.asking_turn_id = ${owner.turnId}::uuid` : sql`true`})
            OR ${owedSql}
          ))`
        : sql`false`;
      // Rows this command already holds lock again at once. A row another transaction holds
      // became held after the thread's lock took its asks (a new question), and its holder waits
      // on a thread lock this command holds: waiting for it would deadlock.
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH claimed AS (
          SELECT a.id, a.status AS prior FROM asks a
          WHERE ${targets} OR ${owned}
          ORDER BY a.id
          FOR UPDATE SKIP LOCKED
        )
        UPDATE asks SET
          status = CASE WHEN claimed.prior IN ('pending', 'open') THEN 'cancelled' ELSE asks.status END,
          resolution = CASE WHEN claimed.prior IN ('pending', 'open')
            THEN '{"kind":"cancelled"}'::jsonb ELSE asks.resolution END,
          resolved_at = CASE WHEN claimed.prior IN ('pending', 'open')
            THEN now() ELSE asks.resolved_at END,
          continuation = 'cancelled'
        FROM claimed
        WHERE asks.id = claimed.id
        RETURNING asks.*, claimed.prior
      `);
      return rows.map((row) => ({
        ask: storedAskFromColumns(row),
        wasLive: row.prior === "pending" || row.prior === "open",
      }));
    },
    async admitContinuation(input) {
      const [row] = await currentDrizzleDb(db)
        .update(asks)
        .set({ continuation: "done", continuationTurnId: input.turnId })
        .where(and(eq(asks.id, input.id), continuationOwedSql()))
        .returning();
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
          .set({
            status: "cancelled",
            resolution: { kind: "cancelled" },
            resolvedAt: now,
            continuation: "cancelled",
          })
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
          continuation: input.status === "cancelled" ? "cancelled" : "pending",
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
          continuation: "cancelled",
        })
        .where(and(eq(asks.id, input.id), inArray(asks.status, ["pending", "open"])))
        .returning();
      return row ? storedAsk(row) : null;
    },
  };
}
