/**
 * Drizzle TurnRepository: SQL for the turns table (idempotent create/list,
 * status updates, and model-response-derived usage rollup recomputation). The
 * projector can replay journal facts safely because rollups are aggregates, not deltas.
 */
import type { TurnId } from "@meridian/contracts/runtime";
import type { Turn } from "@meridian/contracts/threads";
import * as schema from "@meridian/database/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { toDate } from "../../domain/contract-serialization.js";
import type {
  CreateTurnInput,
  TurnRepository,
  UpdateTurnStatusInput,
} from "../../ports/repositories.js";
import { mapTurn } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

export async function writeTurnRollupRecompute(db: DrizzleDb, id: TurnId) {
  const activeDb = currentDrizzleDb(db);
  const [aggregate] = await activeDb
    .select({
      inputTokens: sql<number>`COALESCE(SUM(${schema.modelResponses.inputTokens}), 0)::int`,
      outputTokens: sql<number>`COALESCE(SUM(${schema.modelResponses.outputTokens}), 0)::int`,
      reasoningTokens: sql<number | null>`SUM(${schema.modelResponses.reasoningTokens})::int`,
      cacheReadTokens: sql<number | null>`SUM(${schema.modelResponses.cacheReadTokens})::int`,
      cacheWriteTokens: sql<number | null>`SUM(${schema.modelResponses.cacheWriteTokens})::int`,
      totalCostUsd: sql<string>`COALESCE(SUM(${schema.modelResponses.costUsd}), 0)::numeric(12,6)`,
      totalMillicredits: sql<number | null>`SUM(${schema.modelResponses.millicredits})`,
      responseCount: sql<number>`COUNT(*)::int`,
    })
    .from(schema.modelResponses)
    .where(eq(schema.modelResponses.turnId, id));
  const [latestResponse] = await activeDb
    .select({
      model: schema.modelResponses.model,
      provider: schema.modelResponses.provider,
      responseMetadata: schema.modelResponses.responseMetadata,
    })
    .from(schema.modelResponses)
    .where(eq(schema.modelResponses.turnId, id))
    .orderBy(desc(schema.modelResponses.sequence))
    .limit(1);

  const [row] = await activeDb
    .update(schema.turns)
    .set({
      totalInputTokens: aggregate?.inputTokens ?? 0,
      totalOutputTokens: aggregate?.outputTokens ?? 0,
      reasoningTokens: aggregate?.reasoningTokens ?? null,
      cacheReadTokens: aggregate?.cacheReadTokens ?? null,
      cacheWriteTokens: aggregate?.cacheWriteTokens ?? null,
      totalCostUsd: aggregate?.totalCostUsd ?? "0",
      totalMillicredits: aggregate?.totalMillicredits ?? null,
      responseCount: aggregate?.responseCount ?? 0,
      model: latestResponse?.model ?? null,
      provider: latestResponse?.provider ?? null,
      responseMetadata: latestResponse?.responseMetadata ?? null,
    })
    .where(eq(schema.turns.id, id))
    .returning();
  if (!row) throw new Error(`Turn not found: ${id}`);
  return mapTurn(row);
}

export function createDrizzleTurnRepository(db: DrizzleDb): TurnRepository {
  return {
    async create(input: CreateTurnInput) {
      const [row] = await currentDrizzleDb(db)
        .insert(schema.turns)
        .values({
          id: input.id,
          threadId: input.threadId,
          parentTurnId: input.prevTurnId ?? null,
          role: input.role,
          status: input.status ?? "pending",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCostUsd: "0",
          responseCount: 0,
          requestParams: input.requestParams ?? null,
          createdAt: input.createdAt === undefined ? undefined : toDate(input.createdAt),
        })
        .onConflictDoNothing({ target: schema.turns.id })
        .returning();
      if (!row) {
        if (!input.id) throw new Error("Failed to create turn");
        const existing = await this.findById(input.id);
        if (!existing) throw new Error("Failed to create turn");
        return existing;
      }
      const now = new Date();
      await currentDrizzleDb(db)
        .update(schema.threads)
        .set({
          activeLeafTurnId: row.id,
          updatedAt: now,
        })
        .where(eq(schema.threads.id, row.threadId));
      const [thread] = await currentDrizzleDb(db)
        .select({
          projectId: schema.threads.projectId,
          workId: schema.threadWorks.workId,
        })
        .from(schema.threads)
        .leftJoin(
          schema.threadWorks,
          and(
            eq(schema.threadWorks.threadId, schema.threads.id),
            eq(schema.threadWorks.isPrimary, true),
          ),
        )
        .where(eq(schema.threads.id, row.threadId))
        .limit(1);
      if (thread?.workId) {
        await currentDrizzleDb(db)
          .update(schema.works)
          .set({ updatedAt: now })
          .where(eq(schema.works.id, thread.workId));
        await currentDrizzleDb(db)
          .update(schema.projects)
          .set({ updatedAt: now, lastActivityAt: now })
          .where(eq(schema.projects.id, thread.projectId));
      }
      return mapTurn(row);
    },
    async findById(id: TurnId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.id, id));
      return row ? mapTurn(row) : null;
    },
    async listByThread(threadId) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(asc(schema.turns.createdAt));
      return rows.map(mapTurn);
    },
    async getLatestByThread(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(desc(schema.turns.createdAt))
        .limit(1);
      return row ? mapTurn(row) : null;
    },
    async updateStatus(id, input: UpdateTurnStatusInput) {
      const patch: {
        status: Turn["status"];
        finishReason?: Turn["finishReason"];
        completedAt?: Date | null;
        error?: string | null;
      } = { status: input.status };
      if (input.finishReason !== undefined) patch.finishReason = input.finishReason;
      if (input.completedAt !== undefined) {
        patch.completedAt = input.completedAt === null ? null : toDate(input.completedAt);
      }
      if (input.error !== undefined) patch.error = input.error;
      const [row] = await currentDrizzleDb(db)
        .update(schema.turns)
        .set(patch)
        .where(eq(schema.turns.id, id))
        .returning();
      if (!row) throw new Error(`Turn not found: ${id}`);
      return mapTurn(row);
    },
    async recomputeRollups(id) {
      return writeTurnRollupRecompute(db, id);
    },
  };
}
