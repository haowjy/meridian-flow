/**
 * Provider-agnostic metering metadata on GenerateResult.providerData.
 * Providers flag unmetered cancelled streams with it.
 */
import type { GenerateResult } from "./types.js";

export function readMeteringStatus(providerData: unknown): "missing_usage" | undefined {
  if (!providerData || typeof providerData !== "object") return undefined;
  const status = (providerData as Record<string, unknown>).meteringStatus;
  return status === "missing_usage" ? "missing_usage" : undefined;
}

export function withMissingUsageMetering(result: GenerateResult): GenerateResult {
  const existing =
    result.providerData && typeof result.providerData === "object"
      ? (result.providerData as Record<string, unknown>)
      : {};
  return {
    ...result,
    providerData: {
      ...existing,
      meteringStatus: "missing_usage",
    },
  };
}

export function hasBillableTokenUsage(usage: GenerateResult["usage"]): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}
