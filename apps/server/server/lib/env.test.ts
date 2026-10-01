/** Fail-safe environment gate tests for debug-only server surfaces. */
import { describe, expect, it } from "vitest";
import {
  assertProductionAppEnvPresent,
  resolveDebugPathsEnabled,
  resolveObsVerbose,
} from "./env.js";

describe("assertProductionAppEnvPresent", () => {
  it.each([undefined, "", "   "])("rejects empty production APP_ENV (%s)", (rawAppEnv) => {
    expect(() => assertProductionAppEnvPresent({ rawNodeEnv: "production", rawAppEnv })).toThrow(
      "APP_ENV must be set",
    );
  });

  it("allows explicit live APP_ENV values and non-production defaults", () => {
    expect(() =>
      assertProductionAppEnvPresent({ rawNodeEnv: "production", rawAppEnv: "staging" }),
    ).not.toThrow();
    expect(() => assertProductionAppEnvPresent({ rawNodeEnv: "development" })).not.toThrow();
  });
});

describe("resolveDebugPathsEnabled", () => {
  it.each([
    { rawNodeEnv: "development", rawAppEnv: "dev" },
    { rawNodeEnv: "test", rawAppEnv: "dev" },
    { rawNodeEnv: "development", rawAppEnv: undefined },
    { rawNodeEnv: "production", rawAppEnv: "staging" },
    { rawNodeEnv: "development", rawAppEnv: "staging" },
  ])("is on only with the explicit flag outside production: %o", (environment) => {
    expect(resolveDebugPathsEnabled({ ...environment, debugFlag: "1" })).toBe(true);
    expect(resolveDebugPathsEnabled({ ...environment, debugFlag: "true" })).toBe(true);
    expect(resolveDebugPathsEnabled(environment)).toBe(false);
    expect(resolveDebugPathsEnabled({ ...environment, debugFlag: "0" })).toBe(false);
  });

  it.each([
    { rawNodeEnv: "production", rawAppEnv: "production" },
    { rawNodeEnv: "development", rawAppEnv: "production" },
    { rawNodeEnv: "production", rawAppEnv: "dev" },
    { rawNodeEnv: "production", rawAppEnv: undefined },
  ])("never turns on in production, even with the flag: %o", (environment) => {
    expect(resolveDebugPathsEnabled({ ...environment, debugFlag: "1" })).toBe(false);
  });
});

describe("resolveObsVerbose", () => {
  it("cannot enable verbose categories in production", () => {
    expect(resolveObsVerbose({ rawNodeEnv: "production", obsVerbose: "gateway.chunks" })).toEqual(
      new Set(),
    );
  });

  it.each(["development"])("parses known categories in %s", (rawNodeEnv) => {
    expect(
      resolveObsVerbose({
        rawNodeEnv,
        obsVerbose: "unknown, gateway.chunks,garbage",
      }),
    ).toEqual(new Set(["gateway.chunks"]));
  });

  it("ignores garbage input", () => {
    expect(resolveObsVerbose({ rawNodeEnv: "development", obsVerbose: "garbage,," })).toEqual(
      new Set(),
    );
  });
});
