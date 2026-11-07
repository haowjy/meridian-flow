/**
 * Context entry name behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - rename-field selection and codec error propagation
 */
import { describe, expect, it } from "vitest";

import {
  entryNameStemEnd,
  invalidContextEntryNameReason,
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

  it("selects a folder's whole name", () => {
    expect(entryNameStemEnd("v1.json")).toBe("v1.json".length);
  });
});

describe("validateContextEntryName", () => {
  it("collides a typed `.md` with the stored name beside it", () => {
    expect(
      validateContextEntryName("Chapter 12.md", [
        { entryId: "sibling", name: "Chapter 12", kind: "file" },
      ]),
    ).toMatchObject({
      level: "error",
      message: expect.stringContaining("Chapter 12"),
    });
    expect(
      validateContextEntryName("Chapter 12", [
        { entryId: "sibling", name: "Chapter 12", kind: "file" },
      ])?.level,
    ).toBe("error");
  });

  it("lets a folder and a document not share a name (D15, D16)", () => {
    expect(
      validateContextEntryName("Lore", [{ entryId: "sibling", name: "Lore", kind: "dir" }], "file")
        ?.level,
    ).toBe("error");
    expect(
      validateContextEntryName(
        "Lore.md",
        [{ entryId: "sibling", name: "Lore", kind: "file" }],
        "folder",
      ),
    ).toBeNull();
    expect(
      validateContextEntryName(
        "binary.md",
        [{ entryId: "sibling", name: "binary.md", kind: "file" }],
        "folder",
      )?.level,
    ).toBe("error");
    expect(
      validateContextEntryName(
        "Lore",
        [{ entryId: "sibling", name: "Lore", kind: "file" }],
        "folder",
      )?.level,
    ).toBe("error");
  });

  it("checks a rename's collision against the name it would be stored under", () => {
    expect(
      validateContextEntryName(
        "settings",
        [{ entryId: "sibling", name: "settings.toml", kind: "file" }],
        "file",
        { extension: "toml", editable: true },
      )?.level,
    ).toBe("error");
    expect(
      validateContextEntryName(
        "settings",
        [{ entryId: "sibling", name: "settings.toml", kind: "file" }],
        "file",
      ),
    ).toBeNull();
  });

  it("shows the codec's invalid_name message on the field", () => {
    expect(validateContextEntryName("data.json.md", [])).toMatchObject({
      level: "error",
      message: expect.stringContaining("would show as `data.json`"),
    });
    expect(invalidContextEntryNameReason("data.json.md")).toContain("would show as `data.json`");
  });
});
