/** Pure selection contracts: identity, naming, validation and classification without storage. */
import { randomUUID } from "node:crypto";
import {
  IMPORT_ADMISSION,
  type ImportManifest,
  importNodeId,
  importPathDisposition,
} from "@meridian/contracts";
import { describe, expect, it } from "vitest";
import { classify } from "./classify.js";
import { manifestFingerprint, validateManifest } from "./manifest.js";
import {
  allocateName,
  codePointOrder,
  type MintId,
  planSelection,
  planWithDerivedIds,
} from "./plan.js";

const mint: MintId = (...key) => key.join("\0");

function manifest(): ImportManifest {
  return {
    importId: randomUUID(),
    destination: { folderUri: "kb://" },
    roots: [{ rootId: 1, kind: "folder", name: "Book" }],
    folders: [{ rootId: 1, path: "Lore" }],
    entries: [
      "Lore.md",
      "Lore/Magic System.md",
      "Lore/magic system.md",
      "Plot.canvas",
      ".obsidian/app.json",
    ].map((path, entryId) => ({ path, entryId, rootId: 1, size: 0, sha256: "a".repeat(64) })),
  };
}
describe("import planning", () => {
  it("creates the folder graph, moves folder notes inside and omits settings", () => {
    const planned = planSelection(validateManifest(manifest()), mint, null);
    const lore = planned.find((node) => node.kind === "folder" && node.path === "Lore");
    expect(planned.find((node) => node.filename === "Lore.md")).toMatchObject({
      parentId: lore?.id,
      name: "Lore",
      kind: "note",
    });
    expect(planned.filter((node) => node.entryId !== null)).toHaveLength(4);
    expect(planned.find((node) => node.filename === "Plot.canvas")?.state).toBe("skipped");
    expect(
      planned
        .filter((node) => node.kind === "note" && node.state === "planned")
        .map((node) => node.name),
    ).toEqual(["Lore", "Magic System", "magic system"]);
  });
  it("matches resume by root content rather than client ids/order", () => {
    const original = manifest(),
      resumed = structuredClone(original);
    resumed.roots[0].rootId = 77;
    resumed.entries.reverse().forEach((entry, index) => {
      entry.rootId = 77;
      entry.entryId = index + 20;
    });
    resumed.folders[0].rootId = 77;
    expect(manifestFingerprint(resumed)).toBe(manifestFingerprint(original));
    resumed.entries[0].sha256 = "b".repeat(64);
    expect(manifestFingerprint(resumed)).not.toBe(manifestFingerprint(original));
  });
  it("keeps identically named selected roots independent", () => {
    const selection = manifest();
    selection.roots.push({ rootId: 2, kind: "folder", name: "Book" });
    selection.entries.push({ ...selection.entries[0], rootId: 2, entryId: 30 });
    const roots = planSelection(selection, mint, null).filter(
      (node) => node.kind === "folder" && node.path === "",
    );
    expect(roots).toHaveLength(2);
    expect(roots[0].id).not.toBe(roots[1].id);
  });
  it("gives every planned node the id importNodeId derives from its place in the selection", async () => {
    const projectId = randomUUID();
    const selection = manifest();
    selection.roots.push({ rootId: 2, kind: "folder", name: "Book" });
    selection.entries.push({ ...selection.entries[0], rootId: 2, entryId: 30 });
    selection.unreadable = [{ rootId: 1, path: "Lore/Gone.md" }];
    const validated = validateManifest(selection);
    const planned = planWithDerivedIds(validated, { projectId }, null);
    const kinds = { folder: "folder", entry: "entry" } as const;
    for (const node of planned) {
      const kind =
        node.kind === "folder"
          ? kinds.folder
          : node.reason === "unreadable"
            ? "unreadable"
            : kinds.entry;
      expect(node.id).toBe(
        importNodeId({
          projectId,
          importId: validated.importId,
          rootId: node.rootId,
          kind,
          path: node.path,
        }),
      );
    }
    expect(new Set(planned.map((node) => node.id)).size).toBe(planned.length);
    // The folder note moved inside Lore keeps its own entry id, apart from the folder's.
    const lore = planned.filter((node) => node.rootId === 1 && node.path === "Lore");
    expect(lore.map((node) => node.kind).sort()).toEqual(["folder"]);
    expect(planned.find((node) => node.filename === "Lore.md")?.id).not.toBe(lore[0].id);
  });
  it("allocates exact case and enforces cross-kind collisions, preserving extensions", () => {
    const children = [
      { kind: "folder" as const, name: "Chapters", extension: "" },
      { kind: "file" as const, name: "Magic System", extension: "" },
    ];
    expect(allocateName({ kind: "note", name: "Chapters", extension: "" }, children)).toBe(
      "Chapters (2)",
    );
    expect(allocateName({ kind: "note", name: "magic system", extension: "" }, children)).toBe(
      "magic system",
    );
    expect(
      allocateName({ kind: "binary", name: "map", extension: "png" }, [
        { kind: "file", name: "map", extension: "png" },
      ]),
    ).toBe("map (2)");
  });
  it("compares folder spellings through the codec and orders names by Unicode code point", () => {
    expect(
      allocateName({ kind: "note", name: "Lore", extension: "" }, [
        { kind: "folder", name: "Lore.md", extension: "" },
      ]),
    ).toBe("Lore (2)");
    expect(
      allocateName({ kind: "folder", name: "Lore.md", extension: "" }, [
        { kind: "file", name: "Lore", extension: "" },
      ]),
    ).toBe("Lore.md (2)");
    expect(codePointOrder("\uE000", "😀")).toBeLessThan(0);
  });
  it("routes a marked whole export, omits its wrapper/area directories and reports Works", async () => {
    const value = manifest();
    value.roots[0].meridianExport = JSON.stringify({
      formatVersion: 1,
      areas: { manuscript: "Manuscript", kb: "Knowledge Base", unfiled: "Unfiled" },
      works: true,
    });
    value.folders = [
      { rootId: 1, path: "Manuscript" },
      { rootId: 1, path: "Works/No Work" },
    ];
    value.entries = [
      "Manuscript/Chapter.md",
      "Knowledge Base/Lore/Sects.md",
      "Works/No Work/Scratch/Note.md",
    ].map((path, entryId) => ({ path, entryId, rootId: 1, size: 0, sha256: "a".repeat(64) }));
    const projectId = randomUUID();
    const planned = planWithDerivedIds(value, { projectId }, null);
    expect(planned.find((node) => node.path === "Manuscript/Chapter.md")).toMatchObject({
      id: importNodeId({
        projectId,
        importId: value.importId,
        rootId: 1,
        kind: "entry",
        path: "Manuscript/Chapter.md",
      }),
      area: "manuscript",
      parentId: null,
    });
    expect(planned.find((node) => node.path === "Knowledge Base/Lore")).toMatchObject({
      area: "kb",
      parentId: null,
    });
    expect(planned.find((node) => node.path.startsWith("Works/"))).toMatchObject({
      state: "skipped",
      reason: "export_works",
    });
    expect(planned.filter((node) => node.kind === "folder").map((node) => node.path)).toEqual([
      "Knowledge Base/Lore",
    ]);
    value.roots[0].meridianExport = '{"formatVersion":2}';
    expect(() => planSelection(value, mint, null)).toThrow("export_marker_invalid");
  });
  it("resume identity includes routing settings and aliases rather than trusting a new reader", () => {
    const original = manifest();
    const changed = structuredClone(original);
    changed.roots[0].appJson = '{"newFileLocation":"current"}';
    expect(manifestFingerprint(original)).not.toBe(manifestFingerprint(changed));
    changed.roots[0].appJson = undefined;
    changed.entries[0].frontmatter = "aliases: [Different]\n";
    expect(manifestFingerprint(original)).not.toBe(manifestFingerprint(changed));
  });
  it("classifies binary sniffing, DOCX, prose and code without conversion", () => {
    expect(classify("scan.txt", Buffer.from("%PDF-1.5"))).toMatchObject({
      kind: "binary",
      name: "scan",
      extension: "pdf",
    });
    expect(classify("notes.yaml", Buffer.from("---\nx: [[x]]"))).toMatchObject({
      kind: "code",
      extension: "yaml",
    });
    expect(classify("Chapter.docx", new Uint8Array())).toMatchObject({
      kind: "docx",
      name: "Chapter",
      extension: "",
    });
    expect(classify("Book.zip", Buffer.from([80, 75, 3, 4]))).toMatchObject({
      kind: "binary",
      name: "Book.zip",
      extension: "",
    });
    expect(importPathDisposition(".trash/Old.md")).toBe("trash");
  });
  it.each([
    "../x.md",
    "/x.md",
    "a//b.md",
    "a\\b.md",
    "e\u0301.md",
  ])("rejects unsafe or non-NFC path %s", (path) => {
    const value = manifest();
    value.entries[0].path = path;
    expect(() => validateManifest(value)).toThrow();
  });
  it("rejects duplicate ids, file-root descendants and size overflow", () => {
    const value = manifest();
    value.entries[1].entryId = value.entries[0].entryId;
    expect(() => validateManifest(value)).toThrow("duplicate_entry_id");
    const tooLarge = manifest();
    tooLarge.entries[0].size = IMPORT_ADMISSION.fileBytes + 1;
    expect(() => validateManifest(tooLarge)).toThrow();
    const loose = manifest();
    loose.roots[0].kind = "file";
    expect(() => validateManifest(loose)).toThrow("invalid_root_path");
  });
});
