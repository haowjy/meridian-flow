import { describe, expect, it } from "vitest";

import {
  entryNameKey,
  entryNameStemEnd,
  invalidContextEntryNameReason,
  storedEntryName,
  validateContextEntryName,
} from "./context-entry-name";

const stored = (raw: string, current?: string) => {
  const result = storedEntryName(raw, current);
  return result.ok ? result.name : `refused: ${result.message}`;
};

describe("storedEntryName", () => {
  it("stores a prose document without an extension", () => {
    expect(stored("Chapter 13")).toBe("Chapter 13");
    expect(stored("Chapter 13.md")).toBe("Chapter 13");
    expect(stored("Chapter 13.txt")).toBe("Chapter 13");
    expect(stored("notes.txt")).toBe("notes");
  });

  it("keeps a visible extension, lower-cased", () => {
    expect(stored("outline.json")).toBe("outline.json");
    expect(stored("Map.PNG")).toBe("Map.png");
  });

  it("treats a dotted name as a name", () => {
    expect(stored("Vol. 2")).toBe("Vol. 2");
    expect(stored("Chapter 1.5")).toBe("Chapter 1.5");
  });

  it("keeps the renamed file's extension when none is typed", () => {
    expect(stored("settings", "config.toml")).toBe("settings.toml");
    expect(stored("pic", "map.png")).toBe("pic.png");
    expect(stored("Chapter 14", "Chapter 13")).toBe("Chapter 14");
  });

  it("lets a typed extension state the type", () => {
    expect(stored("Chapter 13.md", "config.toml")).toBe("Chapter 13");
  });

  it("passes the codec's refusal through", () => {
    expect(stored("data.json.md")).toMatch(
      /^refused: .*data\.json\.md.*would show as .*data\.json/,
    );
    expect(stored(".md")).toMatch(/^refused: /);
  });
});

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
    expect(validateContextEntryName("Chapter 12.md", ["Chapter 12"])).toMatchObject({
      level: "error",
      message: expect.stringContaining("Chapter 12"),
    });
    expect(validateContextEntryName("Chapter 12", ["Chapter 12"])?.level).toBe("error");
  });

  it("does not collide a visible extension with the prose name", () => {
    expect(validateContextEntryName("notes.json", ["notes"])).toBeNull();
  });

  it("lets a folder and a document not share a name (D15, D16)", () => {
    expect(validateContextEntryName("Lore", ["Lore/"], "file")?.level).toBe("error");
    expect(validateContextEntryName("Lore.md", ["Lore"], "folder")?.level).toBe("error");
    expect(validateContextEntryName("Lore", ["Lore"], "folder")?.level).toBe("error");
  });

  it("checks a rename's collision against the name it would be stored under", () => {
    expect(
      validateContextEntryName("settings", ["settings.toml"], "file", "config.toml")?.level,
    ).toBe("error");
    expect(validateContextEntryName("settings", ["settings.toml"], "file")).toBeNull();
  });

  it("shows the codec's invalid_name message on the field", () => {
    expect(validateContextEntryName("data.json.md", [])).toMatchObject({
      level: "error",
      message: expect.stringContaining("would show as `data.json`"),
    });
    expect(invalidContextEntryNameReason("data.json.md")).toContain("would show as `data.json`");
  });

  it("accepts dotted names", () => {
    expect(validateContextEntryName("Vol. 2", ["Vol. 1"])).toBeNull();
  });
});
