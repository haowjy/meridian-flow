import { describe, expect, it } from "vitest";
import { isCacheReset } from "./cache-reset.js";

describe("isCacheReset", () => {
  it("flags drops below half of the preceding prompt only after cache activity", () => {
    expect(
      isCacheReset({
        previousInputTokens: 1000,
        hasCacheActivity: true,
        currentCacheReadTokens: 499,
      }),
    ).toBe(true);
    expect(
      isCacheReset({
        previousInputTokens: 1000,
        hasCacheActivity: true,
        currentCacheReadTokens: 500,
      }),
    ).toBe(false);
    expect(
      isCacheReset({
        previousInputTokens: 1000,
        hasCacheActivity: false,
        currentCacheReadTokens: 0,
      }),
    ).toBe(false);
    expect(
      isCacheReset({
        previousInputTokens: null,
        hasCacheActivity: true,
        currentCacheReadTokens: 0,
      }),
    ).toBe(false);
    expect(
      isCacheReset({
        previousInputTokens: 1000,
        hasCacheActivity: true,
        currentCacheReadTokens: null,
      }),
    ).toBe(false);
  });
});
