/** Acknowledges a visible conversation without coupling the write to snapshot transport. */
import type { ThreadAttention, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useThreadActions } from "@/client/stores";
import { threadQueryKeys } from "./thread-query-keys";
import {
  clearThreadUserStateCommandOutcome,
  runThreadUserStateCommand,
  useThreadUserStateCommandState,
} from "./thread-user-state-commands";

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
  const command = useThreadUserStateCommandState(client, projectId ?? "", threadId, "isUnread");

  useEffect(() => {
    if (!projectId) return;
    if (attention !== "unread") {
      clearThreadUserStateCommandOutcome(client, projectId, threadId, "isUnread");
      return;
    }
    if (!enabled || command.pending || command.outcome?.status === "success") return;
    void runThreadUserStateCommand(client, projectId, threadId, "isUnread", false).then(
      (outcome) => {
        if (outcome.status === "error") return;
        const response = outcome.response;
        actions.setThreadAttention(threadId, response.attention);
        client.setQueryData<ThreadSnapshotResponse>(
          threadQueryKeys.snapshot(threadId),
          (snapshot) => (snapshot ? { ...snapshot, attention: response.attention } : snapshot),
        );
      },
    );
  }, [actions, attention, client, command.outcome, command.pending, enabled, projectId, threadId]);
}
