/** The Apply all request names each item once (E-R1). */
import { describe, expect, it } from "vitest";
import { DraftApplyAllRequestSchema, DraftDiscardAllRequestSchema } from "./review.js";

const DRAFT = "00000000-0000-4000-8000-000000000001";
const ref = (itemKey: string) => ({ itemKey, locationToken: "1" });

describe("DraftApplyAllRequestSchema", () => {
  it("accepts distinct items and refuses an item named twice", () => {
    expect(
      DraftApplyAllRequestSchema.safeParse({
        draftId: DRAFT,
        commandId: DRAFT,
        items: [ref("a"), ref("b")],
      }).success,
    ).toBe(true);
    expect(
      DraftApplyAllRequestSchema.safeParse({
        draftId: DRAFT,
        commandId: DRAFT,
        items: [ref("a"), ref("a")],
      }).success,
    ).toBe(false);
  });
});

describe("command ids", () => {
  it("require a UUID on Apply all and Discard all", () => {
    expect(DraftApplyAllRequestSchema.safeParse({ draftId: DRAFT, items: [ref("a")] }).success).toBe(
      false,
    );
    expect(
      DraftApplyAllRequestSchema.safeParse({ draftId: DRAFT, commandId: DRAFT, items: [ref("a")] })
        .success,
    ).toBe(true);
    expect(DraftDiscardAllRequestSchema.safeParse({ draftId: DRAFT }).success).toBe(false);
    expect(DraftDiscardAllRequestSchema.safeParse({ draftId: DRAFT, commandId: "x" }).success).toBe(
      false,
    );
    expect(
      DraftDiscardAllRequestSchema.safeParse({ draftId: DRAFT, commandId: DRAFT }).success,
    ).toBe(true);
  });
});
