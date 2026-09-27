import { describe, expect, it } from "vitest";
import { filterWorkFileGroups } from "./work-files-model";

describe("Work Files grouping and search", () => {
  it("preserves resource groups and filters their names case-insensitively", () => {
    const groups = {
      drafts: [{ name: "Arc 3.md" }],
      scratch: [{ name: "Outline.md" }, { name: "Arc notes.md" }],
      uploads: [{ name: "Arc map.pdf" }],
    };
    expect(filterWorkFileGroups(groups, " ARC ")).toEqual({
      drafts: [{ name: "Arc 3.md" }],
      scratch: [{ name: "Arc notes.md" }],
      uploads: [{ name: "Arc map.pdf" }],
    });
    expect(filterWorkFileGroups(groups, " ")).toEqual(groups);
  });
});
