/**
 * The rows the importing tab predicts before the plan answers: a folder row for each
 * selected folder and every folder beneath it, and a file row for every file, each
 * under its source name. Rows carry the ids the server's plan will give the same
 * nodes (`importNodeId`) and their parent's id, so the catalog's real row replaces a
 * predicted one by id the moment it publishes.
 */

import type { ImportManifest, ImportScheme } from "@meridian/contracts";
import { importNodeId, importPathDisposition, parseExportMarker } from "@meridian/contracts";
import type { ImportDestination } from "./destination";
import { filenameForDisplay } from "./display-name";
import type { Selection } from "./selection";

export type ClientRow = {
  /** The id the plan gives this node. */
  id: string;
  /** The folder row it sits under: null at the root of `scheme`. */
  parentId: string | null;
  kind: "dir" | "file";
  /** Source name, as the writer's file system spells it. */
  name: string;
  scheme: ImportScheme;
  rootId: number;
  /** Path under the root; "" for the root itself. */
  relPath: string;
};

/** What the rows are drawn from: the picked selection, then the built manifest. */
export type RowSource = {
  rootId: number;
  kind: "folder" | "file";
  name: string;
  meridianExport?: string;
  folders: readonly string[];
  files: readonly string[];
}[];

export function sourceOfSelection(selection: Selection): RowSource {
  return selection.roots.map((root) => ({
    rootId: root.rootId,
    kind: root.kind,
    name: root.name,
    meridianExport: root.meridianExport,
    folders: root.folders,
    files: root.files.map((file) => file.path),
  }));
}

/** Unreadable files drop out of a built manifest, along with folders only they implied. */
export function sourceOfManifest(manifest: ImportManifest): RowSource {
  return manifest.roots.map((root) => ({
    rootId: root.rootId,
    kind: root.kind,
    name: root.name,
    meridianExport: root.meridianExport,
    folders: manifest.folders.filter((f) => f.rootId === root.rootId).map((f) => f.path),
    files: manifest.entries.filter((e) => e.rootId === root.rootId).map((e) => e.path),
  }));
}

/** Node ids for one import, derived once and remembered across the rebuild. */
export function nodeIdsFor(projectId: string, importId: string) {
  const cache = new Map<string, Promise<string>>();
  return (kind: "folder" | "entry", rootId: number, path: string): Promise<string> => {
    const key = `${kind}\u0000${rootId}\u0000${path}`;
    let id = cache.get(key);
    if (!id) {
      id = importNodeId({ projectId, importId, rootId, kind, path });
      cache.set(key, id);
    }
    return id;
  };
}
export type NodeIds = ReturnType<typeof nodeIdsFor>;

const lastSegment = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const parentPathOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

type NodeKey = readonly ["folder" | "entry", number, string];
/** `parent`: a node, `"destination"` for the folder the import started on, null for an area root. */
type Draft = Omit<ClientRow, "id" | "parentId"> & {
  key: NodeKey;
  parent: NodeKey | "destination" | null;
};

export async function clientRowsFor(
  source: RowSource,
  destination: ImportDestination,
  ids: NodeIds,
): Promise<ClientRow[]> {
  const marker =
    source.length === 1 && source[0].kind === "folder"
      ? parseExportMarker(source[0].meridianExport)
      : ({ status: "absent" } as const);
  // The server refuses an invalid marker; draw nothing rather than an ordinary folder.
  if (marker.status === "invalid") return [];
  const routed = marker.status === "valid" ? marker : null;
  const drafts: Draft[] = [];
  for (const root of source) {
    if (root.kind === "file") {
      const path = root.files[0];
      if (path === undefined || importPathDisposition(path || root.name) !== null) continue;
      drafts.push({
        key: ["entry", root.rootId, ""],
        parent: "destination",
        kind: "file",
        name: filenameForDisplay(root.name),
        scheme: destination.scheme,
        rootId: root.rootId,
        relPath: "",
      });
      continue;
    }
    const drawn = root.files.filter((file) => importPathDisposition(file) === null);
    const folders = new Set(
      root.folders.filter((folder) => importPathDisposition(folder) === null),
    );
    for (const file of drawn) {
      const parts = file.split("/");
      for (let depth = 1; depth < parts.length; depth += 1)
        folders.add(parts.slice(0, depth).join("/"));
    }
    // A Meridian export's folders go straight to their areas; an area's own folder
    // is the area root, not a row.
    const placeOf = (relPath: string) => {
      if (!routed) return { scheme: destination.scheme, parentRel: parentPathOf(relPath) };
      const area = routed.areas.get(relPath.split("/")[0]);
      if (!area) return null;
      const parent = parentPathOf(relPath);
      return { scheme: area, parentRel: parent.includes("/") ? parent : null };
    };
    const folderKey = (rel: string | null): NodeKey | null =>
      rel === null ? null : ["folder", root.rootId, rel];
    if (!routed)
      drafts.push({
        key: ["folder", root.rootId, ""],
        parent: "destination",
        kind: "dir",
        name: root.name,
        scheme: destination.scheme,
        rootId: root.rootId,
        relPath: "",
      });
    for (const folder of folders) {
      const placed = placeOf(folder);
      if (!placed || (routed && !folder.includes("/"))) continue;
      drafts.push({
        key: ["folder", root.rootId, folder],
        parent: folderKey(placed.parentRel),
        kind: "dir",
        name: lastSegment(folder),
        scheme: placed.scheme,
        rootId: root.rootId,
        relPath: folder,
      });
    }
    for (const file of drawn) {
      const placed = placeOf(file);
      if (!placed) continue;
      drafts.push({
        key: ["entry", root.rootId, file],
        parent: folderKey(placed.parentRel),
        kind: "file",
        name: filenameForDisplay(lastSegment(file)),
        scheme: placed.scheme,
        rootId: root.rootId,
        relPath: file,
      });
    }
  }
  const nameOf = (key: NodeKey) => key.join("\u0000");
  const keys = new Map<string, NodeKey>();
  for (const { key, parent } of drafts) {
    keys.set(nameOf(key), key);
    if (parent && parent !== "destination") keys.set(nameOf(parent), parent);
  }
  const resolved = new Map<string, string>();
  await Promise.all([...keys].map(async ([name, key]) => resolved.set(name, await ids(...key))));
  return drafts.map(({ key, parent, ...row }) => ({
    ...row,
    id: resolved.get(nameOf(key)) as string,
    parentId:
      parent === "destination"
        ? destination.folderId
        : parent
          ? (resolved.get(nameOf(parent)) as string)
          : null,
  }));
}
