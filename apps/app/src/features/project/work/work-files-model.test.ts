import { describe, expect, it } from "vitest";
import { catalogSiblingNames, filterWorkFileGroups, workFileSearch } from "./work-files-model";

describe("Work Files grouping and search", () => {
  it("preserves resource groups and filters their names case-insensitively", () => {
    const groups = {
      scratch: [{ name: "Outline.md" }, { name: "Arc notes.md" }],
      uploads: [{ name: "Arc map.pdf" }],
    };
    expect(filterWorkFileGroups(groups, workFileSearch(" ARC "))).toEqual({
      scratch: [{ name: "Arc notes.md" }],
      uploads: [{ name: "Arc map.pdf" }],
    });
    expect(filterWorkFileGroups(groups, workFileSearch(" "))).toEqual(groups);
  });
});

describe("catalogSiblingNames", () => {
  it("reads the file's direct catalog children instead of the visible search set", () => {
    const calls: string[] = [];
    const names = catalogSiblingNames(
      {
        children(parentId) {
          calls.push(parentId);
          return parentId === "folder-a"
            ? [{ name: "same.md" }, { name: "different.md" }]
            : [{ name: "elsewhere.md" }];
        },
      },
      { parentId: "folder-a" },
    );
    expect(calls).toEqual(["folder-a"]);
    expect(names).toEqual(["same.md", "different.md"]);
  });
});
