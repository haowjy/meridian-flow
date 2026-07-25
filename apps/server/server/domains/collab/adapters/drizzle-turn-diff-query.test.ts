import type { TrailChangeV1 } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { mapTrailChangeToTurnDiff } from "./drizzle-turn-diff-query.js";

function change(overrides: Partial<TrailChangeV1>): TrailChangeV1 {
  return {
    changeId: "change-1",
    ordinal: 1,
    documentId: "doc-1",
    pushId: "push-1",
    receiptId: "receipt-1",
    kind: "modify",
    beforeBlockId: null,
    afterBlockId: null,
    beforeText: "Before",
    afterTextAtReceipt: "After",
    navigation: { kind: "unavailable", reason: "fixture" },
    writerImpact: null,
    reversible: false,
    ...overrides,
  };
}

describe("mapTrailChangeToTurnDiff", () => {
  it("maps writer-impact prose as writer-authored", () => {
    expect(
      mapTrailChangeToTurnDiff(
        change({
          writerImpact: {
            kind: "sweep",
            affectedBlockHash: "abcd",
            body: { status: "available", markdown: "Protected writer prose" },
            beforeContentRef: 1,
          },
        }),
        "doc-1",
      ).mergedOver,
    ).toEqual([{ body: "Protected writer prose", writerAuthored: true }]);
  });

  it("does not invent merged-over prose without writer impact", () => {
    expect(
      mapTrailChangeToTurnDiff(
        change({
          beforeText: "Agent-only prose",
        }),
        "doc-1",
      ).mergedOver,
    ).toEqual([]);
  });
});
