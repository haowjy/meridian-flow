/**
 * Context entry name behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - rename-field selection, and no document name refused (`storedDocumentName`)
 */
import { describe, expect, it } from "vitest";

import {
  entryNameStemEnd,
  storedDocumentName,
  validateContextEntryName,
} from "./context-entry-name";

describe("entryNameStemEnd", () => {
  it("selects all of a prose name, even a dotted one", () => {
    expect(entryNameStemEnd("Chapter 13")).toBe("Chapter 13".length);
    expect(entryNameStemEnd("Vol. 2")).toBe("Vol. 2".length);
  });

  it("selects the part before a visible extension", () => {
    expect(entryNameStemEnd("outline.json", { extension: "json", editable: true })).toBe(
      "outline".length,
    );
    expect(entryNameStemEnd("Vol. 2.json", { extension: "json", editable: true })).toBe(
      "Vol. 2".length,
    );
  });
});

describe("validateContextEntryName", () => {
  it("refuses no document name: one with no stem is Untitled, one that reads as another type stays whole", () => {
    expect(validateContextEntryName(".md")).toBeNull();
    expect(storedDocumentName(".md")).toMatchObject({ ok: true, name: "Untitled" });
    expect(validateContextEntryName("data.json.md")).toBeNull();
    expect(storedDocumentName("data.json.md")).toMatchObject({ ok: true, name: "data.json.md" });
  });
});
