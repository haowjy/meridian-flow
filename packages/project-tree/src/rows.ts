import { entryExtension } from "@meridian/contracts/protocol";
import { isSourceRoot, type TreeRecord } from "./record.js";
import type { TreeNode, TreeProjection } from "./replay.js";

export type ProjectedRow = {
  id: string;
  kind: "folder" | "document";
  parentId: string | null;
  sourceId: string;
  name: string;
  suffix: string | null;
  extension: string;
  filetype: string | null;
  rank: string;
  deleted: boolean;
};

export type DraftRow = ProjectedRow & { existsOnlyInDraft: boolean; changed: boolean };

function toRow(node: TreeNode): ProjectedRow {
  return {
    id: node.id,
    kind: node.kind === "folder" ? "folder" : "document",
    parentId: isSourceRoot(node.parent) ? null : node.parent,
    sourceId: node.source,
    name: node.name,
    suffix: node.suffix ?? null,
    extension: entryExtension(node),
    filetype: node.filetype ?? null,
    rank: node.rank,
    deleted: node.trashed,
  };
}

export function projectedRows(projection: TreeProjection): Map<string, ProjectedRow> {
  return new Map([...projection.nodes.values()].map((node) => [node.id, toRow(node)]));
}

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

export function pendingCreates(
  pending: readonly TreeRecord[],
  kind?: "document" | "folder",
): Set<string> {
  return new Set(
    pending.flatMap((r) => (r.type === "create" && (!kind || r.kind === kind) ? [r.node] : [])),
  );
}

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
