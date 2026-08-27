/** Shared field-scoped commands for project chat rows. */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { runFavoriteCommand, type ThreadUserStateLifecycle } from "./thread-user-state-commands";

export function useProjectChatCommands(projectId: string) {
  const client = useQueryClient();
  const setFavorite = useCallback(
    async (threadId: string, value: boolean, lifecycle?: ThreadUserStateLifecycle) =>
      (await runFavoriteCommand(client, projectId, threadId, value, lifecycle)).status ===
      "success",
    [client, projectId],
  );
  return {
    setFavorite,
  };
}
