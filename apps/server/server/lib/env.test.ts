/** Fail-safe environment gate tests for debug-only server surfaces. */
import { describe, expect, it } from "vitest";
import { resolveRecentEventsEnabled } from "./env.js";

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
