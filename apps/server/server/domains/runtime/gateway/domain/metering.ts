/**
 * Metering helpers on GenerateResult. Providers flag unmetered cancelled streams
 * with `meteringStatus: "missing_usage"`.
 */
import type { GenerateResult } from "./types.js";

export function withMissingUsageMetering(result: GenerateResult): GenerateResult {
  return { ...result, meteringStatus: "missing_usage" };
}

export function hasBillableTokenUsage(usage: GenerateResult["usage"]): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}
