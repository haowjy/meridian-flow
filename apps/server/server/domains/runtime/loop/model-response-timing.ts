import type { ModelResponseReceivedRow } from "@meridian/contracts/threads";
import type { GenerateResult } from "@meridian-flow/runtime/gateway";

export function modelResponseTimingFields(
  result: Pick<GenerateResult, "timing">,
): Pick<
  ModelResponseReceivedRow,
  "requestStartedAt" | "latencyMs" | "timeToFirstTokenMs" | "generationMs"
> {
  return {
    requestStartedAt: result.timing?.requestStartedAt ?? null,
    latencyMs: result.timing?.latencyMs ?? null,
    timeToFirstTokenMs: result.timing?.timeToFirstTokenMs ?? null,
    generationMs: result.timing?.generationMs ?? null,
  };
}
