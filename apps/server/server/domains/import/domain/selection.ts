/** Selection identity without reading bytes or creating Context nodes. */
import {
  EXPORT_WORKS_FOLDER,
  IMPORT_ADMISSION,
  type ImportSelection,
  importNodeId,
  importPathDisposition,
} from "@meridian/contracts";
import type { ImportEntry, ImportRoot } from "../ports/import-repository.js";
import { readExportMarker } from "./export-marker.js";
export function selectionRows(
  selection: ImportSelection,
  projectId: string,
): { roots: ImportRoot[]; entries: ImportEntry[] } {
  const marker = readExportMarker(selection);
  const entries: ImportEntry[] = [];
  const byRoot = new Map(selection.roots.map((root) => [root.rootId, root]));
  const folders = new Set<string>();
  const id = (kind: "folder" | "entry" | "unreadable", rootId: number, path: string) =>
    importNodeId({ projectId, importId: selection.importId, kind, rootId, path });
  const add = (
    kind: ImportEntry["kind"],
    rootId: number,
    path: string,
    entryId: number | null,
    size = 0,
    modifiedAt = 0,
  ): ImportEntry => {
    const root = byRoot.get(rootId);
    const disposition = importPathDisposition(path || root?.name || "");
    const reason =
      size > IMPORT_ADMISSION.fileBytes
        ? "too_large"
        : marker && path.split("/")[0] === EXPORT_WORKS_FOLDER
          ? "export_works"
          : disposition === "omit"
            ? "hidden"
            : disposition;
    const entry: ImportEntry = {
      id: id(kind === "file" ? "entry" : kind, rootId, path),
      importId: selection.importId,
      ordinal: entries.length,
      kind,
      entryId,
      selection: { rootId, path, size, modifiedAt },
      state:
        reason === "too_large"
          ? "failed"
          : reason
            ? "skipped"
            : kind === "folder"
              ? "received"
              : "awaiting",
      reason,
      changedAfterUpload: false,
      receipt: null,
      convertedKey: null,
    } as ImportEntry;
    entries.push(entry);
    return entry;
  };
  const folder = (rootId: number, path: string) => {
    const key = `${rootId}:${path}`;
    if (folders.has(key)) return;
    folders.add(key);
    if (path) folder(rootId, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    if (marker && (!path || marker.areas.has(path))) return;
    add("folder", rootId, path, null);
  };
  const roots = selection.roots.map((root) => ({
    ...root,
    id: root.kind === "folder" && !marker ? id("folder", root.rootId, "") : null,
    created: false,
  }));
  for (const root of roots)
    if (
      root.kind === "folder" &&
      !selection.unreadable?.some((item) => item.rootId === root.rootId && item.path === "")
    )
      folder(root.rootId, "");
  for (const item of selection.folders) folder(item.rootId, item.path);
  for (const item of selection.entries) {
    if (item.path.includes("/"))
      folder(item.rootId, item.path.slice(0, item.path.lastIndexOf("/")));
    add("file", item.rootId, item.path, item.entryId, item.size, item.modifiedAt);
  }
  for (const [index, item] of (selection.unreadable ?? []).entries()) {
    const entry = add("unreadable", item.rootId, item.path, -index - 1);
    entry.state = "skipped";
    entry.reason = "unreadable";
    entry.selection.reasonParams = { readReason: item.reason ?? "unreadable" };
  }
  return { roots, entries };
}
