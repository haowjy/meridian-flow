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
 * The index also says WHICH tree it is. A resolved answer is true of the
 * documents the project held when it was asked, so a rename, a create, or a
 * delete makes every cached answer a claim about a project that no longer
 * exists — without the project, the Work, or the base URI having moved. The
 * revision is what tells the resolution scope that, so no mutation site has to
 * remember to poke a cache it does not own. The project's wake hints (a draft
 * owner's, the sources') also advance it because a server answer may name a
 * folder or hidden document outside the trees this surface loads.
 *
 * Read from the project's list the app already holds: the index costs no request.
 */

import { useMemo, useRef } from "react";
import { useLinkResolutionEpoch } from "@/client/query/link-resolution-epoch";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import type { TreeView } from "@/core/project-tree/tree-view";

import { LINKABLE_SCHEMES, linkableScopes } from "./linkable-scopes";

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
  /** Set for a stored file (anything that is not a tracked document); its size only the server knows. */
  file?: { fileType: string; mimeType: string | null };
};

/** A folder a link can name: by entry id, at its current canonical address. */
export type LinkableFolder = { folderId: string; title: string; uri: string };

export type LinkableDocumentIndex = {
  readonly documents: readonly LinkableDocument[];
  readonly folders: readonly LinkableFolder[];
  /**
   * Which tree these rows are. Content, not an object identity and not a
   * counter: a refetch that found the same documents is the same revision and
   * invalidates nothing, while any change to what a link could reach is a
   * different one.
   */
  readonly revision: string;
  /** Every list has synced, so an address it holds no document at can be left to the server. */
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
  const resolutionEpoch = useLinkResolutionEpoch(projectId);
  const prior = useRef<LinkableDocumentIndex | null>(null);
  const scopes = linkableScopes({ projectId, workId, rootThreadId, chatId });
  const scopedWorkId = scopes?.workId ?? null;
  const scopedRootThreadId = scopes?.rootThreadId ?? null;
  // A surface owns only some sources (an Editor document has no chat, so no uploads): an unowned
  // scheme has an empty tree here, and completeness is the list's.
  const views = useProjectTreeViews(scopes?.projectId ?? "", LINKABLE_SCHEMES, {
    enabled: scopes !== null,
    // A No Work chat's lineage Scratch replaces the Work's.
    workId: scopedRootThreadId ? null : scopedWorkId,
    rootThreadId: scopedRootThreadId,
    chatId: scopes?.chatId ?? null,
  });

  return useMemo(() => {
    const documents: LinkableDocument[] = [];
    const folders: LinkableFolder[] = [];
    let complete = scopes !== null;
    for (const scheme of LINKABLE_SCHEMES) {
      const { tree, isComplete } = views[scheme];
      complete &&= isComplete;
      if (!tree) continue;
      documents.push(
        ...(scheme === "scratch"
          ? linkableDocuments(tree, scopedRootThreadId ? null : scopedWorkId, scopedRootThreadId)
          : linkableDocuments(tree, null)),
      );
      folders.push(...linkableFolders(tree));
    }
    const next = {
      documents,
      folders,
      revision: `${resolutionEpoch}\n${treeRevision(documents, folders)}`,
      complete,
    };
    if (prior.current?.revision === next.revision && prior.current.complete === next.complete)
      return prior.current;
    prior.current = next;
    return next;
  }, [views, scopes, scopedWorkId, scopedRootThreadId, resolutionEpoch]);
}

/**
 * Everything an answer depends on, in one string: which documents exist and
 * where each one is. Two trees with the same revision cannot disagree about
 * where any link goes, which is the property the resolution scope needs — a
 * link is re-asked when this changes and left alone when it does not.
 */
function treeRevision(
  documents: readonly LinkableDocument[],
  folders: readonly LinkableFolder[],
): string {
  return [
    ...documents.map((entry) => `${entry.documentId} ${entry.uri}`),
    ...folders.map((entry) => `${entry.folderId} ${entry.uri}/`),
  ].join("\n");
}

/** The tree's folders. */
function linkableFolders(tree: TreeView): LinkableFolder[] {
  const folders: LinkableFolder[] = [];
  const walk = (parentId: string) => {
    for (const node of tree.children(parentId)) {
      if (node.kind !== "dir") continue;
      folders.push({ folderId: node.entryId, title: node.name, uri: node.uri });
      walk(node.entryId);
    }
  };
  walk(tree.root.entryId);
  return folders;
}

function linkableDocuments(
  tree: TreeView,
  workId: string | null,
  rootThreadId?: string | null,
): LinkableDocument[] {
  return tree.files().map((node) => ({
    documentId: node.documentId,
    title: node.name,
    uri: node.uri,
    workId,
    ...(rootThreadId ? { rootThreadId } : {}),
    ...(node.editable
      ? {}
      : { file: { fileType: node.fileType, mimeType: node.mimeType ?? null } }),
  }));
}
