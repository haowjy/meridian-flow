import { describe, expect, it } from "vitest";
import {
  filetypeForPath,
  schemaTypeForFiletype,
  schemaTypeForTrackedFiletype,
} from "./filetype.js";

describe("tracked document schema policy", () => {
  it.each([
    ["chapter-2", "text", "document"],
    ["chapter.prose", "text", "document"],
    ["chapter.md", "markdown", "document"],
    ["chapter.txt", "text", "document"],
    ["script.py", "python", "code"],
  ] as const)("maps %s through %s to %s", (path, filetype, schemaType) => {
    const resolvedFiletype = filetypeForPath(path);
    expect(resolvedFiletype).toBe(filetype);
    expect(schemaTypeForFiletype(resolvedFiletype)).toBe(schemaType);
    expect(schemaTypeForTrackedFiletype(resolvedFiletype)).toBe(schemaType);
  });

  it("defaults missing and unregistered persisted filetypes to the document schema", () => {
    expect(schemaTypeForTrackedFiletype(null)).toBe("document");
    expect(schemaTypeForTrackedFiletype("future-prose-type")).toBe("document");
  });
});
