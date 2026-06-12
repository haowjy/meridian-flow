/**
 * Purpose: Tests deterministic pricing conversion and the billing contract that
 * every configured gateway model has an explicit pinned price.
 */
import { describe, expect, it } from "vitest";
import { computeModelCost, findModelTokenRate } from "./pricing.js";

describe("model pricing", () => {
  it("computes millicredits deterministically from pinned token rates", () => {
    const cost = computeModelCost({
      provider: "openai",
      model: "gpt-4.1-mini",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });

    expect(cost.costUsd).toBe("2.000000");
    expect(cost.millicredits).toBe("200000");
    expect(cost.pricingSnapshot.source).toContain("openai.com/api/pricing");
  });

  it("throws for unknown provider/model pairs instead of silently billing zero", () => {
    expect(() =>
      computeModelCost({
        provider: "openai",
        model: "missing-model",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toThrow(/No pinned token price/);
  });

  it("prices every production gateway model billing currently supports", () => {
    const supportedGatewayModels = [
      ["anthropic", "claude-sonnet-4-6"],
      ["anthropic", "claude-haiku-4-5-20251001"],
      ["openai", "gpt-4.1"],
      ["openai", "gpt-4.1-mini"],
      ["deepseek", "deepseek-v4-flash"],
    ] as const;

    for (const [provider, model] of supportedGatewayModels) {
      expect(() => findModelTokenRate(provider, model)).not.toThrow();
    }
  });
});
