import type { Turn } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { chooseSummaryPath, previousAttemptRejectedAsTooLarge } from "./summary-path.js";

describe("chooseSummaryPath", () => {
  it.each([
    [false, true, "warm", "branch"],
    [false, true, "cold", "rolling"],
    [false, false, "warm", "rolling"],
    [false, false, "cold", "rolling"],
    [true, true, "warm", "rolling"],
    [true, true, "cold", "rolling"],
  ] as const)("uses one policy regardless of model cost (%s, %s, %s)", (knownTooLarge, hasRequestInHand, cacheState, expected) => {
    expect(chooseSummaryPath({ knownTooLarge, hasRequestInHand, cacheState })).toBe(expected);
  });

  it("reads only the latest settled compaction failure on the current lineage", () => {
    const turns = [
      {
        id: "failed",
        prevTurnId: null,
        role: "compaction",
        status: "error",
        metadata: { reason: "request_too_large", phase: "summary" },
      },
      { id: "current", prevTurnId: "failed", role: "compaction", status: "pending", metadata: {} },
    ] as unknown as Turn[];
    expect(previousAttemptRejectedAsTooLarge(turns, "current", "compaction")).toBe(true);
    expect(previousAttemptRejectedAsTooLarge(turns, "failed", "compaction")).toBe(false);
    expect(
      previousAttemptRejectedAsTooLarge(
        [
          ...turns,
          {
            id: "other-current",
            prevTurnId: null,
            role: "compaction",
            status: "pending",
            metadata: {},
          } as unknown as Turn,
        ],
        "other-current",
        "compaction",
      ),
    ).toBe(false);
  });

  it("recognizes too-large handoff failures only from an earlier seed", () => {
    const turns = [
      {
        id: "failed-seed",
        prevTurnId: null,
        role: "system",
        status: "error",
        metadata: {
          kind: "derivation_seed",
          derivation: "handoff",
          sourceThreadId: "source",
          sourceRef: "@/source",
          sourceTitle: null,
          cutoffTurnId: "cutoff",
          reason: "request_too_large",
        },
      },
      {
        id: "retry",
        prevTurnId: "failed-seed",
        role: "system",
        status: "pending",
        metadata: {
          kind: "derivation_seed",
          derivation: "handoff",
          sourceThreadId: "source",
          sourceRef: "@/source",
          sourceTitle: null,
          cutoffTurnId: "cutoff",
        },
      },
    ] as unknown as Turn[];
    expect(previousAttemptRejectedAsTooLarge(turns, "retry", "handoff_seed")).toBe(true);
  });
});
