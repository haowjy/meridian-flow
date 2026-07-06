/** Unit coverage for receipt-chip priority selection. */
import { describe, expect, it } from "vitest";
import { selectTurnReceiptState } from "./drizzle-turn-receipt.js";

describe("selectTurnReceiptState", () => {
  it("prefers live-active when a turn has both active and reversed live rows", () => {
    expect(selectTurnReceiptState(["live-reversed", "live-active"])).toBe("live-active");
  });

  it("prefers branch-active over an expired live receipt", () => {
    expect(selectTurnReceiptState(["expired", "branch-active"])).toBe("branch-active");
  });
});
