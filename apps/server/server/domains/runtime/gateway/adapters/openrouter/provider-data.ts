/**
 * OpenRouter provider metadata carried on GenerateResult.providerData.
 * Billing reads reportedCostUsd structurally (provider === openrouter only).
 */
import type { OpenRouterGenerationRecord } from "./generation.js";

export interface OpenRouterProviderData {
  generationId?: string;
  /** Authoritative USD cost from OpenRouter stream usage or /generation. */
  reportedCostUsd?: number;
  enrichmentSource?: "stream_usage" | "generation_api";
  /** Set when enrichment could not recover cost or token usage for billing. */
  meteringStatus?: "missing_usage";
  generation?: OpenRouterGenerationRecord;
}

export function readOpenRouterProviderData(providerData: unknown): OpenRouterProviderData {
  if (!providerData || typeof providerData !== "object") {
    return {};
  }
  return providerData as OpenRouterProviderData;
}

export function readOpenRouterGenerationId(providerData: unknown): string | undefined {
  return readOpenRouterProviderData(providerData).generationId;
}
