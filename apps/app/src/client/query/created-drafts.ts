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
import { useProjectTreesAt } from "./useProjectTrees";

export function useCreatedDrafts(
  projectId: string,
  listed: ReadonlyMap<string, readonly DraftItem[]>,
): ReadonlyMap<string, readonly DraftItem[]> {
  const accountId = useAccountId();
  const project = useTreeList(projectId ? { kind: "project", projectId } : null);
  const account = useTreeList(projectId ? { kind: "account", userId: accountId } : null);
  const treesAt = useProjectTreesAt(projectId);
  return useMemo(() => {
    const created = new Map<string, readonly DraftItem[]>();
    for (const [draftId, rows] of listed) {
      const known = new Set(rows.map((row) => row.documentId));
      const candidates = [project.snapshot, account.snapshot].flatMap((snapshot) =>
        snapshot
          ? createdDocuments(snapshot.doc, draftId).filter((documentId) => !known.has(documentId))
          : [],
      );
      if (candidates.length === 0) continue;
      const trees = treesAt(draftTreeVersion(draftId).view);
      created.set(
        draftId,
        candidates.map((documentId): DraftItem => {
          // The row is the record's: a place the trees have not drawn yet is no address, not no row.
          const uri = trees.find(documentId)?.file.uri;
          const location = uri ? parseContextUri(uri) : null;
          return {
            draftId,
            itemKey: draftItemKey(draftId, documentId),
            documentId,
            pending: false,
            liveVersion: null,
            changeCount: 0,
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
        }),
      );
    }
    return created;
  }, [listed, project.snapshot, account.snapshot, treesAt]);
}

function createdDocuments(doc: LoroDoc, draftId: string): string[] {
  const created = pendingCreates(pendingRecords(doc, draftId), "document");
  if (created.size === 0) return [];
  const { nodes } = replayView(doc, { draft: draftId });
  return [...created].filter((id) => nodes.get(id)?.trashed === false);
}

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
