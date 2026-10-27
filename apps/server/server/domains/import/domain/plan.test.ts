/** Receipt-driven graph identity, folder-note relocation, and export routing. */
import { randomUUID } from "node:crypto";
import { importNodeId } from "@meridian/contracts";
import { expect, it } from "vitest";
import { classify } from "./classify.js";
import { codePointOrder, planWithDerivedIds, type ReceiptSelection } from "./plan.js";

function selection(paths: string[]): ReceiptSelection {
  return {
    importId: randomUUID(),
    destination: { folderUri: "kb://" },
    roots: [{ rootId: 1, kind: "folder", name: "Book" }],
    folders: [{ rootId: 1, path: "Lore" }],
    entries: paths.map((path, entryId) => ({
      path,
      entryId,
      rootId: 1,
      size: 0,
      modifiedAt: 0,
      sha256: "a".repeat(64),
      aliases: [],
      facts: {
        kind: "note",
        filetype: "markdown",
        name: (path.split("/").at(-1) ?? "").replace(/\.md$/, ""),
        extension: "",
        mimeType: "text/markdown",
      },
    })),
  };
}
it("keeps derived identity when a folder note relocates and equal-named roots coexist", async () => {
  const value = selection(["Lore.md", "Lore/Child.md"]);
  value.roots.push({ rootId: 2, kind: "folder", name: "Book" });
  value.entries.push({ ...value.entries[0], rootId: 2, entryId: 20 });
  const projectId = randomUUID();
  const nodes = await planWithDerivedIds(value, { projectId }, null);
  const lore = nodes.find((n) => n.kind === "folder" && n.path === "Lore");
  expect(nodes.find((n) => n.filename === "Lore.md" && n.rootId === 1)?.parentId).toBe(lore?.id);
  expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  for (const node of nodes)
    expect(node.id).toBe(
      importNodeId({
        projectId,
        importId: value.importId,
        rootId: node.rootId,
        kind: node.kind === "folder" ? "folder" : "entry",
        path: node.path,
      }),
    );
  expect(codePointOrder("\uE000", "😀")).toBeLessThan(0);
});
it("routes a marked export without recreating wrapper or area folders", async () => {
  const value = selection([
    "Manuscript/Chapter.md",
    "Knowledge Base/Lore/Sects.md",
    "Works/No Work/Scratch/Note.md",
  ]);
  value.roots[0].meridianExport = JSON.stringify({
    formatVersion: 1,
    areas: { manuscript: "Manuscript", kb: "Knowledge Base", unfiled: "Unfiled" },
    works: true,
  });
  value.folders = [{ rootId: 1, path: "Manuscript" }];
  const nodes = await planWithDerivedIds(value, { projectId: randomUUID() }, null);
  expect(nodes.find((n) => n.path === "Manuscript/Chapter.md")).toMatchObject({
    area: "manuscript",
    parentId: null,
  });
  expect(nodes.find((n) => n.path.startsWith("Works/"))).toMatchObject({
    state: "skipped",
    reason: "export_works",
  });
  expect(nodes.filter((n) => n.kind === "folder").map((n) => n.path)).toEqual([
    "Knowledge Base/Lore",
  ]);
});
it("uses actual signatures rather than trusting text-looking file names", async () => {
  expect(await classify("scan.txt", Buffer.from("%PDF-1.5"))).toMatchObject({
    kind: "binary",
    extension: "pdf",
  });
  expect(await classify("Draft.md", Buffer.from("{\\rtf1\\ansi Chapter}"))).toMatchObject({
    kind: "binary",
  });
  expect(await classify("Chapter.docx", new Uint8Array())).toMatchObject({
    kind: "docx",
    name: "Chapter",
  });
});
