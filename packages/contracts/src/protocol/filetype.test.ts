import { describe, expect, it } from "vitest";
import {
  filetypeForPath,
  isTrackedFiletype,
  schemaTypeForFiletype,
  schemaTypeForTrackedFiletype,
  type TrackedFiletype,
  trackedFiletypeForPersistedValue,
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
    if (!isTrackedFiletype(resolvedFiletype)) throw new Error(`${path} must be tracked text`);
    expect(schemaTypeForTrackedFiletype(resolvedFiletype)).toBe(schemaType);
  });

  it("defaults missing and unregistered persisted filetypes to the document schema", () => {
    expect(schemaTypeForTrackedFiletype(null)).toBe("document");
    expect(
      schemaTypeForTrackedFiletype(trackedFiletypeForPersistedValue("future-prose-type")),
    ).toBe("document");
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
    expect(schemaTypeForTrackedFiletype(filetype)).toBe("code");
  });

  it.each([
    "notebook",
    "pdf",
    "png",
    "jpg",
    "svg",
  ] as const)("rejects registered non-text filetype %s at the tracked schema boundary", (filetype) => {
    expect(isTrackedFiletype(filetype)).toBe(false);
    expect(() => trackedFiletypeForPersistedValue(filetype)).toThrow(/tracked text document/);
    expect(() => schemaTypeForTrackedFiletype(filetype as TrackedFiletype)).toThrow(
      /tracked text document/,
    );
  });
});
