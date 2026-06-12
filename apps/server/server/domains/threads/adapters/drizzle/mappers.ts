// @ts-nocheck
/**
 * Drizzle row->domain mappers: convert thread/turn/block/model-response DB rows
 * into their @meridian/contracts shapes (decimal/date/seq coercions). Shared by
 * the drizzle repositories so row translation lives in one place.
 */
import type { Block, ModelResponse, Thread, Turn, TurnUsage } from "@meridian/contracts/threads";
import type * as schema from "@meridian/database/schema";
import { toIsoString, toSeqString } from "../../domain/contract-serialization.js";

function decimalString(value: string | null | undefined): string {
  return value ?? "0";
}

export function turnUsageFromRow(row: typeof schema.turns.$inferSelect): TurnUsage {
  return {
    inputTokens: row.totalInputTokens ?? 0,
    outputTokens: row.totalOutputTokens ?? 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: decimalString(row.totalCostUsd),
    totalMillicredits: row.totalMillicredits?.toString(),
    responseCount: 0,
  };
}

export function mapThread(row: typeof schema.threads.$inferSelect): Thread {
  const isFrozen = Boolean(row.systemPromptHash);
  return {
    id: row.id,
    workbenchId: row.projectId,
    workId: row.workId,
    userId: row.createdByUserId,
    kind: row.kind as Thread["kind"],
    status: row.status === "archived" ? "archived" : "idle",
    title: row.title,
    composedSystemPrompt: isFrozen ? (row.composedSystemPrompt ?? null) : null,
    bakedSkillSlugs: null,
    systemPrompt: isFrozen ? null : row.composedSystemPrompt,
    workingState: row.workingState as Thread["workingState"],
    currentAgent: row.currentAgentId,
    nextSeq: toSeqString(row.nextSeq),
    parentThreadId: row.parentThreadId,
    rootThreadId: row.parentThreadId ?? row.id,
    spawnDepth: row.spawnDepth,
    spawnStatus: row.spawnStatus as Thread["spawnStatus"],
    spawnResult: row.spawnResult as Thread["spawnResult"],
    totalCostUsd: "0",
    turnCount: row.turnCount,
    historySummary: null,
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
    model: null,
    provider: null,
    inputTokens: row.totalInputTokens ?? 0,
    outputTokens: row.totalOutputTokens ?? 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalCostUsd: decimalString(row.totalCostUsd),
    totalMillicredits: row.totalMillicredits?.toString(),
    responseCount: 0,
    usage: turnUsageFromRow(row),
    error: row.error,
    requestParams: null,
    responseMetadata: null,
    createdAt: toIsoString(row.createdAt),
    completedAt: row.completedAt ? toIsoString(row.completedAt) : null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

export function mapBlock(row: typeof schema.turnBlocks.$inferSelect): Block {
  const modelText = row.modelText ?? "";
  const textContent = modelText.length > 0 ? modelText : null;
  return {
    id: row.id,
    turnId: row.turnId,
    responseId: row.modelResponseId,
    blockType: row.blockType as Block["blockType"],
    sequence: row.sequence,
    textContent,
    content: row.content as Block["content"],
    modelText,
    compact: row.compact ?? "",
    pruned: row.pruned,
    provider: null,
    providerData: null,
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
    providerRequestId: null,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    usageBreakdown: row.usageBreakdown as ModelResponse["usageBreakdown"],
    costUsd: decimalString(row.costUsd),
    millicredits: row.millicredits?.toString(),
    priceSource: "computed",
    pricingSnapshot: null,
    finishReason: row.stopReason as ModelResponse["finishReason"],
    stopReason: row.stopReason,
    requestParams: row.requestParams as ModelResponse["requestParams"],
    responseMetadata: row.responseMetadata as ModelResponse["responseMetadata"],
    latencyMs: row.latencyMs != null ? Number(row.latencyMs) : null,
    rawUsage: row.usageBreakdown as ModelResponse["rawUsage"],
    createdAt: toIsoString(row.createdAt),
    completedAt: row.completedAt ? toIsoString(row.completedAt) : null,
  };
}
