/** Tests provider/model routing decisions that protect multi-provider gateway ambiguity. */
import { describe, expect, it } from "vitest";
import type { ModelInfo, ProviderConfig, TraceSpan } from "./domain/index.js";
import type { ProviderAdapter } from "./ports/provider-adapter.js";
import { buildProviderRegistry, resolveRoute } from "./routing.js";

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

function provider(id: string, models: ModelInfo[]): ProviderConfig {
  return { id, adapter: "openai-compatible", models };
}

const adapter: ProviderAdapter = {
  providerId: "test",
  async *stream() {
    if (Math.random() < 0) yield undefined as never;
    throw new Error("not used");
  },
};

describe("buildProviderRegistry", () => {
  it("keeps the first configured provider for duplicate bare model IDs and warns", () => {
    const warnings: TraceSpan[] = [];
    const registry = buildProviderRegistry(
      [
        provider("first", [model("shared-model", "first")]),
        provider("second", [model("shared-model", "second")]),
      ],
      new Map([
        ["first", adapter],
        ["second", adapter],
      ]),
      { onWarning: (span) => warnings.push(span) },
    );

    expect(registry.modelsById.get("shared-model")?.providerId).toBe("first");
    expect(resolveRoute(registry, { model: "shared-model", messages: [] }).providerConfig.id).toBe(
      "first",
    );
    expect(warnings).toEqual([
      {
        name: "gateway.model_collision_skipped",
        attributes: {
          modelId: "shared-model",
          keptProviderId: "first",
          skippedProviderId: "second",
        },
      },
    ]);
  });
});

it("routes duplicate model IDs through an explicitly requested provider", () => {
  const registry = buildProviderRegistry(
    [
      provider("deepseek", [model("deepseek-v4-flash", "deepseek")]),
      provider("deepseek-openai", [model("deepseek-v4-flash", "deepseek-openai")]),
    ],
    new Map([
      ["deepseek", adapter],
      ["deepseek-openai", adapter],
    ]),
  );

  const route = resolveRoute(registry, {
    provider: "deepseek-openai",
    model: "deepseek-v4-flash",
    messages: [],
  });

  expect(route.providerConfig.id).toBe("deepseek-openai");
  expect(route.model.provider).toBe("deepseek-openai");
});
