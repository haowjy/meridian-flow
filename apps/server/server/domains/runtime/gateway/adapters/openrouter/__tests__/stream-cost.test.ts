/**
 * OpenRouter stream-collect extensions: provider-reported cost and generation id.
 */
import { describe, expect, it } from "vitest";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "../../openai-compatible/stream-collect.js";

describe("OpenAI-compatible stream-collect OpenRouter fields", () => {
  it("captures usage.cost as estimatedCostUsd on the final GenerateResult", () => {
    const acc = createStreamAccumulator("openai/gpt-4o", "openrouter");
    for (const _event of eventsFromOpenAIChunk(
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

    const result = buildGenerateResult(acc);
    expect(result.usage.estimatedCostUsd).toBe(0.00125);
    expect(result.providerData).toEqual({ generationId: "gen-stream-1" });
  });
});
