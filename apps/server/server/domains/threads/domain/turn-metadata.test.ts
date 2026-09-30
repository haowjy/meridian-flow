import { isPendingPlaceholder, isPlaceholderRole } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { turnFailedCopy } from "./failure-copy.js";
import {
  CompactionFailurePhaseCodec,
  CompactionMetadataCodec,
  CompactionPlanMetadataCodec,
} from "./turn-metadata.js";

describe("turn roles and failure copy", () => {
  it("classifies only pending turns with a placeholder role", () => {
    expect(isPlaceholderRole("compaction")).toBe(true);
    expect(isPlaceholderRole("system")).toBe(true);
    expect(isPlaceholderRole("assistant")).toBe(false);
    expect(isPendingPlaceholder({ role: "compaction", status: "pending" })).toBe(true);
    expect(isPendingPlaceholder({ role: "compaction", status: "complete" })).toBe(false);
    expect(isPendingPlaceholder({ role: "assistant", status: "pending" })).toBe(false);
    expect(isPendingPlaceholder({ role: "system", status: "pending" })).toBe(true);
  });

  it("uses ordinary compaction failure copy for a recovered manual placeholder", () => {
    const turn = {
      role: "compaction" as const,
      metadata: {
        compactedThrough: { turnId: "turn-1" },
        pinnedRequestTurnIds: ["turn-2"],
        trigger: "manual",
      },
    };

    expect(turnFailedCopy(turn)).toBe("This conversation couldn't be compacted. Try again.");
    expect(turnFailedCopy({ role: "assistant" })).toBe("This response failed.");
  });

  it("uses the same ordinary failure copy for an automatic placeholder", () => {
    const base = {
      role: "compaction" as const,
      metadata: {
        compactedThrough: { turnId: "turn-1" },
        pinnedRequestTurnIds: ["turn-2"],
        trigger: "auto",
      },
    };
    expect(turnFailedCopy(base)).toBe("This conversation couldn't be compacted. Try again.");
    expect(turnFailedCopy({ role: "system" })).toBe(
      "This handoff brief couldn't be generated. Try again.",
    );
  });
});

describe("compaction metadata", () => {
  it("does not expose the removed late-arrival failure phase", () => {
    expect(CompactionFailurePhaseCodec.safeParse("late_arrival").success).toBe(false);
  });

  it("parses typed failure, control, and fit fields even without a compaction plan", () => {
    const metadata = CompactionMetadataCodec.parse({
      trigger: "auto",
      controlMessageId: "control-1",
      reason: "context_too_large",
      phase: "initial_prepare",
      estimatedTokens: 4_321,
      fitLimitTokens: 2_500,
    });

    expect(metadata).toMatchObject({
      trigger: "auto",
      controlMessageId: "control-1",
      reason: "context_too_large",
      phase: "initial_prepare",
      estimatedTokens: 4_321,
      fitLimitTokens: 2_500,
    });
    expect(CompactionPlanMetadataCodec.safeParse(metadata).success).toBe(false);
  });

  it("requires failure reason and phase together on planned metadata", () => {
    expect(
      CompactionMetadataCodec.safeParse({
        compactedThrough: { turnId: "turn-1" },
        pinnedRequestTurnIds: ["request-1"],
        reason: "context_too_large",
      }).success,
    ).toBe(false);
  });
});
