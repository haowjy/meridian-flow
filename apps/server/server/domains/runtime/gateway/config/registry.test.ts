import { describe, expect, it } from "vitest";
import { MODEL_REGISTRY } from "./registry.js";

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
});
