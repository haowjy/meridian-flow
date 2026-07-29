/**
 * The URI of the document being edited, which is what a relative link is
 * relative to.
 *
 * `chapter-213.md` in one chapter and the same text in a note two folders down
 * address different documents, so the resolver needs the holder's own URI and
 * only the app knows it. Read from the tree the app already caches, and null
 * until it arrives — a relative link simply has no answer until then, which is
 * different from having no document.
 */

import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeNode,
} from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectContextTree } from "@/client/query/useProjectContextTree";

export function useDocumentUri(projectId: string | undefined, documentId: string): string | null {
  const { tree } = useProjectContextTree(projectId ?? "", "manuscript", {
    enabled: Boolean(projectId),
  });

  return useMemo(() => (tree ? uriOf(tree, documentId) : null), [tree, documentId]);
}

function uriOf(tree: ProjectContextTreeDirectory, documentId: string): string | null {
  const visit = (node: ProjectContextTreeNode): string | null => {
    if (node.kind === "file") return node.documentId === documentId ? node.uri : null;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(tree);
}
