/**
 * Purpose: Protect canonical usage collection from OpenAI-compatible terminal chunks.
 */
import { describe, expect, it } from "vitest";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromOpenAIChunk,
} from "./stream-collect.js";

describe("OpenAI-compatible stream usage", () => {
  it("collects canonical usage from a terminal usage-only chunk", () => {
    const acc = createStreamAccumulator("deepseek-chat", "deepseek");
    const events = [
      ...eventsFromOpenAIChunk(
        {
          choices: [],
          usage: {
            prompt_tokens: 1_903,
            completion_tokens: 74,
            prompt_tokens_details: { cached_tokens: 1_792 },
          },
        },
        acc,
      ),
    ];

    const usage = {
      inputTokens: 1_903,
      outputTokens: 74,
      cacheReadTokens: 1_792,
    };
    expect(events).toEqual([{ type: "usage", usage }]);
    expect(buildGenerateResult(acc).usage).toEqual(usage);
  });

  it("rejects invalid cache subsets even when usage arrives without a choice", () => {
    const acc = createStreamAccumulator("deepseek-chat", "deepseek");

    expect(() => [
      ...eventsFromOpenAIChunk(
        {
          choices: [],
          usage: {
            prompt_tokens: 111,
            completion_tokens: 74,
            prompt_tokens_details: { cached_tokens: 1_792 },
          },
        },
        acc,
      ),
    ]).toThrow("cacheReadTokens + cacheWriteTokens must not exceed inputTokens");
  });
});
