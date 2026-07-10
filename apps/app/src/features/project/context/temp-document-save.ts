/** Pure save-target collision decision over a freshly fetched context tree. */
import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeNode,
} from "@meridian/contracts/protocol";

export type SaveTargetDecision =
  | { outcome: "available" }
  | { outcome: "blocked"; existing: ProjectContextTreeNode };

export function decideTempDocumentSaveTarget(
  tree: ProjectContextTreeDirectory,
  path: string,
): SaveTargetDecision {
  const existing = findNode(tree, path);
  return existing ? { outcome: "blocked", existing } : { outcome: "available" };
}

function findNode(node: ProjectContextTreeNode, path: string): ProjectContextTreeNode | null {
  if (node.path === path) return node;
  if (node.kind === "file") return null;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}
