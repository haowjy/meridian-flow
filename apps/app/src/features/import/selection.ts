/** What the writer chose, as the browser could read it: roots, files, folders and what was left out. */
import type { ImportSettingsUnread, ImportUnreadableReason } from "@meridian/contracts";

export type SelectedFile = { path: string; file: File };

export type UnreadableItem = { path: string; reason: ImportUnreadableReason };

/** One top-level item. Two folders both called `Book` are two roots. */
export type SelectedRoot = {
  rootId: number;
  kind: "folder" | "file";
  name: string;
  /** Path relative to the root; "" for a file root. */
  files: SelectedFile[];
  /** Directories the reader saw. A folder pick cannot see empty ones. */
  folders: string[];
  /** Files and folders inside the root that could not be opened. */
  unreadable: UnreadableItem[];
  /** Text of `.obsidian/app.json`, when the browser shared it. */
  appJson?: string;
  /** Why there is no `appJson` although the folder may have Obsidian settings. */
  appJsonUnread?: ImportSettingsUnread;
  /** Text of `meridian-export.json` at the folder's top. */
  meridianExport?: string;
};

export type Selection = {
  roots: SelectedRoot[];
  /** Top-level items that could not be opened at all; nothing of them is sent. */
  leftOut: { name: string; kind: "folder" | "file" }[];
};

export const EMPTY_SELECTION: Selection = { roots: [], leftOut: [] };

/** Upper bound on a JSON side file the manifest carries. */
export const SIDE_FILE_MAX_CHARS = 1024 * 1024;

export function unreadableReason(error: unknown): ImportUnreadableReason {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotFoundError") return "not_found";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  return "unreadable";
}

export type SideFile = { text: string } | { unread: "unreadable" | "too_large" };

/** Read a small JSON side file, or say why it could not be. */
export async function readSideFile(file: File): Promise<SideFile> {
  if (file.size > SIDE_FILE_MAX_CHARS) return { unread: "too_large" };
  try {
    const text = await file.text();
    return text.length > SIDE_FILE_MAX_CHARS ? { unread: "too_large" } : { text };
  } catch {
    return { unread: "unreadable" };
  }
}

/** A side file's text, or nothing when it could not be read. */
export const textOf = (read: SideFile) => ("text" in read ? read.text : undefined);

/** Put a read `.obsidian/app.json` on its root, or why it is not there. */
export function holdSettings(root: SelectedRoot, read: SideFile) {
  if ("text" in read) root.appJson = read.text;
  else root.appJsonUnread = read.unread;
}

/**
 * Safari (and every iOS browser, all WebKit) hides dot-entries from folder
 * picks and drops, so `.obsidian` never arrives there.
 */
export function browserHidesDotEntries(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent;
  return /AppleWebKit/.test(agent) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(agent);
}

const NOTE = /\.(md|markdown)$/i;

/**
 * A folder of notes read by a browser that hides dot-folders may have had
 * settings it never saw; say so rather than claim there were none.
 */
export function noteHiddenSettings(root: SelectedRoot, hidesDotEntries: boolean) {
  if (!hidesDotEntries || root.kind !== "folder") return;
  if (root.appJson !== undefined || root.appJsonUnread !== undefined) return;
  if (root.files.some(({ path }) => NOTE.test(path))) root.appJsonUnread = "unavailable";
}

export type ReaderOptions = { hidesDotEntries?: boolean };

export type SelectionTotals = {
  files: number;
  folders: number;
  bytes: number;
  /** Files over the per-file limit, which are listed but not imported. */
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
