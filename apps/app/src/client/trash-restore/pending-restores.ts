/**
 * Documents a drag-restore is placing, shown in their destination before the server answers.
 * The restore is one online request, not a replica journal entry, so these rows live in memory
 * only: a reload shows the server's truth. Each stands at its predicted free name and ends when
 * the real row arrives in the catalog (`overlayPendingRestores` skips it then), when its request
 * fails, or when `SETTLED_VISIBLE_MS` after the answer has passed.
 */
import {
  firstFreeName,
  type ProjectContextTreeScheme,
  type RestoreContextDocumentsRequest,
  storedFilename,
} from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";

export type RestoreDestination = NonNullable<RestoreContextDocumentsRequest["destination"]>;

export type PendingRestore = {
  documentId: string;
  /** The rendered filename as Trash shows it. */
  name: string;
  destination: RestoreDestination;
  /** Set once the server has answered: the row stays until the catalog lists it, or this passes. */
  settledAt?: number;
};

const SETTLED_VISIBLE_MS = 15_000;
const EMPTY: readonly PendingRestore[] = [];

let byProject: ReadonlyMap<string, readonly PendingRestore[]> = new Map();
const listeners = new Set<() => void>();

function publish(next: ReadonlyMap<string, readonly PendingRestore[]>) {
  byProject = next;
  for (const listener of listeners) listener();
}

function update(
  projectId: string,
  change: (current: readonly PendingRestore[]) => PendingRestore[],
) {
  const next = new Map(byProject);
  const rows = change(byProject.get(projectId) ?? EMPTY);
  if (rows.length === 0) next.delete(projectId);
  else next.set(projectId, rows);
  publish(next);
}

export function addPendingRestores(projectId: string, rows: readonly PendingRestore[]) {
  update(projectId, (current) => [...current, ...rows]);
}

export function dropPendingRestores(projectId: string, documentIds: readonly string[]) {
  const gone = new Set(documentIds);
  update(projectId, (current) => current.filter((row) => !gone.has(row.documentId)));
}

/** The server answered for these: they stay listed until the catalog has them. */
export function settlePendingRestores(projectId: string, documentIds: readonly string[]) {
  const done = new Set(documentIds);
  const at = Date.now();
  update(projectId, (current) =>
    current.map((row) => (done.has(row.documentId) ? { ...row, settledAt: at } : row)),
  );
  setTimeout(() => dropPendingRestores(projectId, documentIds), SETTLED_VISIBLE_MS);
}

export function usePendingRestores(projectId: string): readonly PendingRestore[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => byProject.get(projectId) ?? EMPTY,
    () => EMPTY,
  );
}

/**
 * The view with every pending restore of this scheme listed in its destination: under the name
 * the server will give it (the first free one, as a move allocates), at its position, in request
 * order. A row the catalog already lists is left to the catalog.
 */
export function overlayPendingRestores(
  base: CatalogContextView,
  scheme: ProjectContextTreeScheme,
  pending: readonly PendingRestore[],
): CatalogContextView {
  const sourceId = base.normalized.sourceIdsByScheme.get(scheme);
  const parentOf = (row: PendingRestore): string | null => {
    const { parent } = row.destination;
    if (parent.kind === "root") return parent.scheme === scheme ? base.root.entryId : null;
    const folder = base.normalized.entries.get(parent.folderId);
    return folder?.kind === "folder" && folder.sourceId === sourceId ? folder.entryId : null;
  };
  const arriving = new Map<string, CatalogFile[]>();
  const occupied = new Map<string, Set<string>>();
  for (const row of pending) {
    const parentId = parentOf(row);
    if (parentId === null || base.normalized.entries.has(row.documentId)) continue;
    let names = occupied.get(parentId);
    if (!names) {
      names = new Set(base.children(parentId).map((child) => child.name));
      occupied.set(parentId, names);
    }
    const stored = storedFilename(row.name);
    const free = stored.ok
      ? firstFreeName(stored.filename, names)
      : { filename: row.name, extension: "" };
    names.add(free.filename);
    const parentPath = parentId === base.root.entryId ? "" : pathOf(base, parentId);
    const file: CatalogFile = {
      kind: "file",
      entryId: row.documentId,
      parentId,
      documentId: row.documentId,
      name: free.filename,
      extension: free.extension,
      path: `${parentPath}/${free.filename}`,
      uri: `${base.root.uri.replace(/\/*$/, "/")}${`${parentPath}/${free.filename}`.slice(1)}`,
      provisionalName: false,
      hasProperties: false,
      editable: false,
      disposition: "binary",
      fileType: "binary",
      placementPending: true,
    };
    arriving.set(parentId, [...(arriving.get(parentId) ?? []), file]);
  }
  if (arriving.size === 0) return base;
  const position = new Map(
    pending.flatMap((row) =>
      row.destination.position ? [[row.documentId, row.destination.position] as const] : [],
    ),
  );
  return {
    ...base,
    children: (parentId) => {
      const files = arriving.get(parentId);
      const children = [...base.children(parentId)];
      if (!files) return children;
      // The first arrival takes the dropped position; each next one follows the one before it.
      let at = children.length;
      files.forEach((file, index) => {
        const wanted = position.get(file.documentId);
        if (index === 0 && wanted) {
          if (wanted.kind === "start") at = 0;
          else if ("siblingId" in wanted) {
            const anchor = children.findIndex((child) => child.entryId === wanted.siblingId);
            if (anchor >= 0) at = wanted.kind === "before" ? anchor : anchor + 1;
          }
        }
        children.splice(at, 0, file);
        at += 1;
      });
      return children;
    },
    files: () => [...base.files(), ...[...arriving.values()].flat()],
    findDocument: (documentId) =>
      base.findDocument(documentId) ??
      [...arriving.values()].flat().find((file) => file.documentId === documentId) ??
      null,
  };
}

function pathOf(base: CatalogContextView, folderId: string): string {
  const entry = base.normalized.entries.get(folderId);
  return entry?.kind === "folder" ? `/${entry.path.join("/")}` : "";
}
