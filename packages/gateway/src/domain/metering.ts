/**
 * Metering helpers on GenerateResult. `attempt-stream.ts` flags a cancelled stream
 * that ended without provider usage with `meteringStatus: "missing_usage"`.
 */
import type { GenerateResult } from "./types.js";

export function withMissingUsageMetering(result: GenerateResult): GenerateResult {
  return { ...result, meteringStatus: "missing_usage" };
}

export function hasBillableTokenUsage(usage: GenerateResult["usage"]): boolean {
  return usage.inputTokens > 0 || usage.outputTokens > 0;
}
