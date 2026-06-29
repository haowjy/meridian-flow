import { describe, expect, it } from "vitest";
import {
  collapseBreadcrumbSegments,
  folderAncestry,
  parentFolder,
  pathLeafName,
} from "./context-location";

describe("context-location", () => {
  it("returns folder ancestry from scheme root through nested folders", () => {
    expect(folderAncestry(null)).toEqual([]);
    expect(folderAncestry("")).toEqual([]);
    expect(folderAncestry("/")).toEqual([]);
    expect(folderAncestry("/a/b")).toEqual([
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
    ]);
  });

  it("returns the parent folder using null for the scheme root", () => {
    expect(parentFolder(null)).toBeNull();
    expect(parentFolder("/a")).toBeNull();
    expect(parentFolder("/a/b")).toBe("/a");
  });

  it("extracts the leaf display name from an absolute file path", () => {
    expect(pathLeafName("/a/b/file.md")).toBe("file.md");
  });

  it("keeps short breadcrumb trails whole and truncates deep trails", () => {
    expect(collapseBreadcrumbSegments(["Files", "KB", "a", "b"])).toEqual({
      leading: ["Files", "KB", "a", "b"],
      elided: false,
      trailing: [],
    });

    expect(collapseBreadcrumbSegments(["Files", "KB", "a", "b", "c"])).toEqual({
      leading: ["Files"],
      elided: true,
      trailing: ["b", "c"],
    });
  });
});
