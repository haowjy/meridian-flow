/** Pure identity graph, folder-note relocation and exact-case name allocation. */
import {
  EXPORT_WORKS_FOLDER,
  IMPORT_ADMISSION,
  type ImportEntryReason,
  type ImportManifest,
  type ImportUnreadableReason,
  importNodeId,
  importPathDisposition,
} from "@meridian/contracts";
import type { Filetype } from "@meridian/contracts/protocol";
import { folderDocumentName, renderFilename } from "@meridian/contracts/protocol";
import { classify } from "./classify.js";
import { type ImportArea, readExportMarker } from "./export-marker.js";

export interface PlannedNode {
  id: string;
  area?: ImportArea;
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
  reason: ImportEntryReason | null;
  reasonParams?: { readReason: ImportUnreadableReason };
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
export type MintId = (
  kind: "folder" | "entry" | "unreadable",
  rootId: number,
  path: string,
) => string;

export function planSelection(
  manifest: ImportManifest,
  mintId: MintId,
  destinationId: string | null,
): PlannedNode[] {
  const marker = readExportMarker(manifest);
  const nodes: PlannedNode[] = [];
  for (const root of [...manifest.roots].sort(
    (a, b) => codePointOrder(a.name, b.name) || a.rootId - b.rootId,
  )) {
    const unreadableRoot =
      root.kind === "folder" &&
      (manifest.unreadable ?? []).some((item) => item.rootId === root.rootId && item.path === "");
    const folders = new Map<string, { id: string | null }>();
    if (marker) {
      folders.set("", { id: destinationId });
      for (const area of marker.areas.keys()) folders.set(area, { id: null });
    }
    const makeFolder = (path: string): { id: string | null } => {
      const existing = folders.get(path);
      if (existing) return existing;
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const parentId = path === "" ? destinationId : makeFolder(parentPath).id;
      const filename = path === "" ? root.name : (path.split("/").at(-1) ?? "");
      const node: PlannedNode = {
        id: mintId("folder", root.rootId, path),
        ...(marker?.areas.get(path.split("/")[0])
          ? { area: marker.areas.get(path.split("/")[0]) }
          : {}),
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
      };
      folders.set(path, node);
      nodes.push(node);
      return node;
    };
    if (root.kind === "folder" && !unreadableRoot) {
      makeFolder("");
      for (const entry of [...manifest.folders, ...manifest.entries].filter(
        (item) => item.rootId === root.rootId,
      )) {
        if (
          importPathDisposition(entry.path) ||
          (marker && entry.path.split("/")[0] === EXPORT_WORKS_FOLDER)
        )
          continue;
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
      const skip =
        entry.size > IMPORT_ADMISSION.fileBytes
          ? "too_large"
          : marker && entry.path.split("/")[0] === EXPORT_WORKS_FOLDER
            ? "export_works"
            : importPathDisposition(entry.path || filename);
      if (skip === "omit") continue;
      const typed = classify(filename, Buffer.from(entry.sniff ?? "", "base64"));
      let parentPath = entry.path.includes("/")
        ? entry.path.slice(0, entry.path.lastIndexOf("/"))
        : "";
      const folderNote = [parentPath, typed.name].filter(Boolean).join("/");
      if (
        root.kind === "folder" &&
        (typed.kind === "note" || typed.kind === "docx") &&
        folders.has(folderNote)
      ) {
        parentPath = folderNote;
      }
      nodes.push({
        id: mintId("entry", root.rootId, entry.path),
        ...(marker?.areas.get(entry.path.split("/")[0])
          ? { area: marker.areas.get(entry.path.split("/")[0]) }
          : {}),
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
      });
    }
  }
  for (const [index, unreadable] of (manifest.unreadable ?? []).entries()) {
    const root = manifest.roots.find((root) => root.rootId === unreadable.rootId);
    const filename = unreadable.path.split("/").at(-1) || root?.name || "";
    nodes.push({
      id: mintId("unreadable", unreadable.rootId, unreadable.path),
      parentId: destinationId,
      rootId: unreadable.rootId,
      entryId: -index - 1,
      path: unreadable.path,
      filename,
      name: filename,
      extension: "",
      kind: "note",
      filetype: "markdown",
      size: 0,
      sha256: "",
      mimeType: "",
      state: "skipped",
      reason: "unreadable",
      reasonParams: { readReason: unreadable.reason ?? "unreadable" },
    });
  }
  // Parents precede children; the already-spelled canonical name wins among siblings.
  // Names are allocated against the live listing only when a chunk locks the parent.
  const depths = new Map<string, number>();
  for (const node of nodes) depths.set(node.id, (depths.get(node.parentId ?? "") ?? -1) + 1);
  const depth = (node: PlannedNode) => depths.get(node.id) ?? 0;
  return nodes.sort(
    (a, b) =>
      depth(a) - depth(b) ||
      (a.kind === "folder" ? -1 : 1) - (b.kind === "folder" ? -1 : 1) ||
      Number(renderFilename(b.name, b.extension) === b.filename) -
        Number(renderFilename(a.name, a.extension) === a.filename) ||
      codePointOrder(a.filename, b.filename),
  );
}

/** Plans with every node id derived by `importNodeId`. */
export function planWithDerivedIds(
  manifest: ImportManifest,
  scope: { projectId: string },
  destinationId: string | null,
): PlannedNode[] {
  return planSelection(
    manifest,
    (kind, rootId, path) =>
      importNodeId({ projectId: scope.projectId, importId: manifest.importId, rootId, kind, path }),
    destinationId,
  );
}
