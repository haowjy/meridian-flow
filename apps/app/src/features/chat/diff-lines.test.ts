import { describe, expect, it } from "vitest";

import { collapseDiffBlocks, diffLines } from "./diff-lines";

describe("diffLines", () => {
  it("returns equal blocks when the inputs match", () => {
    const ops = diffLines("alpha\nbeta", "alpha\nbeta");
    expect(ops).not.toBeNull();
    expect(ops?.every((op) => op.kind === "equal")).toBe(true);
  });

  it("emits added blocks for inserted lines", () => {
    const ops = diffLines("alpha\nbeta", "alpha\ninserted\nbeta");
    const added = ops?.filter((op) => op.kind === "added");
    expect(added).toEqual([{ kind: "added", text: "inserted" }]);
    expect(ops?.filter((op) => op.kind === "removed")).toEqual([]);
  });

  it("emits removed blocks for deleted lines", () => {
    const ops = diffLines("alpha\nold\nbeta", "alpha\nbeta");
    const removed = ops?.filter((op) => op.kind === "removed");
    expect(removed).toEqual([{ kind: "removed", text: "old" }]);
  });

  it("returns null when the input would exceed the memory budget", () => {
    const a = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n");
    const b = Array.from({ length: 50 }, (_, i) => `other-${i}`).join("\n");
    // Force tiny budget so the helper degrades cleanly.
    expect(diffLines(a, b, { maxCells: 10 })).toBeNull();
  });
});

describe("collapseDiffBlocks", () => {
  it("merges adjacent ops of the same kind into a block", () => {
    const blocks = collapseDiffBlocks([
      { kind: "equal", text: "x" },
      { kind: "removed", text: "old-1" },
      { kind: "removed", text: "old-2" },
      { kind: "added", text: "new-1" },
      { kind: "equal", text: "y" },
    ]);
    expect(blocks).toEqual([
      { kind: "equal", lines: ["x"] },
      { kind: "removed", lines: ["old-1", "old-2"] },
      { kind: "added", lines: ["new-1"] },
      { kind: "equal", lines: ["y"] },
    ]);
  });
});
