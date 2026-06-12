// @ts-nocheck
/**
 * chat-thread-resolution — resolves which thread the workbench chat screen should
 * show from the available sources.
 *
 * Pure precedence function: explicit `?thread=` → pending optimistic thread →
 * first non-subagent (else first) loaded workbench thread → null. Owns only this
 * fallback chain; consumed by `ChatScreen`.
 */
import type { Thread } from "@meridian/contracts/protocol";

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
