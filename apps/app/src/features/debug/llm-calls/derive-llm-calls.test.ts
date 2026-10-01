import type { ModelResponse } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";

import { type LlmCallSummary, pairLlmCallResponses } from "./derive-llm-calls";

function call(gatewayCallId: string, model: string): LlmCallSummary {
  return {
    gatewayCallId,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastEventAt: "2026-01-01T00:00:01.000Z",
    provider: "test",
    model,
    outcome: "ok",
    threadId: "thread-1",
    turnId: "turn-1",
    lifecycleEvents: [],
    chunks: [],
    chunkCount: 0,
  };
}

function response(sequence: number, values: Partial<ModelResponse> = {}): ModelResponse {
  return {
    id: `response-${sequence}`,
    turnId: "turn-1",
    sequence,
    provider: "test",
    model: "model-a",
    inputTokens: 1000,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheReset: false,
    costUsd: null,
    latencyMs: null,
    requestStartedAt: null,
    timeToFirstTokenMs: null,
    generationMs: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    requestMessageCount: 1,
    predictedCacheState: "cold",
    predictedCacheReason: "uncached",
    ...values,
  };
}

describe("pairLlmCallResponses", () => {
  it("pairs calls with their turn response and flags observed cache mismatches", () => {
    const paired = pairLlmCallResponses(
      [call("warm-reset", "model-a"), call("cold-hit", "model-a")],
      {
        "turn-1": [
          response(0, {
            requestMessageCount: 1,
            predictedCacheState: "warm",
            predictedCacheReason: "reusable_prefix",
            cacheReadTokens: 100,
            cacheReset: true,
          }),
          response(1, {
            requestMessageCount: 1,
            predictedCacheState: "cold",
            predictedCacheReason: "uncached",
            cacheReadTokens: 700,
          }),
        ],
      },
    );

    expect(paired.get("warm-reset")).toMatchObject({
      response: { sequence: 0 },
      predictedState: "warm",
      predictedReason: "reusable_prefix",
      mismatch: true,
    });
    expect(paired.get("cold-hit")).toMatchObject({
      response: { sequence: 1 },
      predictedState: "cold",
      predictedReason: "uncached",
      cacheHitPercent: 70,
      mismatch: true,
    });
  });

  it("keeps uncached cold predictions paired without calling a missing cache read a mismatch", () => {
    const paired = pairLlmCallResponses([call("uncached", "model-a")], {
      "turn-1": [
        response(0, {
          cacheReadTokens: null,
          requestMessageCount: 1,
          predictedCacheState: "cold",
          predictedCacheReason: "uncached",
        }),
      ],
    });

    expect(paired.get("uncached")).toMatchObject({
      predictedState: "cold",
      predictedReason: "uncached",
      cacheHitPercent: null,
      mismatch: false,
    });
  });
});
