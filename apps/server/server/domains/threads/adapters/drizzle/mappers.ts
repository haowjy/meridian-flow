// @ts-nocheck
/**
 * Drizzle row->domain mappers: convert thread/turn/block/model-response DB rows
 * into their @meridian/contracts shapes (decimal/date/seq coercions). Shared by
 * the drizzle repositories so row translation lives in one place.
 */
import type { Block, ModelResponse, Thread, Turn, TurnUsage } from "@meridian/contracts/threads";
import type * as schema from "@meridian/database/schema";
import { toIsoString, toSeqString } from "../../domain/contract-serialization.js";

function decimalString(value: string | null): string {
  return value ?? "0";
}

export function turnUsageFromRow(row: typeof schema.turns.$inferSelect): TurnUsage {
  return {
    inputTokens: row.totalInputTokens ?? 0,
    outputTokens: row.totalOutputTokens ?? 0,
    reasoningTokens: row.totalReasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalCostUsd: decimalString(row.totalCostUsd),
    totalMillicredits: row.totalMillicredits?.toString(),
    responseCount: row.responseCount,
  };
}

export function mapThread(row: typeof schema.threads.$inferSelect): Thread {
  const isFrozen = row.bakedSkillSlugs != null;
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    workId: row.workId,
    userId: row.createdBy,
    kind: row.kind as Thread["kind"],
    status: row.status as Thread["status"],
    title: row.title,
    composedSystemPrompt: isFrozen ? row.composedSystemPrompt : null,
    bakedSkillSlugs: row.bakedSkillSlugs ?? null,
    // Agent-bound threads resolve the raw body from the package at first attempt.
    systemPrompt: isFrozen || row.currentAgent ? null : row.composedSystemPrompt,
    workingState: row.workingState as Thread["workingState"],
    currentAgent: row.currentAgent,
    nextSeq: toSeqString(row.nextSeq),
    parentThreadId: row.parentThreadId,
    rootThreadId: row.rootThreadId,
    spawnDepth: row.spawnDepth,
    spawnStatus: row.spawnStatus as Thread["spawnStatus"],
    spawnResult: row.spawnResult as Thread["spawnResult"],
    totalCostUsd: row.totalCostUsd,
    turnCount: row.turnCount,
    historySummary: row.historySummary,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    deletedAt: row.deletedAt ? toIsoString(row.deletedAt) : null,
  };
}

export function mapTurn(row: typeof schema.turns.$inferSelect): Turn {
  return {
    id: row.id,
    threadId: row.threadId,
    prevTurnId: row.parentTurnId,
    parentTurnId: row.parentTurnId,
    role: row.role as Turn["role"],
    status: row.status as Turn["status"],
    agentDefinitionId: row.agentDefinitionId,
    finishReason: row.finishReason as Turn["finishReason"],
    model: row.model,
    provider: row.provider,
    inputTokens: row.totalInputTokens ?? 0,
    outputTokens: row.totalOutputTokens ?? 0,
    reasoningTokens: row.totalReasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalCostUsd: decimalString(row.totalCostUsd),
    totalMillicredits: row.totalMillicredits?.toString(),
    responseCount: row.responseCount,
    usage: turnUsageFromRow(row),
    error: row.error,
    requestParams: row.requestParams as Turn["requestParams"],
    responseMetadata: row.responseMetadata as Turn["responseMetadata"],
    createdAt: toIsoString(row.createdAt),
    completedAt: row.completedAt ? toIsoString(row.completedAt) : null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

export function mapBlock(row: typeof schema.turnBlocks.$inferSelect): Block {
  const textContent = row.modelText.length > 0 ? row.modelText : null;
  return {
    id: row.id,
    turnId: row.turnId,
    responseId: row.modelResponseId,
    blockType: row.blockType as Block["blockType"],
    sequence: row.sequence,
    textContent,
    content: row.content as Block["content"],
    modelText: row.modelText,
    compact: row.compact,
    pruned: row.pruned,
    provider: row.provider,
    providerData: row.providerData as Block["providerData"],
    executionSide: row.executionSide as Block["executionSide"],
    status: row.status as Block["status"],
    collapsedContent: row.compact,
    createdAt: toIsoString(row.createdAt),
  };
}

export function mapModelResponse(row: typeof schema.modelResponses.$inferSelect): ModelResponse {
  return {
    id: row.id,
    turnId: row.turnId,
    sequence: row.sequence,
    provider: row.provider,
    model: row.model,
    providerRequestId: row.providerRequestId,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    usageBreakdown: row.rawUsage as ModelResponse["usageBreakdown"],
    costUsd: row.costUsd,
    millicredits: row.millicredits?.toString(),
    priceSource: row.priceSource as ModelResponse["priceSource"],
    pricingSnapshot: row.pricingSnapshot as ModelResponse["pricingSnapshot"],
    finishReason: row.finishReason as ModelResponse["finishReason"],
    stopReason: row.stopReason,
    requestParams: row.requestParams as ModelResponse["requestParams"],
    responseMetadata: row.responseMetadata as ModelResponse["responseMetadata"],
    latencyMs: row.latencyMs != null ? Number(row.latencyMs) : null,
    rawUsage: row.rawUsage as ModelResponse["rawUsage"],
    createdAt: toIsoString(row.createdAt),
    completedAt: row.completedAt ? toIsoString(row.completedAt) : null,
  };
}
