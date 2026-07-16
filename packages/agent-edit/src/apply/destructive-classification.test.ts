// Behavioral contract for late destructive classification by CRDT ancestry.
import { describe, expect, it } from "vitest";
import { classifyDestructiveBlocks } from "./destructive-classification.js";
import type { BlockSnapshot } from "./echo.js";

const ids = (...clocks: number[]) => clocks.map((clock) => ({ clientID: 1, clock, length: 1 }));

const block = (lineage: NonNullable<BlockSnapshot["lineage"]>): BlockSnapshot => ({
  hash: "block",
  serialized: "block|writer prose",
  lineage,
});

describe("destructive classification", () => {
  it("S4: ignores same-block changes when every late writer lineage survives", () => {
    expect(
      classifyDestructiveBlocks({
        before: [block(ids(1, 3))],
        after: [block(ids(2, 1, 3))],
        protectedLineage: ids(1),
        lineageOrigins: [{ ...ids(3)[0], origin: "human" }],
      }),
    ).toEqual([]);
  });

  it("reports a removed writer lineage even when the block also has agent lineage", () => {
    expect(
      classifyDestructiveBlocks({
        before: [block(ids(1, 2, 3))],
        after: [],
        protectedLineage: ids(1),
        lineageOrigins: [
          { ...ids(2)[0], origin: "agent" },
          { ...ids(3)[0], origin: "human" },
        ],
      }).map(({ hash }) => hash),
    ).toEqual(["block"]);
  });

  it("degrades unknown late-cut lineage toward reporting", () => {
    expect(
      classifyDestructiveBlocks({
        before: [block(ids(1, 4))],
        after: [],
        protectedLineage: ids(1),
        lineageOrigins: [],
      }).map(({ hash }) => hash),
    ).toEqual(["block"]);
  });
});
