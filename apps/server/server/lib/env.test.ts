/** Fail-safe environment gate tests for debug-only server surfaces. */
import { describe, expect, it } from "vitest";
import { resolveObsVerbose, resolveRecentEventsEnabled } from "./env.js";

describe("resolveRecentEventsEnabled", () => {
  it.each(["development", "test"])("enables recent events in %s", (rawNodeEnv) => {
    expect(resolveRecentEventsEnabled({ rawNodeEnv })).toBe(true);
  });

  it.each([
    "production",
    "staging",
    "",
    undefined,
  ])("fails closed for NODE_ENV=%s", (rawNodeEnv) => {
    expect(resolveRecentEventsEnabled({ rawNodeEnv })).toBe(false);
  });
});

describe("resolveObsVerbose", () => {
  it("cannot enable verbose categories in production", () => {
    expect(resolveObsVerbose({ rawNodeEnv: "production", obsVerbose: "gateway.chunks" })).toEqual(
      new Set(),
    );
  });

  it.each(["development", "test"])("parses known categories in %s", (rawNodeEnv) => {
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
