/**
 * Every document and folder a link in this scope can reach, from the trees the
 * app already has.
 *
 * One index answers the link questions an editor scope asks: what the
 * document holding a link is called (its address, which a relative link
 * resolves against), which document is at an address, so a link the index can
 * answer costs no request, and whether a link-ahead address is already taken.
 * It walks the project's manuscript, kb, and Unfiled, the writer's user files,
 * and the scope's Scratch (the chat's lineage notes on No Work, else the scope
 * Work's) and the chat's uploads. A URI naming another owner's Scratch or
 * another chat's uploads is outside it and always asks the server.
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

import { contextOwner } from "@meridian/contracts/protocol";
import { useMemo, useRef } from "react";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { useDraftLinkEpoch } from "@/client/query/draft-link-epoch";
import { useContextCatalogViews } from "@/client/query/useContextCatalog";

import { linkableCatalogScopes, ownedLinkableSchemes } from "./linkable-catalog-scopes";

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
};

/** A folder a link can name: by entry id, at its current canonical address. */
export type LinkableFolder = { folderId: string; title: string; uri: string };

export type LinkableDocumentIndex = {
  readonly documents: readonly LinkableDocument[];
  readonly folders: readonly LinkableFolder[];
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
  chatId,
}: {
  projectId: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  chatId?: string | null;
}): LinkableDocumentIndex {
  const draftEpoch = useDraftLinkEpoch(projectId);
  const prior = useRef<LinkableDocumentIndex | null>(null);
  const scopes = linkableCatalogScopes({ projectId, workId, rootThreadId, chatId });
  const catalogWorkId = scopes?.workId ?? null;
  const catalogRootThreadId = scopes?.rootThreadId ?? null;
  // A surface owns only some catalogs (an Editor document has no chat, so no uploads):
  // an unowned scheme is absent here, not a catalog that never finishes loading.
  const schemes = useMemo(
    () => ownedLinkableSchemes(scopes),
    [scopes?.projectId, scopes?.workId, scopes?.rootThreadId, scopes?.chatId],
  );
  const views = useContextCatalogViews(scopes?.projectId ?? "", schemes, {
    enabled: scopes !== null,
    ...contextOwner(catalogWorkId, catalogRootThreadId),
    chatId: scopes?.chatId ?? null,
  });

  return useMemo(() => {
    const documents: LinkableDocument[] = [];
    const folders: LinkableFolder[] = [];
    let complete = scopes !== null;
    for (const scheme of schemes) {
      const { catalog, isComplete } = views[scheme];
      complete &&= isComplete;
      if (!catalog) continue;
      documents.push(
        ...(scheme === "scratch"
          ? linkableDocuments(
              catalog,
              catalogRootThreadId ? null : catalogWorkId,
              catalogRootThreadId,
            )
          : linkableDocuments(catalog, null)),
      );
      folders.push(...linkableFolders(catalog));
    }
    const next = {
      documents,
      folders,
      revision: `${draftEpoch}\n${catalogRevision(documents, folders)}`,
      complete,
    };
    if (prior.current?.revision === next.revision && prior.current.complete === next.complete)
      return prior.current;
    prior.current = next;
    return next;
  }, [schemes, views, scopes, catalogWorkId, catalogRootThreadId, draftEpoch]);
}

/**
 * Everything an answer depends on, in one string: which documents exist and
 * where each one is. Two catalogs with the same revision cannot disagree about
 * where any link goes, which is the property the resolution scope needs — a
 * link is re-asked when this changes and left alone when it does not.
 */
function catalogRevision(
  documents: readonly LinkableDocument[],
  folders: readonly LinkableFolder[],
): string {
  return [
    ...documents.map((entry) => `${entry.documentId} ${entry.uri}`),
    ...folders.map((entry) => `${entry.folderId} ${entry.uri}/`),
  ].join("\n");
}

/** The catalog's folders with a server identity; device-synthesized ancestry names nothing. */
function linkableFolders(catalog: CatalogContextView): LinkableFolder[] {
  const folders: LinkableFolder[] = [];
  const walk = (parentId: string) => {
    for (const node of catalog.children(parentId)) {
      if (node.kind !== "dir") continue;
      if (!node.navigationOnly)
        folders.push({ folderId: node.entryId, title: node.name, uri: node.uri });
      walk(node.entryId);
    }
  };
  walk(catalog.root.entryId);
  return folders;
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
