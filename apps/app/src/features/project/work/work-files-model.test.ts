import { describe, expect, it } from "vitest";
import {
  catalogSiblingNames,
  compareTreePlaces,
  type TreePlace,
  workFileSearch,
} from "./work-files-model";

describe("workFileSearch", () => {
  it("matches names case-insensitively, and a blank search matches everything", () => {
    const names = ["Outline.md", "Arc notes.md"];
    expect(names.filter(workFileSearch(" ARC "))).toEqual(["Arc notes.md"]);
    expect(names.filter(workFileSearch(" "))).toEqual(names);
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

describe("compareTreePlaces", () => {
  const order = (places: TreePlace[]) =>
    [...places].sort(compareTreePlaces).map((place) => place.path);

  it("orders like the sidebar tree: folders first, then names, open folders' files under them", () => {
    expect(
      order([
        { path: "/zebra.md", folder: false },
        { path: "/notes/b.md", folder: false },
        { path: "/arc.md", folder: false },
        { path: "/notes", folder: true },
        { path: "/notes/a.md", folder: false },
        { path: "/drafts", folder: true },
      ]),
    ).toEqual(["/drafts", "/notes", "/notes/a.md", "/notes/b.md", "/arc.md", "/zebra.md"]);
  });

  it("puts a note still being created where it will land, not after every listed file", () => {
    expect(
      order([
        { path: "/a.md", folder: false },
        { path: "/c.md", folder: false },
        { path: "/b.md", folder: false },
      ]),
    ).toEqual(["/a.md", "/b.md", "/c.md"]);
  });
});
