/**
 * Every document a link in this scope can reach, from the trees the app already
 * has.
 *
 * One index answers both halves of a link question, because they are the same
 * question asked twice. "What can `[[…]]` name?" is the manuscript plus the
 * active Work's scratch, titled by filename. "What is `./cast.md` relative to?"
 * is the URI of the document holding it, which has to come out of that same set
 * or a note the menu happily offers becomes a document that cannot host a
 * relative link of its own.
 *
 * The candidate set is the resolver's, not the tree panel's: a row for anything
 * the resolver cannot match is a row that inserts a link nobody can follow, and
 * withholding one it CAN match is the menu disagreeing with the link.
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

export type LinkableDocument = WikilinkDocument & {
  /** The persisted `documents.id`, which is what a follow opens. */
  documentId: string;
  /**
   * The document's URI in the resolver's spelling, which is what a relative
   * link in it resolves against.
   */
  uri: string;
};

export function useWikilinkDocuments({
  projectId,
  workId,
}: EditorScope): readonly LinkableDocument[] {
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
): LinkableDocument[] {
  const documents: LinkableDocument[] = [];

  const visit = (node: ProjectContextTreeNode, folders: readonly string[]) => {
    if (node.kind === "dir") {
      const inside = node.path === "/" ? folders : [...folders, node.name];
      for (const child of node.children) visit(child, inside);
      return;
    }
    // An image or a PDF has no title a wikilink can name.
    if (!node.editable) return;
    documents.push({
      documentId: node.documentId,
      title: documentTitle(node.name),
      location: folders.join("/"),
      uri: resolverUri(node.uri),
    });
  };

  visit(tree, root);
  return documents;
}

/**
 * The context tree spells a work-scoped document `scratch://`; the link contract
 * and the server that answers it both spell the same document `work://` (tracked
 * task #32). That one scheme swap is the whole translation, and doing it here is
 * what lets a scratch note be a base URI rather than only a destination.
 */
function resolverUri(uri: string): string {
  return uri.startsWith("scratch://") ? `work://${uri.slice("scratch://".length)}` : uri;
}

function documentTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
