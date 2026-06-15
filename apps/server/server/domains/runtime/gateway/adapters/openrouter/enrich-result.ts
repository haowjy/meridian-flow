/**
 * OpenRouter result enrichment: merges provider-reported cost and native token
 * counts from stream usage or the /generation fallback into GenerateResult.
 */
import type { GenerateResult } from "../../domain/index.js";
import { fetchOpenRouterGeneration, type OpenRouterGenerationRecord } from "./generation.js";

export interface OpenRouterProviderData {
  generationId?: string;
  enrichmentSource?: "stream_usage" | "generation_api";
  generation?: OpenRouterGenerationRecord;
}

function providerDataFromResult(result: GenerateResult): OpenRouterProviderData {
  if (result.providerData && typeof result.providerData === "object") {
    return result.providerData as OpenRouterProviderData;
  }
  return {};
}

export async function enrichOpenRouterResult(
  result: GenerateResult,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const providerData = providerDataFromResult(result);
  if (result.usage.estimatedCostUsd !== undefined) {
    return {
      ...result,
      providerData: {
        ...providerData,
        enrichmentSource: providerData.enrichmentSource ?? "stream_usage",
      },
    };
  }

  const generationId = providerData.generationId;
  if (!generationId || !apiKey) return result;

  const generation = await fetchOpenRouterGeneration(generationId, apiKey, signal);
  if (!generation) return result;

  return {
    ...result,
    usage: {
      ...result.usage,
      inputTokens: generation.native_tokens_prompt ?? result.usage.inputTokens,
      outputTokens: generation.native_tokens_completion ?? result.usage.outputTokens,
      ...(generation.native_tokens_reasoning
        ? { reasoningTokens: generation.native_tokens_reasoning }
        : {}),
      ...(generation.native_tokens_cached
        ? { cacheReadTokens: generation.native_tokens_cached }
        : {}),
      estimatedCostUsd: generation.total_cost,
    },
    providerData: {
      ...providerData,
      generationId,
      enrichmentSource: "generation_api",
      generation,
    },
  };
}
