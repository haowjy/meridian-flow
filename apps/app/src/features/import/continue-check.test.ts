import type { ImportEntryReport, ImportManifest } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { compareDigests, compareStructure, outstanding } from "./continue-check";
import type { Selection } from "./selection";

const entry = (
  entryId: number,
  path: string,
  size: number,
  sha256: string,
  state: ImportEntryReport["state"] = "planned",
) =>
  ({
    entryId,
    rootId: 0,
    path,
    filename: path,
    size,
    sha256,
    state,
    reason: null,
  }) as ImportEntryReport;

const stored = {
  roots: [{ rootId: 0, kind: "folder" as const, name: "vault" }],
  entries: [entry(0, "Ch 1.md", 3, "a"), entry(1, "Lore/Sects.md", 5, "b", "landed")],
};

const selectionOf = (files: Record<string, string>, name = "vault"): Selection => ({
  leftOut: [],
  roots: [
    {
      rootId: 0,
      kind: "folder",
      name,
      files: Object.entries(files).map(([path, text]) => ({ path, file: new File([text], path) })),
      folders: [],
      unreadable: [],
    },
  ],
});

describe("continue import checks", () => {
  it("accepts the same files in any order", () => {
    const selection = selectionOf({ "Lore/Sects.md": "12345", "Ch 1.md": "123" });
    expect(compareStructure(stored, selection)).toBeNull();
  });

  it("names a missing, changed or extra file as the difference", () => {
    expect(compareStructure(stored, selectionOf({ "Ch 1.md": "123" }))).toEqual({
      kind: "missing",
      name: "Sects.md",
    });
    expect(
      compareStructure(stored, selectionOf({ "Ch 1.md": "12", "Lore/Sects.md": "12345" })),
    ).toEqual({ kind: "changed", name: "Ch 1.md" });
    expect(
      compareStructure(
        stored,
        selectionOf({ "Ch 1.md": "123", "Lore/Sects.md": "12345", "New.md": "x" }),
      ),
    ).toEqual({ kind: "extra", name: "New.md" });
    expect(
      compareStructure(
        stored,
        selectionOf({ "Ch 1.md": "123", "Lore/Sects.md": "12345" }, "other"),
      ),
    ).toEqual({ kind: "missing", name: "vault" });
  });

  it("refuses a file whose digest changed though its size did not", () => {
    const manifest = {
      roots: [{ rootId: 0, kind: "folder", name: "vault" }],
      entries: [
        { entryId: 0, rootId: 0, path: "Ch 1.md", size: 3, sha256: "a" },
        { entryId: 1, rootId: 0, path: "Lore/Sects.md", size: 5, sha256: "DIFFERENT" },
      ],
    } as ImportManifest;
    expect(compareDigests(stored, manifest)).toEqual({ kind: "changed", name: "Sects.md" });
  });

  it("counts only what the server still waits for", () => {
    expect(outstanding(stored.entries)).toBe(1);
  });
});
