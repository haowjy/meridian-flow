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

  it("does not reconstruct unavailable writer-impact evidence from beforeText", () => {
    const change: TrailChange = {
      ...protectedChange(),
      beforeText: "block-1|Non-authoritative fallback.",
      writerImpact: {
        kind: "sweep",
        affectedBlockHash: "block-1",
        body: { status: "unavailable", reason: "capture_failed" },
        beforeContentRef: null,
      },
    };

    expect(trailChangeRecovery(change)).toMatchObject({
      body: null,
      canExecute: false,
      writerImpact: { kind: "sweep", body: { status: "unavailable" } },
    });
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
    writerImpact: {
      kind: "sweep",
      affectedBlockHash: "block-1",
      body: { status: "available", markdown: "Writer text." },
      beforeContentRef: null,
    },
    reversible: false,
  };
}
