/**
 * The drafts a Work's own creates make, before the server lists them. A document created in a
 * Work is drafted under an id its create names (`createdDraftId`), so the browser knows the whole
 * item from its copy of the list: where the Work puts the document and its item key. It
 * opens at once, offline too, and the server's row, when it comes, is the same draft and replaces
 * this one. A create the server dropped, discarded or applied is no longer pending, and leaves.
 */
import { draftItemKey, parseDraftItemKey } from "@meridian/contracts";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import { pendingCreates, pendingRecords, replayView } from "@meridian/project-tree";
import { useCallback, useMemo } from "react";
import type * as Y from "yjs";
import { draftTreeVersion } from "@/core/project-tree/tree-version";
import {
  useAccountId,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { parseContextUri } from "@/lib/context-uri";
import { useTreeList } from "./useProjectTree";
import { useProjectTrees } from "./useProjectTrees";

/** The branch's pending document creates the server has not listed, as list rows. */
export function useCreatedDrafts(
  projectId: string,
  branchId: string | null,
  listed: readonly ThreadDraftListItem[] | undefined,
): readonly ThreadDraftListItem[] {
  const accountId = useAccountId();
  const project = useTreeList(projectId ? { kind: "project", projectId } : null);
  const account = useTreeList(projectId ? { kind: "account", userId: accountId } : null);
  const candidates = useMemo(() => {
    if (!branchId) return [];
    const known = new Set(listed?.map((row) => row.documentId));
    return [project.snapshot, account.snapshot].flatMap((snapshot) =>
      snapshot
        ? createdDocuments(snapshot.doc, branchId).filter((documentId) => !known.has(documentId))
        : [],
    );
  }, [branchId, listed, project.snapshot, account.snapshot]);
  // The rows the list will hold once these join it: one version, shared with every reader of them.
  const version = useMemo(
    () =>
      branchId && candidates.length > 0
        ? draftTreeVersion(branchId, [
            ...(listed ?? []),
            ...candidates.map((documentId) => ({ documentId, hasDraft: true })),
          ])
        : undefined,
    [branchId, listed, candidates],
  );
  const trees = useProjectTrees(projectId, { version });
  return useMemo(() => {
    if (!branchId || !version) return NONE;
    return candidates.map((documentId): ThreadDraftListItem => {
      // The row is the record's: a place the trees have not drawn yet is no address, not no row.
      const uri = trees.find(documentId)?.file.uri;
      const location = uri ? parseContextUri(uri) : null;
      return {
        branchId,
        itemKey: draftItemKey(branchId, documentId),
        documentId,
        hasDraft: true,
        textChanges: 0,
        origin: "created",
        isNew: true,
        binary: false,
        wholeItem: true,
        documentName: uri ? documentTitleFromUri(uri) : null,
        contextLocation: location ? { scheme: location.scheme, path: location.path } : null,
        deletedLive: false,
        tree: null,
        actorThreads: [],
        unattributed: false,
        updatedAt: new Date(0).toISOString(),
      };
    });
  }, [branchId, version, candidates, trees]);
}

const NONE: readonly ThreadDraftListItem[] = [];

/** The documents the Work's pending creates make and its view still shows: an Undo trashes one. */
function createdDocuments(doc: Y.Doc, branchId: string): string[] {
  const created = pendingCreates(pendingRecords(doc, branchId), "document");
  if (created.size === 0) return [];
  const { nodes } = replayView(doc, { draft: branchId });
  return [...created].filter((id) => nodes.get(id)?.trashed === false);
}

/**
 * Whether this browser's lists hold the pending create that makes a draft item, read when asked:
 * a server read that lacks the item proves nothing then.
 */
export function useCreatesDraft(projectId: string): (itemKey: string) => boolean {
  const accountId = useAccountId();
  const lists = useOptionalTreeLists();
  return useCallback(
    (itemKey) => {
      const item = parseDraftItemKey(itemKey);
      if (!item || !lists) return false;
      const refs = [
        { kind: "project", projectId },
        { kind: "account", userId: accountId },
      ] as const;
      return refs.some((ref) => {
        const handle = lists.acquire(ref);
        try {
          const doc = handle.session.getSnapshot().doc;
          return createdDocuments(doc, item.branchId).includes(item.documentId);
        } finally {
          handle.release();
        }
      });
    },
    [lists, projectId, accountId],
  );
}
