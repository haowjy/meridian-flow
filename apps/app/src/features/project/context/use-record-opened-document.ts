/**
 * useRecordOpenedDocument — the one place an open is written to account recents.
 *
 * The live editor tab is the only recorder. It is the only moment an open is
 * both real and addressable: the document is in the catalog, so its row exists
 * and the server can accept it. Recording earlier races the materializer.
 *
 * Fire-and-forget: the open never waits on the network, and a failed record is
 * not surfaced. Recents are a convenience; the document is already open.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { recordRecentDocument } from "@/client/api/recent-documents-api";
import { accountQueryKeys } from "@/client/query/account-query-keys";

export function useRecordOpenedDocument(): (documentId: string) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (documentId: string) => {
      void recordRecentDocument(documentId).then((recorded) => {
        // Refresh even if the caller is gone by then: a writer can close the
        // document before the POST settles, and the landing they return to still
        // needs the fresh row. The query client outlives the caller. A skipped
        // open reports false and needs no refresh: the row did not move.
        if (recorded) {
          // Every project's list: the open may belong to a project whose landing
          // is not mounted, and only one list is ever rendered at a time.
          void queryClient.invalidateQueries({ queryKey: accountQueryKeys.recentDocumentsRoot });
        }
      });
    },
    [queryClient],
  );
}
