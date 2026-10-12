/** Selection from a file input: a folder pick (`webkitdirectory`) or loose files (`multiple`). */
import { isImportableName, isImportablePath, isOmittedPath, normalizeName } from "./path-rules";
import {
  browserHidesDotEntries,
  holdSettings,
  noteHiddenSettings,
  type ReaderOptions,
  readSideFile,
  type SelectedRoot,
  type Selection,
  textOf,
} from "./selection";

const APP_JSON = ".obsidian/app.json";
const EXPORT_MARKER = "meridian-export.json";

/** A picked folder's files all start with its name; loose files carry no folder. */
export async function readPicked(
  files: readonly File[],
  { hidesDotEntries = browserHidesDotEntries() }: ReaderOptions = {},
): Promise<Selection> {
  const folderPick =
    files.length > 0 && files.every((file) => file.webkitRelativePath.includes("/"));
  return folderPick ? readFolderPick(files, hidesDotEntries) : readLooseFiles(files);
}

async function readFolderPick(
  files: readonly File[],
  hidesDotEntries: boolean,
): Promise<Selection> {
  const name = files[0].webkitRelativePath.split("/")[0];
  if (!isImportableName(name)) return { roots: [], leftOut: [{ name, kind: "folder" }] };
  const root: SelectedRoot = {
    rootId: 0,
    kind: "folder",
    name: normalizeName(name),
    files: [],
    folders: [],
    unreadable: [],
  };
  for (const file of files) {
    const path = file.webkitRelativePath.slice(name.length + 1);
    if (path === APP_JSON) holdSettings(root, await readSideFile(file));
    else if (path === EXPORT_MARKER) root.meridianExport = textOf(await readSideFile(file));
    if (isOmittedPath(path)) continue;
    if (!isImportablePath(path))
      root.unreadable.push({ path: normalizeNamePath(path), reason: "unreadable" });
    else root.files.push({ path: normalizeNamePath(path), file });
  }
  noteHiddenSettings(root, hidesDotEntries);
  return { roots: [root], leftOut: [] };
}

async function readLooseFiles(files: readonly File[]): Promise<Selection> {
  const selection: Selection = { roots: [], leftOut: [] };
  for (const file of files) {
    if (isOmittedPath(file.name)) continue;
    if (!isImportableName(file.name)) {
      selection.leftOut.push({ name: file.name, kind: "file" });
      continue;
    }
    selection.roots.push({
      rootId: selection.roots.length,
      kind: "file",
      name: normalizeName(file.name),
      files: [{ path: "", file }],
      folders: [],
      unreadable: [],
    });
  }
  return selection;
}

export function normalizeNamePath(path: string): string {
  return path.split("/").map(normalizeName).join("/");
}
