/**
 * The documents the `[[` menu offers, from the trees the app already has.
 *
 * The candidate set is the resolver's, not the tree panel's: a wikilink resolves
 * against project documents by title, so a row for anything else would be a row
 * that inserts a link nobody can follow. The resolver matches the manuscript AND
 * the Work's scratch, so both are offered — a note the writer keeps beside the
 * chapter is a document a link can reach, and leaving it out of the menu while
 * the resolver still finds it is the menu disagreeing with the link.
 *
 * Titles are filenames without their extension, which is what `documents.name`
 * holds and what the server matches on.
 *
 * Cached client-side and free: these are the same queries the context tree
 * already pays for, so opening the menu costs no request.
 */

import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeNode,
} from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import type { WikilinkDocument } from "@/core/completion";
import { schemeLabel } from "@/features/project/context/context-schemes";

import type { EditorScope } from "../../editor-scope";

export function useWikilinkDocuments({
  projectId,
  workId,
}: EditorScope): readonly WikilinkDocument[] {
  const { tree: manuscript } = useProjectContextTree(projectId ?? "", "manuscript", {
    enabled: Boolean(projectId),
  });
  const { tree: scratch } = useProjectContextTree(projectId ?? "", "scratch", {
    enabled: Boolean(projectId) && Boolean(workId),
    workId,
  });

  return useMemo(
    () => [
      // The manuscript first, so a title both trees carry keeps the chapter's
      // row above the note's: ranking ties hold the order they arrive in.
      ...(manuscript ? linkableDocuments(manuscript, []) : []),
      ...(scratch ? linkableDocuments(scratch, [schemeLabel("scratch")]) : []),
    ],
    [manuscript, scratch],
  );
}

/**
 * Depth-first, so ties in the menu keep the order the manuscript reads in.
 *
 * `root` names the tree a row came out of. The manuscript is where a chapter
 * lives and needs no label; a scratch note says so, because "where it lives" is
 * the only thing separating two documents whose titles look alike.
 */
function linkableDocuments(
  tree: ProjectContextTreeDirectory,
  root: readonly string[],
): WikilinkDocument[] {
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

  visit(tree, root);
  return documents;
}

function documentTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
