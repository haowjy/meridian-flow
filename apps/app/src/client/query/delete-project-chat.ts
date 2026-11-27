import type { QueryClient } from "@tanstack/react-query";
import { deleteThread, restoreThread } from "@/client/api/threads-api";
import { removeChatRow, restoreChatRow, snapshotChatRow } from "./chat-projections";
import { invalidateProjectThreadData } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

export type ChatCommandOutcome = { status: "success" } | { status: "error"; error: Error };

export async function deleteProjectChat(
  client: QueryClient,
  projectId: string,
  threadId: string,
): Promise<ChatCommandOutcome> {
  const snapshot = snapshotChatRow(client, projectId, threadId);
  const userState = client.getQueryData(projectQueryKeys.threadUserState(projectId, threadId));
  removeChatRow(client, projectId, threadId);
  client.removeQueries({ queryKey: projectQueryKeys.threadUserState(projectId, threadId) });
  try {
    await deleteThread({ data: { threadId } });
    void invalidateProjectThreadData(client, projectId);
    return { status: "success" };
  } catch (cause) {
    restoreChatRow(client, projectId, threadId, snapshot);
    if (userState !== undefined) {
      client.setQueryData(projectQueryKeys.threadUserState(projectId, threadId), userState);
    }
    return { status: "error", error: asError(cause) };
  }
}

export async function restoreProjectChat(
  client: QueryClient,
  projectId: string,
  threadId: string,
): Promise<ChatCommandOutcome> {
  try {
    await restoreThread(threadId);
  } catch (cause) {
    return { status: "error", error: asError(cause) };
  }
  await Promise.all([
    invalidateProjectThreadData(client, projectId),
    // Reset, not invalidate: a kept "deleted" error would read as proof the chat is gone when it
    // next mounts, and drop its unsent words.
    client.resetQueries({ queryKey: threadQueryKeys.snapshot(threadId) }),
  ]);
  return { status: "success" };
}

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));
