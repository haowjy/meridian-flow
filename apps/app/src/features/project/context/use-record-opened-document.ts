/**
 * useRecordOpenedDocument — the one place an open is written to account recents.
 *
 * The live editor tab is the recorder. The device record updates before the
 * POST, so the landing does not wait on the network. A failed or unchanged
 * record leaves that opening where the writer put it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { recordRecentDocument } from "@/client/api/recent-documents-api";
import { accountQueryKeys } from "@/client/query/account-query-keys";
import { type RecentOpening, touchAccountRecent } from "@/client/recents";
import { useAccountEpochSignal, useAccountId } from "./account-feature-context";

export function useRecordOpenedDocument(): (opening: RecentOpening) => void {
  const accountId = useAccountId();
  const epoch = useAccountEpochSignal();
  const queryClient = useQueryClient();
  return useCallback(
    (opening: RecentOpening) => {
      const touched = touchAccountRecent(accountId, opening);
      if (!touched) return;
      void recordRecentDocument(opening.documentId, epoch).then((result) => {
        if (result.kind !== "recorded") return;
        void queryClient.invalidateQueries({
          queryKey: accountQueryKeys.recentDocumentsRoot(accountId),
        });
      });
    },
    [accountId, epoch, queryClient],
  );
}
