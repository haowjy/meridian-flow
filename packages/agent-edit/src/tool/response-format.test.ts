// Guards the manual write-status error classification against union drift.
import { describe, expect, it } from "vitest";
import { isWriteErrorStatus } from "./response-format.js";
import type { WriteErrorStatus, WriteStatus } from "./types.js";

const ERROR_STATUSES = {
  not_found: true,
  ambiguous_match: true,
  invalid_write: true,
  document_not_found: true,
  partial_failure: true,
  cant_undo_dependent: true,
  destructive_write_rejected: true,
  rejected_response_requires_reread: true,
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
