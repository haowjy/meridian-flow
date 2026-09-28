import { describe, expect, it } from "vitest";
import {
  buildFromRegistry,
  MODEL_REGISTRY,
  type ModelRegistry,
  validateModelRegistry,
} from "./registry.js";

function registeredModel(id: string) {
  const model = MODEL_REGISTRY.providers
    .flatMap((provider) => provider.models)
    .find((entry) => entry.id === id);
  if (!model) throw new Error(`Missing registry model: ${id}`);
  return model;
}

describe("model prompt-cache descriptors", () => {
  it("declares cache kind and TTL per model", () => {
    expect(registeredModel("claude-sonnet-4-20250514").promptCache).toEqual({
      kind: "explicit",
      ttlMs: 60 * 60 * 1_000,
    });
    expect(registeredModel("gpt-4.1").promptCache).toEqual({
      kind: "automatic",
      ttlMs: 5 * 60 * 1_000,
    });
    expect(registeredModel("deepseek-v4-flash").promptCache).toEqual({
      kind: "automatic",
      ttlMs: 60 * 60 * 1_000,
    });
    expect(registeredModel("openai/gpt-4o").promptCache).toEqual({ kind: "none", ttlMs: null });
    expect(registeredModel("google/gemini-2.5-flash").promptCache).toEqual({
      kind: "none",
      ttlMs: null,
    });
  });

  it("never exposes prompt caching as a general capability", () => {
    for (const provider of MODEL_REGISTRY.providers) {
      for (const model of provider.models) {
        expect(model.capabilities).not.toContain("caching");
      }
    }
  });

  it("validates explicit TTLs when loading or building a registry", () => {
    const explicit = registeredModel("claude-sonnet-4-20250514");
    const invalid: ModelRegistry = {
      defaultModel: MODEL_REGISTRY.defaultModel,
      providers: [
        {
          ...MODEL_REGISTRY.providers[0],
          models: [{ ...explicit, promptCache: { kind: "explicit", ttlMs: 1 } }],
        },
      ],
    };
    expect(() => buildFromRegistry(invalid, {})).toThrow(
      "Explicit prompt cache TTL for claude-sonnet-4-20250514 must be 5 minutes or 1 hour",
    );

    expect(() =>
      validateModelRegistry({
        defaultModel: explicit.id,
        providers: [
          {
            ...MODEL_REGISTRY.providers[0],
            models: [{ ...explicit, promptCache: { kind: "explicit", ttlMs: 5 * 60 * 1_000 } }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("prices explicit cache writes at the tier declared by each TTL", () => {
    const explicitModels = MODEL_REGISTRY.providers
      .flatMap((provider) => provider.models)
      .filter((model) => model.promptCache.kind === "explicit");
    expect(explicitModels.length).toBeGreaterThan(0);

    for (const model of explicitModels) {
      const expectedMultiplier = model.promptCache.ttlMs === 5 * 60 * 1_000 ? 1.25 : 2;
      expect(model.pricing.cacheWriteUsdPerMillionTokens).toBeDefined();
      expect(Number(model.pricing.cacheWriteUsdPerMillionTokens)).toBe(
        Number(model.pricing.inputUsdPerMillionTokens) * expectedMultiplier,
      );
    }
  });
});

describe("model tokenizer families", () => {
  it("requires and carries each model's declared family, including OpenRouter models", () => {
    const registered = MODEL_REGISTRY.providers.flatMap((provider) => provider.models);
    const built = buildFromRegistry(MODEL_REGISTRY, {
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      DEEPSEEK_API_KEY: "deepseek-key",
      OPENROUTER_API_KEY: "openrouter-key",
    });
    const resolved = built.providers.flatMap((provider) => provider.models);

    expect(registered.every((model) => model.tokenizer.length > 0)).toBe(true);
    expect(resolved.map(({ id, tokenizer }) => [id, tokenizer])).toEqual(
      registered.map(({ id, tokenizer }) => [id, tokenizer]),
    );
    expect(registered.find((model) => model.id === "anthropic/claude-sonnet-4")?.tokenizer).toBe(
      "anthropic",
    );
    expect(registered.find((model) => model.id === "google/gemini-2.5-flash")?.tokenizer).toBe(
      "gemini",
    );
  });
});

describe("input pricing tiers", () => {
  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    200_000,
    300_000,
  ])("rejects invalid tier %s", (inputTierTokens) => {
    const model = registeredModel("claude-sonnet-4-20250514");
    expect(() =>
      validateModelRegistry({
        defaultModel: model.id,
        providers: [
          {
            ...MODEL_REGISTRY.providers[0],
            models: [{ ...model, pricing: { ...model.pricing, inputTierTokens } }],
          },
        ],
      }),
    ).toThrow("must be positive and below its context window");
  });
  it("carries the tier to the resolved model", () => {
    const model = registeredModel("claude-sonnet-4-20250514");
    const built = buildFromRegistry(
      {
        defaultModel: model.id,
        providers: [
          {
            ...MODEL_REGISTRY.providers[0],
            models: [{ ...model, pricing: { ...model.pricing, inputTierTokens: 100_000 } }],
          },
        ],
      },
      { ANTHROPIC_API_KEY: "real-key" },
    );
    expect(built.providers[0]?.models[0]?.inputTierTokens).toBe(100_000);
  });
});
