/**
 * OpenRouter cancelled-call settlement: preserves provider-reported billing by
 * enriching interrupted results through OpenRouter's /generation endpoint when
 * stream usage/cost was missing.
 */
import {
  buildReconciliationStub,
  type CancelledResultSettlement,
  type CancelledResultSettlementInput,
  createReconcileSignal,
  shouldPersistCancelledResult,
} from "../../domain/cancel-settlement.js";
import type { GenerateResult } from "../../domain/index.js";
import { hasBillableTokenUsage } from "../../domain/metering.js";
import { enrichOpenRouterResult } from "./enrich-result.js";
import { readOpenRouterGenerationId, readOpenRouterProviderData } from "./provider-data.js";

function hasProviderReportedCost(result: GenerateResult): boolean {
  return readOpenRouterProviderData(result.providerData).reportedCostUsd !== undefined;
}

/** Whether an OpenRouter cancelled model call has billable or reconcilable usage worth persisting. */
export function shouldPersistOpenRouterCancelledResult(result: GenerateResult): boolean {
  return (
    shouldPersistCancelledResult(result) ||
    hasProviderReportedCost(result) ||
    readOpenRouterGenerationId(result.providerData) !== undefined
  );
}

export function needsOpenRouterReconciliation(result: GenerateResult): boolean {
  if (hasBillableTokenUsage(result.usage) || hasProviderReportedCost(result)) {
    return false;
  }
  return readOpenRouterGenerationId(result.providerData) !== undefined;
}

function withOpenRouterGenerationId(
  result: GenerateResult,
  fallbackGenerationId?: string,
): GenerateResult {
  const generationId = readOpenRouterGenerationId(result.providerData) ?? fallbackGenerationId;
  if (!generationId) return result;
  const existingProviderData =
    result.providerData && typeof result.providerData === "object"
      ? (result.providerData as Record<string, unknown>)
      : {};
  return {
    ...result,
    providerRequestId: result.providerRequestId ?? generationId,
    providerData: { ...existingProviderData, generationId },
  };
}

function resultOrStub(input: {
  result?: GenerateResult;
  model: string;
  provider: string;
  providerRequestId?: string;
}): GenerateResult | undefined {
  if (input.result) return withOpenRouterGenerationId(input.result, input.providerRequestId);
  if (!input.providerRequestId) return undefined;
  return buildReconciliationStub({
    model: input.model,
    provider: input.provider,
    providerRequestId: input.providerRequestId,
    providerData: { generationId: input.providerRequestId },
  });
}

export async function settleOpenRouterCancelledResult(
  input: CancelledResultSettlementInput & {
    provider: string;
    apiKey?: string;
    baseUrl: string;
  },
): Promise<CancelledResultSettlement | null> {
  let result = resultOrStub(input);
  if (!result || !shouldPersistOpenRouterCancelledResult(result)) return null;

  if (needsOpenRouterReconciliation(result) && input.apiKey) {
    try {
      result = await enrichOpenRouterResult(
        result,
        input.apiKey,
        input.baseUrl,
        input.signal ?? createReconcileSignal(),
      );
    } catch {
      // Enrichment is best effort; persisting the request id is still useful for audit/replay.
    }
  }

  return { result: withOpenRouterGenerationId(result), persist: true };
}
