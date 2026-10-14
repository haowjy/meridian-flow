/**
 * The rows the importing tab draws before the server has created anything:
 * a folder row for each selected folder and every folder beneath it, and a
 * file row for every file, each under its source name and where it will land.
 */

import type { ImportScheme } from "@meridian/contracts";
import { importPathDisposition, parseExportMarker } from "@meridian/contracts";
import { type ImportDestination, joinCatalogPath } from "./destination";
import { filenameForDisplay } from "./display-name";
import type { Selection } from "./selection";

export type ClientRow = {
  /** Stable across the plan answering: `<rootId>:<path>`. */
  key: string;
  kind: "dir" | "file";
  /** Source name, as the writer's file system spells it. */
  name: string;
  scheme: ImportScheme;
  /** Catalog path of the folder that will hold this row; "/" for an area root. */
  parentPath: string;
  rootId: number;
  /** Path under the root; "" for the root itself. */
  relPath: string;
  /** Manifest entry id, for files. */
  entryId?: number;
};

function join(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

export function clientRowsFor(
  selection: Selection,
  destination: ImportDestination,
  entryIdOf: (rootId: number, path: string) => number | undefined,
): ClientRow[] {
  const rows: ClientRow[] = [];
  const parsed =
    selection.roots.length === 1 && selection.roots[0].kind === "folder"
      ? parseExportMarker(selection.roots[0].meridianExport)
      : ({ status: "absent" } as const);
  // The server refuses an invalid marker; draw nothing rather than an ordinary folder.
  if (parsed.status === "invalid") return [];
  const marker = parsed.status === "valid" ? parsed : null;
  for (const root of selection.roots) {
    if (root.kind === "file") {
      const file = root.files[0];
      if (!file || importPathDisposition(file.path || root.name) !== null) continue;
      rows.push({
        key: `${root.rootId}:`,
        kind: "file",
        name: filenameForDisplay(root.name),
        scheme: destination.scheme,
        parentPath: destination.path,
        rootId: root.rootId,
        relPath: "",
        entryId: entryIdOf(root.rootId, ""),
      });
      continue;
    }
    // A Meridian export's folders go straight to their areas; no wrapper folder.
    const place = (relPath: string): { scheme: ImportScheme; parentPath: string } | null => {
      if (!marker) {
        const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
        return {
          scheme: destination.scheme,
          parentPath: parent
            ? parent
                .split("/")
                .reduce(joinCatalogPath, joinCatalogPath(destination.path, root.name))
            : joinCatalogPath(destination.path, root.name),
        };
      }
      const [top, ...rest] = relPath.split("/");
      const scheme = marker.areas.get(top);
      if (!scheme) return null;
      rest.pop();
      return { scheme, parentPath: rest.reduce(joinCatalogPath, "/") };
    };
    if (!marker)
      rows.push({
        key: `${root.rootId}:`,
        kind: "dir",
        name: root.name,
        scheme: destination.scheme,
        parentPath: destination.path,
        rootId: root.rootId,
        relPath: "",
      });
    const folders = new Set(
      root.folders.filter((folder) => importPathDisposition(folder) === null),
    );
    const drawn = root.files.filter((file) => importPathDisposition(file.path) === null);
    for (const file of drawn) {
      const parts = file.path.split("/");
      for (let depth = 1; depth < parts.length; depth += 1)
        folders.add(parts.slice(0, depth).join("/"));
    }
    for (const folder of folders) {
      const placed = place(folder);
      if (!placed) continue;
      // An area's own folder is the area root, not a row.
      if (marker && !folder.includes("/")) continue;
      rows.push({
        key: `${root.rootId}:${folder}`,
        kind: "dir",
        name: folder.split("/").at(-1) ?? folder,
        ...placed,
        rootId: root.rootId,
        relPath: folder,
      });
    }
    for (const file of drawn) {
      const placed = place(file.path);
      if (!placed) continue;
      rows.push({
        key: `${root.rootId}:${file.path}`,
        kind: "file",
        name: filenameForDisplay(file.path.split("/").at(-1) ?? file.path),
        ...placed,
        rootId: root.rootId,
        relPath: file.path,
        entryId: entryIdOf(root.rootId, file.path),
      });
    }
  }
  return rows;
}

export { join as joinRelative };
