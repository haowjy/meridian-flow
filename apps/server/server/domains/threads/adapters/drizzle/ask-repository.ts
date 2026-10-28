/** Drizzle adapter for durable ask storage and deadline discovery. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { asks } from "@meridian/database/schema";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { lockThreadAsks } from "../../../../shared/thread-work-lock.js";
import type { AskRelay, AskRepository, StoredAsk } from "../../ports/ask-repository.js";
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
    relay: row.relay as AskRelay | null,
    continuation: row.continuation,
    continuationTurnId: row.continuationTurnId,
    forwardedFromAskId: row.forwardedFromAskId,
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
    relay: row.relay as AskRelay | null,
    continuation: row.continuation as StoredAsk["continuation"],
    continuationTurnId: row.continuation_turn_id as TurnId | null,
    forwardedFromAskId: row.forwarded_from_ask_id as string | null,
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
    async listByIds(ids) {
      if (ids.length === 0) return [];
      return (
        await currentDrizzleDb(db)
          .select()
          .from(asks)
          .where(inArray(asks.id, [...ids]))
      ).map(storedAsk);
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
    async lockHeldByThreads(threadIds) {
      await lockThreadAsks(db, threadIds);
    },
    async listCopyHolders(threadIds) {
      if (threadIds.length === 0) return [];
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH RECURSIVE copies AS (
          SELECT copy.id, copy.thread_id FROM asks copy
          JOIN asks source ON source.id = copy.forwarded_from_ask_id
          WHERE source.thread_id IN (${sql.join(
            threadIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) AND copy.status IN ('pending', 'open')
          UNION
          SELECT copy.id, copy.thread_id FROM asks copy
          JOIN copies ON copy.forwarded_from_ask_id = copies.id
          WHERE copy.status IN ('pending', 'open')
        )
        SELECT DISTINCT thread_id FROM copies
      `);
      return rows.map((row) => row.thread_id as ThreadId);
    },
    async lockByIds(ids) {
      if (ids.length === 0) return;
      await currentDrizzleDb(db)
        .select({ id: asks.id })
        .from(asks)
        .where(inArray(asks.id, [...ids]))
        .orderBy(asc(asks.id))
        .for("update");
    },
    async claimLineage(input) {
      const held = sql`(a.status IN ('pending', 'open') OR a.continuation IN ('pending', 'admitted'))`;
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
            (a.status IN ('pending', 'open') AND ${
              owner.turnId ? sql`a.asking_turn_id = ${owner.turnId}::uuid` : sql`true`
            })
            OR (a.continuation IN ('pending', 'admitted') AND (
              ${owner.spare}::text IS NULL OR NOT EXISTS (
                SELECT 1 FROM turns t
                WHERE t.id = a.continuation_turn_id AND t.execution_id::text = ${owner.spare}::text
              )
            ))
          ))`
        : sql`false`;
      // A live copy forwarded from a claimed ask goes with it, at any remove.
      const rows = await currentDrizzleDb(db).execute(sql`
        WITH RECURSIVE reached AS (
          SELECT a.id FROM asks a WHERE ${targets} OR ${owned}
          UNION
          SELECT copy.id FROM asks copy
          JOIN reached ON copy.forwarded_from_ask_id = reached.id
          WHERE copy.status IN ('pending', 'open')
        ),
        claimed AS (
          SELECT a.id, a.status AS prior FROM asks a
          WHERE a.id IN (SELECT id FROM reached)
          ORDER BY a.id
          FOR UPDATE
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
        .set({
          continuation: input.forwarded ? "admitted" : "done",
          continuationTurnId: input.turnId,
        })
        .where(
          and(
            eq(asks.id, input.id),
            input.forwarded
              ? inArray(asks.continuation, ["pending", "admitted"])
              : eq(asks.continuation, "pending"),
          ),
        )
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
    async recordRelayOnce(id, relay) {
      const [row] = await currentDrizzleDb(db)
        .update(asks)
        .set({ relay })
        .where(and(eq(asks.id, id), isNull(asks.relay)))
        .returning();
      if (row) return storedAsk(row);
      const existing = (
        await currentDrizzleDb(db).select().from(asks).where(eq(asks.id, id)).limit(1)
      )[0];
      if (!existing) throw new Error("Forwarded ask disappeared while recording its relay");
      const stored = storedAsk(existing);
      if (!sameRelayAdmission(stored.relay, relay))
        throw new Error("Forwarded ask already has a different relay");
      return stored;
    },
    async completeRelay(input) {
      const relay = input.late
        ? sql`${JSON.stringify({ ...input.late, result: input.result })}::jsonb`
        : sql`${asks.relay} || jsonb_build_object('result', ${JSON.stringify(input.result)}::jsonb)`;
      const [row] = await currentDrizzleDb(db)
        .update(asks)
        .set({ relay, continuation: "done" })
        .where(
          and(
            eq(asks.id, input.id),
            eq(asks.continuation, "admitted"),
            eq(asks.continuationTurnId, input.turnId),
            input.late ? isNull(asks.relay) : sql`${asks.relay} IS NOT NULL`,
          ),
        )
        .returning();
      return row ? storedAsk(row) : null;
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

function sameRelayAdmission(left: AskRelay | null, right: AskRelay): boolean {
  return (
    left?.childAskId === right.childAskId &&
    left.mode === right.mode &&
    left.messageId === right.messageId
  );
}
