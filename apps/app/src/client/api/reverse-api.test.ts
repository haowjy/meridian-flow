/** Typed Work reversal result selection. */
import type { ReversalOutcome } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { successfulWorkReversals } from "./reverse-api";

describe("successfulWorkReversals", () => {
  it("returns only contract-declared successful Work parts", () => {
    const outcome: ReversalOutcome = {
      status: "partial_failure",
      documents: [],
      workReceipts: [
        { command: "restore", workId: "w1", name: "Arc", status: "reversed" },
        { command: "update", workId: "w2", name: "Notes", status: "failed" },
      ],
    };
    expect(successfulWorkReversals(outcome)).toEqual([outcome.workReceipts?.[0]]);
  });

  it("returns no entries when the response has no Work half", () => {
    expect(successfulWorkReversals({ status: "nothing_to_undo", documents: [] })).toEqual([]);
  });
});
