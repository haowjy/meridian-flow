/**
 * Everything a reference in this scope can name, from the trees the app already
 * has.
 *
 * One index answers every half of the question, because they are the same
 * question asked several ways. "What can `[[…]]` name?" is the manuscript plus
 * the active Work's scratch, titled by filename. "What can `@` bring here?" is
 * that plus the images and PDFs beside them. "What is `./cast.md` relative to?"
 * is the URI of the document holding it, which has to come out of that same set
 * or a note the menu happily offers becomes a document that cannot host a
 * relative link of its own.
 *
 * The candidate set is the resolver's, not the tree panel's: a row for anything
 * the resolver cannot match is a row that inserts a link nobody can follow, and
 * withholding one it CAN match is the menu disagreeing with the link. Assets are
 * the exception that proves it — they never go through the resolver at all, so a
 * pick carries the concrete document id instead of a name.
 *
 * Titles are filenames without their extension, which is what `documents.name`
 * holds and what the server matches on. An asset keeps its extension, because
 * `map.png` is the file and `map` would be the chapter.
 *
 * The index also says WHICH catalog it is. A resolved answer is true of the
 * documents the project held when it was asked, so a rename, a create, or a
 * delete makes every cached answer a claim about a project that no longer
 * exists — without the project, the Work, or the base URI having moved. The
 * revision is what tells the resolution scope that, so no mutation site has to
 * remember to poke a cache it does not own.
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
import type { ReferenceCandidate } from "@/core/references";
import { schemeLabel } from "@/features/project/context/context-schemes";

import type { EditorScope } from "../../editor-scope";

export type ReferenceCandidateIndex = {
  readonly candidates: readonly ReferenceCandidate[];
  /**
   * Which catalog these rows are. Content, not an object identity and not a
   * counter: a refetch that found the same documents is the same revision and
   * invalidates nothing, while any change to what a link could reach is a
   * different one.
   */
  readonly revision: string;
};

export function useReferenceCandidates({
  projectId,
  workId,
}: EditorScope): ReferenceCandidateIndex {
  const { tree: manuscript } = useProjectContextTree(projectId ?? "", "manuscript", {
    enabled: Boolean(projectId),
  });
  const { tree: scratch } = useProjectContextTree(projectId ?? "", "scratch", {
    enabled: Boolean(projectId) && Boolean(workId),
    workId,
  });

  return useMemo(() => {
    const candidates = [
      // The manuscript first, so a title both trees carry keeps the chapter's
      // row above the note's: ranking ties hold the order they arrive in.
      ...(manuscript ? referenceCandidates(manuscript, []) : []),
      ...(scratch ? referenceCandidates(scratch, [schemeLabel("scratch")]) : []),
    ];
    return { candidates, revision: catalogRevision(candidates) };
  }, [manuscript, scratch]);
}

/**
 * Everything a link's answer depends on, in one string: which documents exist,
 * what each is called, and where each one is. Two catalogs with the same
 * revision cannot disagree about where any link goes, which is the property the
 * resolution scope needs — a link is re-asked when this changes and left alone
 * when it does not.
 *
 * Assets are deliberately not in it. They resolve to nothing by name, so an
 * upload changes what `@` offers without changing where a single link goes, and
 * counting one would throw away every resolved link in the document for it.
 */
function catalogRevision(candidates: readonly ReferenceCandidate[]): string {
  return candidates
    .filter((candidate) => candidate.kind === "document")
    .map((entry) => `${entry.documentId} ${entry.uri} ${entry.title}`)
    .join("\n");
}

/**
 * Depth-first, so ties in the menu keep the order the manuscript reads in.
 *
 * `root` names the tree a row came out of. The manuscript is where a chapter
 * lives and needs no label; a scratch note says so, because "where it lives" is
 * the only thing separating two documents whose titles look alike.
 */
function referenceCandidates(
  tree: ProjectContextTreeDirectory,
  root: readonly string[],
): ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];

  const visit = (node: ProjectContextTreeNode, folders: readonly string[]) => {
    if (node.kind === "dir") {
      const inside = node.path === "/" ? folders : [...folders, node.name];
      for (const child of node.children) visit(child, inside);
      return;
    }
    const location = folders.join("/");
    candidates.push(
      node.editable
        ? {
            kind: "document",
            documentId: node.documentId,
            title: documentTitle(node.name),
            location,
            uri: resolverUri(node.uri),
          }
        : {
            kind: "asset",
            assetDocumentId: node.documentId,
            name: node.name,
            location,
            path: node.path,
            fileType: node.fileType,
          },
    );
  };

  visit(tree, root);
  return candidates;
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
