/**
 * OpenRouter stream extensions on top of the generic openai-compatible collector.
 * Provider-reported cost and generation id stay in providerData — not on Usage.
 */
import type { GenerateResult, StreamEvent } from "../../domain/index.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "../openai-compatible/stream-collect.js";
import { type OpenRouterProviderData, readOpenRouterProviderData } from "./provider-data.js";

export type OpenRouterStreamAccumulator = ReturnType<typeof createStreamAccumulator> & {
  reportedCostUsd?: number;
  generationId?: string;
};

export function createOpenRouterStreamAccumulator(
  model: string,
  provider: string,
): OpenRouterStreamAccumulator {
  return createStreamAccumulator(model, provider);
}

export function* eventsFromOpenRouterChunk(
  chunk: Parameters<typeof eventsFromOpenAIChunk>[0] & {
    usage?:
      | ({ cost?: number } & NonNullable<Parameters<typeof eventsFromOpenAIChunk>[0]["usage"]>)
      | null;
  },
  acc: OpenRouterStreamAccumulator,
): Generator<StreamEvent> {
  if (chunk.id && !acc.generationId) {
    acc.generationId = chunk.id;
  }
  if (typeof chunk.usage?.cost === "number") {
    acc.reportedCostUsd = chunk.usage.cost;
  }
  yield* eventsFromOpenAIChunk(chunk, acc);
}

export function buildOpenRouterGenerateResult(acc: OpenRouterStreamAccumulator): GenerateResult {
  const result = buildGenerateResult(acc);
  const providerData: OpenRouterProviderData = {
    ...readOpenRouterProviderData(result.providerData),
  };
  if (acc.generationId) {
    providerData.generationId = acc.generationId;
  }
  if (acc.reportedCostUsd !== undefined) {
    providerData.reportedCostUsd = acc.reportedCostUsd;
    providerData.enrichmentSource = providerData.enrichmentSource ?? "stream_usage";
  }
  const hasProviderData =
    providerData.generationId !== undefined ||
    providerData.reportedCostUsd !== undefined ||
    providerData.enrichmentSource !== undefined ||
    providerData.meteringStatus !== undefined ||
    providerData.generation !== undefined;
  return {
    ...result,
    providerData: hasProviderData ? providerData : undefined,
  };
}
