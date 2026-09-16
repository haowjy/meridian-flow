/**
 * chat-thread-resolution — resolves which thread the project chat should show
 * from the available sources.
 *
 * Pure precedence function: explicit URL chat id (even if not yet loaded) →
 * pending optimistic thread → remembered synced thread → first non-subagent
 * (else first) loaded project thread → null. Remembered ids must resolve in
 * the loaded list. An explicit URL id never falls through.
 * `ReadableProjectRoute` calls `useResolvedChatThread` once and passes that result to
 * context hydration, review, and every chat surface. Descendants must never
 * re-derive the thread or their Work and conversation can diverge.
 */
import type { Thread } from "@meridian/contracts/protocol";

import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useThreadStore } from "@/client/stores";
import { readRememberedThread } from "@/client/working-set";

export function resolveChatThreadId({
  explicitThreadId,
  pendingThreadId,
  rememberedThreadId,
  projectThreads,
  allowDefaults = true,
}: {
  explicitThreadId: string | null;
  pendingThreadId: string | null;
  rememberedThreadId: string | null;
  projectThreads: Thread[] | null;
  allowDefaults?: boolean;
}): string | null {
  const availableThreads = projectThreads?.filter((thread) => thread.deletedAt === null) ?? null;
  const loadedId = (threadId: string | null) =>
    threadId && availableThreads?.some((thread) => thread.id === threadId) ? threadId : null;
  if (explicitThreadId) return explicitThreadId;
  if (!allowDefaults) return null;
  return (
    pendingThreadId ??
    loadedId(rememberedThreadId) ??
    (availableThreads && availableThreads.length > 0
      ? (availableThreads.find((t) => t.kind !== "subagent")?.id ?? availableThreads[0].id)
      : null)
  );
}

/**
 * The full resolution chain as a hook: the store's pending optimistic thread +
 * the cached project thread list + the pure precedence function. Query state
 * is passed through for callers that render error/empty fallbacks.
 */
export function useResolvedChatThread(
  projectId: string,
  explicitThreadId: string | null,
  allowDefaults = true,
) {
  const pendingThreadId = useThreadStore((state) => {
    for (const [tid, ps] of Object.entries(state.pendingStreamByThreadId)) {
      if (ps.creation?.projectId === projectId) return tid;
    }
    return null;
  });
  const { threads: projectThreads, isError, refetch } = useProjectThreads(projectId);
  const resolvedThreadId = resolveChatThreadId({
    allowDefaults,
    explicitThreadId,
    pendingThreadId,
    rememberedThreadId: readRememberedThread(projectId),
    projectThreads,
  });
  return { resolvedThreadId, projectThreads, isError, refetch };
}
