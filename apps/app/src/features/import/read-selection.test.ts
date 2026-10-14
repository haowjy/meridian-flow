import { describe, expect, it } from "vitest";
import { readDropped } from "./read-dropped";
import { readPicked } from "./read-picked";
import { SIDE_FILE_MAX_CHARS } from "./selection";
import { fakeDirectory, fakeEntry, pickedFile } from "./test-files";

describe("a picked folder", () => {
  it("is one root; settings and the export marker are read, not imported", async () => {
    const selection = await readPicked([
      pickedFile("vault/Ch 1.md", "# One"),
      pickedFile("vault/Lore/Sects.md", "x"),
      pickedFile("vault/.obsidian/app.json", '{"attachmentFolderPath":"files"}'),
      pickedFile("vault/.obsidian/workspace.json", "{}"),
      pickedFile("vault/.git/HEAD", "ref"),
      pickedFile("vault/.DS_Store", "x"),
      pickedFile("vault/meridian-export.json", '{"version":1}'),
    ]);
    expect(selection.roots).toHaveLength(1);
    const [root] = selection.roots;
    expect(root.name).toBe("vault");
    expect(root.files.map((file) => file.path)).toEqual(["Ch 1.md", "Lore/Sects.md"]);
    expect(root.appJson).toBe('{"attachmentFolderPath":"files"}');
    expect(root.meridianExport).toBe('{"version":1}');
  });

  it("puts a file Meridian cannot name in the report as unreadable instead of refusing the import", async () => {
    const selection = await readPicked([
      pickedFile("vault/Fine.md", "x"),
      pickedFile("vault/Who? What.md", "x"),
    ]);
    expect(selection.roots[0].files.map((file) => file.path)).toEqual(["Fine.md"]);
    expect(selection.roots[0].unreadable).toEqual([{ path: "Who? What.md", reason: "unreadable" }]);
  });
});

describe("a folder's app settings", () => {
  it("sends none when the file is unreadable or too large, and still reads the notes", async () => {
    const unreadable = pickedFile("vault/.obsidian/app.json", "{}");
    unreadable.text = () => Promise.reject(new DOMException("gone", "NotReadableError"));
    const huge = pickedFile("vault/.obsidian/app.json", " ".repeat(SIDE_FILE_MAX_CHARS + 1));
    for (const settings of [unreadable, huge]) {
      const selection = await readPicked([pickedFile("vault/Ch 1.md", "# One"), settings]);
      expect(selection.roots[0].appJson).toBeUndefined();
      expect(selection.roots[0].files.map((file) => file.path)).toEqual(["Ch 1.md"]);
    }
  });
});

describe("picked loose files", () => {
  it("makes each file its own root, even when names repeat", async () => {
    const selection = await readPicked([pickedFile("Notes.md", "a"), pickedFile("Notes.md", "b")]);
    expect(selection.roots.map((root) => [root.rootId, root.kind, root.name])).toEqual([
      [0, "file", "Notes.md"],
      [1, "file", "Notes.md"],
    ]);
  });
});

describe("a dropped folder", () => {
  const vault = {
    name: "vault",
    children: [
      { name: "Ch 1.md", content: "a" },
      { name: "Ch 2.md", content: "b" },
      { name: "Ch 3.md", content: "c" },
      { name: "Empty", children: [] },
      {
        name: "Lore",
        children: [
          { name: "Sects.md", content: "x" },
          { name: "Gone.md", content: "x", broken: true },
        ],
      },
      {
        name: ".obsidian",
        children: [
          { name: "app.json", content: "{}" },
          { name: "plugins", children: [] },
        ],
      },
      { name: "Locked", children: [], broken: true },
    ],
  };

  it("keeps listing until the reader runs dry, sees empty folders and reports what it could not open", async () => {
    const selection = await readDropped({ entries: [fakeDirectory(vault)], files: [] });
    const [root] = selection.roots;
    expect(root.files.map((file) => file.path).sort()).toEqual([
      "Ch 1.md",
      "Ch 2.md",
      "Ch 3.md",
      "Lore/Sects.md",
    ]);
    expect(root.folders.sort()).toEqual(["Empty", "Lore"]);
    expect(root.appJson).toBe("{}");
    expect(root.unreadable).toEqual(
      expect.arrayContaining([
        { path: "Lore/Gone.md", reason: "permission_denied" },
        { path: "Locked", reason: "folder_unreadable" },
      ]),
    );
  });

  it("makes two folders with one name two roots", async () => {
    const book = { name: "Book", children: [{ name: "Chapter.md", content: "x" }] };
    const selection = await readDropped({
      entries: [
        fakeDirectory(book),
        fakeDirectory(book),
        fakeEntry({ name: "Notes.md", content: "n" }),
      ],
      files: [],
    });
    expect(selection.roots.map((root) => [root.rootId, root.kind, root.name])).toEqual([
      [0, "folder", "Book"],
      [1, "folder", "Book"],
      [2, "file", "Notes.md"],
    ]);
  });

  it("leaves out a dropped folder it cannot list at all", async () => {
    const selection = await readDropped({
      entries: [fakeDirectory({ name: "Locked", children: [], broken: true })],
      files: [],
    });
    expect(selection.roots).toEqual([]);
    expect(selection.leftOut).toEqual([{ name: "Locked", kind: "folder" }]);
  });
});
