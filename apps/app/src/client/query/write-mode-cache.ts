/**
 * A chat's write mode changed (a switch applied): bring the chat's cached mode
 * to it and refresh the Work's default from the server.
 *
 * The thread's mode comes from authoritative order only: the newest divider in
 * its transcript, or an applied answer the cached snapshot has not yet seen. A
 * Work's default is never patched from either (a chat's historical switch is
 * not the Work's latest); the versioned Works acquisition path refetches it.
 */
import type { AiWriteMode } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";
import type { deserializeThreadSnapshot } from "@/client/api/threads-api";
import { projectQueryKeys } from "./project-query-keys";
import { patchThreadInProjectCaches } from "./project-thread-cache";
import { threadQueryKeys } from "./thread-query-keys";

function setThreadMode(client: QueryClient, threadId: string, mode: AiWriteMode): void {
  patchThreadInProjectCaches(client, threadId, { aiWriteMode: mode });
  client.setQueryData<ReturnType<typeof deserializeThreadSnapshot>>(
    threadQueryKeys.snapshot(threadId),
    (snapshot) =>
      snapshot ? { ...snapshot, thread: { ...snapshot.thread, aiWriteMode: mode } } : snapshot,
  );
}

function refreshWorkDefault(client: QueryClient, projectId: string): void {
  void client.invalidateQueries({ queryKey: projectQueryKeys.works(projectId), exact: true });
}

/** The newest divider in the chat's transcript says its mode is `mode`. */
export function applyWriteModeDivider(
  client: QueryClient,
  input: { projectId: string; threadId: string; mode: AiWriteMode },
): void {
  setThreadMode(client, input.threadId, input.mode);
  refreshWorkDefault(client, input.projectId);
}

/**
 * The server answered that a switch applied, as divider turn `turnId`. The
 * cached snapshot already holding that turn is newer or equal evidence (a
 * replayed answer must not regress it), so only an unseen turn patches.
 */
export function applyWriteModeAnswer(
  client: QueryClient,
  input: { projectId: string; threadId: string; mode: AiWriteMode; turnId: string },
): void {
  const snapshot = client.getQueryData<ReturnType<typeof deserializeThreadSnapshot>>(
    threadQueryKeys.snapshot(input.threadId),
  );
  if (snapshot && !snapshot.turns.some((turn) => turn.id === input.turnId)) {
    setThreadMode(client, input.threadId, input.mode);
  }
  refreshWorkDefault(client, input.projectId);
}
