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
    swept: null,
    reversible: false,
    ...overrides,
  };
}

describe("mapTrailChangeToTurnDiff", () => {
  it("maps protected swept prose as writer-authored", () => {
    expect(
      mapTrailChangeToTurnDiff(
        change({
          writerProtection: {
            kind: "sweep",
            body: { status: "available", markdown: "Protected writer prose" },
          },
          swept: {
            affectedBlockHash: "abcd",
            removed: { status: "available", markdown: "Captured fallback" },
            beforeContentRef: 1,
          },
        }),
        "doc-1",
      ).mergedOver,
    ).toEqual([{ body: "Protected writer prose", writerAuthored: true }]);
  });

  it("maps an agent-only swept body without claiming writer authorship", () => {
    expect(
      mapTrailChangeToTurnDiff(
        change({
          swept: {
            affectedBlockHash: "abcd",
            removed: { status: "available", markdown: "Agent-only prose" },
            beforeContentRef: null,
          },
        }),
        "doc-1",
      ).mergedOver,
    ).toEqual([{ body: "Agent-only prose", writerAuthored: false }]);
  });
});
