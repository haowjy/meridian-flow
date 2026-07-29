/**
 * The documents the `[[` menu offers, from the trees the app already has.
 *
 * The candidate set is the resolver's, not the tree panel's: a wikilink
 * resolves against project documents by title, so a row for anything else
 * would be a row that inserts a link nobody can follow. Titles are filenames
 * without their extension, which is what `documents.name` holds and what the
 * server matches on.
 *
 * Cached client-side and free: this is the same query the context tree already
 * pays for, so opening the menu costs no request.
 */

import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeNode,
} from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import type { WikilinkDocument } from "@/core/editor/extensions/wikilink";

export function useWikilinkDocuments(projectId: string | undefined): readonly WikilinkDocument[] {
  const { tree } = useProjectContextTree(projectId ?? "", "manuscript", {
    enabled: Boolean(projectId),
  });

  return useMemo(() => (tree ? linkableDocuments(tree) : []), [tree]);
}

/** Depth-first, so ties in the menu keep the order the manuscript reads in. */
function linkableDocuments(tree: ProjectContextTreeDirectory): WikilinkDocument[] {
  const documents: WikilinkDocument[] = [];

  const visit = (node: ProjectContextTreeNode, folders: readonly string[]) => {
    if (node.kind === "dir") {
      const inside = node.path === "/" ? folders : [...folders, node.name];
      for (const child of node.children) visit(child, inside);
      return;
    }
    // An image or a PDF has no title a wikilink can name.
    if (!node.editable) return;
    documents.push({ title: documentTitle(node.name), location: folders.join("/") });
  };

  visit(tree, []);
  return documents;
}

function documentTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
