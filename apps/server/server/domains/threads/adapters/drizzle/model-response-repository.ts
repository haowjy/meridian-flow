/**
 * Drizzle ModelResponseRepository: SQL for model response rows. Create is
 * replay-idempotent by producer-minted id: re-applying the same journal event
 * returns the existing row instead of clobbering or duplicating it.
 */
import * as schema from "@meridian/database/schema";
import { asc, eq } from "drizzle-orm";
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
      usageBreakdown: input.rawUsage ?? null,
      costUsd: input.costUsd ?? "0",
      millicredits: input.millicredits != null ? Number(input.millicredits) : null,
      stopReason: input.finishReason ?? null,
      requestParams: null,
      responseMetadata: null,
      latencyMs: input.latencyMs ?? null,
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
