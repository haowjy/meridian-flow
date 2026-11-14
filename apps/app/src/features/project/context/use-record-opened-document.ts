/**
 * useRecordOpenedDocument — the one place an open is written to account recents.
 *
 * Main's document host is the recorder. The device record updates before the
 * POST, so the landing does not wait on the network. A failed or unchanged
 * record leaves that opening where the writer put it.
 *
 * A document the writer just made exists only in this device's copy of the list until the list
 * syncs, and the server answers a record for it 404. So the POST waits until the project's list
 * has synced; one that never gets there (the account closed, or no access) is never posted.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { recordRecentDocument } from "@/client/api/recent-documents-api";
import { accountQueryKeys } from "@/client/query/account-query-keys";
import { type RecentOpening, touchAccountRecent } from "@/client/recents";
import type { TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import {
  useAccountEpochSignal,
  useAccountId,
  useOptionalTreeLists,
} from "./account-feature-context";

/** Resolves true once the project's list holds the copy's records on the server; false when it will not. */
function whenListSynced(
  lists: TreeListRegistry,
  projectId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const held = lists.acquire({ kind: "project", projectId });
    let stop = () => {};
    const finish = (synced: boolean) => {
      stop();
      signal.removeEventListener("abort", onAbort);
      held.release();
      resolve(synced);
    };
    const onAbort = () => finish(false);
    const check = () => {
      const { status } = held.session.getSnapshot();
      if (status === "synced" || status === "read-only") finish(true);
      else if (status === "denied") finish(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stop = held.session.subscribe(check);
    if (signal.aborted) onAbort();
    else check();
  });
}

export function useRecordOpenedDocument(): (opening: RecentOpening) => void {
  const accountId = useAccountId();
  const epoch = useAccountEpochSignal();
  const lists = useOptionalTreeLists();
  const queryClient = useQueryClient();
  return useCallback(
    (opening: RecentOpening) => {
      const touched = touchAccountRecent(accountId, opening);
      if (!touched) return;
      void (async () => {
        if (lists && !(await whenListSynced(lists, opening.projectId, epoch))) return;
        const result = await recordRecentDocument(opening.documentId, epoch);
        if (result.kind !== "recorded") return;
        void queryClient.invalidateQueries({
          queryKey: accountQueryKeys.recentDocumentsRoot(accountId),
        });
      })();
    },
    [accountId, epoch, queryClient, lists],
  );
}
