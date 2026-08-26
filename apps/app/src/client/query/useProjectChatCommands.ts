/** Shared field-scoped commands for project chat rows. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  runThreadUserStateCommand,
  type ThreadUserStateLifecycle,
} from "./thread-user-state-commands";

export function useProjectChatCommands(projectId: string) {
  const client = useQueryClient();
  const run = useCallback(
    async (
      threadId: string,
      field: "isFavorite" | "isUnread",
      value: boolean,
      lifecycle?: ThreadUserStateLifecycle,
    ) =>
      (await runThreadUserStateCommand(client, projectId, threadId, field, value, lifecycle))
        .status === "success",
    [client, projectId],
  );
  return {
    setFavorite: (threadId: string, value: boolean, lifecycle?: ThreadUserStateLifecycle) =>
      run(threadId, "isFavorite", value, lifecycle),
    setUnread: (threadId: string, value: boolean) => run(threadId, "isUnread", value),
  };
}
