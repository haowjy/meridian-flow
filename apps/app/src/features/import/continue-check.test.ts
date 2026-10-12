import type { ImportEntryReport, ImportManifest } from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { compareDigests, compareStructure, matchHeld, outstanding } from "./continue-check";
import { type BuiltManifest, buildManifest } from "./manifest";
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

/** What the server stored for a manifest: every entry as planned, file roots named by their root. */
function storedFor(built: BuiltManifest, skipped: { rootId: number; path: string }[] = []) {
  const names = new Map(built.manifest.roots.map((root) => [root.rootId, root.name]));
  return {
    roots: built.manifest.roots,
    entries: [
      ...built.manifest.entries.map(
        (item) =>
          ({
            ...item,
            filename: item.path || names.get(item.rootId) || "",
            state: "planned",
            reason: null,
          }) as ImportEntryReport,
      ),
      ...skipped.map(
        (item, index) =>
          ({
            entryId: -index - 1,
            rootId: item.rootId,
            path: item.path,
            filename: item.path,
            size: 0,
            sha256: "",
            state: "skipped",
            reason: "unreadable",
          }) as ImportEntryReport,
      ),
    ],
  };
}

const options = { importId: "00000000-0000-4000-8000-000000000000", destinationUri: "kb://" };
/** Loose files all called `Notes.md`, as a multiple-file pick reads them. */
const loose = async (...texts: string[]): Promise<Selection> => ({
  leftOut: [],
  roots: texts.map((text, rootId) => ({
    rootId,
    kind: "file" as const,
    name: "Notes.md",
    files: [{ path: "", file: new File([text], "Notes.md") }],
    folders: [],
    unreadable: [],
  })),
});
function folders(...roots: Record<string, string>[]): Selection {
  return {
    leftOut: [],
    roots: roots.map((files, rootId) => ({
      rootId,
      kind: "folder" as const,
      name: "Book",
      files: Object.entries(files).map(([path, text]) => ({ path, file: new File([text], path) })),
      folders: [],
      unreadable: [],
    })),
  };
}

describe("continue import with roots that share a name", () => {
  it("accepts two different same-name files chosen in the other order", async () => {
    const stored = storedFor(await buildManifest(await loose("a", "bbbb"), options));
    const again = await loose("bbbb", "a");
    expect(compareStructure(stored, again)).toBeNull();
    expect(compareDigests(stored, (await buildManifest(again, options)).manifest)).toBeNull();
  });

  it("refuses a changed copy among identical same-name files, and adopts one file per entry", async () => {
    const stored = storedFor(await buildManifest(await loose("a", "a"), options));
    const changed = await buildManifest(await loose("a", "b"), options);
    expect(compareDigests(stored, changed.manifest)).toEqual({ kind: "changed", name: "Notes.md" });

    const same = await buildManifest(await loose("a", "a"), options);
    const adopted = matchHeld(stored, same.manifest, same.held);
    expect([...adopted.keys()].sort()).toEqual([0, 1]);
    expect(new Set(adopted.values()).size).toBe(2);
  });

  it("keeps each same-name folder's files together when the folders come back reordered", async () => {
    const first = { "Ch 1.md": "one" };
    const second = { "Ch 1.md": "uno", "Ch 2.md": "dos" };
    const stored = storedFor(await buildManifest(folders(first, second), options));
    const again = await buildManifest(folders(second, first), options);
    expect(compareStructure(stored, folders(second, first))).toBeNull();
    expect(compareDigests(stored, again.manifest)).toBeNull();
    const adopted = matchHeld(stored, again.manifest, again.held);
    expect(await adopted.get(0)?.file.text()).toBe("one");
    expect(await adopted.get(2)?.file.text()).toBe("dos");
  });
});

describe("continue import with files that could not be read", () => {
  async function book(unreadable: string[]) {
    const selection = folders({ "Fine.md": "fine" });
    selection.roots[0].unreadable = unreadable.map((path) => ({
      path,
      reason: "permission_denied" as const,
    }));
    return selection;
  }

  it("accepts the same selection when a file left out at the start still can't be read", async () => {
    const stored = storedFor(await buildManifest(await book(["Gone.md"]), options), [
      { rootId: 0, path: "Gone.md" },
    ]);
    const again = await book(["Gone.md"]);
    expect(compareStructure(stored, again)).toBeNull();
    expect(compareDigests(stored, (await buildManifest(again, options)).manifest)).toBeNull();
  });

  it("refuses when a file the import needs can no longer be read", async () => {
    const stored = storedFor(await buildManifest(await book([]), options));
    const again = folders({});
    again.roots[0].unreadable = [{ path: "Fine.md", reason: "permission_denied" }];
    expect(compareStructure(stored, again)).toEqual({ kind: "unreadable", name: "Fine.md" });
  });

  it("asks for the exact selection while the server is still planning", async () => {
    const stored = storedFor(await buildManifest(await book(["Gone.md"]), options), [
      { rootId: 0, path: "Gone.md" },
    ]);
    const readable = folders({ "Fine.md": "fine", "Gone.md": "back" });
    expect(compareStructure(stored, readable)).toBeNull();
    expect(compareStructure(stored, readable, { exact: true })).toEqual({
      kind: "changed",
      name: "Gone.md",
    });
  });
});
