/**
 * Purpose: Tests deterministic pricing conversion and registry-sourced pinned rates.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Gateway price-source precedence and missing-price refusal (kb/decisions/auth-billing/gateway-registry-pricing.md)
 */
import { describe, expect, it } from "vitest";
import { mapUsage as mapAnthropicUsage } from "../gateway/adapters/anthropic/stream-collect.js";
import { mapUsage as mapOpenAIUsage } from "../gateway/adapters/openai/stream-collect.js";
import { extractPinnedRates, MODEL_REGISTRY } from "../gateway/config/registry.js";
import {
  computeModelCost,
  createDefaultModelTokenRateSource,
  createLayeredTokenRateSource,
} from "./pricing.js";

const REGISTRY_PINNED_RATES = extractPinnedRates(MODEL_REGISTRY);

describe("model pricing", () => {
  const rateSource = createDefaultModelTokenRateSource();

  it("prices Anthropic cache writes by the TTL written: 5m at 1.25x input, 1h at 2x", () => {
    const price = (usage: { cacheWriteTokens: number; cacheWriteLongTokens?: number }) =>
      computeModelCost({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 1_000_000, outputTokens: 0, ...usage },
        rateSource,
      });

    expect(price({ cacheWriteTokens: 1_000_000 }).costUsd).toBe("2.500000");
    expect(price({ cacheWriteTokens: 1_000_000, cacheWriteLongTokens: 1_000_000 }).costUsd).toBe(
      "4.000000",
    );
    expect(price({ cacheWriteTokens: 1_000_000, cacheWriteLongTokens: 400_000 }).costUsd).toBe(
      "3.100000",
    );
  });

  it("prices OpenAI's inclusive cache counters without double-counting input", () => {
    const usage = mapOpenAIUsage({
      input_tokens: 1_903,
      input_tokens_details: { cached_tokens: 1_792 },
      output_tokens: 74,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1_977,
    });

    expect(usage).toEqual({
      inputTokens: 1_903,
      outputTokens: 74,
      cacheReadTokens: 1_792,
    });
    expect(
      computeModelCost({
        provider: "deepseek",
        model: "deepseek-flash",
        usage,
        rateSource,
      }),
    ).toMatchObject({
      costUsd: "0.000131",
      millicredits: "16",
    });
  });

  it("prices the complete MR3 Anthropic usage sample without dropping uncached input", () => {
    const nativeUsages = [
      [111, 1_792, 74],
      [142, 1_920, 89],
      [125, 2_048, 1_648],
      [164, 3_712, 107],
      [86, 3_968, 76],
      [47, 4_096, 1_523],
      [5_804, 0, 83],
      [256, 5_632, 1_539],
      [864, 7_424, 295],
    ] as const;

    const costs = nativeUsages.map(([inputTokens, cacheReadTokens, outputTokens]) =>
      computeModelCost({
        provider: "deepseek",
        model: "deepseek-flash",
        usage: mapAnthropicUsage({
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: 0,
          output_tokens_details: null,
        } as Parameters<typeof mapAnthropicUsage>[0]),
        rateSource,
      }),
    );

    const totalUsdMicros = costs.reduce(
      (total, cost) => total + BigInt(cost.costUsd.replace(".", "")),
      0n,
    );
    const totalMillicredits = costs.reduce((total, cost) => total + BigInt(cost.millicredits), 0n);
    expect(totalUsdMicros).toBe(8_971n);
    expect(totalMillicredits).toBe(1_035n);
  });

  it("retains Anthropic input categories when the terminal delta only updates output", () => {
    const initial = mapAnthropicUsage({
      input_tokens: 111,
      output_tokens: 1,
      cache_read_input_tokens: 1_792,
      cache_creation_input_tokens: 0,
      output_tokens_details: null,
    } as Parameters<typeof mapAnthropicUsage>[0]);
    const terminal = mapAnthropicUsage(
      {
        input_tokens: null,
        output_tokens: 74,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        output_tokens_details: null,
      } as Parameters<typeof mapAnthropicUsage>[0],
      initial,
    );

    expect(terminal).toEqual({
      inputTokens: 1_903,
      outputTokens: 74,
      cacheReadTokens: 1_792,
    });
  });

  it("rejects cache counters that exceed the canonical inclusive input total", () => {
    expect(() =>
      computeModelCost({
        provider: "deepseek",
        model: "deepseek-flash",
        usage: {
          inputTokens: 111,
          outputTokens: 74,
          cacheReadTokens: 1_792,
        },
        rateSource,
      }),
    ).toThrow(
      "Usage invariant violated: cacheReadTokens + cacheWriteTokens must not exceed inputTokens",
    );
  });

  it("uses OpenRouter providerData.reportedCostUsd when provider is openrouter", () => {
    const cost = computeModelCost({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      usage: { inputTokens: 0, outputTokens: 0 },
      providerData: { reportedCostUsd: 0.0042, enrichmentSource: "stream_usage" },
      rateSource,
    });

    expect(cost.costUsd).toBe("0.004200");
    expect(cost.millicredits).toBe("483");
    expect(cost.priceSource).toBe("provider_reported");
    expect(cost.pricingSnapshot.sourceLayer).toBe("provider_reported");
    expect(cost.pricingSnapshot.source).toBe("provider_reported");
  });

  it("ignores providerData.reportedCostUsd for non-openrouter providers", () => {
    const cost = computeModelCost({
      provider: "stub",
      model: "stub-model",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      providerData: { reportedCostUsd: 0.0042 },
      rateSource,
    });

    expect(cost.costUsd).toBe("0.000000");
    expect(cost.priceSource).toBe("computed");
    expect(cost.pricingSnapshot.sourceLayer).toBe("override");
  });

  it("surfaces missing_usage instead of silently billing zero for openrouter", () => {
    const cost = computeModelCost({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
      usage: { inputTokens: 0, outputTokens: 0 },
      providerData: { meteringStatus: "missing_usage", generationId: "gen-missing" },
      rateSource,
    });

    expect(cost.costUsd).toBe("0.000000");
    expect(cost.priceSource).toBe("unknown");
    expect(cost.pricingSnapshot.usageMeteringStatus).toBe("missing_usage");
  });

  it("surfaces missing_usage for aborted OpenAI partial streams without usage", () => {
    const cost = computeModelCost({
      provider: "openai",
      model: "gpt-6.1-sol",
      usage: { inputTokens: 0, outputTokens: 0 },
      providerData: { meteringStatus: "missing_usage" },
      rateSource,
    });

    expect(cost.costUsd).toBe("0.000000");
    expect(cost.millicredits).toBe("0");
    expect(cost.priceSource).toBe("unknown");
    expect(cost.pricingSnapshot.usageMeteringStatus).toBe("missing_usage");
    expect(cost.pricingSnapshot.sourceDetail).toBe("openai.meteringStatus.missing_usage");
  });

  it("throws for unknown provider/model pairs instead of silently billing zero", () => {
    expect(() =>
      computeModelCost({
        provider: "openai",
        model: "missing-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        rateSource,
      }),
    ).toThrow(/No pinned token price/);
  });

  it("prefers override rates over pinned rates for the same provider/model key", () => {
    const source = createLayeredTokenRateSource({
      pinnedRates: REGISTRY_PINNED_RATES.map((rate) => ({
        provider: rate.provider,
        model: rate.model,
        inputUsdPerMillionTokens: rate.inputUsdPerMillionTokens,
        cachedInputUsdPerMillionTokens: rate.cachedInputUsdPerMillionTokens,
        cacheWriteUsdPerMillionTokens: rate.cacheWriteUsdPerMillionTokens,
        outputUsdPerMillionTokens: rate.outputUsdPerMillionTokens,
        source: rate.source,
      })),
      overrideRates: [
        {
          provider: "deepseek",
          model: "deepseek-flash",
          inputUsdPerMillionTokens: "99.00",
          outputUsdPerMillionTokens: "99.00",
          source: "test override",
        },
      ],
    });

    const rate = source.findRate("deepseek", "deepseek-flash");
    expect(rate?.inputUsdPerMillionTokens).toBe("99.00");
    expect(rate?.sourceLayer).toBe("override");
  });
});
