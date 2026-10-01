/** Flattens per-attempt gateway timing into the persisted model-response fields. */
import type { ModelResponseReceivedRow } from "@meridian/contracts/threads";
import type { GenerateResult } from "../gateway/domain/index.js";

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
