/** The Apply all request names each item once (E-R1). */
import { describe, expect, it } from "vitest";
import { BranchApplyAllRequestSchema, BranchDiscardAllRequestSchema } from "./review.js";

const DRAFT = "00000000-0000-4000-8000-000000000001";
const ref = (itemKey: string) => ({ itemKey, locationToken: "1" });

describe("BranchApplyAllRequestSchema", () => {
  it("accepts distinct items and refuses an item named twice", () => {
    expect(
      BranchApplyAllRequestSchema.safeParse({
        branchId: DRAFT,
        commandId: DRAFT,
        items: [ref("a"), ref("b")],
      }).success,
    ).toBe(true);
    expect(
      BranchApplyAllRequestSchema.safeParse({
        branchId: DRAFT,
        commandId: DRAFT,
        items: [ref("a"), ref("a")],
      }).success,
    ).toBe(false);
  });
});

describe("command ids", () => {
  it("require a UUID on Apply all and Discard all", () => {
    expect(
      BranchApplyAllRequestSchema.safeParse({ branchId: DRAFT, items: [ref("a")] }).success,
    ).toBe(false);
    expect(
      BranchApplyAllRequestSchema.safeParse({
        branchId: DRAFT,
        commandId: DRAFT,
        items: [ref("a")],
      }).success,
    ).toBe(true);
    expect(BranchDiscardAllRequestSchema.safeParse({ branchId: DRAFT }).success).toBe(false);
    expect(
      BranchDiscardAllRequestSchema.safeParse({ branchId: DRAFT, commandId: "x" }).success,
    ).toBe(false);
    expect(
      BranchDiscardAllRequestSchema.safeParse({ branchId: DRAFT, commandId: DRAFT }).success,
    ).toBe(true);
  });
});
