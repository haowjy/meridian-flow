/**
 * OpenRouter result enrichment tests: /generation fallback when stream usage omits cost.
 */
import { describe, expect, it, vi } from "vitest";
import { enrichOpenRouterResult } from "../enrich-result.js";
import * as generation from "../generation.js";

const BASE_URL = "https://openrouter.example/api/v1";

describe("enrichOpenRouterResult", () => {
  it("returns stream-reported cost without calling /generation", async () => {
    const fetchSpy = vi.spyOn(generation, "fetchOpenRouterGeneration");

    const result = await enrichOpenRouterResult(
      {
        content: [],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "openai/gpt-4o",
        provider: "openrouter",
        providerData: {
          generationId: "gen-stream",
          reportedCostUsd: 0.001,
          enrichmentSource: "stream_usage",
        },
      },
      "test-key",
      BASE_URL,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.providerData).toMatchObject({
      reportedCostUsd: 0.001,
      enrichmentSource: "stream_usage",
    });
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
      BASE_URL,
    );

    expect(fetchSpy).toHaveBeenCalledWith("gen-test-123", "test-key", BASE_URL, undefined);
    expect(result.providerData).toMatchObject({
      reportedCostUsd: 0.0042,
      enrichmentSource: "generation_api",
      generationId: "gen-test-123",
    });
    expect(result.usage.inputTokens).toBe(120);
    fetchSpy.mockRestore();
  });

  it("uses configured baseUrl for /generation", async () => {
    const fetchSpy = vi.spyOn(generation, "fetchOpenRouterGeneration").mockResolvedValue({
      id: "gen-custom-base",
      total_cost: 0.01,
      native_tokens_prompt: 5,
      native_tokens_completion: 5,
    });

    await enrichOpenRouterResult(
      {
        content: [],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "openai/gpt-4o",
        provider: "openrouter",
        providerData: { generationId: "gen-custom-base" },
      },
      "test-key",
      "https://custom.openrouter.test/v1/",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "gen-custom-base",
      "test-key",
      "https://custom.openrouter.test/v1/",
      undefined,
    );
    fetchSpy.mockRestore();
  });

  it("returns the original result when /generation throws", async () => {
    const fetchSpy = vi
      .spyOn(generation, "fetchOpenRouterGeneration")
      .mockRejectedValue(new Error("network timeout"));

    const original = {
      content: [{ type: "text" as const, text: "hello" }],
      toolCalls: [],
      finishReason: "end_turn" as const,
      usage: { inputTokens: 12, outputTokens: 8 },
      model: "openai/gpt-4o",
      provider: "openrouter",
      providerData: { generationId: "gen-fail" },
    };

    const result = await enrichOpenRouterResult(original, "test-key", BASE_URL);
    expect(result).toEqual(original);
    fetchSpy.mockRestore();
  });

  it("flags missing_usage when enrichment yields no cost and no tokens", async () => {
    const fetchSpy = vi.spyOn(generation, "fetchOpenRouterGeneration").mockResolvedValue(null);

    const result = await enrichOpenRouterResult(
      {
        content: [],
        toolCalls: [],
        finishReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
        model: "openai/gpt-4o",
        provider: "openrouter",
        providerData: { generationId: "gen-missing" },
      },
      "test-key",
      BASE_URL,
    );

    expect(result.providerData).toMatchObject({ meteringStatus: "missing_usage" });
    fetchSpy.mockRestore();
  });
});
