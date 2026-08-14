/**
 * useThreadSnapshotSync — applies the authoritative native thread snapshot.
 *
 * Fetches the server `Turn[]` snapshot over HTTP and reconciles it into the
 * thread store. This is the only client snapshot path; AG-UI remains a live
 * streaming transport, not persisted history.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  deserializeThreadSnapshot,
  getThreadSnapshot,
  toThreadSnapshotApplyOptions,
} from "@/client/api/threads-api";
import { useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
import { threadQueryKeys } from "./thread-query-keys";

type DeserializedThreadSnapshot = ReturnType<typeof deserializeThreadSnapshot>;

export type ThreadSnapshotSyncStatus = {
  snapshot: DeserializedThreadSnapshot | null;
  thread: DeserializedThreadSnapshot["thread"] | null;
  liveState: DeserializedThreadSnapshot["liveState"] | null;
  attention: DeserializedThreadSnapshot["attention"] | null;
  nextSeq: DeserializedThreadSnapshot["nextSeq"] | null;
  /**
   * The request resolved at least once — applied or failed. Surfaces that must
   * distinguish "this thread has no such turn" from "history hasn't arrived
   * yet" (the conversation-reveal handshake) key off this, not off emptiness.
   */
  settled: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

/**
 * Suppressed while the thread is still pending optimistic server creation —
 * `POST /api/threads` races `GET /api/threads/:id/snapshot` from the chat
 * surface otherwise, producing benign 404s during a normal flow.
 */
export function useThreadSnapshotSync(threadId: string): ThreadSnapshotSyncStatus {
  const actions = useThreadActions();
  const isPendingCreation = useIsThreadPendingCreation(threadId);

  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: threadQueryKeys.snapshot(threadId),
    queryFn: async () => {
      const snapshot = await getThreadSnapshot({ data: { threadId } });
      return deserializeThreadSnapshot(snapshot);
    },
    staleTime: 30_000,
    enabled: !isPendingCreation,
  });

  useEffect(() => {
    if (!data) return;
    actions.applyThreadSnapshot(data.thread, data.turns, toThreadSnapshotApplyOptions(data));
  }, [actions, data]);

  return {
    snapshot: data ?? null,
    thread: data?.thread ?? null,
    liveState: data?.liveState ?? null,
    attention: data?.attention ?? null,
    nextSeq: data?.nextSeq ?? null,
    settled: data !== undefined || isError,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
