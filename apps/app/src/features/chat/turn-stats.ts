/** Per-assistant-turn usage summary for the turn info popover. */
import type { Turn } from "@meridian/contracts/protocol";

export type TurnStats = {
  model: string | null;
  callCount: number;
  outputTokens: number;
  inputTokens: number;
  cacheReportedInputTokens: number;
  cacheReportedCalls: number;
  cacheHitPercent: number | null;
  cacheResets: number;
  ttftMs: number | null;
  outputTokensPerSecond: number | null;
};

/** Token-weighted prompt cache hit rate. Cache writes are already misses within input tokens. */
export function cacheHitPercent(read: number, input: number): number | null {
  return input > 0 ? (read / input) * 100 : null;
}

/** Summary of the model calls that produced one assistant turn. */
export function turnStats(turn: Turn): TurnStats {
  const responses = [...turn.responses].sort((a, b) => a.sequence - b.sequence);
  const inputTokens = responses.reduce((sum, response) => sum + response.inputTokens, 0);
  const outputTokens = responses.reduce((sum, response) => sum + response.outputTokens, 0);
  const cacheReadTokens = responses.reduce(
    (sum, response) => sum + (response.cacheReadTokens ?? 0),
    0,
  );
  const cacheReportedResponses = responses.filter((response) => response.cacheReadTokens != null);
  const cacheReportedInputTokens = cacheReportedResponses.reduce(
    (sum, response) => sum + response.inputTokens,
    0,
  );
  const cacheResets = responses.filter((response) => response.cacheReset === true).length;
  // Speed counts only calls whose generation window the server measured, so
  // tokens and time come from the same set of calls.
  let generationMs = 0;
  let generationOutputTokens = 0;
  for (const response of responses) {
    if (response.generationMs == null || response.generationMs <= 0) continue;
    generationMs += response.generationMs;
    generationOutputTokens += response.outputTokens;
  }
  const firstTtft = responses[0]?.timeToFirstTokenMs ?? null;
  return {
    model: responses[0]?.model ?? turn.model ?? null,
    callCount: responses.length,
    inputTokens,
    cacheReportedInputTokens,
    cacheReportedCalls: cacheReportedResponses.length,
    outputTokens,
    cacheHitPercent: cacheHitPercent(cacheReadTokens, cacheReportedInputTokens),
    cacheResets,
    ttftMs: firstTtft,
    outputTokensPerSecond: generationMs > 0 ? (generationOutputTokens * 1000) / generationMs : null,
  };
}

export function compactCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
