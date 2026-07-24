/**
 * Purpose: Protect OpenRouter cost enrichment without guessing native token semantics.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerateResult } from "../../domain/index.js";
import { settleOpenRouterCancelledResult } from "./cancel-settlement.js";
import { enrichOpenRouterResult } from "./enrich-result.js";

const BASE_URL = "https://openrouter.example/api/v1";

function resultWithUsage(usage: GenerateResult["usage"]): GenerateResult {
  return {
    content: [],
    toolCalls: [],
    finishReason: "end_turn",
    usage,
    model: "anthropic/claude-sonnet-4",
    provider: "openrouter",
    providerData: { generationId: "gen-1" },
  };
}

function stubGenerationFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            id: "gen-1",
            total_cost: 0.0042,
            native_tokens_prompt: 111,
            native_tokens_cached: 1_792,
            native_tokens_completion: 74,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouter result enrichment", () => {
  it("preserves authoritative cost without treating ambiguous native counters as Usage", async () => {
    stubGenerationFetch();
    const result = await enrichOpenRouterResult(
      resultWithUsage({ inputTokens: 0, outputTokens: 0 }),
      "test-key",
      BASE_URL,
    );

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.providerData).toMatchObject({
      reportedCostUsd: 0.0042,
      enrichmentSource: "generation_api",
      generation: {
        native_tokens_prompt: 111,
        native_tokens_cached: 1_792,
        native_tokens_completion: 74,
      },
    });
  });

  it("preserves authoritative cost for a cancelled result with ambiguous native counters", async () => {
    stubGenerationFetch();
    const settlement = await settleOpenRouterCancelledResult({
      result: resultWithUsage({ inputTokens: 0, outputTokens: 0 }),
      model: "anthropic/claude-sonnet-4",
      provider: "openrouter",
      apiKey: "test-key",
      baseUrl: BASE_URL,
    });

    expect(settlement?.result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(settlement?.result.providerData).toMatchObject({
      reportedCostUsd: 0.0042,
      enrichmentSource: "generation_api",
    });
    expect(settlement?.persist).toBe(true);
  });

  it("rejects non-canonical usage instead of hiding the invariant violation", async () => {
    await expect(
      enrichOpenRouterResult(
        resultWithUsage({
          inputTokens: 111,
          outputTokens: 74,
          cacheReadTokens: 1_792,
        }),
        undefined,
        BASE_URL,
      ),
    ).rejects.toThrow("cacheReadTokens + cacheWriteTokens must not exceed inputTokens");
  });
});
