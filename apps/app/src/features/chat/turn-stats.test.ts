import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { cacheHitPercent, turnStats } from "./turn-stats";

describe("cacheHitPercent", () => {
  it("uses inclusive prompt input and hides empty totals", () => {
    expect(cacheHitPercent(25, 100)).toBe(25);
    expect(cacheHitPercent(0, 0)).toBeNull();
  });
});

function turn(responses: Array<Record<string, unknown>>): Turn {
  return { model: "fallback", responses } as unknown as Turn;
}

describe("turnStats", () => {
  it("sums calls and computes cache hit from inclusive input", () => {
    const stats = turnStats(
      turn([
        {
          sequence: 1,
          model: "m1",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheReset: true,
          latencyMs: 1_000,
          timeToFirstTokenMs: 200,
          generationMs: 800,
        },
        {
          sequence: 2,
          model: "m2",
          inputTokens: 300,
          outputTokens: 40,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
          latencyMs: 2_000,
          timeToFirstTokenMs: 500,
          generationMs: 1_500,
        },
      ]),
    );
    expect(stats).toMatchObject({
      model: "m1",
      callCount: 2,
      inputTokens: 400,
      outputTokens: 60,
      cacheHitPercent: 32.5,
      cacheReportedInputTokens: 400,
      cacheReportedCalls: 2,
      cacheResets: 1,
      ttftMs: 200,
    });
    expect(stats.outputTokensPerSecond).toBeCloseTo(60_000 / 2_300);
  });

  it("omits speed and TTFT without measured generation and cache rate for zero input", () => {
    const stats = turnStats(
      turn([{ sequence: 1, model: "m", inputTokens: 0, outputTokens: 12, latencyMs: 1_000 }]),
    );
    expect(stats).toMatchObject({
      cacheHitPercent: null,
      ttftMs: null,
      outputTokensPerSecond: null,
    });
  });

  it("excludes calls whose providers omit cache counters from cache-rate input", () => {
    const stats = turnStats(
      turn([
        { sequence: 1, inputTokens: 100, outputTokens: 1, cacheReadTokens: 50 },
        { sequence: 2, inputTokens: 900, outputTokens: 1, cacheReadTokens: null },
      ]),
    );
    expect(stats.cacheHitPercent).toBe(50);
    expect(stats.cacheReportedInputTokens).toBe(100);
    expect(stats.cacheReportedCalls).toBe(1);
  });

  it("excludes calls without timing from both sides of the speed calculation", () => {
    const stats = turnStats(
      turn([
        {
          sequence: 1,
          model: "m",
          inputTokens: 2,
          outputTokens: 20,
          latencyMs: 1_000,
          timeToFirstTokenMs: 500,
          generationMs: 500,
        },
        { sequence: 2, model: "m", inputTokens: 2, outputTokens: 80, latencyMs: 1_000 },
      ]),
    );
    expect(stats.outputTokensPerSecond).toBe(40);
  });
});
