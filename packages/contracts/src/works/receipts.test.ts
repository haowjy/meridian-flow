import { describe, expect, it } from "vitest";
import { parseWorkReceipt } from "./receipts.js";

describe("parseWorkReceipt", () => {
  it("accepts the typed JSON shape and rejects false changed metadata", () => {
    const receipt = {
      operation: "switch",
      category: "binding",
      changed: false,
      workId: "w1",
      workName: "Arc",
      before: null,
      after: null,
      inverse: null,
    };
    expect(parseWorkReceipt(receipt)).toEqual(receipt);
    expect(parseWorkReceipt({ ...receipt, changed: true })).toBeNull();
  });
});
