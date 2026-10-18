/** The Apply all request names each item once (E-R1). */
import { describe, expect, it } from "vitest";
import { BranchApplyAllRequestSchema, BranchDiscardAllRequestSchema } from "./review.js";

const UUID = "00000000-0000-4000-8000-000000000001";
const ref = (itemKey: string) => ({ itemKey, locationToken: "1" });

describe("BranchApplyAllRequestSchema", () => {
  it("accepts distinct items and refuses an item named twice", () => {
    expect(
      BranchApplyAllRequestSchema.safeParse({
        branchId: UUID,
        commandId: UUID,
        items: [ref("a"), ref("b")],
      }).success,
    ).toBe(true);
    expect(
      BranchApplyAllRequestSchema.safeParse({
        branchId: UUID,
        commandId: UUID,
        items: [ref("a"), ref("a")],
      }).success,
    ).toBe(false);
  });
});

describe("command ids", () => {
  it("require a UUID on Apply all and Discard all", () => {
    expect(
      BranchApplyAllRequestSchema.safeParse({ branchId: UUID, items: [ref("a")] }).success,
    ).toBe(false);
    expect(
      BranchApplyAllRequestSchema.safeParse({
        branchId: UUID,
        commandId: UUID,
        items: [ref("a")],
      }).success,
    ).toBe(true);
    expect(BranchDiscardAllRequestSchema.safeParse({ branchId: UUID }).success).toBe(false);
    expect(
      BranchDiscardAllRequestSchema.safeParse({ branchId: UUID, commandId: "x" }).success,
    ).toBe(false);
    expect(
      BranchDiscardAllRequestSchema.safeParse({ branchId: UUID, commandId: UUID }).success,
    ).toBe(true);
  });
});
