/**
 * Every document a link in this scope can reach, from the trees the app already
 * has.
 *
 * One index answers the link questions an editor scope asks: what the
 * document holding a link is called (its address, which a relative link
 * resolves against), which document is at an address, so a link the index can
 * answer costs no request, and whether a link-ahead address is already taken.
 * It walks the project's manuscript, kb, and Unfiled, the writer's user files,
 * and the scope's Scratch (the chat's lineage notes on No Work, else the scope
 * Work's) and the scope Work's Uploads. A URI naming another owner's Scratch is
 * outside it and always asks the server.
 *
 * The index also says WHICH catalog it is. A resolved answer is true of the
 * documents the project held when it was asked, so a rename, a create, or a
 * delete makes every cached answer a claim about a project that no longer
 * exists — without the project, the Work, or the base URI having moved. The
 * revision is what tells the resolution scope that, so no mutation site has to
 * remember to poke a cache it does not own.
 *
 * Cached client-side and free: these are the same queries the context tree
 * already pays for, so the index costs no request.
 */

import { isProjectScopedScheme } from "@meridian/contracts";
import { contextOwner } from "@meridian/contracts/protocol";
import { useMemo, useRef } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useDraftLinkEpoch } from "@/client/query/draft-link-epoch";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import { documentBasename, type ReviewFileTarget } from "@/client/query/work-draft-files";

import { LINKABLE_SCHEMES, linkableCatalogScopes } from "./linkable-catalog-scopes";

export type LinkableDocument = {
  /** Persisted identity, stable across reorder, move, and rename. */
  documentId: string;
  /** The stored name: what the writer sees. */
  title: string;
  /** Its canonical Context URI: its address, and what a relative link in it resolves against. */
  uri: string;
  workId: string | null;
  /** A chat's Scratch note is held by its lineage instead of a Work. */
  rootThreadId?: string;
  /** Present iff the document is hidden: it exists only in this draft, and only its review opens it. */
  draft?: { draftId: string; workId: string };
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
  /** Every catalog has loaded, so an address it holds no document at can be left to the server. */
  readonly complete: boolean;
};

export function useLinkableDocuments({
  projectId,
  workId,
  rootThreadId,
  withDraftDocuments = false,
}: {
  projectId: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  /**
   * Also hold the documents only the scope Work's draft has created (hidden from every
   * catalog), so an address names them as "in a draft". A chat's links and doors read
   * the Work's draft; an editor's links keep resolving against the live tree.
   */
  withDraftDocuments?: boolean;
}): LinkableDocumentIndex {
  const draftEpoch = useDraftLinkEpoch(projectId);
  const prior = useRef<LinkableDocumentIndex | null>(null);
  const scopes = linkableCatalogScopes({ projectId, workId, rootThreadId });
  const catalogWorkId = scopes?.workId ?? null;
  const catalogRootThreadId = scopes?.rootThreadId ?? null;
  const {
    manuscript: { catalog: manuscript, isComplete: manuscriptComplete },
    kb: { catalog: knowledgeBase, isComplete: knowledgeBaseComplete },
    unfiled: { catalog: unfiled, isComplete: unfiledComplete },
    user: { catalog: user, isComplete: userComplete },
    scratch: { catalog: scratch, isComplete: scratchComplete },
    uploads: { catalog: uploads, isComplete: uploadsComplete },
  } = useContextCatalogViews(scopes?.projectId ?? "", LINKABLE_SCHEMES, {
    enabled: scopes !== null,
    ...contextOwner(catalogWorkId, catalogRootThreadId),
    // A lineage's Scratch and the Work row's Uploads are separate owners of one index.
    uploadsWorkId: catalogWorkId,
  });

  // The projected Work list (not the raw rows): a change settled on this device is already out of it.
  const drafts = useWorkDrafts(
    withDraftDocuments ? projectId : null,
    withDraftDocuments ? catalogWorkId : null,
  );
  const draftDocuments = useMemo(
    () => (drafts.files && catalogWorkId ? draftOnlyDocuments(drafts.files, catalogWorkId) : []),
    [drafts.files, catalogWorkId],
  );
  const draftsSettled =
    !withDraftDocuments || drafts.status === "ready" || drafts.status === "empty";

  return useMemo(() => {
    const documents = [
      ...(manuscript ? linkableDocuments(manuscript, null) : []),
      ...(knowledgeBase ? linkableDocuments(knowledgeBase, null) : []),
      ...(user ? linkableDocuments(user, null) : []),
      ...(unfiled ? linkableDocuments(unfiled, null) : []),
      ...(scratch
        ? linkableDocuments(
            scratch,
            catalogRootThreadId ? null : catalogWorkId,
            catalogRootThreadId,
          )
        : []),
      ...(uploads ? linkableDocuments(uploads, catalogWorkId) : []),
      // After every live entry: a live document at the same address answers a plain address.
      ...draftDocuments,
    ];
    const next = {
      documents,
      revision: `${draftEpoch}\n${catalogRevision(documents)}`,
      complete:
        manuscriptComplete &&
        knowledgeBaseComplete &&
        userComplete &&
        unfiledComplete &&
        scratchComplete &&
        uploadsComplete &&
        draftsSettled,
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
    catalogWorkId,
    catalogRootThreadId,
    draftEpoch,
    draftDocuments,
    draftsSettled,
  ]);
}

/**
 * Everything an answer depends on, in one string: which documents exist and
 * where each one is. Two catalogs with the same revision cannot disagree about
 * where any link goes, which is the property the resolution scope needs — a
 * link is re-asked when this changes and left alone when it does not.
 */
function catalogRevision(documents: readonly LinkableDocument[]): string {
  return documents
    .map(
      (entry) => `${entry.documentId} ${entry.uri}${entry.draft ? ` ${entry.draft.draftId}` : ""}`,
    )
    .join("\n");
}

/** The Work's created-and-still-hidden documents in the schemes a project shares. */
function draftOnlyDocuments(
  files: readonly ReviewFileTarget[],
  workId: string,
): LinkableDocument[] {
  return files.flatMap((file) => {
    const location = file.contextLocation;
    if (!file.isNew || !location || !isProjectScopedScheme(location.scheme)) return [];
    return [
      {
        documentId: file.documentId,
        title: file.documentName ?? documentBasename(location.path) ?? file.documentId,
        uri: `${location.scheme}://${location.path.replace(/^\/+/, "")}`,
        workId: null,
        draft: { draftId: file.draft.draftId, workId },
      },
    ];
  });
}

function linkableDocuments(
  catalog: CatalogContextView,
  workId: string | null,
  rootThreadId?: string | null,
): LinkableDocument[] {
  return catalog.files().map((node) => ({
    documentId: node.documentId,
    title: node.name,
    uri: node.uri,
    workId,
    ...(rootThreadId ? { rootThreadId } : {}),
  }));
}
