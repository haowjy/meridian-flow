/** Tests the layered token-rate source that resolves pinned and override rates. */
import { describe, expect, it } from "vitest";
import { computeModelCost, createLayeredTokenRateSource, type ModelTokenRate } from "./pricing.js";

const pinnedRate: ModelTokenRate = {
  provider: "openai",
  model: "gpt-pinned",
  inputUsdPerMillionTokens: "10.00",
  outputUsdPerMillionTokens: "20.00",
  source: "legacy pinned",
};

describe("createLayeredTokenRateSource", () => {
  it("returns pinned rates for configured provider/model pairs", () => {
    const source = createLayeredTokenRateSource({
      pinnedRates: [pinnedRate],
    });

    expect(source.findRate("OPENAI", "GPT-PINNED")).toMatchObject({
      inputUsdPerMillionTokens: "10.00",
      source: "legacy pinned",
      sourceLayer: "pinned",
    });
  });

  it("prefers override rates over pinned rates", () => {
    const source = createLayeredTokenRateSource({
      pinnedRates: [pinnedRate],
      overrideRates: [
        {
          ...pinnedRate,
          inputUsdPerMillionTokens: "0",
          outputUsdPerMillionTokens: "0",
          source: "override",
        },
      ],
    });

    expect(source.findRate("openai", "gpt-pinned")).toMatchObject({
      inputUsdPerMillionTokens: "0",
      sourceLayer: "override",
    });
  });

  it("returns null instead of throwing for unpriced provider/model pairs", () => {
    const source = createLayeredTokenRateSource({ pinnedRates: [] });
    expect(source.findRate("openai", "missing")).toBeNull();
  });

  it("records the selected pricing layer in computed snapshots", () => {
    const source = createLayeredTokenRateSource({
      pinnedRates: [
        {
          provider: "openai",
          model: "gpt-catalog",
          inputUsdPerMillionTokens: "1.00",
          outputUsdPerMillionTokens: "2.00",
          source: "pinned test",
        },
      ],
    });

    const cost = computeModelCost({
      provider: "openai",
      model: "gpt-catalog",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      rateSource: source,
    });

    expect(cost).toMatchObject({
      costUsd: "3.000000",
      pricingSnapshot: { sourceLayer: "pinned" },
    });
  });
});
