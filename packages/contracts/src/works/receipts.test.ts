import { describe, expect, it } from "vitest";
import { parseWorkReceipt } from "./receipts.js";

describe("parseWorkReceipt", () => {
  it("accepts a changed factual switch without an inverse", () => {
    const receipt = {
      operation: "switch",
      category: "binding",
      before: { kind: "none" },
      after: {
        kind: "work",
        workId: "w1",
        workSlug: "arc",
        name: "Arc",
        goal: null,
        description: null,
        status: "active",
      },
      inverse: null,
    };
    expect(parseWorkReceipt(receipt)).toEqual(receipt);
    expect(
      parseWorkReceipt({ ...receipt, inverse: { command: "switch", workId: "w0" } }),
    ).toBeNull();
  });

  it("keeps mutation changed state coupled to its inverse", () => {
    const receipt = {
      operation: "delete",
      category: "mutate",
      changed: true,
      workId: "w1",
      workName: "Arc",
      before: { name: "Arc", goal: null, description: null, status: "active" },
      after: null,
      inverse: { command: "restore", workId: "w1" },
    };
    expect(parseWorkReceipt(receipt)).toEqual(receipt);
    expect(parseWorkReceipt({ ...receipt, inverse: null })).toBeNull();
    expect(parseWorkReceipt({ ...receipt, category: "binding" })).toBeNull();
  });
});
