/**
 * chat-thread-resolution — resolves which thread the project chat should show
 * from the available sources.
 *
 * Pure precedence function: explicit `?thread=` → pending optimistic thread →
 * first non-subagent (else first) loaded project thread → null. The
 * `useResolvedChatThread` hook is the ONE resolution source shared by the
 * chat body (`ChatScreen`) and every header that names the thread
 * (`ChatSurface`'s dock title, `ChatPaneController`) — headers must never
 * re-derive the thread independently or they can title a different chat than
 * the body renders.
 */
import type { Thread } from "@meridian/contracts/protocol";

import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useThreadStore } from "@/client/stores";

export function resolveChatThreadId({
  explicitThreadId,
  pendingThreadId,
  projectThreads,
}: {
  explicitThreadId: string | null;
  pendingThreadId: string | null;
  projectThreads: Thread[] | null;
}): string | null {
  return (
    explicitThreadId ??
    pendingThreadId ??
    (projectThreads && projectThreads.length > 0
      ? (projectThreads.find((t) => t.kind !== "subagent")?.id ?? projectThreads[0].id)
      : null)
  );
}

/**
 * The full resolution chain as a hook: the store's pending optimistic thread +
 * the cached project thread list + the pure precedence function. Query state
 * is passed through for callers that render error/empty fallbacks.
 */
export function useResolvedChatThread(projectId: string, explicitThreadId: string | null) {
  const pendingThreadId = useThreadStore((state) => {
    for (const [tid, ps] of Object.entries(state.pendingStreamByThreadId)) {
      if (ps.deferredSend?.projectId === projectId) return tid;
    }
    return null;
  });
  const { threads: projectThreads, isError, refetch } = useProjectThreads(projectId);
  const resolvedThreadId = resolveChatThreadId({
    explicitThreadId,
    pendingThreadId,
    projectThreads,
  });
  return { resolvedThreadId, projectThreads, isError, refetch };
}
