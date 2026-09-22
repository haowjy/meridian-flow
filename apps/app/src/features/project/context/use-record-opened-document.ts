/**
 * useRecordOpenedDocument — the one place an open is written to account recents.
 *
 * Every open lands here: the live editor tab, and a document the create path
 * materialized. Both used to carry their own copy of "record, then refresh the
 * list if it landed", which also meant two places had to know the throttle.
 *
 * Fire-and-forget: the open never waits on the network, and a failed record is
 * not surfaced. Recents are a convenience; the document is already open.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { recordRecentDocument } from "@/client/api/recent-documents-api";
import { accountQueryKeys } from "@/client/query/account-query-keys";

import { useAccountId } from "./account-feature-context";

export function useRecordOpenedDocument(): (documentId: string) => void {
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  return useCallback(
    (documentId: string) => {
      void recordRecentDocument(documentId, accountId).then((recorded) => {
        // Refresh even if the caller is gone by then: a writer can close the
        // document before the POST settles, and the landing they return to still
        // needs the fresh row. The query client outlives the caller.
        if (recorded) {
          void queryClient.invalidateQueries({ queryKey: accountQueryKeys.recentDocuments });
        }
      });
    },
    [accountId, queryClient],
  );
}
