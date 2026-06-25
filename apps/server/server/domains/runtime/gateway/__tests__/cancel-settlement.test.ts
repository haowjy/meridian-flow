/**
 * Gateway cancelled-settlement tests: provider-neutral callers receive the same
 * persist/reconcile decision without importing provider-specific helpers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRouterGeneration } from "../adapters/openrouter/generation.js";
import { createGateway } from "../create-gateway.js";
import type { GenerateResult, ModelInfo, ProviderConfig } from "../domain/index.js";

vi.mock("../adapters/openrouter/generation.js", () => ({
  fetchOpenRouterGeneration: vi.fn(),
}));

function model(id: string, provider: string): ModelInfo {
  return {
    id,
    provider,
    displayName: id,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    capabilities: new Set(["streaming"]),
  };
}

function gatewayFor(provider: ProviderConfig) {
  const defaultModel = provider.models[0]?.id;
  return createGateway({
    providers: [provider],
    retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1 },
    ...(defaultModel ? { defaultModel } : {}),
  });
}

function cancelledResult(overrides: Partial<GenerateResult> = {}): GenerateResult {
  return {
    content: [],
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    model: "gpt-4.1-mini",
    provider: "openai",
    ...overrides,
  };
}

describe("gateway cancelled settlement", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("persists generic cancelled results that include token usage", async () => {
    const gateway = gatewayFor({
      id: "openai",
      adapter: "openai-compatible",
      models: [model("gpt-4.1-mini", "openai")],
    });
    const result = cancelledResult({ usage: { inputTokens: 10, outputTokens: 5 } });

    const settlement = await gateway.settleCancelledResult?.({ result, model: result.model });

    expect(settlement).toEqual({ result, persist: true });
  });

  it("skips generic zero-usage cancelled results", async () => {
    const gateway = gatewayFor({
      id: "openai",
      adapter: "openai-compatible",
      models: [model("gpt-4.1-mini", "openai")],
    });

    const settlement = await gateway.settleCancelledResult?.({
      result: cancelledResult(),
      model: "gpt-4.1-mini",
    });

    expect(settlement).toBeNull();
  });

  it("settles OpenRouter hard-cancel results through the provider config", async () => {
    vi.mocked(fetchOpenRouterGeneration).mockResolvedValue({
      id: "gen-hard-cancel",
      total_cost: 0.25,
      native_tokens_prompt: 1000,
      native_tokens_completion: 500,
    });
    const gateway = gatewayFor({
      id: "openrouter",
      adapter: "openrouter",
      baseUrl: "https://openrouter.example/api/v1",
      auth: { apiKey: "test-openrouter-key" },
      models: [model("openai/gpt-4o", "openrouter")],
    });

    const settlement = await gateway.settleCancelledResult?.({
      result: cancelledResult({
        model: "openai/gpt-4o",
        provider: "openrouter",
        providerData: { generationId: "gen-hard-cancel" },
      }),
      model: "openai/gpt-4o",
    });

    expect(fetchOpenRouterGeneration).toHaveBeenCalledWith(
      "gen-hard-cancel",
      "test-openrouter-key",
      "https://openrouter.example/api/v1",
      expect.any(AbortSignal),
    );
    expect(settlement?.persist).toBe(true);
    expect(settlement?.result.providerRequestId).toBe("gen-hard-cancel");
    expect(settlement?.result.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500 });
    expect(settlement?.result.providerData).toMatchObject({
      reportedCostUsd: 0.25,
      enrichmentSource: "generation_api",
    });
  });
});
