/**
 * OpenRouter result enrichment: best-effort merge of provider-reported cost and
 * native token counts from stream providerData or the /generation fallback.
 * Failures never reject a completed stream — the original result is returned.
 */
import type { GenerateResult } from "../../domain/index.js";
import { hasBillableTokenUsage, withMissingUsageMetering } from "../../domain/metering.js";
import { fetchOpenRouterGeneration } from "./generation.js";
import { type OpenRouterProviderData, readOpenRouterProviderData } from "./provider-data.js";

function withMissingUsageMeteringForOpenRouter(
  result: GenerateResult,
  providerData: OpenRouterProviderData,
): GenerateResult {
  return withMissingUsageMetering({
    ...result,
    providerData: {
      ...providerData,
      ...((result.providerData && typeof result.providerData === "object"
        ? result.providerData
        : {}) as OpenRouterProviderData),
    },
  });
}

export async function enrichOpenRouterResult(
  result: GenerateResult,
  apiKey: string | undefined,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const providerData = readOpenRouterProviderData(result.providerData);

  if (providerData.reportedCostUsd !== undefined) {
    return {
      ...result,
      providerData: {
        ...providerData,
        enrichmentSource: providerData.enrichmentSource ?? "stream_usage",
      },
    };
  }

  const generationId = providerData.generationId;
  if (!generationId || !apiKey) {
    if (!hasBillableTokenUsage(result.usage)) {
      return withMissingUsageMeteringForOpenRouter(result, providerData);
    }
    return result;
  }

  try {
    const generation = await fetchOpenRouterGeneration(generationId, apiKey, baseUrl, signal);
    if (!generation) {
      if (!hasBillableTokenUsage(result.usage)) {
        return withMissingUsageMeteringForOpenRouter(result, providerData);
      }
      return result;
    }

    const enrichedUsage = {
      ...result.usage,
      inputTokens: generation.native_tokens_prompt ?? result.usage.inputTokens,
      outputTokens: generation.native_tokens_completion ?? result.usage.outputTokens,
      ...(generation.native_tokens_reasoning
        ? { reasoningTokens: generation.native_tokens_reasoning }
        : {}),
      ...(generation.native_tokens_cached
        ? { cacheReadTokens: generation.native_tokens_cached }
        : {}),
    };

    if (!hasBillableTokenUsage(enrichedUsage) && generation.total_cost <= 0) {
      return withMissingUsageMeteringForOpenRouter(result, {
        ...providerData,
        generationId,
        generation,
        enrichmentSource: "generation_api",
      });
    }

    return {
      ...result,
      usage: enrichedUsage,
      providerData: {
        ...providerData,
        generationId,
        reportedCostUsd: generation.total_cost,
        enrichmentSource: "generation_api",
        generation,
      },
    };
  } catch {
    if (!hasBillableTokenUsage(result.usage)) {
      return withMissingUsageMeteringForOpenRouter(result, providerData);
    }
    return result;
  }
}
