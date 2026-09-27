import { isPendingPlaceholder, isPlaceholderRole } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";
import { interruptedPlaceholderError } from "./turn-metadata.js";

describe("pending placeholders", () => {
  it("classifies only pending turns with a placeholder role", () => {
    expect(isPlaceholderRole("compaction")).toBe(true);
    expect(isPlaceholderRole("assistant")).toBe(false);
    expect(isPendingPlaceholder({ role: "compaction", status: "pending" })).toBe(true);
    expect(isPendingPlaceholder({ role: "compaction", status: "complete" })).toBe(false);
    expect(isPendingPlaceholder({ role: "assistant", status: "pending" })).toBe(false);
  });

  it("uses the compaction codec for manual interruption copy", () => {
    const turn = {
      role: "compaction" as const,
      metadata: {
        compactedThrough: { turnId: "turn-1" },
        pinnedRequestTurnId: "turn-2",
        trigger: "manual",
      },
    };

    expect(interruptedPlaceholderError(turn)).toBe("This manual compaction was interrupted.");
  });

  it("uses the compaction interruption copy for auto or malformed metadata", () => {
    const base = {
      role: "compaction" as const,
      metadata: {
        compactedThrough: { turnId: "turn-1" },
        pinnedRequestTurnId: "turn-2",
        trigger: "auto",
      },
    };
    expect(interruptedPlaceholderError(base)).toBe("This compaction was interrupted.");
    expect(interruptedPlaceholderError({ ...base, metadata: { trigger: "manual" } })).toBe(
      "This compaction was interrupted.",
    );
  });
});
