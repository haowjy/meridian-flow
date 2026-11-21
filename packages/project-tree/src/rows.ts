import { isSourceRoot, type TreeRecord } from "./record.js";
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
  /** The name shown, which a sibling may share. */
  name: string;
  /** A later twin's suffix (rule 14), without the `~`; null for the first to arrive. */
  suffix: string | null;
  /** What follows the last dot of the name, lowercased; empty for a folder or a bare name. */
  extension: string;
  /** A document's type: the editor that opens it. Null for a folder. */
  filetype: string | null;
  rank: string;
  deleted: boolean;
};

/**
 * A row of a Work's view: it differs from live, or exists only in the Work. `changed` is whether
 * it is a change the Work made, which review lists and the count counts: a row that differs from
 * live only in a twin's suffix is not one (its sibling was renamed, moved or deleted).
 */
export type DraftRow = ProjectedRow & { existsOnlyInDraft: boolean; changed: boolean };

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
    name: node.name,
    suffix: node.suffix ?? null,
    extension: extensionOf(node),
    filetype: node.filetype ?? null,
    rank: node.rank,
    deleted: node.trashed,
  };
}

export function projectedRows(projection: TreeProjection): Map<string, ProjectedRow> {
  return new Map([...projection.nodes.values()].map((node) => [node.id, toRow(node)]));
}

/** The facts the records set agree: everything but the suffix, which the replay derives. */
function sameFacts(a: ProjectedRow, b: ProjectedRow): boolean {
  return (
    a.kind === b.kind &&
    a.parentId === b.parentId &&
    a.sourceId === b.sourceId &&
    a.name === b.name &&
    a.extension === b.extension &&
    a.filetype === b.filetype &&
    a.rank === b.rank &&
    a.deleted === b.deleted
  );
}

function same(a: ProjectedRow, b: ProjectedRow): boolean {
  const draft = (row: ProjectedRow) => row as Partial<DraftRow>;
  return (
    sameFacts(a, b) &&
    a.suffix === b.suffix &&
    draft(a).existsOnlyInDraft === draft(b).existsOnlyInDraft &&
    draft(a).changed === draft(b).changed
  );
}

/** The nodes a Work's pending records create, in list order; `kind` keeps one kind of them. */
export function pendingCreates(
  pending: readonly TreeRecord[],
  kind?: "document" | "folder",
): Set<string> {
  return new Set(
    pending.flatMap((r) => (r.type === "create" && (!kind || r.kind === kind) ? [r.node] : [])),
  );
}

/**
 * What a Work's tree shows differently from live: each node that differs or exists only in the
 * Work. A node exists only in the Work when live has no row for it or the Work's pending records
 * create it and the Work still shows it: Un-Apply puts a create back to pending while live keeps
 * the node in Trash when anything else holds it there (rule 15), and an Undo of that create
 * leaves it in Trash in both, which is no change.
 * A node in Trash in both is no change whatever the Work drafted for it: that waits for a restore.
 */
export function draftRows(
  live: ReadonlyMap<string, ProjectedRow>,
  draft: ReadonlyMap<string, ProjectedRow>,
  pending: readonly TreeRecord[],
): Map<string, DraftRow> {
  const created = pendingCreates(pending);
  const out = new Map<string, DraftRow>();
  for (const row of draft.values()) {
    const base = live.get(row.id);
    if (!base || (created.has(row.id) && !row.deleted))
      out.set(row.id, { ...row, existsOnlyInDraft: true, changed: true });
    else if (!(base.deleted && row.deleted) && !same(base, row))
      out.set(row.id, { ...row, existsOnlyInDraft: false, changed: !sameFacts(base, row) });
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
