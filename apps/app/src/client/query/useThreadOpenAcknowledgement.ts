/** Acknowledges a visible conversation and exposes destination failure recovery. */
import { t } from "@lingui/core/macro";
import type { ThreadAttention, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { useAnnouncement, useThreadActions } from "@/client/stores";
import { threadQueryKeys } from "./thread-query-keys";
import {
  clearThreadUserStateCommandOutcome,
  runThreadUserStateCommand,
  useThreadUserStateCommandState,
} from "./thread-user-state-commands";

const announcedOpenErrors = new WeakSet<Error>();

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
  const { announceError } = useAnnouncement();
  const command = useThreadUserStateCommandState(client, projectId ?? "", threadId, "isUnread");

  const acknowledge = useCallback(async () => {
    if (!projectId) return;
    const outcome = await runThreadUserStateCommand(client, projectId, threadId, "isUnread", false);
    if (outcome.status === "error") return;
    actions.setThreadAttention(threadId, outcome.response.attention);
    client.setQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId), (snapshot) =>
      snapshot ? { ...snapshot, attention: outcome.response.attention } : snapshot,
    );
  }, [actions, client, projectId, threadId]);

  useEffect(() => {
    if (!projectId) return;
    if (!enabled) return;
    if (command.error) return;
    if (attention === "unread" || command.pending) {
      if (!command.outcome) void acknowledge();
      return;
    }
    clearThreadUserStateCommandOutcome(client, projectId, threadId, "isUnread");
  }, [
    acknowledge,
    attention,
    client,
    command.outcome,
    command.pending,
    enabled,
    projectId,
    threadId,
  ]);

  useEffect(() => {
    const error = command.error;
    if (!enabled || !error || announcedOpenErrors.has(error)) return;
    announcedOpenErrors.add(error);
    announceError(t`Read status wasn’t saved`);
  }, [announceError, command.error, enabled]);

  const retry = useCallback(() => {
    if (!projectId) return;
    clearThreadUserStateCommandOutcome(client, projectId, threadId, "isUnread");
    void acknowledge();
  }, [acknowledge, client, projectId, threadId]);

  return { error: enabled ? command.error : null, pending: command.pending, retry };
}
