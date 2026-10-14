/** The Apply all request names each item once (E-R1). */
import { describe, expect, it } from "vitest";
import { DraftApplyAllBodySchema, DraftDiscardAllBodySchema } from "./review.js";

const DRAFT = "00000000-0000-4000-8000-000000000001";
const ref = (itemKey: string) => ({ itemKey, locationToken: "1" });

describe("DraftApplyAllBodySchema", () => {
  it("accepts distinct items and refuses an item named twice", () => {
    expect(
      DraftApplyAllBodySchema.safeParse({
        draftId: DRAFT,
        commandId: DRAFT,
        items: [ref("a"), ref("b")],
      }).success,
    ).toBe(true);
    expect(
      DraftApplyAllBodySchema.safeParse({
        draftId: DRAFT,
        commandId: DRAFT,
        items: [ref("a"), ref("a")],
      }).success,
    ).toBe(false);
  });
});

describe("command ids", () => {
  it("require a UUID on Apply all and Discard all", () => {
    expect(DraftApplyAllBodySchema.safeParse({ draftId: DRAFT, items: [ref("a")] }).success).toBe(
      false,
    );
    expect(
      DraftApplyAllBodySchema.safeParse({ draftId: DRAFT, commandId: DRAFT, items: [ref("a")] })
        .success,
    ).toBe(true);
    expect(DraftDiscardAllBodySchema.safeParse({ draftId: DRAFT }).success).toBe(false);
    expect(DraftDiscardAllBodySchema.safeParse({ draftId: DRAFT, commandId: "x" }).success).toBe(
      false,
    );
    expect(DraftDiscardAllBodySchema.safeParse({ draftId: DRAFT, commandId: DRAFT }).success).toBe(
      true,
    );
  });
});
