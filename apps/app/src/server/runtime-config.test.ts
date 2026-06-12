import { describe, expect, it } from "vitest";
import { parseRuntimeConfig, RuntimeConfigError } from "./runtime-config";

describe("parseRuntimeConfig", () => {
  it("defaults to dev/debug", () => {
    expect(parseRuntimeConfig({})).toEqual({ appEnv: "dev", logLevel: "debug" });
  });

  it("defaults staging and production to info logs", () => {
    expect(parseRuntimeConfig({ APP_ENV: "staging" })).toEqual({
      appEnv: "staging",
      logLevel: "info",
    });
    expect(parseRuntimeConfig({ APP_ENV: "production" })).toEqual({
      appEnv: "production",
      logLevel: "info",
    });
  });

  it("allows explicit overrides", () => {
    expect(parseRuntimeConfig({ APP_ENV: "dev", LOG_LEVEL: "warn" })).toEqual({
      appEnv: "dev",
      logLevel: "warn",
    });
  });

  it("rejects invalid enum values", () => {
    expect(() => parseRuntimeConfig({ APP_ENV: "local" })).toThrow(/APP_ENV must be one of/);
    expect(() => parseRuntimeConfig({ LOG_LEVEL: "trace" })).toThrow(/LOG_LEVEL must be one of/);
    expect(() => parseRuntimeConfig({ APP_ENV: "local" })).toThrow(RuntimeConfigError);
  });
});
