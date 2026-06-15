/**
 * OpenRouter stream-collect extensions: provider-reported cost and generation id.
 */
import { describe, expect, it } from "vitest";
import {
  buildOpenRouterGenerateResult,
  createOpenRouterStreamAccumulator,
  eventsFromOpenRouterChunk,
} from "../stream-collect.js";

describe("OpenRouter stream-collect", () => {
  it("captures usage.cost as reportedCostUsd on providerData", () => {
    const acc = createOpenRouterStreamAccumulator("openai/gpt-4o", "openrouter");
    for (const _event of eventsFromOpenRouterChunk(
      {
        id: "gen-stream-1",
        choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          cost: 0.00125,
        },
      },
      acc,
    )) {
      // drain generator
    }

    const result = buildOpenRouterGenerateResult(acc);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.providerData).toMatchObject({
      generationId: "gen-stream-1",
      reportedCostUsd: 0.00125,
      enrichmentSource: "stream_usage",
    });
  });
});
