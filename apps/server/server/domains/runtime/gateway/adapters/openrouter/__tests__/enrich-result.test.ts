/**
 * OpenRouter result enrichment tests: /generation fallback when stream usage omits cost.
 */
import { describe, expect, it, vi } from "vitest";
import { enrichOpenRouterResult } from "../enrich-result.js";
import * as generation from "../generation.js";

describe("enrichOpenRouterResult", () => {
  it("returns stream-reported cost without calling /generation", async () => {
    const fetchSpy = vi.spyOn(generation, "fetchOpenRouterGeneration");

    const result = await enrichOpenRouterResult(
      {
        content: [],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 },
        model: "openai/gpt-4o",
        provider: "openrouter",
        providerData: { generationId: "gen-stream" },
      },
      "test-key",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.usage.estimatedCostUsd).toBe(0.001);
    fetchSpy.mockRestore();
  });

  it("fetches /generation when cost is missing but generation id is present", async () => {
    const fetchSpy = vi.spyOn(generation, "fetchOpenRouterGeneration").mockResolvedValue({
      id: "gen-test-123",
      total_cost: 0.0042,
      native_tokens_prompt: 120,
      native_tokens_completion: 45,
    });

    const result = await enrichOpenRouterResult(
      {
        content: [],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "openai/gpt-4o",
        provider: "openrouter",
        providerData: { generationId: "gen-test-123" },
      },
      "test-key",
    );

    expect(fetchSpy).toHaveBeenCalledWith("gen-test-123", "test-key", undefined);
    expect(result.usage.estimatedCostUsd).toBe(0.0042);
    expect(result.usage.inputTokens).toBe(120);
    expect(result.providerData).toMatchObject({
      enrichmentSource: "generation_api",
      generationId: "gen-test-123",
    });
    fetchSpy.mockRestore();
  });
});
