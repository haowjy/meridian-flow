/**
 * OpenRouter result enrichment: preserves provider-reported billing from stream
 * providerData or the /generation fallback. Provider-native token counters stay
 * in providerData because OpenRouter does not define their cache-subset shape.
 */
import { assertValidUsage } from "@meridian/contracts/runtime";
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
  assertValidUsage(result.usage);
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

  let generation: Awaited<ReturnType<typeof fetchOpenRouterGeneration>>;
  try {
    generation = await fetchOpenRouterGeneration(generationId, apiKey, baseUrl, signal);
  } catch {
    if (!hasBillableTokenUsage(result.usage)) {
      return withMissingUsageMeteringForOpenRouter(result, providerData);
    }
    return result;
  }

  if (!generation) {
    if (!hasBillableTokenUsage(result.usage)) {
      return withMissingUsageMeteringForOpenRouter(result, providerData);
    }
    return result;
  }

  return {
    ...result,
    providerData: {
      ...providerData,
      generationId,
      reportedCostUsd: generation.total_cost,
      enrichmentSource: "generation_api",
      generation,
    },
  };
}
