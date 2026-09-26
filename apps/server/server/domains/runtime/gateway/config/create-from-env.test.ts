/** The model retained by Agent bindings must match the gateway's actual configured default. */
import { describe, expect, it } from "vitest";
import { createGatewayFromEnv } from "./create-from-env.js";
import { buildProviderConfigs, parseEnvMs } from "./providers.js";

describe("resolved gateway default", () => {
  it("returns the mock model when no real provider is enabled", async () => {
    const result = await createGatewayFromEnv({}, { mockBaseUrl: "http://unused.invalid" });
    expect(result.defaultModel).toBe("mock-llm-v1");
  });

  it("returns the enabled provider default when the preferred provider is absent", async () => {
    const environment = { OPENAI_API_KEY: "sk-real-fixture-key" };
    const configured = buildProviderConfigs(environment);
    const result = await createGatewayFromEnv(environment);
    expect(configured.defaultModel).toBeDefined();
    expect(result.defaultModel).toBe(configured.defaultModel);
  });
});

describe("gateway timeout env", () => {
  it("parses numeric overrides and tolerates unset, blank, and NaN values", () => {
    expect(parseEnvMs(undefined)).toBeUndefined();
    expect(parseEnvMs("")).toBeUndefined();
    expect(parseEnvMs("not-a-number")).toBeUndefined();
    expect(parseEnvMs("0")).toBe(0);
    expect(parseEnvMs("600000")).toBe(600_000);
    expect(parseEnvMs(45_000)).toBe(45_000);
  });
});
