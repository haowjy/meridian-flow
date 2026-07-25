/** Durable Restore eligibility shared by the live peer-mark popover. */
import type { TrailChangeV1 as TrailChange } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { trailChangeRecovery } from "./trail-change-recovery";

describe("trailChangeRecovery", () => {
  it("vends the retained before excerpt to Restore", () => {
    expect(trailChangeRecovery(change())).toMatchObject({
      action: "restore",
      body: "Writer text.",
      canExecute: true,
    });
  });

  it("does not offer another command after durable terminal settlement", () => {
    const settled: TrailChange = {
      ...change(),
      forwardActions: {
        restore: { status: "settled", outcome: "retry_exhausted" },
      },
    };

    expect(trailChangeRecovery(settled).canExecute).toBe(false);
  });
});

function change(): TrailChange {
  return {
    changeId: "change-1",
    ordinal: 1,
    documentId: "document-1",
    pushId: null,
    receiptId: null,
    kind: "delete",
    beforeBlockId: null,
    afterBlockId: null,
    beforeText: "block-1|Writer text.",
    afterTextAtReceipt: null,
    navigation: { kind: "unavailable", reason: "test" },
    reversible: false,
  };
}
