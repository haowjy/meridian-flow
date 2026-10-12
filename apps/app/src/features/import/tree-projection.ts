/**
 * Pending rows are a projection owned by the importing client, not intents in
 * the resource replica: this layers an import's rows over a catalog view. Real
 * rows gain "arriving" and "failed" marks; rows the server has not created yet
 * (every row before the plan answers; binaries and code until they land) are
 * drawn from the importing tab's selection.
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
  if (!local || local.rows.length === 0) return [];
  // A finished import has nothing left to draw: what landed is in the catalog.
  if (state.report?.summary.state === "finished") return [];
  const report = fullyRead(state.report) ? state.report : null;
  const rootPath = new Map<number, string | null>();
  for (const root of report?.roots ?? []) rootPath.set(root.rootId, catalogPathOfUri(root.uri));
  return local.rows.map<Placed>((row) => {
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

/** Layers every given import's rows over `catalog`; returns it unchanged when none touch it. */
export function withImportRows(
  catalog: CatalogContextView,
  scheme: ProjectContextTreeScheme,
  imports: readonly ImportState[],
): CatalogContextView {
  const placed = imports.flatMap(place).filter((p) => p.row.scheme === scheme);
  const arrivingEntries = new Map<string, ImportRowMeta>();
  const folders = new Set<string>();
  for (const state of imports) {
    if (state.report?.summary.state === "finished") continue;
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

  if (placed.length === 0 && arrivingEntries.size === 0 && failures.size === 0) return catalog;

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

  const realized = (
    p: Placed,
    ids: ReadonlySet<string>,
    dirNames: ReadonlySet<string>,
  ): boolean => {
    if (p.row.kind === "file") {
      const entry = p.entry;
      if (!entry) return false;
      if (entry.state === "skipped" || entry.state === "deleted") return true;
      return ids.has(entry.documentId);
    }
    // A folder is real once the plan has answered and the parent holds one by that name.
    return hasReport(p.importId) && dirNames.has(p.name);
  };
  const reports = new Set(
    imports.filter((state) => fullyRead(state.report)).map((state) => state.importId),
  );
  const hasReport = (importId: string) => reports.has(importId);

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
    const candidates = byParent.get(parentPath);
    let result: readonly CatalogNode[];
    if (!candidates) result = real.map(mark);
    else {
      const ids = new Set(real.flatMap((node) => (node.kind === "file" ? [node.documentId] : [])));
      const dirNames = new Set(real.flatMap((node) => (node.kind === "dir" ? [node.name] : [])));
      const added = candidates
        .filter((p) => !realized(p, ids, dirNames))
        .map((p) => clientNode(p, parentId));
      result = added.length === 0 ? real.map(mark) : sorted([...real.map(mark), ...added]);
    }
    cache.set(parentId, result);
    return result;
  };

  return { ...catalog, children };
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
