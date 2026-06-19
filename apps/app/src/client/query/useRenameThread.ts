/**
 * useRenameThread — optimistic thread-title rename.
 *
 * Rename is client-cache-only today (no PATCH endpoint yet): it patches the
 * thread row across the cached project thread lists in place. This is a pure
 * cache mutation with no per-thread turn state, so it lives beside
 * `useProjectThreads` rather than on the thread store (which owns turns,
 * streaming coordination, and the pending-creation gate).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { patchThreadInProjectCaches } from "./project-thread-cache";

export function useRenameThread(): (threadId: string, title: string) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (threadId, title) => {
      const next = title.trim() ? title.trim() : null;
      patchThreadInProjectCaches(queryClient, threadId, {
        title: next,
        updatedAt: new Date().toISOString(),
      });
    },
    [queryClient],
  );
}
