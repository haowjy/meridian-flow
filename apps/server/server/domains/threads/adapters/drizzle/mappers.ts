/**
 * Drizzle row->domain mappers: convert thread/turn/block/model-response DB rows
 * into their @meridian/contracts shapes (decimal/date/seq coercions). Shared by
 * the drizzle repositories so row translation lives in one place.
 */
import type {
  Block,
  ModelResponse,
  PromptBake,
  Thread,
  Turn,
  TurnUsage,
} from "@meridian/contracts/threads";
import type * as schema from "@meridian/database/schema";
import { toIsoString } from "../../domain/contract-serialization.js";

function decimalString(value: string | null | undefined): string {
  if (value == null) return "0";
  return /^-?0(?:\.0+)?$/.test(value) ? "0" : value;
}

export function turnUsageFromRow(row: typeof schema.turns.$inferSelect): TurnUsage {
  return {
    inputTokens: row.totalInputTokens ?? 0,
    outputTokens: row.totalOutputTokens ?? 0,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalCostUsd: decimalString(row.totalCostUsd),
    totalMillicredits: row.totalMillicredits?.toString(),
    responseCount: row.responseCount,
  };
}

export function mapThread(
  row: typeof schema.threads.$inferSelect & {
    workId?: string | null;
    agentDefinitionRevisionId?: string | null;
    agentName?: string | null;
  },
): Thread {
  return {
    id: row.id,
    projectId: row.projectId,
    workId: row.workId ?? null,
    userId: row.createdByUserId,
    kind: row.kind as Thread["kind"],
    status: row.status as Thread["status"],
    title: row.title === "" ? null : row.title,
    ref: row.ref,
    initialPromptBakeId: row.initialPromptBakeId,
    agentDefinitionRevisionId: row.agentDefinitionRevisionId ?? null,
    agentName: row.agentName ?? null,
    nextSeq: String(row.nextSeq),
    activeLeafTurnId: row.activeLeafTurnId,
    parentThreadId: row.parentThreadId,
    originType: row.originType as Thread["originType"],
    originTurnId: row.originTurnId,
    rootThreadId: row.rootThreadId ?? row.id,
    spawnDepth: row.spawnDepth,
    spawnStatus: row.spawnStatus as Thread["spawnStatus"],
    totalCostUsd: decimalString(row.totalCostUsd),
    turnCount: row.turnCount,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    deletedAt: row.deletedAt ? toIsoString(row.deletedAt) : null,
  };
}

export function mapTurn(row: typeof schema.turns.$inferSelect): Turn {
  return {
    id: row.id,
    threadId: row.threadId,
    position: row.position,
    prevTurnId: row.parentTurnId,
    parentTurnId: row.parentTurnId,
    role: row.role as Turn["role"],
    origin: row.origin as Turn["origin"],
    writeMode: row.aiWriteMode as Turn["writeMode"],
    status: row.status as Turn["status"],
    promptBakeId: row.promptBakeId,
    finishReason: row.finishReason as Turn["finishReason"],
    model: row.model,
    provider: row.provider,
    inputTokens: row.totalInputTokens ?? 0,
    outputTokens: row.totalOutputTokens ?? 0,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalCostUsd: decimalString(row.totalCostUsd),
    totalMillicredits: row.totalMillicredits?.toString(),
    responseCount: row.responseCount,
    usage: turnUsageFromRow(row),
    error: row.error,
    requestParams: row.requestParams as Turn["requestParams"],
    responseMetadata: row.responseMetadata as Turn["responseMetadata"],
    metadata: row.metadata as Turn["metadata"],
    createdAt: toIsoString(row.createdAt),
    completedAt: row.completedAt ? toIsoString(row.completedAt) : null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

export function mapPromptBake(row: typeof schema.promptBakes.$inferSelect): PromptBake {
  return {
    id: row.id,
    ownerThreadId: row.ownerThreadId,
    composedSystemPrompt: row.composedSystemPrompt,
    bakedSkillSlugs: row.bakedSkillSlugs,
    bakedTools: row.bakedTools as PromptBake["bakedTools"],
    contentHash: row.contentHash,
    createdAt: toIsoString(row.createdAt),
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
    cacheReset: row.cacheReset,
    usageBreakdown: row.usageBreakdown as ModelResponse["usageBreakdown"],
    costUsd: decimalString(row.costUsd),
    millicredits: row.millicredits?.toString(),
    priceSource: row.priceSource,
    pricingSnapshot: row.pricingSnapshot as ModelResponse["pricingSnapshot"],
    finishReason: row.stopReason as ModelResponse["finishReason"],
    stopReason: row.stopReason,
    requestParams: row.requestParams as ModelResponse["requestParams"],
    responseMetadata: row.responseMetadata as ModelResponse["responseMetadata"],
    latencyMs: row.latencyMs != null ? Number(row.latencyMs) : null,
    requestStartedAt: row.requestStartedAt?.toISOString() ?? null,
    timeToFirstTokenMs: row.timeToFirstTokenMs != null ? Number(row.timeToFirstTokenMs) : null,
    generationMs: row.generationMs != null ? Number(row.generationMs) : null,
    rawUsage: row.usageBreakdown as ModelResponse["rawUsage"],
    predictedCacheState: row.predictedCacheState,
    predictedCacheReason: row.predictedCacheReason as ModelResponse["predictedCacheReason"],
    createdAt: toIsoString(row.createdAt),
    completedAt: row.completedAt ? toIsoString(row.completedAt) : null,
  };
}
