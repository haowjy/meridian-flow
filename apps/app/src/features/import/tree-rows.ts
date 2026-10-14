/**
 * The tree's rows: real catalog nodes with import decorations, or rows only an
 * import draws. A pending row is not a catalog document: it has no URI, editor
 * classification or document capabilities, so navigation and namespace actions
 * need the catalog variant. Document lookup stays on the canonical catalog.
 */
import type { ImportEntryReason, ImportRefusalCode } from "@meridian/contracts";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogNode,
} from "@/client/query/context-catalog-projection";

/**
 * The import's own run, once the plan is accepted: what it is doing and what the
 * writer can do about it. The mark's menu and the future progress popup read this.
 */
export type ImportRunInfo = {
  importId: string;
  /** Sending: files are arriving. Interrupted: the server wants files this tab does not hold. */
  kind: "sending" | "stopping" | "interrupted" | "failed";
  arrived: number;
  total: number;
  failed: number;
  /** Files the import still lacks (arriving or failed); what Stop here gives up. */
  remaining: number;
  /** This tab holds the files, so Retry can send the failed ones. */
  canRetry: boolean;
};

/** How an import touches a row: still arriving, failed, or carrying the run's own state. */
export type ImportRowInfo = {
  /** Text (or the file) has not landed yet. */
  arriving?: true;
  /** An import into this folder is still reading what the writer chose. */
  reading?: true;
  /** Hashing and planning: the selection is read, the server has not answered. Stop ends it. */
  preparing?: { importId: string };
  /** The accepted import's own state, carried by its root row, destination or area header. */
  run?: ImportRunInfo;
  /** The plan was refused or lost; the mark carries the import's warning, Try again and Discard. */
  notStarted?: { importId: string; code: ImportRefusalCode | null };
  failure?: {
    importId: string;
    entryId: number;
    reason: ImportEntryReason | null;
    /** This tab still holds the file, so Retry can send it. */
    canRetry: boolean;
  };
};

/** A catalog node, decorated when an import touches it. */
export type CatalogRow = { origin: "catalog"; node: CatalogNode; status?: ImportRowInfo };

/** A row the importing tab draws before the server has made it. */
export type PendingRow = {
  origin: "import";
  id: string;
  parentId: string;
  kind: "dir" | "file";
  name: string;
  status: ImportRowInfo;
};

export type TreeRow = CatalogRow | PendingRow;

/** Rows by parent id, and the import marks by target id (a folder row, the area root). */
export type ImportedTree = {
  root: CatalogDirectory;
  rows(parentId: string): readonly TreeRow[];
  statusOf(id: string): ImportRowInfo | undefined;
};

export const rowId = (row: TreeRow): string =>
  row.origin === "import" ? row.id : row.node.entryId;

export const rowKind = (row: TreeRow): "dir" | "file" =>
  row.origin === "import" ? row.kind : row.node.kind;

export const rowName = (row: TreeRow): string =>
  row.origin === "import" ? row.name : row.node.name;

/** What a name form checks a new name against: every row in the folder, pending ones included. */
export const siblingsOf = (rows: readonly TreeRow[]) =>
  rows.map((row) => ({ entryId: rowId(row), name: rowName(row), kind: rowKind(row) }));

/** The tree of a catalog no import touches. */
export function plainTree(catalog: CatalogContextView): ImportedTree {
  const cache = new Map<string, readonly TreeRow[]>();
  return {
    root: catalog.root,
    rows(parentId) {
      let rows = cache.get(parentId);
      if (!rows) {
        rows = catalog.children(parentId).map((node) => ({ origin: "catalog", node }));
        cache.set(parentId, rows);
      }
      return rows;
    },
    statusOf: () => undefined,
  };
}
