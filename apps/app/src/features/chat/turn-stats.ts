/** Per-assistant-turn usage summary for the turn info popover. */
import type { Turn } from "@meridian/contracts/protocol";

export type TurnStats = {
  model: string | null;
  callCount: number;
  outputTokens: number;
  inputTokens: number;
  cacheHitPercent: number | null;
  ttftMs: number | null;
  outputTokensPerSecond: number | null;
};

/** Summary of the model calls that produced one assistant turn. */
export function turnStats(turn: Turn): TurnStats {
  const responses = [...turn.responses].sort((a, b) => a.sequence - b.sequence);
  const inputTokens = responses.reduce((sum, response) => sum + response.inputTokens, 0);
  const outputTokens = responses.reduce((sum, response) => sum + response.outputTokens, 0);
  const cacheReadTokens = responses.reduce(
    (sum, response) => sum + (response.cacheReadTokens ?? 0),
    0,
  );
  let generationMs = 0;
  let generationOutputTokens = 0;
  let hasGenerationTime = false;
  for (const response of responses) {
    const ttft = response.timeToFirstTokenMs;
    if (response.latencyMs != null && ttft != null && response.latencyMs > ttft) {
      generationMs += response.latencyMs - ttft;
      generationOutputTokens += response.outputTokens;
      hasGenerationTime = true;
    }
  }
  const firstTtft = responses[0]?.timeToFirstTokenMs ?? null;
  return {
    model: responses[0]?.model ?? turn.model ?? null,
    callCount: responses.length,
    inputTokens,
    outputTokens,
    cacheHitPercent: inputTokens > 0 ? (cacheReadTokens / inputTokens) * 100 : null,
    ttftMs: firstTtft,
    outputTokensPerSecond:
      hasGenerationTime && generationMs > 0 ? (generationOutputTokens * 1000) / generationMs : null,
  };
}

export function compactCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}
