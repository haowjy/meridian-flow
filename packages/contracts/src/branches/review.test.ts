/** Whole-Work Discard requires a command id. */
import { describe, expect, it } from "vitest";
import { BranchDiscardAllRequestSchema } from "./review.js";

const UUID = "00000000-0000-4000-8000-000000000001";
describe("command ids", () => {
  it("require a UUID on Discard all", () => {
    expect(BranchDiscardAllRequestSchema.safeParse({ branchId: UUID }).success).toBe(false);
    expect(
      BranchDiscardAllRequestSchema.safeParse({ branchId: UUID, commandId: "x" }).success,
    ).toBe(false);
    expect(
      BranchDiscardAllRequestSchema.safeParse({ branchId: UUID, commandId: UUID }).success,
    ).toBe(true);
  });
});
