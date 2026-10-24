/**
 * Context entry name behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - rename-field selection and codec error propagation
 */
import { describe, expect, it } from "vitest";

import {
  entryNameKey,
  entryNameStemEnd,
  invalidContextEntryNameReason,
  validateContextEntryName,
} from "./context-entry-name";

describe("entryNameKey", () => {
  it("makes every spelling of a prose name one key", () => {
    const key = entryNameKey("Chapter 13");
    expect(entryNameKey("Chapter 13.md")).toBe(key);
    expect(entryNameKey("Chapter 13.txt")).toBe(key);
    expect(entryNameKey("Chapter 13/")).toBe(key);
  });

  it("keeps a visible extension distinct from the prose name", () => {
    expect(entryNameKey("notes.json")).not.toBe(entryNameKey("notes"));
  });
});

describe("entryNameStemEnd", () => {
  it("selects all of a prose name, even a dotted one", () => {
    expect(entryNameStemEnd("Chapter 13")).toBe("Chapter 13".length);
    expect(entryNameStemEnd("Vol. 2")).toBe("Vol. 2".length);
  });

  it("selects the part before a visible extension", () => {
    expect(entryNameStemEnd("outline.json")).toBe("outline".length);
    expect(entryNameStemEnd("Vol. 2.json")).toBe("Vol. 2".length);
  });

  it("selects a folder's whole name", () => {
    expect(entryNameStemEnd("v1.json", "folder")).toBe("v1.json".length);
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

  it("does not collide a visible extension with the prose name", () => {
    expect(
      validateContextEntryName("notes.json", [{ entryId: "sibling", name: "notes", kind: "file" }]),
    ).toBeNull();
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
        "config.toml",
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

  it("accepts dotted names", () => {
    expect(
      validateContextEntryName("Vol. 2", [{ entryId: "sibling", name: "Vol. 1", kind: "file" }]),
    ).toBeNull();
  });
});

it("compares folders literally and reports the occupant kind", () => {
  const folder = { entryId: "lore", name: "Lore", kind: "dir" as const };
  expect(validateContextEntryName("Lore.md", [folder], "folder")).toBeNull();
  expect(validateContextEntryName("Lore.md", [folder], "file")?.message).toContain(
    "A folder named Lore",
  );
  expect(
    validateContextEntryName("Lore", [{ ...folder, kind: "file" }], "folder")?.message,
  ).toContain("A file named Lore");
});
