import { describe, expect, it } from "vitest";
import { parseWorkReceipt } from "./receipts.js";

describe("parseWorkReceipt", () => {
  it("keeps mutation changed state coupled to its inverse", () => {
    const receipt = {
      operation: "delete",
      changed: true,
      workId: "w1",
      workName: "Arc",
      before: { name: "Arc", goal: null, status: null, archived: false },
      after: null,
      inverse: { command: "restore", workId: "w1" },
    };
    expect(parseWorkReceipt(receipt)).toEqual(receipt);
    expect(parseWorkReceipt({ ...receipt, inverse: null })).toBeNull();
  });
});
