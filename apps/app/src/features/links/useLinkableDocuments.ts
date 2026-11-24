import { useMemo, useRef } from "react";
import { useLinkResolutionEpoch } from "@/client/query/link-resolution-epoch";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import type { TreeView } from "@/core/project-tree/tree-view";

import { LINKABLE_SCHEMES, linkableScopes } from "./linkable-scopes";

export type LinkableDocument = {
  documentId: string;
  title: string;
  uri: string;
  workId: string | null;
  rootThreadId?: string;
  file?: { fileType: string; mimeType: string | null };
};

export type LinkableFolder = { folderId: string; title: string; uri: string };

export type LinkableDocumentIndex = {
  readonly documents: readonly LinkableDocument[];
  readonly folders: readonly LinkableFolder[];
  readonly trees: readonly TreeView[];
  readonly revision: string;
  readonly complete: boolean;
};

export function useLinkableDocuments({
  projectId,
  workId,
  rootThreadId,
  chatThreadId,
}: {
  projectId: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  chatThreadId?: string | null;
}): LinkableDocumentIndex {
  const resolutionEpoch = useLinkResolutionEpoch(projectId);
  const prior = useRef<LinkableDocumentIndex | null>(null);
  const scopes = linkableScopes({ projectId, workId, rootThreadId, chatThreadId });
  const scopedWorkId = scopes?.workId ?? null;
  const scopedRootThreadId = scopes?.rootThreadId ?? null;
  const views = useProjectTreeViews(scopes?.projectId ?? "", LINKABLE_SCHEMES, {
    enabled: scopes !== null,
    workId: scopedRootThreadId ? null : scopedWorkId,
    rootThreadId: scopedRootThreadId,
    chatThreadId: scopes?.chatThreadId ?? null,
  });

  return useMemo(() => {
    const documents: LinkableDocument[] = [];
    const folders: LinkableFolder[] = [];
    const trees: TreeView[] = [];
    let complete = scopes !== null;
    for (const scheme of LINKABLE_SCHEMES) {
      const { tree, isComplete } = views[scheme];
      complete &&= isComplete;
      if (!tree) continue;
      trees.push(tree);
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
      trees,
      revision: `${resolutionEpoch}\n${treeRevision(documents, folders)}`,
      complete,
    };
    if (prior.current?.revision === next.revision && prior.current.complete === next.complete)
      return prior.current;
    prior.current = next;
    return next;
  }, [views, scopes, scopedWorkId, scopedRootThreadId, resolutionEpoch]);
}

function treeRevision(
  documents: readonly LinkableDocument[],
  folders: readonly LinkableFolder[],
): string {
  return [
    ...documents.map((entry) => `${entry.documentId} ${entry.uri}`),
    ...folders.map((entry) => `${entry.folderId} ${entry.uri}/`),
  ].join("\n");
}

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
