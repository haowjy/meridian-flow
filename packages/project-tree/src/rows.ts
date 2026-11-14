import { isSourceRoot } from "./record.js";
import type { TreeNode, TreeProjection } from "./replay.js";

/**
 * A node as a database row for the server's SQL readers. The server compares the rows a replay
 * gives with the last it wrote and writes only those that differ.
 */
export type ProjectedRow = {
  id: string;
  kind: "folder" | "document";
  /** Null for the top of a source. */
  parentId: string | null;
  sourceId: string;
  /** The name shown, numbered where a sibling shows the same. */
  name: string;
  /** What follows the last dot of the name, lowercased; empty for a folder or a bare name. */
  extension: string;
  /** A document's type: the editor that opens it. Null for a folder. */
  filetype: string | null;
  rank: string;
  deleted: boolean;
};

/** A row of a Work's view: it differs from live, or exists only in the Work. */
export type BranchRow = ProjectedRow & { existsOnlyInDraft: boolean };

function extensionOf(node: TreeNode): string {
  if (node.kind === "folder") return "";
  const dot = node.name.lastIndexOf(".");
  return dot > 0 ? node.name.slice(dot + 1).toLowerCase() : "";
}

function toRow(node: TreeNode): ProjectedRow {
  return {
    id: node.id,
    // A file is a document row, as it is today.
    kind: node.kind === "folder" ? "folder" : "document",
    parentId: isSourceRoot(node.parent) ? null : node.parent,
    sourceId: node.source,
    name: node.displayName,
    extension: extensionOf(node),
    filetype: node.filetype ?? null,
    rank: node.rank,
    deleted: node.trashed,
  };
}

export function projectedRows(projection: TreeProjection): Map<string, ProjectedRow> {
  return new Map([...projection.nodes.values()].map((node) => [node.id, toRow(node)]));
}

function same(a: ProjectedRow, b: ProjectedRow): boolean {
  return (
    a.kind === b.kind &&
    a.parentId === b.parentId &&
    a.sourceId === b.sourceId &&
    a.name === b.name &&
    a.extension === b.extension &&
    a.filetype === b.filetype &&
    a.rank === b.rank &&
    a.deleted === b.deleted &&
    (a as Partial<BranchRow>).existsOnlyInDraft === (b as Partial<BranchRow>).existsOnlyInDraft
  );
}

/** What a Work's tree shows differently from live: each node that differs or exists only in the Work. */
export function branchRows(
  live: ReadonlyMap<string, ProjectedRow>,
  draft: ReadonlyMap<string, ProjectedRow>,
): Map<string, BranchRow> {
  const out = new Map<string, BranchRow>();
  for (const row of draft.values()) {
    const base = live.get(row.id);
    if (!base) out.set(row.id, { ...row, existsOnlyInDraft: true });
    else if (!same(base, row)) out.set(row.id, { ...row, existsOnlyInDraft: false });
  }
  return out;
}

/** The rows to write to go from `prev` to `next`: the ones that differ, and the ids no longer there. */
export function changedRows<Row extends ProjectedRow>(
  prev: ReadonlyMap<string, Row>,
  next: ReadonlyMap<string, Row>,
): { upserts: Row[]; gone: string[] } {
  const upserts = [...next.values()].filter((row) => {
    const was = prev.get(row.id);
    return !was || !same(was, row);
  });
  const gone = [...prev.keys()].filter((id) => !next.has(id));
  return { upserts, gone };
}
