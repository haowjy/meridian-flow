// Guards the manual write-status error classification against union drift.
import { describe, expect, it } from "vitest";
import { formatTurnDiff, isWriteErrorStatus } from "./response-format.js";
import type { WriteErrorStatus, WriteStatus } from "./types.js";

const ERROR_STATUSES = {
  not_found: true,
  ambiguous_match: true,
  invalid_write: true,
  document_not_found: true,
  partial_failure: true,
  cant_undo_dependent: true,
  internal_error: true,
} satisfies Record<WriteErrorStatus, true>;

describe("isWriteErrorStatus", () => {
  it("classifies every write error status", () => {
    for (const status of Object.keys(ERROR_STATUSES) as WriteErrorStatus[]) {
      expect(isWriteErrorStatus(status)).toBe(true);
    }
  });

  it.each<WriteStatus>([
    "success",
    "reversed",
    "reconciled",
    "nothing_to_undo",
  ])("does not classify the success status %s as an error", (status) => {
    expect(isWriteErrorStatus(status)).toBe(false);
  });
});

describe("formatTurnDiff", () => {
  it("distinguishes a missing provisional shell from a settled net-empty turn", () => {
    expect(formatTurnDiff(null).text).toContain(
      "Results are provisional until the turn's change trail settles.",
    );
    expect(
      formatTurnDiff({ trailState: "settled", changes: [], sharedEffects: false }).text,
    ).not.toContain("provisional");
  });

  it("reports shared-only document effects without inventing turn-owned changes", () => {
    expect(
      formatTurnDiff({ trailState: "settled", changes: [], sharedEffects: true }).text,
    ).toContain("No turn-owned changes; thread-shared effects exist for this turn's documents.");
  });
});
