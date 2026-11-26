import {
  deleteCovering,
  isSourceRoot,
  type TreeNode,
  type TreeProjection,
} from "@meridian/project-tree";
import type { TreeListSnapshot } from "./tree-list-session";

export type DocumentStanding =
  | { kind: "waiting" }
  | { kind: "in-tree"; node: TreeNode }
  | { kind: "in-trash"; node: TreeNode; folders: readonly string[]; entry: string }
  | { kind: "purged" }
  | { kind: "not-in-list" };

const ANSWERS: ReadonlySet<TreeListSnapshot["status"]> = new Set([
  "synced",
  "offline",
  "broken",
  "unauthenticated",
]);

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
  const entry = deleteCovering(projection, documentId);
  return {
    kind: "in-trash",
    node,
    folders: foldersAbove(projection, node),
    entry: entry?.node ?? documentId,
  };
}

export function standingAcross(
  project: { snapshot: TreeListSnapshot; projection: TreeProjection },
  account: { snapshot: TreeListSnapshot; projection: TreeProjection },
  documentId: string,
): DocumentStanding {
  const answer = standingIn(project.snapshot, project.projection, documentId);
  if (answer.kind !== "not-in-list") return answer;
  const there = standingIn(account.snapshot, account.projection, documentId);
  if (there.kind === "waiting") return there;
  return there.kind === "not-in-list" ? answer : there;
}

export function foldersAbove(projection: TreeProjection, node: TreeNode): string[] {
  const names: string[] = [];
  for (
    let at = projection.nodes.get(node.parent);
    at && !isSourceRoot(node.parent);
    at = isSourceRoot(at.parent) ? undefined : projection.nodes.get(at.parent)
  )
    names.unshift(at.name);
  return names;
}
