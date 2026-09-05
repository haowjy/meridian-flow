import { describe, expect, it } from "vitest";
import {
  requireWorkDraftOwner,
  threadExecutionContext,
  type WorkRequiredError,
} from "./thread-execution-context.js";

describe("thread execution context", () => {
  it("executes no-Work directly without a draft owner", () => {
    expect(threadExecutionContext(null)).toEqual({
      scope: { kind: "none" },
      aiWriteMode: "direct",
      draftOwner: null,
    });
  });
  it("returns typed work_required only at the Work draft boundary", () => {
    expect(() => requireWorkDraftOwner(threadExecutionContext(null), "branch.apply")).toThrow(
      expect.objectContaining({
        name: "WorkRequiredError",
        code: "work_required",
        operation: "branch.apply",
      }) as WorkRequiredError,
    );
  });
});
