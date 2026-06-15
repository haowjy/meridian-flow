/**
 * Cancel settlement: reconcile interrupted model calls for billing-correct
 * cancellation. OpenRouter hard-cancels without stream usage use the /generation
 * client; direct providers rely on partial stream results from adapter drain.
 */

import { enrichOpenRouterResult } from "../gateway/adapters/openrouter/enrich-result.js";
import {
  readOpenRouterGenerationId,
  readOpenRouterProviderData,
} from "../gateway/adapters/openrouter/provider-data.js";
import type { GenerateResult } from "../gateway/index.js";

export type OpenRouterReconcileConfig = {
  apiKey?: string;
  baseUrl?: string;
};

function hasBillableTokenUsage(usage: GenerateResult["usage"]): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}

function hasProviderReportedCost(result: GenerateResult): boolean {
  if (result.provider !== "openrouter") return false;
  return readOpenRouterProviderData(result.providerData).reportedCostUsd !== undefined;
}

/** Whether a cancelled model call produced billable usage worth persisting. */
export function shouldPersistCancelledModelCall(result: GenerateResult): boolean {
  if (hasBillableTokenUsage(result.usage) || hasProviderReportedCost(result)) {
    return true;
  }
  if (result.provider === "openrouter" && readOpenRouterGenerationId(result.providerData)) {
    return true;
  }
  return false;
}

export function needsOpenRouterReconciliation(result: GenerateResult): boolean {
  if (result.provider !== "openrouter") return false;
  if (hasBillableTokenUsage(result.usage) || hasProviderReportedCost(result)) {
    return false;
  }
  return readOpenRouterGenerationId(result.providerData) !== undefined;
}

export function buildReconciliationStub(input: {
  model: string;
  provider: string;
  generationId?: string;
}): GenerateResult {
  return {
    content: [],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: input.model,
    provider: input.provider,
    providerData: input.generationId ? { generationId: input.generationId } : undefined,
  };
}

export async function reconcileInterruptedModelResult(
  config: OpenRouterReconcileConfig | undefined,
  result: GenerateResult,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  if (!needsOpenRouterReconciliation(result)) return result;
  const apiKey = config?.apiKey;
  if (!apiKey) return result;
  const baseUrl = config?.baseUrl ?? "https://openrouter.ai/api/v1";
  try {
    return await enrichOpenRouterResult(result, apiKey, baseUrl, signal);
  } catch {
    return result;
  }
}
