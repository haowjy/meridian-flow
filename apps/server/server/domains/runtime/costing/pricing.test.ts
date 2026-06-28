/**
 * Purpose: Tests deterministic pricing conversion and registry-sourced pinned rates.
 */
import { describe, expect, it } from "vitest";
import { extractPinnedRates, MODEL_REGISTRY } from "../gateway/config/registry.js";
import {
  computeModelCost,
  createDefaultModelTokenRateSource,
  createLayeredTokenRateSource,
  findModelTokenRate,
  MOCK_FIXTURE_TOKEN_RATES,
  meteredMillicreditsFromRaw,
} from "./pricing.js";

const REGISTRY_PINNED_RATES = extractPinnedRates(MODEL_REGISTRY);

/** Pre-B2 pinned values for production registry models — parity guard. */
const PRODUCTION_RATE_PARITY = {
  "anthropic::claude-sonnet-4-20250514": {
    inputUsdPerMillionTokens: "3.00",
    cachedInputUsdPerMillionTokens: "0.30",
    cacheWriteUsdPerMillionTokens: "3.75",
    outputUsdPerMillionTokens: "15.00",
  },
  "anthropic::claude-sonnet-4-6": {
    inputUsdPerMillionTokens: "3.00",
    cachedInputUsdPerMillionTokens: "0.30",
    cacheWriteUsdPerMillionTokens: "3.75",
    outputUsdPerMillionTokens: "15.00",
  },
  "anthropic::claude-haiku-4-5-20251001": {
    inputUsdPerMillionTokens: "1.00",
    cachedInputUsdPerMillionTokens: "0.10",
    cacheWriteUsdPerMillionTokens: "1.25",
    outputUsdPerMillionTokens: "5.00",
  },
  "anthropic::claude-3-5-haiku-latest": {
    inputUsdPerMillionTokens: "0.80",
    cachedInputUsdPerMillionTokens: "0.08",
    cacheWriteUsdPerMillionTokens: "1.00",
    outputUsdPerMillionTokens: "4.00",
  },
  "openai::gpt-4o": {
    inputUsdPerMillionTokens: "2.50",
    cachedInputUsdPerMillionTokens: "1.25",
    outputUsdPerMillionTokens: "10.00",
  },
  "openai::gpt-4.1": {
    inputUsdPerMillionTokens: "2.00",
    cachedInputUsdPerMillionTokens: "0.50",
    outputUsdPerMillionTokens: "8.00",
  },
  "openai::gpt-4.1-mini": {
    inputUsdPerMillionTokens: "0.40",
    cachedInputUsdPerMillionTokens: "0.10",
    outputUsdPerMillionTokens: "1.60",
  },
  "openai::gpt-4o-mini": {
    inputUsdPerMillionTokens: "0.15",
    cachedInputUsdPerMillionTokens: "0.075",
    outputUsdPerMillionTokens: "0.60",
  },
  "deepseek::deepseek-v4-flash": {
    inputUsdPerMillionTokens: "0.14",
    cachedInputUsdPerMillionTokens: "0.0028",
    outputUsdPerMillionTokens: "0.28",
  },
  "openrouter::anthropic/claude-sonnet-4": {
    inputUsdPerMillionTokens: "3.00",
    outputUsdPerMillionTokens: "15.00",
  },
  "openrouter::openai/gpt-4o": {
    inputUsdPerMillionTokens: "2.50",
    outputUsdPerMillionTokens: "10.00",
  },
  "openrouter::google/gemini-2.5-flash": {
    inputUsdPerMillionTokens: "0.15",
    outputUsdPerMillionTokens: "0.60",
  },
} as const;

describe("model pricing", () => {
  const rateSource = createDefaultModelTokenRateSource();

  it("applies the fixed cost multiplier when converting raw USD micros to metered millicredits", () => {
    // $0.10 raw = 100,000 USD micros. ceil(100,000 * 115 / 1000) = 11,500 millicredits ($0.115).
    expect(meteredMillicreditsFromRaw(100_000n)).toBe(11_500n);
    expect(meteredMillicreditsFromRaw(1n)).toBe(1n);
    expect(meteredMillicreditsFromRaw(0n)).toBe(0n);
  });

  it("computes millicredits deterministically from registry-pinned token rates", () => {
    const cost = computeModelCost({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      rateSource,
    });

    expect(cost.costUsd).toBe("0.420000");
    expect(cost.millicredits).toBe("48300");
    expect(cost.pricingSnapshot.source).toContain("pinned:");
    expect(cost.pricingSnapshot.sourceLayer).toBe("pinned");
  });

  it("uses OpenRouter providerData.reportedCostUsd when provider is openrouter", () => {
    const cost = computeModelCost({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
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
      model: "anthropic/claude-sonnet-4",
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
      model: "gpt-4o",
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

  it("falls back to pinned rates when provider-reported cost is absent", () => {
    const cost = computeModelCost({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      rateSource,
    });

    expect(cost.costUsd).toBe("3.000000");
    expect(cost.pricingSnapshot.sourceLayer).toBe("pinned");
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

  it("prices every production registry model for its provider entry", () => {
    for (const provider of MODEL_REGISTRY.providers) {
      for (const model of provider.models) {
        expect(() => findModelTokenRate(provider.id, model.id, rateSource)).not.toThrow();
      }
    }
  });

  it("matches previous pinned values for all production registry models", () => {
    for (const [key, expected] of Object.entries(PRODUCTION_RATE_PARITY)) {
      const [provider, model] = key.split("::");
      const rate = findModelTokenRate(provider, model, rateSource);
      expect(rate.inputUsdPerMillionTokens).toBe(expected.inputUsdPerMillionTokens);
      if ("cachedInputUsdPerMillionTokens" in expected) {
        expect(rate.cachedInputUsdPerMillionTokens).toBe(expected.cachedInputUsdPerMillionTokens);
      }
      if ("cacheWriteUsdPerMillionTokens" in expected) {
        expect(rate.cacheWriteUsdPerMillionTokens).toBe(expected.cacheWriteUsdPerMillionTokens);
      }
      expect(rate.outputUsdPerMillionTokens).toBe(expected.outputUsdPerMillionTokens);
    }
  });

  it("bills mock gateway fixtures at zero via the override layer", () => {
    const cost = computeModelCost({
      provider: "mock",
      model: "mock-llm-v1",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      rateSource,
    });

    expect(cost.costUsd).toBe("0.000000");
    expect(cost.millicredits).toBe("0");
    expect(cost.pricingSnapshot.sourceLayer).toBe("override");
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
          model: "deepseek-v4-flash",
          inputUsdPerMillionTokens: "99.00",
          outputUsdPerMillionTokens: "99.00",
          source: "test override",
        },
      ],
    });

    const rate = source.findRate("deepseek", "deepseek-v4-flash");
    expect(rate?.inputUsdPerMillionTokens).toBe("99.00");
    expect(rate?.sourceLayer).toBe("override");
  });

  it("exposes mock fixture rates only through the override layer", () => {
    const pinnedOnly = createLayeredTokenRateSource({
      pinnedRates: REGISTRY_PINNED_RATES.map((rate) => ({
        provider: rate.provider,
        model: rate.model,
        inputUsdPerMillionTokens: rate.inputUsdPerMillionTokens,
        cachedInputUsdPerMillionTokens: rate.cachedInputUsdPerMillionTokens,
        cacheWriteUsdPerMillionTokens: rate.cacheWriteUsdPerMillionTokens,
        outputUsdPerMillionTokens: rate.outputUsdPerMillionTokens,
        source: rate.source,
      })),
    });

    expect(pinnedOnly.findRate("mock", "mock-llm-v1")).toBeNull();

    const withFixtures = createLayeredTokenRateSource({
      pinnedRates: [],
      overrideRates: MOCK_FIXTURE_TOKEN_RATES,
    });
    expect(withFixtures.findRate("mock", "mock-llm-v1")?.outputUsdPerMillionTokens).toBe("0");
  });
});
