import { describe, expect, it } from "vitest";
import { classifyFiletype, filetypeForPath } from "./filetype.js";

describe("filetype disposition policy", () => {
  it.each([
    ["chapter-2", "text", "document"],
    ["chapter.prose", "text", "document"],
    ["chapter.md", "markdown", "document"],
    ["chapter.txt", "text", "document"],
    ["script.py", "python", "code"],
  ] as const)("maps %s through %s to the %s schema", (path, filetype, schemaType) => {
    const resolvedFiletype = filetypeForPath(path);
    expect(resolvedFiletype).toBe(filetype);
    expect(classifyFiletype(resolvedFiletype)).toEqual({ kind: "tracked", schemaType });
  });

  it.each([
    null,
    undefined,
    "future-prose-type",
  ])("keeps unregistered persisted value %s distinct", (filetype) => {
    expect(classifyFiletype(filetype)).toEqual({ kind: "unknown" });
  });

  it.each([
    "python",
    "typescript",
    "javascript",
    "json",
    "shell",
    "yaml",
    "csv",
  ] as const)("keeps %s in the explicit code allowlist", (filetype) => {
    expect(classifyFiletype(filetype)).toEqual({ kind: "tracked", schemaType: "code" });
  });

  it.each([
    "pdf",
    "png",
    "jpg",
    "svg",
  ] as const)("classifies registered binary filetype %s as binary", (filetype) => {
    expect(classifyFiletype(filetype)).toEqual({
      kind: "binary",
      fileType: filetype === "pdf" ? "pdf" : "image",
    });
  });

  it("classifies bespoke-viewer filetypes separately from binary storage", () => {
    expect(classifyFiletype("notebook")).toEqual({ kind: "custom", fileType: "binary" });
  });
});
