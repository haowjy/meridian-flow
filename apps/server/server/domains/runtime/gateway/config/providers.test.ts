import { describe, expect, it } from "vitest";
import { buildProviderConfigs } from "./providers.js";

describe("buildProviderConfigs", () => {
  it("enables a real provider key when MODEL_PROVIDER is unset", () => {
    const config = buildProviderConfigs({ DEEPSEEK_API_KEY: "sk-deepseek-real" });

    expect(config.providers.map((provider) => provider.id)).toEqual(["deepseek"]);
    expect(config.defaultModel).toBe("deepseek-v4-flash");
  });

  it("treats MODEL_PROVIDER=mock as the explicit mock switch", () => {
    const config = buildProviderConfigs({
      MODEL_PROVIDER: "mock",
      DEEPSEEK_API_KEY: "sk-deepseek-real",
    });

    expect(config.providers).toEqual([]);
    expect(config.defaultModel).toBeUndefined();
  });

  it("does not treat legacy MODEL_PROVIDER values as provider selection", () => {
    const config = buildProviderConfigs({
      MODEL_PROVIDER: "auto",
      DEEPSEEK_API_KEY: "sk-deepseek-real",
    });

    expect(config.providers.map((provider) => provider.id)).toEqual(["deepseek"]);
    expect(config.defaultModel).toBe("deepseek-v4-flash");
  });

  it("keeps placeholder keys on the mock fallback path", () => {
    const config = buildProviderConfigs({ DEEPSEEK_API_KEY: "dev-deepseek-key" });

    expect(config.providers).toEqual([]);
    expect(config.defaultModel).toBeUndefined();
  });
});
