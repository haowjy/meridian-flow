/**
 * Drizzle ModelResponseRepository: SQL for model response rows. Create is
 * replay-idempotent by producer-minted id: re-applying the same journal event
 * returns the existing row instead of clobbering or duplicating it.
 */
import * as schema from "@meridian/database/schema";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type {
  CreateModelResponseInput,
  CreateModelResponseResult,
  ModelResponseRepository,
} from "../../ports/repositories.js";
import { mapModelResponse } from "./mappers.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

export async function writeModelResponse(
  db: DrizzleDb,
  input: CreateModelResponseInput,
): Promise<CreateModelResponseResult> {
  const [row] = await currentDrizzleDb(db)
    .insert(schema.modelResponses)
    .values({
      ...(input.id ? { id: input.id } : {}),
      turnId: input.turnId,
      sequence: input.sequence,
      provider: input.provider,
      model: input.model,
      providerRequestId: input.providerRequestId ?? null,
      priceSource: input.priceSource,
      pricingSnapshot: input.pricingSnapshot ?? null,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? null,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      cacheReset: input.cacheReset ?? false,
      usageBreakdown: input.rawUsage ?? null,
      costUsd: input.costUsd ?? "0",
      millicredits: input.millicredits != null ? Number(input.millicredits) : null,
      stopReason: input.finishReason ?? null,
      requestParams: null,
      responseMetadata: null,
      latencyMs: input.latencyMs ?? null,
      requestMessageCount: input.requestMessageCount,
      requestStartedAt: input.requestStartedAt ? new Date(input.requestStartedAt) : null,
      predictedCacheState: input.predictedCacheState,
      predictedCacheReason: input.predictedCacheReason,
      timeToFirstTokenMs: input.timeToFirstTokenMs ?? null,
      generationMs: input.generationMs ?? null,
    })
    .onConflictDoNothing({ target: schema.modelResponses.id })
    .returning();
  if (!row) {
    if (!input.id) throw new Error("Failed to create model response");
    const [existing] = await currentDrizzleDb(db)
      .select()
      .from(schema.modelResponses)
      .where(eq(schema.modelResponses.id, input.id));
    if (!existing) throw new Error("Failed to create model response");
    return { row: mapModelResponse(existing), inserted: false };
  }
  return { row: mapModelResponse(row), inserted: true };
}

export function createDrizzleModelResponseRepository(db: DrizzleDb): ModelResponseRepository {
  return {
    async create(input: CreateModelResponseInput) {
      return writeModelResponse(db, input);
    },
    async findById(id) {
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(schema.modelResponses)
        .where(eq(schema.modelResponses.id, id));
      return row ? mapModelResponse(row) : null;
    },
    async findLatestByThread(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select({
          turnId: schema.modelResponses.turnId,
          sequence: schema.modelResponses.sequence,
          model: schema.modelResponses.model,
          requestStartedAt: schema.modelResponses.requestStartedAt,
          inputTokens: schema.modelResponses.inputTokens,
          requestMessageCount: schema.modelResponses.requestMessageCount,
        })
        .from(schema.modelResponses)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.modelResponses.turnId))
        .where(and(eq(schema.turns.threadId, threadId), eq(schema.turns.role, "assistant")))
        .orderBy(desc(schema.turns.position), desc(schema.modelResponses.sequence))
        .limit(1);
      return row
        ? {
            ...row,
            inputTokens: row.inputTokens ?? 0,
            requestStartedAt: row.requestStartedAt?.toISOString() ?? null,
          }
        : null;
    },
    async findLatestForTurns(turnIds) {
      if (turnIds.length === 0) return null;
      const [row] = await currentDrizzleDb(db)
        .select({
          turnId: schema.modelResponses.turnId,
          sequence: schema.modelResponses.sequence,
          model: schema.modelResponses.model,
          requestStartedAt: schema.modelResponses.requestStartedAt,
          inputTokens: schema.modelResponses.inputTokens,
          requestMessageCount: schema.modelResponses.requestMessageCount,
        })
        .from(schema.modelResponses)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.modelResponses.turnId))
        .where(and(inArray(schema.turns.id, turnIds), eq(schema.turns.role, "assistant")))
        .orderBy(desc(schema.turns.position), desc(schema.modelResponses.sequence))
        .limit(1);
      return row
        ? {
            ...row,
            inputTokens: row.inputTokens ?? 0,
            requestStartedAt: row.requestStartedAt?.toISOString() ?? null,
          }
        : null;
    },
    async listByThread(threadId) {
      const rows = await currentDrizzleDb(db)
        .select({ response: schema.modelResponses })
        .from(schema.modelResponses)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.modelResponses.turnId))
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(asc(schema.modelResponses.sequence));
      return rows.map(({ response }) => mapModelResponse(response));
    },
    async sumUsageByThread(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select({
          inputTokens: sql<number>`coalesce(sum(${schema.modelResponses.inputTokens}), 0)::int`,
          cacheReportedInputTokens: sql<number>`coalesce(sum(${schema.modelResponses.inputTokens}) filter (where ${schema.modelResponses.cacheReadTokens} is not null), 0)::int`,
          cacheReportedCalls: sql<number>`count(*) filter (where ${schema.modelResponses.cacheReadTokens} is not null)::int`,
          cacheReadTokens: sql<number>`coalesce(sum(${schema.modelResponses.cacheReadTokens}), 0)::int`,
          cacheWriteTokens: sql<number>`coalesce(sum(${schema.modelResponses.cacheWriteTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${schema.modelResponses.outputTokens}), 0)::int`,
          cacheResets: sql<number>`count(*) filter (where ${schema.modelResponses.cacheReset})::int`,
        })
        .from(schema.modelResponses)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.modelResponses.turnId))
        .where(eq(schema.turns.threadId, threadId));
      return (
        row ?? {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheReportedInputTokens: 0,
          cacheReportedCalls: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          cacheResets: 0,
        }
      );
    },
    async cacheResetContext(threadId) {
      const activeDb = currentDrizzleDb(db);
      const [latest] = await activeDb
        .select({ inputTokens: schema.modelResponses.inputTokens })
        .from(schema.modelResponses)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.modelResponses.turnId))
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(desc(schema.turns.position), desc(schema.modelResponses.sequence))
        .limit(1);
      const [activity] = await activeDb
        .select({ found: sql<boolean>`count(*) > 0` })
        .from(schema.modelResponses)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.modelResponses.turnId))
        .where(
          and(
            eq(schema.turns.threadId, threadId),
            or(
              gt(schema.modelResponses.cacheReadTokens, 0),
              gt(schema.modelResponses.cacheWriteTokens, 0),
            ),
          ),
        );
      return {
        hasCacheActivity: activity?.found ?? false,
        previousInputTokens: latest?.inputTokens ?? null,
      };
    },
    async listByTurn(turnId) {
      const rows = await currentDrizzleDb(db)
        .select()
        .from(schema.modelResponses)
        .where(eq(schema.modelResponses.turnId, turnId))
        .orderBy(asc(schema.modelResponses.sequence));
      return rows.map(mapModelResponse);
    },
  };
}
