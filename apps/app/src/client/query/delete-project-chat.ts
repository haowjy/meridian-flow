/**
 * A chat's soft delete and its restore. The delete is optimistic: the row leaves every cached
 * chat projection at once, ahead of the server's confirmation, and a refusal puts the exact
 * pre-delete snapshot back.
 */
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

/**
 * Brings a chat back from Trash: a delete's Undo, or Restore over a trashed chat's draft. Resolves
 * once every list that names the chat has reread it, its drafts included: a chat with no Work
 * keeps its drafts under its lineage, frozen while it is in Trash.
 */
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
    client.invalidateQueries({ queryKey: projectQueryKeys.ownerDraftsOf(projectId) }),
    // Reset, not invalidate: a kept "deleted" error would read as proof the chat is gone when it
    // next mounts, and drop its unsent words.
    client.resetQueries({ queryKey: threadQueryKeys.snapshot(threadId) }),
  ]);
  return { status: "success" };
}

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));
