/** Durable action eligibility shared by every trail-recovery surface. */
import type { TrailChangeV1 as TrailChange } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { trailChangeRecovery } from "./trail-change-recovery";

describe("trailChangeRecovery", () => {
  it("does not offer another command after durable terminal settlement", () => {
    const active = protectedChange();
    const settled: TrailChange = {
      ...active,
      forwardActions: {
        restore: { status: "settled", outcome: "retry_exhausted" },
      },
    };

    expect(trailChangeRecovery(active).canExecute).toBe(true);
    expect(trailChangeRecovery(settled).canExecute).toBe(false);
  });
});

function protectedChange(): TrailChange {
  return {
    changeId: "change-1",
    ordinal: 1,
    documentId: "document-1",
    pushId: null,
    receiptId: null,
    kind: "delete",
    beforeBlockId: null,
    afterBlockId: null,
    beforeText: null,
    afterTextAtReceipt: null,
    navigation: { kind: "unavailable", reason: "test" },
    swept: null,
    writerProtection: {
      kind: "sweep",
      body: { status: "available", markdown: "Writer text." },
    },
    reversible: false,
  };
}
