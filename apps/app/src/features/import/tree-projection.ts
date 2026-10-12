/**
 * Pending rows are a projection owned by the importing client, not intents in
 * the resource replica: this layers an import's rows over a catalog view. Real
 * rows gain "arriving" and "failed" marks; rows the server has not created yet
 * (every row before the plan answers; binaries and code until they land) are
 * drawn from the importing tab's selection.
 *
 * Each client row hands off on its own: it is drawn until this browser's catalog
 * holds what it stands for, or the report says nothing will. A finished import
 * is not a handoff: the report and the catalog reach this tab independently.
 */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
} from "@/client/query/context-catalog-projection";
import type { ClientRow } from "./client-rows";
import { joinCatalogPath, parentCatalogPath } from "./destination";
import { filenameForDisplay } from "./display-name";
import { effectiveEntry, fullyRead, type ImportState } from "./import-state";

export const CLIENT_ROW_PREFIX = "import:";

/** The catalog path ("/Lore/Sects") of a context URI, or null when it is not one. */
export function catalogPathOfUri(uri: string | null): string | null {
  if (!uri) return null;
  const parsed = parseContextUri(uri);
  return parsed.ok ? `/${parsed.value.path}` : null;
}

type Placed = {
  row: ClientRow;
  importId: string;
  /** The full report has been read: the plan has answered and its names are known. */
  planned: boolean;
  parentPath: string;
  name: string;
  entryId: string;
  /** The file's stored entry, when the server answered. */
  entry?: ReturnType<typeof effectiveEntry>;
  holdsFile: boolean;
};

export function pseudoRowId(importId: string, row: ClientRow) {
  return `${CLIENT_ROW_PREFIX}${importId}:${row.key}`;
}

/** Where each of an import's client rows lands now: the plan's names once it has answered. */
function place(state: ImportState): Placed[] {
  const local = state.local;
  if (!local || local.rows.length === local.handedOff.size) return [];
  const report = fullyRead(state.report) ? state.report : null;
  const rootPath = new Map<number, string | null>();
  for (const root of report?.roots ?? []) rootPath.set(root.rootId, catalogPathOfUri(root.uri));
  return local.rows.flatMap<Placed>((row) => {
    if (local.handedOff.has(row.key)) return [];
    let parentPath = row.parentPath;
    let name = row.name;
    let entry: Placed["entry"];
    if (report) {
      const stored = row.entryId === undefined ? undefined : report.entries.get(row.entryId);
      if (stored) {
        entry = effectiveEntry(state, stored);
        const path = catalogPathOfUri(entry.uri);
        if (path) {
          parentPath = parentCatalogPath(path);
          name = filenameForDisplay(path.slice(path.lastIndexOf("/") + 1));
        }
      } else {
        const base = rootPath.get(row.rootId);
        if (base) {
          if (row.relPath === "") {
            parentPath = parentCatalogPath(base);
            name = base.slice(base.lastIndexOf("/") + 1);
          } else {
            const slash = row.relPath.lastIndexOf("/");
            parentPath = slash < 0 ? base : joinRel(base, row.relPath.slice(0, slash));
          }
        }
      }
    }
    return {
      row,
      importId: state.importId,
      planned: report !== null,
      parentPath,
      name,
      entryId: pseudoRowId(state.importId, row),
      entry,
      holdsFile: local.held !== null,
    };
  });
}

function joinRel(base: string, relative: string): string {
  return relative.split("/").reduce(joinCatalogPath, base);
}

/** What this browser's catalog holds now: every document id and folder path. */
type Held = { documents: ReadonlySet<string>; folders: ReadonlySet<string> };

function heldBy(catalog: CatalogContextView): Held {
  const documents = new Set<string>();
  const folders = new Set<string>();
  const walk = (parentId: string) => {
    for (const node of catalog.children(parentId)) {
      if (node.kind === "file") documents.add(node.documentId);
      else {
        folders.add(node.path);
        walk(node.entryId);
      }
    }
  };
  walk(catalog.root.entryId);
  return { documents, folders };
}

/**
 * The one handoff rule: a client row goes once the catalog holds its document
 * (wherever it has moved) or its folder, or once the report says no row will
 * come (skipped, deleted, left unmade, or never planned at all).
 */
function handedOff(p: Placed, held: Held): boolean {
  if (p.row.kind === "dir")
    return p.planned && held.folders.has(joinCatalogPath(p.parentPath, p.name));
  const entry = p.entry;
  // The plan answered without this file (it could not be read): nothing will arrive.
  if (!entry) return p.planned;
  if (entry.state === "skipped" || entry.state === "deleted") return true;
  if (!entry.exists && (entry.state === "landed" || entry.state === "not_imported")) return true;
  return held.documents.has(entry.documentId);
}

export type ImportedCatalog = {
  view: CatalogContextView;
  /** Client rows, by import, that the catalog now draws or that will never come. */
  handedOff: ReadonlyMap<string, readonly string[]>;
};

/** Layers every given import's rows over `catalog`; the view is unchanged when none touch it. */
export function withImportRows(
  catalog: CatalogContextView,
  scheme: ProjectContextTreeScheme,
  imports: readonly ImportState[],
): ImportedCatalog {
  const candidates = imports.flatMap(place).filter((p) => p.row.scheme === scheme);
  const held = candidates.length ? heldBy(catalog) : null;
  const handed = new Map<string, string[]>();
  const placed = candidates.filter((p) => {
    if (!held || !handedOff(p, held)) return true;
    const keys = handed.get(p.importId);
    if (keys) keys.push(p.row.key);
    else handed.set(p.importId, [p.row.key]);
    return false;
  });
  const arrivingEntries = new Map<string, ImportRowMeta>();
  const folders = new Set<string>();
  for (const state of imports) {
    for (const raw of state.report?.entries.values() ?? []) {
      const entry = effectiveEntry(state, raw);
      const arriving = entry.state === "planned" || entry.state === "landing";
      const path = catalogPathOfUri(entry.uri);
      if (arriving) {
        arrivingEntries.set(entry.documentId, { importId: state.importId });
        if (path && entry.uri?.startsWith(`${scheme}://`)) addAncestors(folders, path);
      }
    }
  }
  const failures = new Map<string, NonNullable<CatalogFile["import"]>["failure"]>();
  for (const state of imports) {
    for (const raw of state.report?.entries.values() ?? []) {
      const entry = effectiveEntry(state, raw);
      if (entry.state !== "failed") continue;
      failures.set(entry.documentId, {
        importId: state.importId,
        entryId: entry.entryId,
        reason: entry.reason,
        canRetry: state.local?.held != null,
      });
    }
  }
  // Rows not yet in the catalog count as arriving inside their folders.
  for (const p of placed) {
    const settled = p.entry && p.entry.state !== "planned" && p.entry.state !== "landing";
    if (!settled && p.row.kind === "file")
      addAncestors(folders, joinCatalogPath(p.parentPath, p.name));
  }

  if (placed.length === 0 && arrivingEntries.size === 0 && failures.size === 0)
    return { view: catalog, handedOff: handed };

  const byParent = new Map<string, Placed[]>();
  for (const p of placed) byParent.set(p.parentPath, [...(byParent.get(p.parentPath) ?? []), p]);
  const placedById = new Map(placed.map((p) => [p.entryId, p]));

  const mark = (node: CatalogNode): CatalogNode => {
    if (node.kind === "dir") {
      return folders.has(node.path) ? { ...node, import: { arriving: true } } : node;
    }
    const failure = failures.get(node.documentId);
    const arriving = arrivingEntries.has(node.documentId) || node.importPending === true;
    if (!failure && !arriving) return node;
    return {
      ...node,
      import: { ...(arriving ? { arriving: true as const } : {}), ...(failure ? { failure } : {}) },
    };
  };

  const clientNode = (p: Placed, parentId: string): CatalogNode => {
    const path = joinCatalogPath(p.parentPath, p.name);
    const failure =
      p.entry?.state === "failed"
        ? {
            importId: p.importId,
            entryId: p.entry.entryId,
            reason: p.entry.reason,
            canRetry: p.holdsFile,
          }
        : undefined;
    if (p.row.kind === "dir") {
      const dir: CatalogDirectory = {
        kind: "dir",
        entryId: p.entryId,
        parentId,
        name: p.name,
        path,
        uri: "",
        import: { client: true, arriving: true },
      };
      return dir;
    }
    const file: CatalogFile = {
      kind: "file",
      entryId: p.entryId,
      parentId,
      documentId: p.entry?.documentId ?? p.entryId,
      name: p.name,
      path,
      uri: "",
      provisionalName: false,
      hasProperties: false,
      importPending: true,
      editable: false,
      disposition: "binary",
      fileType: "binary",
      import: { client: true, arriving: true, ...(failure ? { failure } : {}) },
    };
    return file;
  };

  const sorted = (nodes: CatalogNode[]) =>
    nodes.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );

  const cache = new Map<string, readonly CatalogNode[]>();
  const children = (parentId: string): readonly CatalogNode[] => {
    const cached = cache.get(parentId);
    if (cached) return cached;
    const pseudo = placedById.get(parentId);
    const parentPath = pseudo
      ? joinCatalogPath(pseudo.parentPath, pseudo.name)
      : parentId === catalog.root.entryId
        ? "/"
        : folderPathOf(catalog, parentId);
    const real = pseudo ? [] : catalog.children(parentId);
    const added = (byParent.get(parentPath) ?? []).map((p) => clientNode(p, parentId));
    const result = added.length === 0 ? real.map(mark) : sorted([...real.map(mark), ...added]);
    cache.set(parentId, result);
    return result;
  };

  return { view: { ...catalog, children }, handedOff: handed };
}

type ImportRowMeta = { importId: string };

function addAncestors(into: Set<string>, path: string, includeSelf = false) {
  let current = includeSelf ? path : parentCatalogPath(path);
  while (current !== "/" && !into.has(current)) {
    into.add(current);
    current = parentCatalogPath(current);
  }
}

function folderPathOf(catalog: CatalogContextView, folderId: string): string {
  const entry = catalog.normalized.entries.get(folderId);
  return entry?.kind === "folder" ? `/${entry.path.join("/")}` : "/";
}
