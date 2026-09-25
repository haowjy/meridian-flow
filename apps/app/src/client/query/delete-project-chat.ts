/**
 * Optimistic soft delete: the row leaves every cached chat projection at once
 * and the caller's current-chat/favorite side effects run immediately, ahead
 * of the server's confirmation.
 */
import type { QueryClient } from "@tanstack/react-query";
import { deleteThread } from "@/client/api/threads-api";
import { removeChatRow, restoreChatRow, snapshotChatRow } from "./chat-projections";
import { invalidateProjectThreadData, invalidateWorkThreads } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";

export type DeleteProjectChatOutcome = { status: "success" } | { status: "error"; error: Error };

/**
 * Remove the chat from every projection and its normalized user-state record
 * before the server confirms. A failure restores the exact pre-delete cache
 * snapshot and returns the error for the caller to surface on the row.
 */
export async function deleteProjectChat(
  client: QueryClient,
  projectId: string,
  threadId: string,
): Promise<DeleteProjectChatOutcome> {
  const snapshot = snapshotChatRow(client, projectId, threadId);
  const userState = client.getQueryData(projectQueryKeys.threadUserState(projectId, threadId));
  removeChatRow(client, projectId, threadId);
  client.removeQueries({ queryKey: projectQueryKeys.threadUserState(projectId, threadId) });
  try {
    await deleteThread({ data: { threadId } });
    void invalidateProjectThreadData(client, projectId);
    void invalidateWorkThreads(client, projectId);
    return { status: "success" };
  } catch (cause) {
    restoreChatRow(client, projectId, threadId, snapshot);
    if (userState !== undefined) {
      client.setQueryData(projectQueryKeys.threadUserState(projectId, threadId), userState);
    }
    return { status: "error", error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}
