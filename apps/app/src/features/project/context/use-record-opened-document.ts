/**
 * useRecordOpenedDocument — the one place an open is written to account recents.
 *
 * The live editor tab is the recorder. The device record updates before the
 * POST, so the landing does not wait on the network. A failed or unchanged
 * record leaves that opening where the writer put it.
 *
 * A document the writer just made exists only on this device until its create
 * syncs, and the server answers a record for it 404. So the POST waits until
 * the replica says the server has the document; one that never gets there
 * (deleted first, or the account closed) is never posted. A document the
 * replica does not hold is the server's already.
 */
import type { ResourceProjectionSnapshot, ResourceRecord } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { recordRecentDocument } from "@/client/api/recent-documents-api";
import { accountQueryKeys } from "@/client/query/account-query-keys";
import { type RecentOpening, touchAccountRecent } from "@/client/recents";
import {
  useAccountEpochSignal,
  useAccountId,
  useOptionalAccountResourceReplica,
} from "./account-feature-context";

/** The replica reads the recorder needs. */
export type ServerPresenceSource = {
  readKnownDocument(
    projectId: string,
    documentId: string,
  ): Promise<{ record: ResourceRecord } | null>;
  observeProjection(
    projectId: string,
    listener: (snapshot: ResourceProjectionSnapshot) => void,
    onError: (error: unknown) => void,
  ): () => void;
};

/**
 * True once the server holds the document: at once for one the replica does
 * not track or has acknowledged, later when a local create is acknowledged.
 * False when it ends without reaching the server, or the signal aborts.
 */
export async function whenOnServer(
  source: ServerPresenceSource,
  projectId: string,
  documentId: string,
  signal: AbortSignal,
): Promise<boolean> {
  // A replica that is closing, or a read that fails, proves nothing: no post.
  try {
    return await waitOnServer(source, projectId, documentId, signal);
  } catch {
    return false;
  }
}

async function waitOnServer(
  source: ServerPresenceSource,
  projectId: string,
  documentId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const known = await source.readKnownDocument(projectId, documentId);
  const state = (record: ResourceRecord | undefined) =>
    !record || record.resource.lifecycle.kind === "acknowledged"
      ? "server"
      : record.resource.lifecycle.kind === "terminal"
        ? "gone"
        : "local";
  const initial = state(known?.record);
  if (initial !== "local") return initial === "server" && !signal.aborted;
  return new Promise<boolean>((resolve) => {
    let stop: () => void = () => {};
    const finish = (result: boolean) => {
      stop();
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      stop = source.observeProjection(
        projectId,
        ({ records }) => {
          const current = state(
            records.find((record) => record.resource.identity.documentId === documentId),
          );
          if (current !== "local") finish(current === "server");
        },
        () => finish(false),
      );
    } catch {
      finish(false);
      return;
    }
    if (signal.aborted) finish(false);
  });
}

export function useRecordOpenedDocument(): (opening: RecentOpening) => void {
  const accountId = useAccountId();
  const epoch = useAccountEpochSignal();
  const resources = useOptionalAccountResourceReplica();
  const queryClient = useQueryClient();
  return useCallback(
    (opening: RecentOpening) => {
      const touched = touchAccountRecent(accountId, opening);
      if (!touched) return;
      void (async () => {
        if (
          resources &&
          !(await whenOnServer(resources, opening.projectId, opening.documentId, epoch))
        )
          return;
        const result = await recordRecentDocument(opening.documentId, epoch);
        if (result.kind !== "recorded") return;
        void queryClient.invalidateQueries({
          queryKey: accountQueryKeys.recentDocumentsRoot(accountId),
        });
      })();
    },
    [accountId, epoch, queryClient, resources],
  );
}
