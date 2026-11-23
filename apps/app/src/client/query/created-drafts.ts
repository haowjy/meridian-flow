/**
 * The drafts a Work's own creates make, before the server lists them. A document created in a
 * Work is drafted under an id its create names (`createdDraftId`), so the browser knows the whole
 * item from its copy of the list: where the Work puts the document and its item key. It
 * opens at once, offline too, and the server's row, when it comes, is the same draft and replaces
 * this one. A create the server dropped, discarded or applied is no longer pending, and leaves.
 */
import { draftItemKey, parseDraftItemKey } from "@meridian/contracts";
import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import type { DraftItem } from "@meridian/contracts/drafts";
import { pendingCreates, pendingRecords, replayView } from "@meridian/project-tree";
import type { LoroDoc } from "loro-crdt";
import { useCallback, useMemo } from "react";
import { draftTreeVersion } from "@/core/project-tree/tree-version";
import {
  useAccountId,
  useOptionalTreeLists,
} from "@/features/project/context/account-feature-context";
import { parseContextUri } from "@/lib/context-uri";
import { useTreeList } from "./useProjectTree";
import { useProjectTrees } from "./useProjectTrees";

/** The draft's pending document creates the server has not listed, as list rows. */
export function useCreatedDrafts(
  projectId: string,
  draftId: string | null,
  listed: readonly DraftItem[] | undefined,
): readonly DraftItem[] {
  const accountId = useAccountId();
  const project = useTreeList(projectId ? { kind: "project", projectId } : null);
  const account = useTreeList(projectId ? { kind: "account", userId: accountId } : null);
  const candidates = useMemo(() => {
    if (!draftId) return [];
    const known = new Set(listed?.map((row) => row.documentId));
    return [project.snapshot, account.snapshot].flatMap((snapshot) =>
      snapshot
        ? createdDocuments(snapshot.doc, draftId).filter((documentId) => !known.has(documentId))
        : [],
    );
  }, [draftId, listed, project.snapshot, account.snapshot]);
  const version = draftId && candidates.length > 0 ? draftTreeVersion(draftId) : undefined;
  const trees = useProjectTrees(projectId, { version });
  return useMemo(() => {
    if (!draftId || !version) return NONE;
    return candidates.map((documentId): DraftItem => {
      // The row is the record's: a place the trees have not drawn yet is no address, not no row.
      const uri = trees.find(documentId)?.file.uri;
      const location = uri ? parseContextUri(uri) : null;
      return {
        draftId,
        itemKey: draftItemKey(draftId, documentId),
        documentId,
        pending: false,
        liveVersion: null,
        changes: 0,
        origin: "created",
        isNew: true,
        binary: false,
        wholeItem: true,
        documentName: uri ? documentTitleFromUri(uri) : null,
        contextLocation: location ? { scheme: location.scheme, path: location.path } : null,
        tree: null,
        actorThreads: [],
        unattributed: false,
        updatedAt: new Date(0).toISOString(),
      };
    });
  }, [draftId, version, candidates, trees]);
}

const NONE: readonly DraftItem[] = [];

/** The documents the Work's pending creates make and its view still shows: an Undo trashes one. */
function createdDocuments(doc: LoroDoc, draftId: string): string[] {
  const created = pendingCreates(pendingRecords(doc, draftId), "document");
  if (created.size === 0) return [];
  const { nodes } = replayView(doc, { draft: draftId });
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
          return createdDocuments(doc, item.draftId).includes(item.documentId);
        } finally {
          handle.release();
        }
      });
    },
    [lists, projectId, accountId],
  );
}
