/**
 * Resolves the work ID used for work-scoped context browse APIs (`work`, `uploads`).
 * Prefers the active thread's work, then the project's first work.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectThreads } from "./useProjectThreads";
import { useWorks } from "./useWorks";

export function useContextWorkId(projectId: string, activeThreadId: string | null): string | null {
  const { threads } = useProjectThreads(projectId);
  const { works } = useWorks(projectId);

  return useMemo(() => {
    if (activeThreadId && threads) {
      const thread = threads.find((candidate) => candidate.id === activeThreadId);
      if (thread?.workId) return thread.workId;
    }
    return works?.[0]?.id ?? null;
  }, [activeThreadId, threads, works]);
}

export function contextRequestOptionsForScheme(
  scheme: ProjectContextTreeScheme,
  workId: string | null,
): { workId?: string } | undefined {
  if (!isWorkScopedProjectContextScheme(scheme) || !workId) return undefined;
  return { workId };
}
