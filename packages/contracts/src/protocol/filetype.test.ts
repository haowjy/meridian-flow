import { describe, expect, it } from "vitest";
import { classifyFiletype, filetypeForPath } from "./filetype.js";

describe("filetype disposition policy", () => {
  it.each([
    ["chapter-2", "text", "document"],
    ["chapter.prose", "text", "document"],
    ["chapter.md", "markdown", "document"],
    ["script.py", "python", "code"],
  ] as const)("maps %s through %s to the %s schema", (path, filetype, schemaType) => {
    const resolvedFiletype = filetypeForPath(path);
    expect(resolvedFiletype).toBe(filetype);
    expect(classifyFiletype(resolvedFiletype)).toEqual({ kind: "tracked", schemaType });
  });

  it.each([
    null,
    "future-prose-type",
  ])("keeps unregistered persisted value %s distinct", (filetype) => {
    expect(classifyFiletype(filetype)).toEqual({ kind: "unknown" });
  });

  it.each([
    "pdf",
    "png",
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
