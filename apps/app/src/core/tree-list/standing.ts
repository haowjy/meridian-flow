/**
 * Where a document stands in a list, read from the replay: the one answer to "is it still there".
 * Nothing is polled and nothing is stamped: the replay is the copy the tree is drawn from, so it
 * cannot disagree with the tree.
 */
import { listRecords, type TreeNode, type TreeProjection } from "@meridian/project-tree";
import type { TreeListSnapshot } from "./tree-list-session";

export type DocumentStanding =
  /** The list has not been read in this session: an absence now proves nothing. */
  | { kind: "waiting" }
  | { kind: "in-tree"; node: TreeNode }
  /** Deleted, and `deletedBy` is the delete record's actor (`user:<id>`, `agent:<chat>/<turn>`). */
  | { kind: "in-trash"; node: TreeNode; deletedBy: string | null }
  | { kind: "purged" }
  | { kind: "not-in-list" };

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
    if (projection.gone.has(documentId)) return { kind: "purged" };
    return listIsReadable(snapshot.status) ? { kind: "not-in-list" } : { kind: "waiting" };
  }
  if (node.purged) return { kind: "purged" };
  if (!node.trashed) return { kind: "in-tree", node };
  const entry = projection.trash.find(
    (each) => each.node === documentId || each.cascade.includes(documentId),
  );
  const deleted = entry && listRecords(snapshot.doc).find((record) => record.id === entry.id);
  return { kind: "in-trash", node, deletedBy: deleted?.actor ?? null };
}
