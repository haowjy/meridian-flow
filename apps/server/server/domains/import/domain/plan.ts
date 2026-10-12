/** Pure identity graph, folder-note relocation and exact-case name allocation. */
import type { ImportFinding, ImportManifest } from "@meridian/contracts";
import type { Filetype } from "@meridian/contracts/protocol";
import { folderDocumentName, renderFilename } from "@meridian/contracts/protocol";
import { classify, skipPath } from "./classify.js";

export interface PlannedNode {
  id: string;
  parentId: string | null;
  rootId: number;
  entryId: number | null;
  path: string;
  filename: string;
  name: string;
  extension: string;
  kind: "folder" | "note" | "docx" | "code" | "binary";
  filetype: Filetype;
  size: number;
  sha256: string;
  mimeType: string;
  state: "planned" | "skipped";
  reason: string | null;
  findings: ImportFinding[];
}
export function codePointOrder(a: string, b: string): number {
  const left = Array.from(a, (character) => character.codePointAt(0) ?? 0);
  const right = Array.from(b, (character) => character.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
export function allocateName(
  node: Pick<PlannedNode, "kind" | "name" | "extension">,
  used: readonly { kind: "folder" | "file"; name: string; extension: string }[],
) {
  const taken = (name: string) =>
    used.some((item) =>
      node.kind === "folder"
        ? item.kind === "folder"
          ? item.name === name
          : renderFilename(item.name, item.extension) === folderDocumentName(name)
        : item.kind === "folder"
          ? folderDocumentName(item.name) === renderFilename(name, node.extension)
          : renderFilename(item.name, item.extension) === renderFilename(name, node.extension),
    );
  let name = node.name;
  for (let count = 2; taken(name); count++) name = `${node.name} (${count})`;
  return name;
}
export function planSelection(
  manifest: ImportManifest,
  mintId: () => string,
  destinationId: string | null,
): PlannedNode[] {
  const nodes: PlannedNode[] = [];
  for (const root of [...manifest.roots].sort(
    (a, b) => codePointOrder(a.name, b.name) || a.rootId - b.rootId,
  )) {
    const folders = new Map<string, PlannedNode>();
    const makeFolder = (path: string): PlannedNode => {
      const existing = folders.get(path);
      if (existing) return existing;
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const parentId = path === "" ? destinationId : makeFolder(parentPath).id;
      const filename = path === "" ? root.name : (path.split("/").at(-1) ?? "");
      const node: PlannedNode = {
        id: mintId(),
        parentId,
        rootId: root.rootId,
        entryId: null,
        path,
        filename,
        name: filename,
        extension: "",
        kind: "folder",
        filetype: "markdown",
        size: 0,
        sha256: "",
        mimeType: "",
        state: "planned",
        reason: null,
        findings: [],
      };
      folders.set(path, node);
      nodes.push(node);
      return node;
    };
    if (root.kind === "folder") {
      makeFolder("");
      for (const entry of [...manifest.folders, ...manifest.entries].filter(
        (item) => item.rootId === root.rootId,
      )) {
        if (skipPath(entry.path)) continue;
        const isFolder = !("entryId" in entry);
        const folder = isFolder
          ? entry.path
          : entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/")));
        if (folder) makeFolder(folder);
      }
    }
    for (const entry of manifest.entries
      .filter((entry) => entry.rootId === root.rootId)
      .sort((a, b) => codePointOrder(a.path, b.path))) {
      const filename = root.kind === "file" ? root.name : (entry.path.split("/").at(-1) ?? "");
      const skip = skipPath(entry.path || filename);
      if (skip === "omit") continue;
      const typed = classify(filename, Buffer.from(entry.sniff ?? "", "base64"));
      let parentPath = entry.path.includes("/")
        ? entry.path.slice(0, entry.path.lastIndexOf("/"))
        : "";
      const findings: ImportFinding[] = [];
      const folderNote = [parentPath, typed.name].filter(Boolean).join("/");
      if (
        root.kind === "folder" &&
        (typed.kind === "note" || typed.kind === "docx") &&
        folders.has(folderNote)
      ) {
        parentPath = folderNote;
        findings.push({ code: "folder_note", message: "Moved inside its folder" });
      }
      if (/\.zip$/i.test(filename))
        findings.push({
          code: "zip",
          message: "Unzip it and select the folder to import its contents",
        });
      if (renderFilename(typed.name, typed.extension) !== filename && typed.kind === "binary")
        findings.push({ code: "binary_extension", message: "Renamed to match its binary type" });
      nodes.push({
        id: mintId(),
        parentId: root.kind === "folder" ? makeFolder(skip ? "" : parentPath).id : destinationId,
        rootId: root.rootId,
        entryId: entry.entryId,
        path: entry.path,
        filename,
        ...typed,
        size: entry.size,
        sha256: entry.sha256,
        state: skip ? "skipped" : "planned",
        reason: skip,
        findings,
      });
    }
  }
  // Parents precede children; the already-spelled canonical name wins among siblings.
  const depth = (node: PlannedNode): number => {
    const parent = nodes.find((item) => item.id === node.parentId);
    return parent ? depth(parent) + 1 : 0;
  };
  return nodes.sort(
    (a, b) =>
      depth(a) - depth(b) ||
      (a.kind === "folder" ? -1 : 1) - (b.kind === "folder" ? -1 : 1) ||
      Number(renderFilename(b.name, b.extension) === b.filename) -
        Number(renderFilename(a.name, a.extension) === a.filename) ||
      codePointOrder(a.filename, b.filename),
  );
}
