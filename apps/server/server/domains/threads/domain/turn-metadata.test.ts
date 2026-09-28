import {
  isPendingPlaceholder,
  isPlaceholderRole,
  isRunOwnedPlaceholder,
  isRunOwnedPlaceholderRole,
} from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import {
  CompactionMetadataCodec,
  CompactionPlanMetadataCodec,
  CompactionUndoMetadataCodec,
  interruptedPlaceholderError,
} from "./turn-metadata.js";

describe("pending placeholders", () => {
  it("classifies only pending turns with a placeholder role", () => {
    expect(isPlaceholderRole("compaction")).toBe(true);
    expect(isPlaceholderRole("system")).toBe(true);
    expect(isPlaceholderRole("assistant")).toBe(false);
    expect(isPendingPlaceholder({ role: "compaction", status: "pending" })).toBe(true);
    expect(isPendingPlaceholder({ role: "compaction", status: "complete" })).toBe(false);
    expect(isPendingPlaceholder({ role: "assistant", status: "pending" })).toBe(false);
    expect(isRunOwnedPlaceholderRole("compaction")).toBe(true);
    expect(isRunOwnedPlaceholderRole("system")).toBe(false);
    expect(isRunOwnedPlaceholder({ role: "compaction", status: "pending" })).toBe(true);
    expect(isRunOwnedPlaceholder({ role: "system", status: "pending" })).toBe(false);
  });

  it("uses manual interruption copy, including a refusal without a cut", () => {
    const turn = {
      role: "compaction" as const,
      metadata: {
        compactedThrough: { turnId: "turn-1" },
        pinnedRequestTurnIds: ["turn-2"],
        trigger: "manual",
      },
    };

    expect(interruptedPlaceholderError(turn)).toBe("This manual compaction was interrupted.");
    expect(interruptedPlaceholderError({ ...turn, metadata: { trigger: "manual" } })).toBe(
      "This manual compaction was interrupted.",
    );
  });

  it("uses automatic interruption copy only for non-manual metadata", () => {
    const base = {
      role: "compaction" as const,
      metadata: {
        compactedThrough: { turnId: "turn-1" },
        pinnedRequestTurnIds: ["turn-2"],
        trigger: "auto",
      },
    };
    expect(interruptedPlaceholderError(base)).toBe("This compaction was interrupted.");
    expect(interruptedPlaceholderError({ ...base, metadata: { trigger: "unknown" } })).toBe(
      "This compaction was interrupted.",
    );
  });
});

describe("compaction metadata", () => {
  it("parses typed failure, control, and fit fields even without a compaction plan", () => {
    const metadata = CompactionMetadataCodec.parse({
      trigger: "auto",
      controlMessageId: "control-1",
      reason: "context_too_large",
      phase: "late_arrival",
      estimatedTokens: 4_321,
      fitLimitTokens: 2_500,
    });

    expect(metadata).toMatchObject({
      trigger: "auto",
      controlMessageId: "control-1",
      reason: "context_too_large",
      phase: "late_arrival",
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

it("rejects unknown undo refusal reasons but accepts successful markers", () => {
  const metadata = { kind: "compaction_undo", revertsCompactionTurnId: "c" };
  expect(CompactionUndoMetadataCodec.safeParse(metadata).success).toBe(true);
  expect(
    CompactionUndoMetadataCodec.safeParse({ ...metadata, reason: "provider_error" }).success,
  ).toBe(false);
});
