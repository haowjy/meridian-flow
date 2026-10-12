/**
 * Selection from a drop. A drop's entries and files are dead once the event
 * returns, so `captureDrop` runs inside it and `readDropped` walks the capture.
 */
import { isImportableName, isOmittedPath, normalizeName } from "./path-rules";
import { readSideFile, type SelectedRoot, type Selection, unreadableReason } from "./selection";

export type DroppedItems = {
  entries: (FileSystemEntry | null)[];
  files: File[];
};

/** Call synchronously inside the drop event. */
export function captureDrop(dataTransfer: DataTransfer): DroppedItems {
  return {
    entries: Array.from(dataTransfer.items ?? []).map((item) =>
      item.kind === "file" ? item.webkitGetAsEntry() : null,
    ),
    files: Array.from(dataTransfer.files ?? []),
  };
}

type Walk = {
  root: SelectedRoot;
  seen: { count: number };
  report: (count: number, name: string) => void;
  signal?: AbortSignal;
};

const FILE_BATCH = 24;

export async function readDropped(
  items: DroppedItems,
  options: { signal?: AbortSignal; onProgress?: (count: number, name: string) => void } = {},
): Promise<Selection> {
  const selection: Selection = { roots: [], leftOut: [] };
  const seen = { count: 0 };
  const report = options.onProgress ?? (() => {});
  const entries = items.entries.filter((entry) => entry !== null);
  // Browsers without entries (or items that were not files) still give loose files.
  const sources: (FileSystemEntry | File)[] = entries.length > 0 ? entries : items.files;
  for (const source of sources) {
    if (options.signal?.aborted) break;
    const name = source.name;
    const kind = source instanceof File || source.isFile ? "file" : "folder";
    if (isOmittedPath(name) || (kind === "folder" && (name === ".git" || name === ".obsidian")))
      continue;
    if (!isImportableName(name)) {
      selection.leftOut.push({ name, kind });
      continue;
    }
    const root: SelectedRoot = {
      rootId: selection.roots.length,
      kind,
      name: normalizeName(name),
      files: [],
      folders: [],
      unreadable: [],
    };
    if (kind === "file") {
      try {
        const file =
          source instanceof File ? source : await entryFile(source as FileSystemFileEntry);
        root.files.push({ path: "", file });
        seen.count += 1;
        report(seen.count, name);
      } catch (error) {
        root.unreadable.push({ path: "", reason: unreadableReason(error) });
      }
      selection.roots.push(root);
      continue;
    }
    const walk: Walk = { root, seen, report, signal: options.signal };
    try {
      const directory = source as FileSystemDirectoryEntry;
      await readSettings(directory, root);
      await walkDirectory(directory, "", walk);
    } catch {
      selection.leftOut.push({ name, kind: "folder" });
      continue;
    }
    selection.roots.push(root);
  }
  // Roots are numbered after the unreadable ones leave, so ids stay dense.
  selection.roots.forEach((root, index) => {
    root.rootId = index;
  });
  return selection;
}

async function readSettings(directory: FileSystemDirectoryEntry, root: SelectedRoot) {
  const marker = await childFile(directory, "meridian-export.json");
  if (marker) root.meridianExport = await readSideFile(marker);
  const settings = await childDirectory(directory, ".obsidian");
  const appJson = settings ? await childFile(settings, "app.json") : null;
  if (appJson) root.appJson = await readSideFile(appJson);
}

async function walkDirectory(directory: FileSystemDirectoryEntry, path: string, walk: Walk) {
  const children = await listDirectory(directory);
  const subdirectories: FileSystemDirectoryEntry[] = [];
  const files: FileSystemFileEntry[] = [];
  for (const child of children) {
    const childPath = path ? `${path}/${child.name}` : child.name;
    if (isOmittedPath(childPath) || child.name === ".git") continue;
    if (!isImportableName(child.name)) {
      walk.root.unreadable.push({
        path: normalizePath(childPath),
        reason: child.isDirectory ? "folder_unreadable" : "unreadable",
      });
      continue;
    }
    if (child.isDirectory) subdirectories.push(child as FileSystemDirectoryEntry);
    else files.push(child as FileSystemFileEntry);
  }
  for (let start = 0; start < files.length; start += FILE_BATCH) {
    if (walk.signal?.aborted) return;
    const batch = files.slice(start, start + FILE_BATCH);
    const opened = await Promise.allSettled(batch.map(entryFile));
    opened.forEach((result, index) => {
      const entryPath = normalizePath(path ? `${path}/${batch[index].name}` : batch[index].name);
      if (result.status === "fulfilled") {
        walk.root.files.push({ path: entryPath, file: result.value });
        walk.seen.count += 1;
      } else {
        walk.root.unreadable.push({ path: entryPath, reason: unreadableReason(result.reason) });
      }
    });
    walk.report(walk.seen.count, walk.root.name);
  }
  for (const child of subdirectories) {
    if (walk.signal?.aborted) return;
    const childPath = normalizePath(path ? `${path}/${child.name}` : child.name);
    try {
      walk.root.folders.push(childPath);
      await walkDirectory(child, path ? `${path}/${child.name}` : child.name, walk);
    } catch {
      // A folder that cannot be listed is left out whole; the rest carries on.
      const prefix = `${childPath}/`;
      walk.root.folders = walk.root.folders.filter(
        (folder) => folder !== childPath && !folder.startsWith(prefix),
      );
      walk.root.files = walk.root.files.filter((file) => !file.path.startsWith(prefix));
      walk.root.unreadable.push({ path: childPath, reason: "folder_unreadable" });
    }
  }
}

function normalizePath(path: string): string {
  return path.split("/").map(normalizeName).join("/");
}

/** `readEntries` hands out about 100 at a time; call it again until it returns an empty batch. */
async function listDirectory(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function childFile(directory: FileSystemDirectoryEntry, name: string): Promise<File | null> {
  return new Promise((resolve) =>
    directory.getFile(
      name,
      { create: false },
      (entry) => entryFile(entry as FileSystemFileEntry).then(resolve, () => resolve(null)),
      () => resolve(null),
    ),
  );
}

function childDirectory(
  directory: FileSystemDirectoryEntry,
  name: string,
): Promise<FileSystemDirectoryEntry | null> {
  return new Promise((resolve) =>
    directory.getDirectory(
      name,
      { create: false },
      (entry) => resolve(entry as FileSystemDirectoryEntry),
      () => resolve(null),
    ),
  );
}
