/** Fail-safe environment gate tests for debug-only server surfaces. */
import { describe, expect, it } from "vitest";
import { resolveDebugPathsEnabled, resolveObsVerbose } from "./env.js";

describe("resolveDebugPathsEnabled", () => {
  it.each([
    { rawNodeEnv: "development", rawAppEnv: "dev" },
  ])("is on only with the explicit flag outside production: %o", (environment) => {
    expect(resolveDebugPathsEnabled({ ...environment, debugFlag: "1" })).toBe(true);
    expect(resolveDebugPathsEnabled({ ...environment, debugFlag: "true" })).toBe(true);
    expect(resolveDebugPathsEnabled(environment)).toBe(false);
    expect(resolveDebugPathsEnabled({ ...environment, debugFlag: "0" })).toBe(false);
  });

  it.each([
    { rawNodeEnv: "production", rawAppEnv: "production" },
    { rawNodeEnv: "development", rawAppEnv: "production" },
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
});
