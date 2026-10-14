/**
 * Import rows over a catalog view: a pure function of the catalog and the
 * coordinator's snapshot, keyed by node id. It never writes back.
 *
 * For each node an import knows (predicted before the plan answers, the status's
 * plan nodes after), the rows are:
 *  1. the catalog holds it: the catalog row, marked arriving or failed;
 *  2. the coordinator has seen the catalog hold it: nothing (it moved out of view
 *     or was deleted);
 *  3. before acceptance: the predicted row under its parent id;
 *  4. accepted, a code or binary file that has not landed: an overlay row under the
 *     planned parent, with the allocated name;
 *  5. accepted and materialized: an overlay only while a bridge is open;
 *  6. otherwise nothing.
 * An overlay whose parent is drawn nowhere is not drawn.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { renderFilename } from "@meridian/contracts/protocol";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
} from "@/client/query/context-catalog-projection";
import { filenameForDisplay } from "./display-name";
import { effectiveEntry, fullyRead, type ImportState } from "./import-state";

/** What the projection reads of one import: its state and the coordinator's evidence. */
export type ProjectedImport = {
  importId: string;
  state: ImportState;
  /** Node ids the catalog has held while this tab tracked the import. */
  seen: ReadonlySet<string>;
  /** Node ids materialized on the server that this tab drew and the catalog may not show yet. */
  bridges: ReadonlySet<string>;
};

type Failure = NonNullable<NonNullable<CatalogFile["import"]>["failure"]>;

/** One node an import knows, however it came to know it. */
type Node = {
  id: string;
  parentId: string | null;
  kind: "dir" | "file";
  scheme: ProjectContextTreeScheme;
  name: string;
  /** The server's plan holds the node (the status was read). */
  accepted: boolean;
  /** Materialized in context at plan time, or landed: only a bridge draws it. */
  materialized: boolean;
  /** Text or file has not landed. */
  arriving: boolean;
  failure?: Failure;
  seen: boolean;
  bridged: boolean;
};

function nodesOf(item: ProjectedImport): Node[] {
  const { state, seen, bridges } = item;
  const report = fullyRead(state.report) ? state.report : null;
  if (!report) {
    return (state.local?.rows ?? []).map((row) => ({
      id: row.id,
      parentId: row.parentId,
      kind: row.kind,
      scheme: row.scheme,
      name: row.name,
      accepted: false,
      materialized: false,
      arriving: true,
      seen: seen.has(row.id),
      bridged: false,
    }));
  }
  const nodes: Node[] = [];
  for (const folder of report.folders.values()) {
    if (folder.state === "deleted") continue;
    nodes.push({
      id: folder.id,
      parentId: folder.parentId,
      kind: "dir",
      scheme: folder.scheme,
      name: folder.name,
      accepted: true,
      materialized: true,
      arriving: false,
      seen: seen.has(folder.id),
      bridged: bridges.has(folder.id),
    });
  }
  const canRetry = state.local?.held != null;
  for (const raw of report.entries.values()) {
    const entry = effectiveEntry(state, raw);
    if (entry.state === "skipped" || entry.state === "deleted" || entry.state === "not_imported")
      continue;
    const placeholder = entry.kind === "note" || entry.kind === "docx";
    const unlanded = entry.state === "planned" || entry.state === "landing";
    nodes.push({
      id: entry.documentId,
      parentId: entry.parentId,
      kind: "file",
      scheme: entry.scheme,
      name: filenameForDisplay(renderFilename(entry.name, entry.extension)),
      accepted: true,
      materialized: placeholder || entry.state === "landed",
      arriving: unlanded,
      ...(entry.state === "failed"
        ? {
            failure: {
              importId: item.importId,
              entryId: entry.entryId,
              reason: entry.reason,
              canRetry,
            },
          }
        : {}),
      seen: seen.has(entry.documentId),
      bridged: bridges.has(entry.documentId),
    });
  }
  return nodes;
}

/** Layers every given import's nodes over `catalog`; the view is unchanged when none touch it. */
export function withImportRows(
  catalog: CatalogContextView,
  scheme: ProjectContextTreeScheme,
  imports: readonly ProjectedImport[],
): CatalogContextView {
  const held = (id: string) =>
    catalog.findDocument(id) !== null || catalog.normalized.entries.get(id)?.kind === "folder";
  const nodes = new Map<string, Node & { importId: string }>();
  for (const item of imports)
    for (const node of nodesOf(item)) nodes.set(node.id, { ...node, importId: item.importId });

  const drawn = new Map<string, boolean>();
  const parentPresent = (parentId: string | null): boolean =>
    parentId === null || held(parentId) || overlaid(parentId);
  const overlaid = (id: string): boolean => {
    const cached = drawn.get(id);
    if (cached !== undefined) return cached;
    drawn.set(id, false); // a cycle draws nothing
    const node = nodes.get(id);
    const wanted =
      node !== undefined &&
      node.scheme === scheme &&
      !held(id) &&
      !node.seen &&
      (node.accepted ? (node.materialized ? node.bridged : true) : true) &&
      parentPresent(node.parentId);
    drawn.set(id, wanted);
    return wanted;
  };

  // Folders holding arriving rows read as arriving, found through the plan's own parents.
  const arrivingFolders = new Set<string>();
  for (const node of nodes.values()) {
    if (!node.arriving || !(held(node.id) || overlaid(node.id))) continue;
    let up = node.parentId;
    while (up && !arrivingFolders.has(up)) {
      arrivingFolders.add(up);
      up = nodes.get(up)?.parentId ?? null;
    }
  }

  const byParent = new Map<string, Node[]>();
  for (const node of nodes.values()) {
    if (!overlaid(node.id)) continue;
    const key = node.parentId ?? catalog.root.entryId;
    const siblings = byParent.get(key);
    if (siblings) siblings.push(node);
    else byParent.set(key, [node]);
  }

  const marks = (node: CatalogNode): CatalogNode => {
    const id = node.kind === "dir" ? node.entryId : node.documentId;
    const known = nodes.get(id);
    if (node.kind === "dir")
      return arrivingFolders.has(id) ? { ...node, import: { arriving: true } } : node;
    const arriving = known?.arriving === true || node.importPending === true;
    if (!known?.failure && !arriving) return node;
    return {
      ...node,
      import: {
        ...(arriving ? { arriving: true as const } : {}),
        ...(known?.failure ? { failure: known.failure } : {}),
      },
    };
  };

  if (nodes.size === 0) return catalog;

  const overlay = (node: Node, parentId: string): CatalogNode => {
    if (node.kind === "dir") {
      const dir: CatalogDirectory = {
        kind: "dir",
        entryId: node.id,
        parentId,
        name: node.name,
        path: "",
        uri: "",
        import: { client: true, arriving: true },
      };
      return dir;
    }
    const file: CatalogFile = {
      kind: "file",
      entryId: node.id,
      parentId,
      documentId: node.id,
      name: node.name,
      path: "",
      uri: "",
      provisionalName: false,
      hasProperties: false,
      importPending: true,
      editable: false,
      disposition: "binary",
      fileType: "binary",
      import: {
        client: true,
        arriving: true,
        ...(node.failure ? { failure: node.failure } : {}),
      },
    };
    return file;
  };

  const sorted = (list: CatalogNode[]) =>
    list.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );

  const cache = new Map<string, readonly CatalogNode[]>();
  const children = (parentId: string): readonly CatalogNode[] => {
    const cached = cache.get(parentId);
    if (cached) return cached;
    const real = nodes.has(parentId) && !held(parentId) ? [] : catalog.children(parentId);
    const added = (byParent.get(parentId) ?? []).map((node) => overlay(node, parentId));
    const result = added.length === 0 ? real.map(marks) : sorted([...real.map(marks), ...added]);
    cache.set(parentId, result);
    return result;
  };

  return { ...catalog, children };
}
