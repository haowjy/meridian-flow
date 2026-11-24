import { IMPORT_ADMISSION, type ImportUnreadableReason } from "@meridian/contracts";

export type SelectedFile = { path: string; file: File };

export type UnreadableItem = { path: string; reason: ImportUnreadableReason };

export type SelectedRoot = {
  rootId: number;
  kind: "folder" | "file";
  name: string;
  files: SelectedFile[];
  folders: string[];
  unreadable: UnreadableItem[];
  appJson?: string;
  meridianExport?: string;
};

export type Selection = {
  roots: SelectedRoot[];
  leftOut: { name: string; kind: "folder" | "file" }[];
};

export const EMPTY_SELECTION: Selection = { roots: [], leftOut: [] };

export function unreadableReason(error: unknown): ImportUnreadableReason {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotFoundError") return "not_found";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  return "unreadable";
}

export async function readSideFile(file: File): Promise<string | undefined> {
  if (file.size > IMPORT_ADMISSION.sideFileBytes) return undefined;
  try {
    const text = await file.text();
    return text.length > IMPORT_ADMISSION.sideFileBytes ? undefined : text;
  } catch {
    return undefined;
  }
}

export type SelectionTotals = {
  files: number;
  folders: number;
  bytes: number;
  oversize: number;
  unreadableFiles: number;
};

export function rootTotals(root: SelectedRoot, fileBytesLimit: number): SelectionTotals {
  const folderPaths = new Set<string>(root.folders);
  let bytes = 0;
  let oversize = 0;
  for (const { path, file } of root.files) {
    bytes += file.size;
    if (file.size > fileBytesLimit) oversize += 1;
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const folder = path.slice(0, slash);
      if (folderPaths.has(folder)) break;
      folderPaths.add(folder);
      slash = folder.lastIndexOf("/");
    }
  }
  return {
    files: root.files.length,
    folders: folderPaths.size,
    bytes,
    oversize,
    unreadableFiles: root.unreadable.length,
  };
}

export function selectionTotals(selection: Selection, fileBytesLimit: number): SelectionTotals {
  const total: SelectionTotals = {
    files: 0,
    folders: 0,
    bytes: 0,
    oversize: 0,
    unreadableFiles: 0,
  };
  for (const root of selection.roots) {
    const each = rootTotals(root, fileBytesLimit);
    total.files += each.files;
    total.folders += each.folders;
    total.bytes += each.bytes;
    total.oversize += each.oversize;
    total.unreadableFiles += each.unreadableFiles;
  }
  return total;
}
