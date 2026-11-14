/**
 * Where a document stands in a list, read from the replay: the one answer to "is it still there".
 * Nothing is polled and nothing is stamped: the replay is the copy the tree is drawn from, so it
 * cannot disagree with the tree.
 */
import {
  lastSettlements,
  listRecords,
  type TreeNode,
  type TreeProjection,
} from "@meridian/project-tree";
import type { TreeListSnapshot } from "./tree-list-session";

export type DocumentStanding =
  /** The list has not been read in this session: an absence now proves nothing. */
  | { kind: "waiting" }
  | { kind: "in-tree"; node: TreeNode }
  /** Deleted, and `deletedBy` is the delete record's actor (`user:<id>`, `agent:<chat>/<turn>`). */
  | { kind: "in-trash"; node: TreeNode; deletedBy: string | null }
  /** Its content is gone. */
  | ({ kind: "purged" } & Discarded)
  | ({ kind: "not-in-list" } & Discarded);

/**
 * `discardedBy`: it was a Work's new document and a Discard took it away, so it never was live
 * (the Discard's actor, null when unknown).
 */
type Discarded = { discardedBy?: string | null };

const ANSWERS: ReadonlySet<TreeListSnapshot["status"]> = new Set([
  "synced",
  "read-only",
  "offline",
  "unauthenticated",
]);

/** A list whose absences can be believed. */
export const listIsReadable = (status: TreeListSnapshot["status"]) => ANSWERS.has(status);

export function standingIn(
  snapshot: TreeListSnapshot,
  projection: TreeProjection,
  documentId: string,
): DocumentStanding {
  const node = projection.nodes.get(documentId);
  if (!node) {
    const discarded = discardedCreate(snapshot, documentId);
    if (projection.gone.has(documentId)) return { kind: "purged", ...discarded };
    return listIsReadable(snapshot.status)
      ? { kind: "not-in-list", ...discarded }
      : { kind: "waiting" };
  }
  if (node.purged) return { kind: "purged" };
  if (!node.trashed) return { kind: "in-tree", node };
  const entry = projection.trash.find(
    (each) => each.node === documentId || each.cascade.includes(documentId),
  );
  const deleted = entry && listRecords(snapshot.doc).find((record) => record.id === entry.id);
  return { kind: "in-trash", node, deletedBy: deleted?.actor ?? null };
}

/** The Discard that took away the node's latest create, when that is what happened to it. */
function discardedCreate(snapshot: TreeListSnapshot, documentId: string): Discarded {
  const create = listRecords(snapshot.doc)
    .filter((record) => record.type === "create" && record.node === documentId)
    .pop();
  const settle = create && lastSettlements(snapshot.doc).get(create.id);
  return settle?.to === "discarded" ? { discardedBy: settle.actor } : {};
}
