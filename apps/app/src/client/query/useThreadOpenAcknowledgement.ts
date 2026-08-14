/** Acknowledges a visible conversation without coupling the write to snapshot transport. */
import type { ThreadAttention, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { updateThreadUserState } from "@/client/api/threads-api";
import { useThreadActions } from "@/client/stores";
import { createHomeFeedCacheController } from "./home-chat-feed-cache";
import { threadQueryKeys } from "./thread-query-keys";

const pendingAcknowledgements = new WeakMap<
  QueryClient,
  Map<string, ReturnType<typeof updateThreadUserState>>
>();

function acknowledgeThread(client: QueryClient, threadId: string) {
  let pending = pendingAcknowledgements.get(client);
  if (!pending) {
    pending = new Map();
    pendingAcknowledgements.set(client, pending);
  }
  const existing = pending.get(threadId);
  if (existing) return existing;
  const request = updateThreadUserState(threadId, { isUnread: false });
  pending.set(threadId, request);
  const settle = () => {
    if (pending?.get(threadId) === request) pending.delete(threadId);
  };
  void request.then(settle, settle);
  return request;
}

export function useThreadOpenAcknowledgement({
  threadId,
  projectId,
  attention,
  enabled,
}: {
  threadId: string;
  projectId: string | null;
  attention: ThreadAttention | null;
  enabled: boolean;
}) {
  const client = useQueryClient();
  const actions = useThreadActions();

  useEffect(() => {
    if (!enabled || !projectId || attention !== "unread") return;
    void acknowledgeThread(client, threadId)
      .then((response) => {
        actions.setThreadAttention(threadId, response.attention);
        createHomeFeedCacheController(client, projectId).reconcile(threadId, response);
        client.setQueryData<ThreadSnapshotResponse>(
          threadQueryKeys.snapshot(threadId),
          (snapshot) => (snapshot ? { ...snapshot, attention: response.attention } : snapshot),
        );
      })
      .catch(() => undefined);
  }, [actions, attention, client, enabled, projectId, threadId]);
}
