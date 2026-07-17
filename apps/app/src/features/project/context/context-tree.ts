/**
 * context-tree — type aliases and lookup helpers for a project's context
 * document tree.
 *
 * Re-exports the contract tree node types under local names and provides
 * recursive find-by-path helpers (`findContextFile`, `findContextDir`).
 * Pure tree traversal; shared by the context browser/tree/viewer components.
 */
import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeFile,
  ProjectContextTreeNode,
} from "@meridian/contracts/protocol";

export type ContextDir = ProjectContextTreeDirectory;
export type ContextFile = ProjectContextTreeFile;
export type ContextNode = ProjectContextTreeNode;

/** First file in tree order — the default-open target for a fresh project. */
export function firstContextFile(root: ContextNode): ContextFile | null {
  if (root.kind === "file") return root;
  for (const child of root.children) {
    const hit = firstContextFile(child);
    if (hit) return hit;
  }
  return null;
}

export function findContextFile(root: ContextNode, path: string): ContextFile | null {
  if (root.kind === "file") return root.path === path ? root : null;
  for (const child of root.children) {
    const hit = findContextFile(child, path);
    if (hit) return hit;
  }
  return null;
}

export function findContextFileByDocumentId(
  root: ContextNode,
  documentId: string,
): ContextFile | null {
  if (root.kind === "file") return root.documentId === documentId ? root : null;
  for (const child of root.children) {
    const hit = findContextFileByDocumentId(child, documentId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Look up a directory by its absolute path (e.g. `/project/learnings`). The
 * root itself is matched on the empty string or `/`. Returns null if the path
 * does not name an existing folder.
 */
export function findContextDir(root: ContextNode, path: string): ContextDir | null {
  if (root.kind !== "dir") return null;
  const normalized = path === "" ? "/" : path;
  if (root.path === normalized) return root;
  for (const child of root.children) {
    if (child.kind !== "dir") continue;
    const hit = findContextDir(child, normalized);
    if (hit) return hit;
  }
  return null;
}
