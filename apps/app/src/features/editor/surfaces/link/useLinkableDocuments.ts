import type { CatalogContextView } from "@/client/query/context-catalog-projection";
/**
 * Every document a link in this scope can reach, from the trees the app already
 * has.
 *
 * One index answers both halves of a link question. "What can `[[…]]` name?"
 * uses every server-resolvable project, user, and current Work-or-No-Work scope,
 * including aliases and non-editable ambiguity candidates. "What is `./cast.md`
 * relative to?" uses the URI of the document holding it from that same set.
 *
 * The candidate set is the resolver's, not the tree panel's: a row for anything
 * the resolver cannot match is a row that inserts a link nobody can follow, and
 * withholding one it CAN match is the menu disagreeing with the link.
 *
 * Titles are filenames without their extension; aliases remain alternate
 * resolver names.
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

import { useMemo, useRef } from "react";

import { useContextCatalogView } from "@/client/query/useContextCatalog";
import type { WikilinkDocument } from "@/core/completion";
import { schemeLabel } from "@/features/project/context/context-schemes";

import type { EditorScope } from "../../editor-scope";

export type LinkableDocument = WikilinkDocument & {
  /**
   * The document's URI in the resolver's spelling, which is what a relative
   * link in it resolves against.
   */
  uri: string;
  filename: string;
  aliases: readonly string[];
  workId: string | null;
};

export type LinkableDocumentIndex = {
  readonly documents: readonly LinkableDocument[];
  /**
   * Which catalog these rows are. Content, not an object identity and not a
   * counter: a refetch that found the same documents is the same revision and
   * invalidates nothing, while any change to what a link could reach is a
   * different one.
   */
  readonly revision: string;
  /** All server candidate scopes are represented, so uniqueness can be proven locally. */
  readonly complete: boolean;
};

export function useLinkableDocuments({ projectId, workId }: EditorScope): LinkableDocumentIndex {
  const prior = useRef<LinkableDocumentIndex | null>(null);
  const { catalog: manuscript, isComplete: manuscriptComplete } = useContextCatalogView(
    projectId ?? "",
    "manuscript",
    {
      enabled: Boolean(projectId),
      workId: null,
    },
  );
  const { catalog: knowledgeBase, isComplete: knowledgeBaseComplete } = useContextCatalogView(
    projectId ?? "",
    "kb",
    {
      enabled: Boolean(projectId),
      workId: null,
    },
  );
  const { catalog: unfiled, isComplete: unfiledComplete } = useContextCatalogView(
    projectId ?? "",
    "unfiled",
    {
      enabled: Boolean(projectId && !workId),
      workId: null,
    },
  );
  const { catalog: user, isComplete: userComplete } = useContextCatalogView(
    projectId ?? "",
    "user",
    {
      enabled: Boolean(projectId),
      workId: null,
    },
  );
  const { catalog: scratch, isComplete: scratchComplete } = useContextCatalogView(
    projectId ?? "",
    "scratch",
    {
      enabled: Boolean(projectId),
      workId,
    },
  );
  const { catalog: uploads, isComplete: uploadsComplete } = useContextCatalogView(
    projectId ?? "",
    "uploads",
    {
      enabled: Boolean(projectId),
      workId,
    },
  );

  return useMemo(() => {
    const documents = [
      // The manuscript first, so a title both trees carry keeps the chapter's
      // row above the note's: ranking ties hold the order they arrive in.
      ...(manuscript ? linkableDocuments(manuscript, [], null) : []),
      ...(knowledgeBase ? linkableDocuments(knowledgeBase, [schemeLabel("kb")], null) : []),
      ...(user ? linkableDocuments(user, [schemeLabel("user")], null) : []),
      ...(!workId && unfiled ? linkableDocuments(unfiled, [schemeLabel("unfiled")], null) : []),
      ...(scratch ? linkableDocuments(scratch, [schemeLabel("scratch")], workId) : []),
      ...(uploads ? linkableDocuments(uploads, [schemeLabel("uploads")], workId) : []),
    ];
    const next = {
      documents,
      revision: catalogRevision(documents),
      complete:
        manuscriptComplete &&
        knowledgeBaseComplete &&
        userComplete &&
        (Boolean(workId) || unfiledComplete) &&
        scratchComplete &&
        uploadsComplete,
    };
    if (prior.current?.revision === next.revision && prior.current.complete === next.complete)
      return prior.current;
    prior.current = next;
    return next;
  }, [
    knowledgeBase,
    knowledgeBaseComplete,
    manuscript,
    manuscriptComplete,
    scratch,
    scratchComplete,
    unfiled,
    unfiledComplete,
    uploads,
    uploadsComplete,
    user,
    userComplete,
    workId,
  ]);
}

/**
 * Everything an answer depends on, in one string: which documents exist, what
 * each is called, and where each one is. Two catalogs with the same revision
 * cannot disagree about where any link goes, which is the property the
 * resolution scope needs — a link is re-asked when this changes and left alone
 * when it does not.
 */
function catalogRevision(documents: readonly LinkableDocument[]): string {
  return documents
    .map(
      (entry) =>
        `${entry.documentId} ${entry.uri} ${entry.filename} ${entry.title} ${entry.aliases.join("\u0000")}`,
    )
    .join("\n");
}

/**
 * Depth-first, so ties in the menu keep the order the manuscript reads in.
 *
 * `root` names the tree a row came out of. The manuscript is where a chapter
 * lives and needs no label; a scratch note says so, because "where it lives" is
 * the only thing separating two documents whose titles look alike.
 */
function linkableDocuments(
  catalog: CatalogContextView,
  root: readonly string[],
  workId: string | null,
): LinkableDocument[] {
  const documents: LinkableDocument[] = [];
  for (const node of catalog.files()) {
    const folders = [...root, ...node.path.split("/").filter(Boolean).slice(0, -1)];
    documents.push({
      documentId: node.documentId,
      filename: node.name,
      title: documentTitle(node.name),
      location: folders.join("/"),
      uri: node.uri,
      aliases: node.aliases ?? [],
      workId,
    });
  }
  return documents;
}

function documentTitle(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
