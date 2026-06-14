/**
 * Unit tests for the phone shell's pure context-location helpers — breadcrumb
 * ancestry and middle-truncation. These guard the route URL convention
 * (absolute `/a/b` folders, `""` = scheme root).
 */
import { describe, expect, it } from "vitest";

import { collapseBreadcrumbSegments, folderAncestry, pathLeafName } from "./context-location";

describe("folderAncestry", () => {
  it("returns [] for the scheme root in all spellings", () => {
    expect(folderAncestry(null)).toEqual([]);
    expect(folderAncestry("")).toEqual([]);
    expect(folderAncestry("/")).toEqual([]);
  });

  it("returns shallowest-first crumbs with absolute paths", () => {
    expect(folderAncestry("/a/b")).toEqual([
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ]);
  });

  it("ignores duplicate slashes", () => {
    expect(folderAncestry("//a//b/")).toEqual([
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ]);
  });
});

describe("pathLeafName", () => {
  it("returns the file name of a nested path", () => {
    expect(pathLeafName("/notes/deep/file.md")).toBe("file.md");
  });

  it("falls back to the input for pathless strings", () => {
    expect(pathLeafName("")).toBe("");
  });
});

describe("collapseBreadcrumbSegments", () => {
  it("keeps short trails whole", () => {
    expect(collapseBreadcrumbSegments(["Files", "kb", "a", "file.md"])).toEqual({
      leading: ["Files", "kb", "a", "file.md"],
      elided: false,
      trailing: [],
    });
  });

  it("elides the middle of deep trails, keeping the Files root + last two", () => {
    // The scheme ("kb") sits second, so it elides on deep paths — intended.
    expect(collapseBreadcrumbSegments(["Files", "kb", "a", "notes", "file.md"])).toEqual({
      leading: ["Files"],
      elided: true,
      trailing: ["notes", "file.md"],
    });
  });

  it("handles the empty trail", () => {
    expect(collapseBreadcrumbSegments([])).toEqual({ leading: [], elided: false, trailing: [] });
  });
});
