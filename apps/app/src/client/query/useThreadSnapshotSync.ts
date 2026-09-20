/**
 * useThreadSnapshotSync — applies the authoritative native thread snapshot.
 *
 * Fetches the server `Turn[]` snapshot over HTTP and reconciles it into the
 * thread store. This is the only client snapshot path; AG-UI remains a live
 * streaming transport, not persisted history.
 */
import { EventType } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  deserializeThreadSnapshot,
  getThreadSnapshot,
  toThreadSnapshotApplyOptions,
} from "@/client/api/threads-api";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import { useIsThreadPendingCreation, useThreadActions } from "@/client/stores";
import { threadQueryKeys } from "./thread-query-keys";

type DeserializedThreadSnapshot = ReturnType<typeof deserializeThreadSnapshot>;

export type ThreadSnapshotSyncStatus = {
  snapshot: DeserializedThreadSnapshot | null;
  thread: DeserializedThreadSnapshot["thread"] | null;
  liveState: DeserializedThreadSnapshot["liveState"] | null;
  actionRequired: DeserializedThreadSnapshot["actionRequired"] | null;
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
  const transport = useThreadTransport();

  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: threadQueryKeys.snapshot(threadId),
    queryFn: async () => {
      const snapshot = await getThreadSnapshot({ data: { threadId } });
      return deserializeThreadSnapshot(snapshot);
    },
    // Always revalidate on activation: the thread may have advanced while the
    // writer was elsewhere (for example a background child's report waking the
    // parent). Cached turns still render first, so this stays navigate-first.
    staleTime: 0,
    refetchOnMount: "always",
    enabled: !isPendingCreation,
  });

  useEffect(() => {
    if (isPendingCreation) return;
    // A server-initiated run (a background report waking the parent) begins with
    // no local controller, so nothing would otherwise learn it started. Refetch
    // on a new run so the turn/card appears and the handoff can resume it live.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void refetch();
      }, 250);
    };
    return transport.subscribe(threadId, {
      onEvent: ({ event }) => {
        if (event.type === EventType.RUN_STARTED) refresh();
      },
      onGap: refresh,
    });
  }, [transport, threadId, isPendingCreation, refetch]);

  useEffect(() => {
    if (!data) return;
    actions.applyThreadSnapshot(data.thread, data.turns, toThreadSnapshotApplyOptions(data));
  }, [actions, data]);

  return {
    snapshot: data ?? null,
    thread: data?.thread ?? null,
    liveState: data?.liveState ?? null,
    actionRequired: data?.actionRequired ?? null,
    nextSeq: data?.nextSeq ?? null,
    settled: data !== undefined || isError,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
