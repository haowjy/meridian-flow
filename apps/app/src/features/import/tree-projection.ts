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
 * An overlay whose parent is drawn nowhere is not drawn. An overlay sits in the area
 * of its nearest catalog ancestor, found by id through overlay parents, so a folder
 * the writer moved to another area takes its unlanded files along; only a node
 * parented at an area root uses the planned scheme. An import none of whose nodes
 * can land in the scheme's catalog is skipped, and a scheme nothing touches keeps
 * its own view.
 */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { renderFilename } from "@meridian/contracts/protocol";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
  ImportRowInfo,
} from "@/client/query/context-catalog-projection";
import { filenameForDisplay } from "./display-name";
import { effectiveEntry, fullyRead, type ImportState } from "./import-state";
import type { ImportTarget } from "./placements";

/** What the projection reads of one import: its state and the coordinator's evidence. */
export type ProjectedImport = {
  importId: string;
  state: ImportState;
  /** Node ids the catalog has held while this tab tracked the import. */
  seen: ReadonlySet<string>;
  /** Node ids materialized on the server that this tab drew and the catalog may not show yet. */
  bridges: ReadonlySet<string>;
  /** Where the import shows and where its own marks go; null before it knows. */
  target: ImportTarget | null;
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
  /** The plan was refused or lost, so a predicted row is only a leftover, not arriving. */
  stalled?: true;
  failure?: Failure;
  seen: boolean;
  bridged: boolean;
};

/** An import's nodes and what decides which catalogs they can land in; built once per projected item. */
type Nodes = {
  list: readonly Node[];
  /** Every distinct parent id the nodes name. */
  parentIds: ReadonlySet<string>;
  /** The planned areas of the nodes parented at an area root. */
  rootSchemes: ReadonlySet<ProjectContextTreeScheme>;
};

const nodeCache = new WeakMap<ProjectedImport, Nodes>();

function nodesOf(item: ProjectedImport): Nodes {
  let cached = nodeCache.get(item);
  if (!cached) {
    const list = buildNodes(item);
    const parentIds = new Set<string>();
    const rootSchemes = new Set<ProjectContextTreeScheme>();
    for (const node of list)
      if (node.parentId === null) rootSchemes.add(node.scheme);
      else parentIds.add(node.parentId);
    cached = { list, parentIds, rootSchemes };
    nodeCache.set(item, cached);
  }
  return cached;
}

function buildNodes(item: ProjectedImport): Node[] {
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
      arriving: state.local?.phase.kind !== "not-started",
      ...(state.local?.phase.kind === "not-started" ? { stalled: true as const } : {}),
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

/**
 * The rows that carry a run's own status instead of a file's, from each import's
 * target: the destination while the selection is read, and after a refusal the root
 * row of each picked folder, where Try again and Discard live. A run with no root
 * row to carry it (loose files, an unreadable marker, a routed export) marks its
 * destination or each affected area header.
 */
function runMarks(
  imports: readonly ProjectedImport[],
  scheme: ProjectContextTreeScheme,
  rootId: string,
): Map<string, ImportRowInfo> {
  const marks = new Map<string, ImportRowInfo>();
  const add = (id: string, info: ImportRowInfo) => marks.set(id, { ...marks.get(id), ...info });
  for (const { importId, state, target } of imports) {
    const local = state.local;
    if (!local || !target) continue;
    const anchors = target.anchors.filter((anchor) => anchor.scheme === scheme);
    const anchorId = (folderId: string | null) => folderId ?? rootId;
    if (local.phase.kind === "reading")
      for (const anchor of anchors) add(anchorId(anchor.folderId), { reading: true });
    if (local.phase.kind !== "not-started") continue;
    const notStarted = { importId, code: local.phase.code };
    for (const id of target.rootIds) add(id, { notStarted });
    if (target.rootIds.length === 0 || local.roots.some((root) => root.kind === "file"))
      for (const anchor of anchors) add(anchorId(anchor.folderId), { notStarted });
  }
  return marks;
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
  for (const item of imports) {
    const known = nodesOf(item);
    // Skip an import none of whose nodes can land here, without touching its nodes.
    if (!known.rootSchemes.has(scheme) && ![...known.parentIds].some((parentId) => held(parentId)))
      continue;
    for (const node of known.list) nodes.set(node.id, { ...node, importId: item.importId });
  }

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
      (node.parentId !== null || node.scheme === scheme) &&
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

  const run = runMarks(imports, scheme, catalog.root.entryId);
  if (nodes.size === 0 && run.size === 0) return catalog;

  const marks = (node: CatalogNode): CatalogNode => {
    const id = node.kind === "dir" ? node.entryId : node.documentId;
    const known = nodes.get(id);
    const status = run.get(id);
    if (node.kind === "dir") {
      if (!arrivingFolders.has(id) && !status) return node;
      return {
        ...node,
        import: { ...(arrivingFolders.has(id) ? { arriving: true as const } : {}), ...status },
      };
    }
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

  const overlay = (node: Node, parentId: string): CatalogNode => {
    if (node.kind === "dir") {
      const dir: CatalogDirectory = {
        kind: "dir",
        entryId: node.id,
        parentId,
        name: node.name,
        path: "",
        uri: "",
        import: {
          client: true,
          ...(node.stalled ? {} : { arriving: true as const }),
          ...run.get(node.id),
        },
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
        ...(node.stalled ? {} : { arriving: true as const }),
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

  const root = run.get(catalog.root.entryId);
  return {
    ...catalog,
    ...(root ? { root: { ...catalog.root, import: root } } : {}),
    children,
  };
}
